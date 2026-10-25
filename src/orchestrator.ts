/**
 * 编排器：从一条群消息到一条回复，中间的所有决策都在这里。
 *
 * 职责链：幂等入库 → 命令拦截 → 触发判定 → 按群串行排队 → 上下文构造 →
 *         预算检查 → 流式生成 → 分段发送 → 用量记账 → 推进冷却
 */

import type { Adapter, AdapterNotice, ChatMessage, Envelope, Provider, Usage } from "./types.ts";
import { parseConvKey } from "./types.ts";
import type { Store } from "./store.ts";
import type { AgentConfig, Binding } from "./agent.ts";
import type { Logger } from "./logger.ts";
import type { QuotaConfig } from "./config.ts";
import type { HistoryRow } from "./context.ts";
import { buildContext } from "./context.ts";
import { createTriggerState, evaluateTrigger, recordReply, type TriggerState } from "./trigger.ts";
import { SentenceSplitter } from "./stream.ts";
import { splitForChat } from "./text.ts";
import { clampSegment, firstReplyDelayMs, segmentGapMs, stripAiTells, stripTranscriptPrefix, voiceHint } from "./humanize.ts";
import { pickRandomImage } from "./emoji.ts";
import { summarizeIfNeeded } from "./memory.ts";
import { estimateCostUsd, formatCny, usdToCny } from "./cost.ts";
import { DEFAULT_SAFE_REPLY, scanText, type SafetyConfig } from "./safety.ts";
import { shouldThinkDeeply } from "./deep.ts";
import { loadImageUrls } from "./vision.ts";

export interface OrchestratorDeps {
  adapter: Adapter;
  provider: Provider;
  store: Store;
  agents: Map<string, AgentConfig>;
  bindings: Binding[];
  quota: QuotaConfig;
  logger: Logger;
  /** 内容安全：入站挡话题、出站挡发言。不传就等于关闭 */
  safety?: SafetyConfig;
  /**
   * 语音合成。传了才能用 /语音。
   * 返回音频文件路径；返回 undefined 表示没合成出来。
   */
  speak?: (text: string) => Promise<string | undefined>;
  now?: () => number;
  rng?: () => number;
  sendDelayMs?: number;
  maxConcurrentTurns?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/** 排队超过这个时间就不回了：补旧消息没有意义，只会让对话越追越远 */
const MAX_QUEUE_WAIT_MS = 20_000;

/** 昵称里可能有正则特殊字符，拼进正则前必须转义 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toRow(env: Envelope): HistoryRow {
  return {
    id: env.id,
    convKey: env.convKey,
    senderId: env.sender.id,
    senderName: env.sender.name,
    isSelf: env.sender.isSelf,
    text: env.text,
    ts: env.ts,
  };
}

function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 会话级脱敏 id：用于 API 的 user_id（缓存隔离 + 内容审核），不泄露真实 QQ 号 */
function hashUserId(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `u_${h.toString(16)}`;
}

/**
 * 绑定匹配。支持通配符 `qqbot:102030405:group:*`：
 * QQ 官方机器人的 group_openid 用户事先不可能知道（收到第一条消息才有），
 * 没有通配符就没法完成首次配置。
 */
export function matchBinding(binding: { convKey: string }, convKey: string): boolean {
  if (binding.convKey === convKey) return true;
  if (binding.convKey.endsWith(":*")) {
    return convKey.startsWith(binding.convKey.slice(0, -1));
  }
  return false;
}

export class Orchestrator {
  #deps: OrchestratorDeps;
  #state: TriggerState = createTriggerState();
  #tails = new Map<string, Promise<void>>();
  #active = 0;
  #waiters: Array<() => void> = [];
  #maxConcurrent: number;
  #sleep: (ms: number) => Promise<void>;
  /** 每个会话最近一条自己发的消息 id，用来撤回 */
  #lastSent = new Map<string, string>();
  /** 被禁言到什么时候（convKey → 时间戳） */
  #muteUntil = new Map<string, number>();
  /** 已经被移出的群：不再尝试说话，也别装没事 */
  #leftConvs = new Set<string>();


  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#maxConcurrent = deps.maxConcurrentTurns ?? 4;
    this.#sleep = deps.sleep ?? DEFAULT_SLEEP;
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  #rng(): number {
    return this.#deps.rng ? this.#deps.rng() : Math.random();
  }

  /**
   * 群里发生了什么：撤回、禁言、被踢。
   * 不处理这些，它会活在一个假世界里 —— 答已撤回的话、被禁言了还拼命发、被踢了还以为自己在。
   */
  async handleNotice(notice: AdapterNotice): Promise<void> {
    const log = this.#deps.logger.child("notice");

    switch (notice.kind) {
      case "recall": {
        if (!notice.messageId) break;
        const changed = this.#deps.store.markRecalled(notice.messageId);
        if (changed) log.info(`消息已撤回，不再作为上下文：${notice.messageId}`);
        break;
      }

      case "muted": {
        if (!notice.convKey) break;
        const seconds = notice.durationSec && notice.durationSec > 0 ? notice.durationSec : 600;
        this.#muteUntil.set(notice.convKey, this.#now() + seconds * 1000);
        log.warn(`被禁言 ${seconds} 秒（${notice.convKey}）`);
        break;
      }

      case "unmuted": {
        if (notice.convKey) this.#muteUntil.delete(notice.convKey);
        log.info('禁言解除');
        break;
      }

      case "kicked": {
        if (!notice.convKey) break;
        this.#leftConvs.add(notice.convKey);
        log.warn(`被移出群 ${notice.convKey}，后续不再尝试发言`);
        break;
      }

      default:
        break;
    }
  }

  /** 这个会话现在能不能说话 */
  #canSpeak(convKey: string): { ok: boolean; reason?: string } {    if (this.#leftConvs.has(convKey)) return { ok: false, reason: "已经被移出这个群" };
    const until = this.#muteUntil.get(convKey) ?? 0;
    if (until > this.#now()) {
      const left = Math.ceil((until - this.#now()) / 1000);
      return { ok: false, reason: `正在被禁言（还剩 ${left} 秒）` };
    }
    return { ok: true };
  }

  /** 入口。返回不代表已处理完，只代表已入队。测试用 drain() 等待。 */
  async handleEnvelope(env: Envelope): Promise<void> {    const log = this.#deps.logger.child("orch");
    const now = this.#now();

    // 先落库：不管这个群有没有绑定，消息本身都要记下来。
    // 这样"看不看得到"和"回不回"才是两件事 —— 用户可以先观察再决定交给 AI。
    const inserted = this.#deps.store.appendMessage(toRow(env));
    if (!inserted) {
      log.debug(`重复消息已忽略 ${env.id}`);
      return;
    }

    if (env.sender.isSelf) return;

    // 私聊的名字就是对方昵称；群名由控制台从群列表里补
    if (parseConvKey(env.convKey).type === "private") {
      const title = env.sender.name.trim();
      if (title && this.#deps.store.getConversationTitle(env.convKey) !== title) {
        this.#deps.store.setConversationTitle(env.convKey, title, now);
      }
    }

    // 引用回复：QQ 的事件里只带 message_id，正文得自己补。
    // 不补的话模型看到的引用是空的，只能说"我不知道你在说什么"。
    if (env.replyTo && !env.replyTo.excerpt) {
      const local = this.#deps.store.getMessage(env.replyTo.id);
      if (local) {
        env.replyTo = {
          id: env.replyTo.id,
          senderName: local.senderName,
          excerpt: local.text,
          senderIsSelf: local.isSelf,
        };
      } else if (this.#deps.adapter.getMessage) {
        const fetched = await this.#deps.adapter.getMessage(env.replyTo.id).catch(() => undefined);
        if (fetched) env.replyTo = { id: env.replyTo.id, ...fetched };
      }
    }

    const binding = this.#deps.bindings.find((b) => b.enabled && matchBinding(b, env.convKey));
    if (!binding) {
      log.debug(`会话未绑定，只记录不回复 ${env.convKey}`);
      return;
    }

    const agent = this.#deps.agents.get(binding.agentId);
    if (!agent) {
      log.warn(`绑定指向不存在的 Agent: ${binding.agentId}`);
      return;
    }

    // 被禁言 / 被踢：别再白费力气发消息，日志里要能看出原因
    const speakable = this.#canSpeak(env.convKey);
    if (!speakable.ok) {
      log.info(`不回复（${speakable.reason}）：${env.text.slice(0, 30)}`);
      return;
    }

    // 入站安全：话题本身违法就不接，免得被带着说出违规内容
    const safety = this.#deps.safety;
    if (safety?.enabled) {
      const scan = scanText(env.text, safety.words);
      if (scan.hit) {
        log.warn(`话题被安全策略跳过：命中「${scan.matched.join("、")}」 | ${env.text.slice(0, 30)}`);
        return;
      }
    }

    if (this.#handleCommand(env, agent, binding)) return;

    const decision = evaluateTrigger(env, agent.trigger, this.#state, now, () => this.#rng());
    if (!decision.respond) {
      // 用户最常问"它怎么不回我"，所以把原因写到日志里，能直接查
      log.info(`不回复（${decision.reason}）：${env.text.slice(0, 30)}`);
      return;
    }

    log.info(`决定回复（${decision.reason}）：${env.text.slice(0, 40)}`);

    // 排队排太久就丢掉：两个人聊得比它回得快时，补一句五分钟前的话没有意义，
    // 反而会让它一直在追旧消息，看起来像"卡住了"
    const queuedAt = this.#now();
    this.#enqueue(env.convKey, async () => {
      const waitedMs = this.#now() - queuedAt;
      if (waitedMs > MAX_QUEUE_WAIT_MS) {
        log.info(`排队 ${Math.round(waitedMs / 1000)} 秒已过时，跳过这条：${env.text.slice(0, 30)}`);
        return;
      }
      await this.#runTurn(env, agent, binding);
    });
  }

  /** 等待所有已入队的轮次结束（测试和优雅退出用） */
  async drain(): Promise<void> {
    for (;;) {
      const pending = [...this.#tails.values()];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
      if (this.#tails.size === 0) return;
    }
  }

  /**
   * 主动开口：群里安静很久时，它自己发起一句话。
   *
   * 和"插话"不同 —— 插话是别人说话它接，这个是**没人说话它先说**。
   * 所以提示词完全不一样：不能提问（没人问它），不能客套，得像老群友自言自语。
   */
  async speakProactively(convKey: string, agent: AgentConfig, quietMinutes: number): Promise<boolean> {
    const log = this.#deps.logger.child("proactive");
    const speakable = this.#canSpeak(convKey);
    if (!speakable.ok) {
      log.info(`不主动开口（${speakable.reason}）`);
      return false;
    }

    // 主动开口也是花钱的，日预算用尽就别开口
    const spent = usdToCny(this.#deps.store.costSince(startOfLocalDay(this.#now())));
    if (this.#deps.quota.globalDailyCny > 0 && spent >= this.#deps.quota.globalDailyCny) {
      log.info(`日预算已用尽（${formatCny(spent)}），不主动开口`);
      return false;
    }

    const traits = agent.traits
      ? [
          agent.traits.likes.length ? `喜欢：${agent.traits.likes.join("、")}` : "",
          agent.traits.dislikes.length ? `讨厌：${agent.traits.dislikes.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          `你是「${agent.name}」，这个群里的一个老群友。`,
          agent.persona,
          traits,
          "",
          "现在群里安静了很久。你主动说一句，要求：",
          "- 不要提问（没人问你），不要客套，不要「大家好」",
          "- 不要复述以前说过的话",
          "- 1~2 句，20 字左右，像自己嘀咕一句",
          "- 不用 Markdown，不列点",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      {
        role: "user",
        content: `（群里已经 ${quietMinutes} 分钟没人说话了。你随便说一句。）`,
      },
    ];

    let text = "";
    try {
      for await (const chunk of this.#deps.provider.chat({
        model: agent.model,
        messages,
        maxOutputTokens: 200,
        temperature: 1.0,
        thinking: false,
        userId: hashUserId(agent.id),
      })) {
        if (chunk.delta) text += chunk.delta;
      }
    } catch (err) {
      log.warn(`主动开口生成失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    const clean = clampSegment(stripAiTells(stripTranscriptPrefix(text.trim())), 120);
    if (!clean || clean.length < 4) return false;

    if (this.#deps.safety?.enabled) {
      const scan = scanText(clean, this.#deps.safety.words);
      if (scan.hit) {
        log.warn(`主动开口被安全策略挡下：命中「${scan.matched.join("、")}」`);
        return false;
      }
    }

    try {
      const sent = await this.#deps.adapter.send(convKey, { segments: [clean] });
      if (sent.messageId) this.#lastSent.set(convKey, sent.messageId);

      // 自己说的话也要入库：否则它不记得说过、也不会进归档
      const ts = this.#now();
      this.#deps.store.appendMessage({
        id: `bot:${convKey}:${ts}`,
        convKey,
        senderId: "self",
        senderName: agent.name,
        isSelf: true,
        text: clean,
        ts,
      });

      log.info(`主动开口：${clean.slice(0, 40)}`);
      return true;
    } catch (err) {
      log.warn(`主动开口发送失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * /语音 [音色名] 要说的话
   * 音色名可省略，省略就用默认音色。
   */
  async #speak(env: Envelope, raw: string): Promise<void> {
    const log = this.#deps.logger.child("tts");

    if (!this.#deps.speak) {
      await this.#sendText(env, "语音没开，或者没装合成引擎。");
      return;
    }
    if (!this.#deps.adapter.sendVoice) {
      await this.#sendText(env, "这个平台发不了语音。");
      return;
    }

    const arg = raw.trim();
    if (!arg) {
      await this.#sendText(env, "用法：/语音 你好呀，或者 /语音 晓晓 你好呀");
      return;
    }

    try {
      const file = await this.#deps.speak(arg);
      if (!file) {
        await this.#sendText(env, "这句没合成出来，换个说法试试。");
        return;
      }
      await this.#deps.adapter.sendVoice(env.convKey, file);
    } catch (err) {
      log.warn("合成失败", err instanceof Error ? err.message : String(err));
      await this.#sendText(env, "语音合成失败了，等下再试。");
    }
  }

  #handleCommand(env: Envelope, agent: AgentConfig, _binding: Binding): boolean {
    // 群里正常用法是 "@AI /help"，开头的 @ 必须先剥掉，否则命令永远识别不到
    const text = env.text.trim().replace(/^(?:@\S+\s*)+/, "").trim();
    if (!text.startsWith("/")) return false;

    const parts = text.slice(1).split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase();
    const isAdmin = env.sender.role === "owner" || env.sender.role === "admin";
    const adapter = this.#deps.adapter;

    if (cmd === "语音" || cmd === "voice") {
      const rest = text.slice(text.indexOf(parts[0] ?? "") + (parts[0]?.length ?? 0)).trim();
      this.#enqueue(env.convKey, async () => {
        await this.#speak(env, rest);
      });
      return true;
    }

    if (cmd === "reset") {
      this.#enqueue(env.convKey, async () => {
        if (!isAdmin) {
          await this.#sendText(env, "只有群主或管理员能重置记忆。");
          return;
        }
        this.#deps.store.clearSummary(env.convKey, this.#now());
        await this.#sendText(env, "已重置本群记忆。");
      });
      return true;
    }

    if (cmd === "撤回" || cmd === "recall") {
      this.#enqueue(env.convKey, async () => {
        if (!agent.allowRecall) {
          await this.#sendText(env, "撤回功能没开。");
          return;
        }
        if (!isAdmin) {
          await this.#sendText(env, "只有群主或管理员能让我撤回。");
          return;
        }
        if (!adapter.recall) {
          await this.#sendText(env, "这个平台不支持撤回。");
          return;
        }
        const last = this.#lastSent.get(env.convKey);
        if (!last) {
          await this.#sendText(env, "没有可撤回的消息。");
          return;
        }
        try {
          await adapter.recall(env.convKey, last);
          this.#lastSent.delete(env.convKey);
          await this.#sendText(env, "撤回了。");
        } catch {
          await this.#sendText(env, "撤回失败，可能已经超时了。");
        }
      });
      return true;
    }

    if (cmd === "退群" || cmd === "leave") {
      this.#enqueue(env.convKey, async () => {
        if (!agent.allowLeave) {
          await this.#sendText(env, "退群功能没开。");
          return;
        }
        if (!isAdmin) {
          await this.#sendText(env, "只有群主或管理员能让我退群。");
          return;
        }
        if (!adapter.leaveGroup) {
          await this.#sendText(env, "这个平台不支持退群。");
          return;
        }
        // 不可逆操作，必须显式再说一次「确认」
        if ((parts[1] ?? "") !== "确认") {
          await this.#sendText(env, "真要退？回一句 /退群 确认。退了要群主重新同意才能回来。");
          return;
        }
        await this.#sendText(env, "那我走了，有事再拉我。");
        await adapter.leaveGroup(env.convKey);
      });
      return true;
    }

    if (cmd === "表情" || cmd === "emoji") {
      this.#enqueue(env.convKey, async () => {
        if (!adapter.sendImage) {
          await this.#sendText(env, "这个平台发不了图。");
          return;
        }
        const picked = agent.emojiDir ? pickRandomImage(agent.emojiDir, () => this.#rng()) : undefined;
        if (!picked) {
          await this.#sendText(env, "表情包目录里没图，或者还没配目录。");
          return;
        }
        await adapter.sendImage(env.convKey, picked);
      });
      return true;
    }

    if (cmd === "help") {
      this.#enqueue(env.convKey, () =>
        this.#sendText(
          env,
          "在群里 @我 就能对话。\n/reset 清空记忆（群主/管理员）\n/撤回 收回我上一条\n/表情 发一张表情包\n/退群 确认 让我退出这个群（群主/管理员）",
        ),
      );
      return true;
    }

    return false;
  }

  #enqueue(convKey: string, task: () => Promise<void>): void {
    const prev = this.#tails.get(convKey) ?? Promise.resolve();
    const next = prev
      .then(() => this.#withConcurrency(task))
      .catch((err: unknown) => {
        this.#deps.logger.error("轮次执行失败", err);
      });
    this.#tails.set(convKey, next);
    void next.finally(() => {
      if (this.#tails.get(convKey) === next) this.#tails.delete(convKey);
    });
  }

  async #withConcurrency(task: () => Promise<void>): Promise<void> {
    if (this.#active >= this.#maxConcurrent) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    try {
      await task();
    } finally {
      this.#active -= 1;
      const next = this.#waiters.shift();
      if (next) next();
    }
  }

  async #runTurn(env: Envelope, agentIn: AgentConfig, binding: Binding): Promise<void> {
    const log = this.#deps.logger.child("turn");
    const now = this.#now();
    const dayStart = startOfLocalDay(now);

    // 认真模式：只有用户开了、且这轮确实像技术问题时，才开思考 + 放宽输出。
    // 闲聊照旧快而短。
    const deepMode =
      agentIn.deep?.enabled === true
        ? shouldThinkDeeply(env.text, env.mentions.self)
        : { deep: false, reason: "未开启" };
    if (deepMode.deep) {
      log.info(`认真模式：${deepMode.reason}，开思考（${agentIn.deep.maxTokens} tokens）`);
    }
    const agent: AgentConfig = deepMode.deep
      ? {
          ...agentIn,
          thinking: true,
          maxOutputTokens: Math.max(agentIn.maxOutputTokens, agentIn.deep.maxTokens),
        }
      : agentIn;

    const globalSpent = usdToCny(this.#deps.store.costSince(dayStart));
    if (this.#deps.quota.globalDailyCny > 0 && globalSpent >= this.#deps.quota.globalDailyCny) {
      log.warn(`全局日预算已用尽 ${formatCny(globalSpent)}，跳过本轮`);
      if (this.#deps.quota.onExceed !== "silent") {
        await this.#sendText(env, "今天的额度用完了，明天再来找我吧。");
      }
      return;
    }

    const bindingSpent = usdToCny(this.#deps.store.costSinceForBinding(binding.convKey, dayStart));
    if (this.#deps.quota.bindingDailyCny > 0 && bindingSpent >= this.#deps.quota.bindingDailyCny) {
      log.warn(`本群日预算已用尽 ${formatCny(bindingSpent)}，跳过本轮`);
      return;
    }

    // 已经被摘要覆盖的消息不再进上下文，否则会和摘要重复
    const summaryUpto = this.#deps.store.getSummaryUpto(env.convKey);
    const history = this.#deps.store
      .recentMessages(env.convKey, 60)
      .filter((row) => row.id !== env.id && row.ts > summaryUpto);
    const summary = this.#deps.store.getSummary(env.convKey);

    // 长期记忆召回：关键词 + 同一个人说过的话 + 最近说过的话，三路加权
    // 最近说过的话已经在窗口里了，去重后再塞，避免同一句出现两次
    const recentTexts = new Set(history.slice(-20).map((h) => h.text));
    const recalled = this.#deps.store
      .recallMemory(env.convKey, env.text, { limit: 8, senderName: env.sender.name })
      .filter((r) => !recentTexts.has(r.text))
      .slice(0, 5);

    // 结构化事实：比摘要更省 token，因为只带属性不带过程
    const facts = this.#deps.store.listFacts(env.convKey, 20);

    // 看图：QQ 的图片地址带时效，必须现在取。取不到就退回纯文字，不让整轮失败。
    let images: string[] | undefined;
    const imageRefs = env.media.filter((m) => m.kind === "image").map((m) => m.url);
    if (imageRefs.length > 0) {
      const loaded = await loadImageUrls(imageRefs);
      if (loaded.urls.length > 0) images = loaded.urls;
      if (loaded.failed > 0) log.warn(`有 ${loaded.failed} 张图取不到，这轮只发文字`);
    }

    const built = buildContext({
      botName: agent.name,
      persona: agent.persona,
      traits: agent.traits,
      deep: deepMode.deep,
      groupTitle: env.convKey,
      replyTo: env.replyTo
        ? { senderName: env.replyTo.senderName || "某人", excerpt: env.replyTo.excerpt }
        : undefined,
      summary,
      recalled,
      facts,
      images,
      history,
      current: toRow(env),
      now,
      maxContextTokens: agent.maxContextTokens,
      maxOutputTokens: agent.maxOutputTokens,
    });

    log.info(
      `生成中 群=${env.convKey} 历史=${history.length}条 丢弃=${built.droppedCount} 估算≈${built.estimatedTokens}tok`,
    );

    const splitter = new SentenceSplitter(deepMode.deep ? 900 : 600, deepMode.deep ? 4 : 3);
    let text = "";
    let usage: Usage | undefined;
    let sentAny = false;
    let blockedSegments = 0;
    // 安全开启时不走流式发送，先攒全文再扫一遍 —— 否则半句话先发出去就收不回来了
    const safetyOn = this.#deps.safety?.enabled === true;
    // 记下真正发出去的干净文本：存原文会让下次上下文里全是 "[昵称 时间]" 前缀，越学越歪
    const sentParts: string[] = [];

    // 引用只在"已经被别人插话"时才用：
    // 对方的消息就是最后一条时，@ 一下就够，再引用一遍纯属噪音
    const latest = this.#deps.store.recentMessages(env.convKey, 1)[0];
    const overtaken = Boolean(latest && latest.id !== env.id && latest.ts > env.ts);
    const quoteId =
      overtaken && history.length >= agent.quoteThreshold ? env.id : undefined;

    // 心声由代码控制频率：约四分之一的轮次才提示模型加
    const hint = voiceHint(() => this.#rng());
    const messages = hint
      ? [...built.messages.slice(0, -1), { role: "system" as const, content: hint }, built.messages.at(-1)!]
      : built.messages;

    try {
      const controller = new AbortController();
      for await (const chunk of this.#deps.provider.chat({
        model: agent.model,
        messages,
        maxOutputTokens: agent.maxOutputTokens,
        temperature: agent.temperature,
        thinking: agent.thinking,
        reasoningEffort: agent.reasoningEffort,
        userId: hashUserId(env.sender.id),
        signal: controller.signal,
      })) {
        if (chunk.delta) {
          text += chunk.delta;

          // 开了内容安全就不逐句发：流式会把前半句先发出去，
          // 等后半句被拦下来时群里已经看到半句话了。先攒全文，扫完再发。
          if (!safetyOn) {
            for (const segment of splitter.push(chunk.delta)) {
              const r = await this.#sendSegment(env, agent, segment, sentAny ? undefined : quoteId, !sentAny, deepMode.deep ? 320 : 120);
              if (r.text) sentParts.push(r.text);
              else if (r.blocked) blockedSegments += 1;
              sentAny = true;
            }
          }
        }
        if (chunk.usage) usage = chunk.usage;
      }

      // 思考模式偶发把输出额度全花在思考上，正文一个字都没有。
      // 这是静默失败（用户等半天等不到回复），退化成不思考再问一次。
      if (!text.trim() && agent.thinking) {
        log.warn("思考模式没产出正文，退回普通模式重试一次");
        try {
          for await (const chunk of this.#deps.provider.chat({
            model: agent.model,
            messages,
            maxOutputTokens: 600,
            temperature: 1,
            thinking: false,
            userId: hashUserId(agent.id),
          })) {
            if (chunk.delta) {
              text += chunk.delta;
              if (!safetyOn) {
                for (const segment of splitter.push(chunk.delta)) {
                  const r = await this.#sendSegment(env, agent, segment, sentAny ? undefined : quoteId, !sentAny, deepMode.deep ? 320 : 120);
                  if (r.text) sentParts.push(r.text);
                  else if (r.blocked) blockedSegments += 1;
                  sentAny = true;
                }
              }
            }
            if (chunk.usage) usage = chunk.usage;
          }
        } catch (err) {
          log.warn(`重试也失败了：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!safetyOn) {
        const tail = splitter.flush();
        if (tail) {
          const r = await this.#sendSegment(env, agent, tail, sentAny ? undefined : quoteId, !sentAny, deepMode.deep ? 320 : 120);
          if (r.text) sentParts.push(r.text);
          else if (r.blocked) blockedSegments += 1;
          sentAny = true;
        }
      } else {
        // 全文一次性过安全扫描，再按句拆开发
        const full = text.trim();
        const scan = full ? scanText(full, this.#deps.safety?.words ?? []) : { hit: false, matched: [] };
        if (scan.hit) {
          blockedSegments += 1;
          log.warn(`整段发言被安全策略挡下：命中「${scan.matched.join("、")}」`);
        } else if (full) {
          for (const piece of splitForChat(full, this.#deps.adapter.capabilities().maxTextLength)) {
            const r = await this.#sendSegment(env, agent, piece, sentAny ? undefined : quoteId, !sentAny, deepMode.deep ? 320 : 120);
            if (r.text) sentParts.push(r.text);
            else if (r.blocked) blockedSegments += 1;
            sentAny = true;
          }
        }
      }
    } catch (err) {
      log.error("生成失败", err instanceof Error ? (err.stack ?? err.message) : err);
      if (!sentAny) {
        await this.#sendText(env, "（我这边卡住了，等下再试）");
      }
      return;
    }

    // 整段发言都被安全策略挡掉了：回一句"不接这个话题"，别让群里以为它死了
    if (sentAny === false && sentParts.length === 0 && blockedSegments > 0) {
      const reply = this.#deps.safety?.reply || DEFAULT_SAFE_REPLY;
      await this.#sendText(env, reply);
      return;
    }

    // 存真正发出去的干净文本；模型原始输出可能带着 "[昵称 时间]" 前缀，存进去会污染后续上下文
    const finalText = sentParts.length > 0 ? sentParts.join("") : text.trim();
    if (!finalText) {
      log.warn("模型返回空内容");
      return;
    }

    const replyTs = this.#now();
    this.#deps.store.appendMessage({
      id: `bot:${env.convKey}:${replyTs}`,
      convKey: env.convKey,
      senderId: "self",
      senderName: agent.name,
      isSelf: true,
      text: finalText,
      ts: replyTs,
    });

    if (usage) {
      const costUsd = estimateCostUsd(agent.model, usage, replyTs);
      this.#deps.store.recordUsage({
        bindingId: binding.convKey,
        model: agent.model,
        tokensIn: usage.promptTokens,
        tokensOut: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        cacheHit: usage.cacheHitTokens,
        costUsd,
        ts: replyTs,
      });
      log.info(
        `完成 in=${usage.promptTokens} out=${usage.completionTokens} cache=${usage.cacheHitTokens} 花费≈${formatCny(usdToCny(costUsd))}`,
      );
    }

    recordReply(this.#state, env.convKey, env.sender.id, replyTs);

    // 记忆压缩：不阻塞当前回复，失败也不影响对话
    if (agent.summarizeAfter > 0) {
      void summarizeIfNeeded({
        store: this.#deps.store,
        provider: this.#deps.provider,
        convKey: env.convKey,
        model: agent.model,
        minMessages: agent.summarizeAfter,
        botName: agent.name,
      })
        .then((result) => {
          if (result.summarized) {
            log.info(
              `已压缩 ${result.covered} 条历史为摘要，新增 ${result.facts ?? 0} 条事实（${env.convKey}）`,
            );
          }
        })
        .catch(() => undefined);
    }
  }

  async #sendSegment(
    env: Envelope,
    agent: AgentConfig,
    text: string,
    replyTo: string | undefined,
    isFirst: boolean,
    maxChars = 120,
  ): Promise<{ text: string; blocked: boolean }> {
    // 先剥掉模仿出来的 "[昵称 时间]"，再清口头禅，最后砍超长句
    let staged = stripTranscriptPrefix(text.trim());
    // 模型偶尔会学成 "大肥鱼：xxx" 的对话格式，把名字前缀剥掉
    staged = staged.replace(new RegExp(`^${escapeRegExp(agent.name)}\\s*[：:]\\s*`), "");
    staged = staged.replace(/^(?:AI|助手|机器人)\s*[：:]\s*/, "");
    const clean = clampSegment(stripAiTells(staged), maxChars);
    if (!clean) return { text: "", blocked: false };

    // 出站安全：这句话是以用户的小号名义发出去的，不能让它带着违规内容出去
    const safety = this.#deps.safety;
    if (safety?.enabled) {
      const scan = scanText(clean, safety.words);
      if (scan.hit) {
        this.#deps.logger
          .child("safety")
          .warn(`挡下一条发言：命中「${scan.matched.join("、")}」 | ${clean.slice(0, 40)}`);
        return { text: "", blocked: true };
      }
    }

    const rng = (): number => this.#rng();
    const override = this.#deps.sendDelayMs ?? 0;
    const delay = isFirst
      ? firstReplyDelayMs(clean.length, rng)
      : override > 0
        ? override
        : segmentGapMs(clean.length, rng);

    await this.#sleep(delay);

    const result = await this.#deps.adapter.send(env.convKey, {
      segments: [clean],
      replyTo,
      // 只在第一条 @ 提问的人，连续发多条时反复 @ 很烦
      mentionUserIds: isFirst && agent.mentionSender ? [env.sender.id] : undefined,
    });

    if (result.messageId) {
      this.#lastSent.set(env.convKey, result.messageId);
    }

    return { text: clean, blocked: false };
  }

  async #sendText(env: Envelope, text: string): Promise<void> {
    const caps = this.#deps.adapter.capabilities();
    const segments = splitForChat(text, caps.maxTextLength);
    for (const segment of segments) {
      const res = await this.#deps.adapter.send(env.convKey, { segments: [segment] });
      // 命令的回复也要记，否则 /撤回 找不到它
      if (res.messageId) this.#lastSent.set(env.convKey, res.messageId);
    }
  }
}

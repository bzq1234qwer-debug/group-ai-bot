/**
 * 触发判定：决定"这条群消息要不要回"。
 *
 * 这是产品体验的分水岭。默认只回 @ 和引用，是唯一不会因为刷屏被群主踢掉的模式。
 */

import type { Envelope } from "./types.ts";

export type TriggerMode =
  | "mention"
  | "keyword"
  | "mention_or_keyword"
  | "reply"
  | "always"
  | "random"
  /** 自己判断要不要插话：不等 @，靠启发式打分 */
  | "interject";

/** 插话策略：不要求 @，但必须有理由才开口，否则会变成刷屏机器 */
export interface InterjectOptions {
  /** 基础冲动，0~1，越大越爱说话 */
  rate?: number;
  /** 命中这些话题词就加分 */
  keywords?: string[];
  /** 分数达到多少才开口，默认 1.0 */
  threshold?: number;
  questionBonus?: number;
  keywordBonus?: number;
  lengthBonus?: number;
  /** 名字被提到时加分（"大肥鱼""鱼"这类） */
  names?: string[];
  nameBonus?: number;
  /** 最近刚在这个群里说过话 —— 正在聊天，接话更自然 */
  inConversation?: boolean;
  momentumBonus?: number;
  /** 有人直接回复它说的话 */
  conversationBonus?: number;
}

export interface TriggerPolicy {
  mode: TriggerMode;
  /** keyword / mention_or_keyword 模式下的关键词 */
  keywords?: string[];
  /** random 模式的插话概率，0~1 */
  randomRate?: number;
  interject?: InterjectOptions;
  /** 同群两次回复的最短间隔（秒） */
  cooldownSec: number;
  /** 单用户每小时最多触发次数 */
  perUserPerHour: number;
  /** 免打扰时段，支持跨零点，如 ["23:00", "08:00"] */
  quietHours?: Array<[string, string]>;
  /** 以这些前缀开头的消息当作命令，不触发 */
  ignorePrefixes?: string[];
  /** 永不回复的用户 id */
  denyUsers?: string[];
}

export interface TriggerState {
  lastReplyAt: Map<string, number>;
  userCounters: Map<string, { windowStart: number; count: number }>;
}

export interface TriggerDecision {
  respond: boolean;
  reason: string;
}

export const DEFAULT_TRIGGER: TriggerPolicy = {
  mode: "mention",
  cooldownSec: 10,
  perUserPerHour: 6,
  ignorePrefixes: ["/"],
};

export function createTriggerState(): TriggerState {
  return { lastReplyAt: new Map(), userCounters: new Map() };
}

const HOUR_MS = 3_600_000;

export function minutesOfDay(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`invalid HH:mm: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 判断某个时刻是否落在免打扰区间内（区间左闭右开，支持 23:00→08:00 这种跨零点写法） */
export function inQuietHours(now: number, ranges: Array<[string, string]>): boolean {
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  for (const [start, end] of ranges) {
    const a = minutesOfDay(start);
    const b = minutesOfDay(end);
    if (a === b) continue;
    if (a < b) {
      if (cur >= a && cur < b) return true;
    } else {
      if (cur >= a || cur < b) return true;
    }
  }
  return false;
}

/** 私聊天然就是"对着它说"，不该再要求 @ */
function isPrivateConv(env: Envelope): boolean {
  return env.convKey.includes(":private:");
}

function modeMatches(
  env: Envelope,
  policy: TriggerPolicy,
  rng: () => number,
  inConversation = false,
): boolean {
  const priv = isPrivateConv(env);

  switch (policy.mode) {
    case "mention":
      return env.mentions.self || priv;
    case "keyword":
      return hasKeyword(env.text, policy.keywords);
    case "mention_or_keyword":
      return env.mentions.self || priv || hasKeyword(env.text, policy.keywords);
    case "reply":
      return env.replyTo?.senderIsSelf === true;
    case "always":
      return true;
    case "random":
      return rng() < (policy.randomRate ?? 0.05);
    case "interject":
      // 私聊不需要"插话判断"，对方就是在跟你说话
      // 被直接 @ 也是明确在叫它，必须回，不能交给概率
      if (priv || env.mentions.self || env.replyTo?.senderIsSelf === true) return true;
      return shouldInterject(env, { ...(policy.interject ?? {}), inConversation }, rng);
    default:
      return false;
  }
}

function hasKeyword(text: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => k.length > 0 && lower.includes(k.toLowerCase()));
}

/**
 * 插话打分：不问"要不要 @"，而是问"这话我有没有理由接"。
 *
 * 纯启发式，没有语义理解：问句、命中话题词、够长、@全体，各加一点分。
 * 真正的"听懂再插嘴"要让模型先做一次判断，成本翻倍，留到以后。
 */
/**
 * 中文群聊里大多数人**不打问号**。
 * 只认 `?` 会让"这个报错怎么回事"这种明显在问的话被漏掉，
 * 所以把常见疑问词也算成问句。
 */
const QUESTION_HINTS =
  /[?？]|吗|嘛|呢|吧|怎么|为什么|为啥|什么|啥|哪|谁|多少|多久|几点|是不是|能不能|有没有|要不要|行不行|可不可以|求|请问|帮我/;

/** 明确在让它说话 —— 这种再判断"要不要接"就太迟钝了 */
const IMPERATIVE_HINTS =
  /说句话|说句话呗|说话|说点什么|说点啥|来一句|来两句|讲个|讲讲|聊聊|聊两句|开个口|出声|叫一声|喊我|叫我|表演|整活|评价一下|怎么看/;

export function looksLikeQuestion(text: string): boolean {
  return QUESTION_HINTS.test(text);
}

export function looksLikeSummons(text: string): boolean {
  return IMPERATIVE_HINTS.test(text);
}

export function shouldInterject(
  env: Envelope,
  opt: InterjectOptions,
  rng: () => number,
): boolean {
  const rate = clamp01(opt.rate ?? 0.3);
  const threshold = opt.threshold ?? 0.9;
  const text = env.text.trim();

  // ── 下面几条是硬规则，不参与打分 ──
  // 加法计分在这里会出问题：动量加成能把"嗯"抬过线，刷屏也能被抬过线。

  // 纯数字/标点/表情（"666""。。。"）就是刷屏，一律不接
  if (!/[\u4e00-\u9fffA-Za-z]/.test(text)) return false;

  // 有人在回复它说过的那句 —— 这是在接着它聊，必须接
  if (env.replyTo?.senderIsSelf) return true;

  // "说句话""整活""喊我一声"——这就是在叫它
  if (looksLikeSummons(text)) return true;

  // 名字被叫到：基本就是在跟它说话
  if (opt.names?.some((n) => n.length > 0 && text.includes(n))) return true;

  const isQuestion = looksLikeQuestion(text);

  // 一两个字的应答（"嗯""哦""好"）不需要接；但"在吗"这种两字问句要接
  if (!isQuestion && text.length <= 2) return false;

  // ── 其余情况按分数判断 ──
  let score = rng() * rate * 2;
  if (isQuestion) score += opt.questionBonus ?? 0.6;
  if (hasKeyword(text, opt.keywords)) score += opt.keywordBonus ?? 0.9;
  if (text.length >= 12) score += opt.lengthBonus ?? 0.2;
  if (text.length >= 24) score += 0.1;
  if (env.mentions.all) score += 0.5;

  // 正在聊天：刚说过话的 2 分钟里，接话门槛自然更低
  if (opt.inConversation) score += opt.momentumBonus ?? 0.65;

  return score >= threshold;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * 判定顺序刻意如此：先排除绝不该回的（自己 / 黑名单 / 命令 / 免打扰），
 * 再看想不想回，最后看能不能回（冷却 / 配额）。
 */
export function evaluateTrigger(
  env: Envelope,
  policy: TriggerPolicy,
  state: TriggerState,
  now: number,
  rng: () => number = Math.random,
): TriggerDecision {
  if (env.sender.isSelf) return { respond: false, reason: "self" };

  if (policy.denyUsers?.includes(env.sender.id)) {
    return { respond: false, reason: "denied_user" };
  }

  const trimmed = env.text.trimStart();
  if (policy.ignorePrefixes?.some((p) => p.length > 0 && trimmed.startsWith(p))) {
    return { respond: false, reason: "command" };
  }

  if (policy.quietHours && policy.quietHours.length > 0 && inQuietHours(now, policy.quietHours)) {
    return { respond: false, reason: "quiet_hours" };
  }

  // 刚在这个群说过话（2 分钟内）就算"正在聊天"，接话门槛更低
  const lastForMomentum = state.lastReplyAt.get(env.convKey) ?? 0;
  const inConversation = lastForMomentum > 0 && now - lastForMomentum < 180_000;

  if (!modeMatches(env, policy, rng, inConversation)) {
    return { respond: false, reason: "no_trigger_match" };
  }

  // 冷却：防止刷屏。但"有人直接 @"是明确在叫它，用同一条 20 秒冷却挡住
  // 就是群里两个人同时说话时它彻底哑掉 —— 那看起来像"卡死了"，不像克制。
  const last = state.lastReplyAt.get(env.convKey) ?? 0;
  const directAt = env.mentions.self || isPrivateConv(env) || env.replyTo?.senderIsSelf === true;
  // 刚说完话的那几分钟里，别人接着说就是在接它的话；12 秒冷却会把正常对话卡成"它不理人"
  const cooldownSec = directAt
    ? Math.min(policy.cooldownSec, 2)
    : inConversation
      ? Math.min(policy.cooldownSec, 4)
      : policy.cooldownSec;
  if (now - last < cooldownSec * 1000) {
    return { respond: false, reason: "cooldown" };
  }

  // 人均小时配额只用在群里：它的作用是防止一个人刷屏把额度吃光。
  // 私聊里对方每一句都是在跟它说话，套这个配额就会出现"聊到一半突然不理人"——
  // 用户只会认为它坏了。私聊的花费由日预算兜底。
  // 被直接 @ 就是明确在问它：人均配额只用来防"闲聊刷屏",不该把点名提问挡掉
  if (!isPrivateConv(env) && !env.mentions.self && env.replyTo?.senderIsSelf !== true) {
    const counterKey = `${env.convKey}:${env.sender.id}`;
    const counter = state.userCounters.get(counterKey);
    if (counter && now - counter.windowStart < HOUR_MS && counter.count >= policy.perUserPerHour) {
      return { respond: false, reason: "user_hourly_quota" };
    }
  }

  return { respond: true, reason: "matched" };
}

/** 回复成功后调用，推进冷却与配额窗口 */
export function recordReply(state: TriggerState, convKey: string, senderId: string, now: number): void {
  state.lastReplyAt.set(convKey, now);

  const counterKey = `${convKey}:${senderId}`;
  const counter = state.userCounters.get(counterKey);
  if (!counter || now - counter.windowStart >= HOUR_MS) {
    state.userCounters.set(counterKey, { windowStart: now, count: 1 });
  } else {
    counter.count += 1;
  }
}

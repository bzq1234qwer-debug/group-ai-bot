/**
 * 配置控制台：给普通用户用的图形界面。
 *
 *   node tools/console.ts        # 打开 http://127.0.0.1:7799
 *
 * 它把原来"手改 config.json + 设环境变量"的流程，变成网页上点几下：
 * 加号 → 连接 → 填 Key → 选群 → 开始工作。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, readdirSync, statSync, unlinkSync, renameSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { Orchestrator, matchBinding } from "../src/orchestrator.ts";
import { OneBotAdapter } from "../src/adapters/onebot.ts";
import { DeepSeekProvider } from "../src/providers/deepseek.ts";
import { defaultAgent, type AgentConfig } from "../src/agent.ts";
import { archiveDay, dayKey, listArchivedDays, zipDay } from "../src/archive.ts";
import { createLogger } from "../src/logger.ts";
import { DEFAULT_BLOCKLIST, DEFAULT_SAFE_REPLY, parseWordList, type SafetyConfig } from "../src/safety.ts";
import { backfillConversations } from "../src/backfill.ts";
import { DEFAULT_VOICES, resolvePython, synthesize, type VoicePreset } from "../src/tts.ts";

/** 启动时锁定 python 绝对路径，避免隐藏窗口里 PATH 解析歧义 */
let pythonPath: string | undefined;

/**
 * 查一次显卡。本地情感语音（IndexTTS2）要 8G 显存，
 * 没有独显的机器装了也跑不动，所以先问清楚再引导。
 */
let gpuInfo: { name: string; vramMb: number; canRunLocal: boolean } | undefined;

async function detectGpu(): Promise<void> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "nvidia-smi",
        ["--query-gpu=name,memory.total", "--format=csv,noheader"],
        { windowsHide: true },
      );
      let out = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });

    const first = output.trim().split(/\r?\n/)[0] ?? "";
    const [name, mem] = first.split(",").map((s) => s.trim());
    const vramMb = Number.parseInt(mem ?? "", 10);
    if (name && Number.isFinite(vramMb)) {
      gpuInfo = { name, vramMb, canRunLocal: vramMb >= 7500 };
      log.info(`显卡：${name} ${Math.round(vramMb / 1024)}G，本地情感语音${gpuInfo.canRunLocal ? "可用" : "不建议"}`);
    }
  } catch {
    gpuInfo = undefined;
    log.info("没检测到 NVIDIA 显卡，本地情感语音不可用（继续用 edge 音色）");
  }
}
import { usdToCny } from "../src/cost.ts";
import type { QuotaConfig } from "../src/config.ts";
import type { Adapter, Conversation, PendingRequest, Provider } from "../src/types.ts";
import type { TriggerMode } from "../src/trigger.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "data");
const CONFIG_PATH = join(DATA_DIR, "console.json");
const DB_PATH = join(DATA_DIR, "console.db");
const BASE_PORT = Number(process.env.CONSOLE_PORT ?? 7799);
/** 本机跑只听回环；放服务器上必须显式开 0.0.0.0，并且必须配令牌 */
const LISTEN_HOST = process.env.CONSOLE_HOST ?? "127.0.0.1";
/** 访问令牌：设了就要求每个 /api 请求都带上，否则 401 */
const AUTH_TOKEN = (process.env.CONSOLE_TOKEN ?? "").trim();

// 对外监听却没设令牌 = 把账号控制权交给整个互联网。宁可起不来，也不能裸奔。
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK.has(LISTEN_HOST) && AUTH_TOKEN === "") {
  console.error("");
  console.error(`[console] 拒绝启动：监听 ${LISTEN_HOST} 但没有设置 CONSOLE_TOKEN`);
  console.error("          任何人都能打开这个端口控制你的机器人、看到你的 Key。");
  console.error("          请设置环境变量 CONSOLE_TOKEN（一串长随机字符）后重试。");
  console.error("");
  process.exit(1);
}

interface ChannelRec {
  id: string;
  label: string;
  wsUrl?: string;
  baseUrl?: string;
  token?: string;
  selfId?: string;
  eventPort?: number;
}

interface Persisted {
  channels: ChannelRec[];
  key: string;
  model: string;
  agent: {
    name: string;
    persona: string;
    /** 喜好与习惯 */
    traits: { likes: string[]; dislikes: string[]; habits: string[] };
    mode: TriggerMode;
    cooldownSec: number;
    keywords: string[];
    /** 插话积极性 0~1，越大越爱接话 */
    interjectRate: number;
    mentionSender: boolean;
    allowLeave: boolean;
    emojiDir: string;
    /** 认真模式：被 @ 的技术问题允许思考 + 长回答 */
    deep: { enabled: boolean; maxTokens: number };
  };
  bindings: Array<{ convKey: string; enabled: boolean }>;
  /** 待处理的好友申请 / 加群邀请 */
  requests: PendingRequest[];
  /** 风险确认记录；null 表示还没确认过 */
  riskAccepted?: { version: string; at: string } | null;
  /** 每日归档设置 */
  archive: {
    enabled: boolean;
    /** 每天几点归档（0~23） */
    hour: number;
    /** 保留多少天，0 = 永久保留 */
    keepDays: number;
    /** 归档完是否再打一个 zip */
    zip: boolean;
    /** 上次归档到哪一天，防止重复 */
    lastDay?: string;
  };
  /** 内容安全：入站挡话题、出站挡发言 */
  safety: {
    enabled: boolean;
    words: string[];
    reply: string;
  };
  /** 主动开口：群里安静久了，它自己说一句 */
  proactive: {
    enabled: boolean;
    /** 安静多少分钟后算"该说话了" */
    quietMin: number;
    /** 两次主动开口之间至少隔多少分钟 */
    intervalMin: number;
  };
  /** 花钱上限（元/天） */
  quota: {
    globalDailyCny: number;
    bindingDailyCny: number;
  };
  /** 语音音色预设 */
  voices: VoicePreset[];
  /** 默认用哪个音色 */
  defaultVoiceId: string;
}

/** 免责条款版本：改条款就改这个号，会重新要求确认 */
const RISK_VERSION = "1.0";

function defaultPersisted(): Persisted {
  const def = defaultAgent();
  return {
    channels: [],
    key: "",
    model: "deepseek-flash",
    agent: {
      name: def.name,
      persona: def.persona,
      traits: { ...def.traits },
      mode: "mention",
      cooldownSec: 20,
      keywords: [],
      interjectRate: 0.4,
      mentionSender: true,
      allowLeave: false,
      emojiDir: "",
      deep: { enabled: false, maxTokens: 2400 },
    },
    bindings: [],
    requests: [],
    riskAccepted: null,
    archive: { enabled: true, hour: 0, keepDays: 0, zip: true },
    safety: { enabled: true, words: [...DEFAULT_BLOCKLIST], reply: DEFAULT_SAFE_REPLY },
    proactive: { enabled: false, quietMin: 30, intervalMin: 60 },
    quota: { globalDailyCny: 20, bindingDailyCny: 5 },
    voices: DEFAULT_VOICES.map((v) => ({ ...v })),
    defaultVoiceId: "xiaoxiao",
  };
}

function loadPersisted(): Persisted {
  if (!existsSync(CONFIG_PATH)) return defaultPersisted();

  let text = "";
  try {
    // 用户可能用记事本改过这个文件 —— Windows 记事本会加 BOM，JSON.parse 会直接报错
    text = readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text) as Partial<Persisted>;
    const base = defaultPersisted();

    return {
      channels: raw.channels ?? base.channels,
      key: raw.key ?? base.key,
      model: raw.model ?? base.model,
      agent: { ...base.agent, ...(raw.agent ?? {}) },
      bindings: raw.bindings ?? base.bindings,
      requests: raw.requests ?? base.requests,
      riskAccepted: raw.riskAccepted ?? null,
      archive: { ...base.archive, ...(raw.archive ?? {}) },
      safety: { ...base.safety, ...(raw.safety ?? {}) },
      proactive: { ...base.proactive, ...(raw.proactive ?? {}) },
      quota: { ...base.quota, ...(raw.quota ?? {}) },
      voices: Array.isArray(raw.voices) && raw.voices.length > 0 ? raw.voices : base.voices,
      defaultVoiceId: raw.defaultVoiceId ?? base.defaultVoiceId,
    };
  } catch (err) {
    // 配置坏了不能让人开不了机：备份坏文件，用默认值继续启动
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[console] 配置文件读不了（${msg}），已备份并重建：${CONFIG_PATH}`);
    if (text) {
      try {
        writeFileSync(`${CONFIG_PATH}.broken-${Date.now()}`, text, "utf8");
      } catch {
        // 备份失败就算了
      }
    }
    return defaultPersisted();
  }
}

const state = loadPersisted();
mkdirSync(DATA_DIR, { recursive: true });

/**
 * 传给编排器的安全配置。必须是一个长期存在的对象，
 * 保存新词表时原地改，才能立刻生效而不用重连。
 */
const safety: SafetyConfig = {
  enabled: state.safety.enabled !== false,
  words: [...state.safety.words],
  reply: state.safety.reply || DEFAULT_SAFE_REPLY,
};

/**
 * 预算也必须是长期对象：编排器持有它的引用，
 * 改完数字立刻生效，不用重连。
 */
const quota: QuotaConfig = {
  globalDailyCny: state.quota?.globalDailyCny ?? 20,
  bindingDailyCny: state.quota?.bindingDailyCny ?? 5,
  onExceed: "notify",
};

// 启动时把默认值落盘：否则配置文件里会缺 safety/quota 这些字段，
// 排查问题时看到的文件和实际运行状态对不上
try {
  writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2), "utf8");
} catch {
  // 落盘失败不影响启动
}

const store = new Store(DB_PATH);

// 日志落盘：控制台是隐藏窗口启动的，stdout 等于扔掉，出事必须靠文件排查
const LOG_DIR = join(DATA_DIR, "logs");
mkdirSync(LOG_DIR, { recursive: true });
const today = new Date();
const LOG_FILE = join(
  LOG_DIR,
  `app-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}.log`,
);
const ARCHIVE_ROOT = join(DATA_DIR, "archive");
/** 归档天数缓存（声明必须早于任何调用点，否则会踩 TDZ） */
let archiveDaysCache: { at: number; days: Array<{ day: string; sizeKb: number }> } | null = null;
const logStream = createWriteStream(LOG_FILE, { flags: "a" });
const log = createLogger("info", "console", (line) => logStream.write(`${line}\n`));

// 启动时问一次 python 在哪：隐藏窗口里的 PATH 可能解析到应用商店的占位符
void resolvePython().then((path) => {
  pythonPath = path;
  log.info(
    path
      ? `语音引擎：python = ${path}`
      : "语音引擎：没找到可用的 python，在线音色不可用（会退回系统离线音色）",
  );
});

void detectGpu();

// 补归档：如果 04:00 那时电脑是关的，那天的记录就会被漏掉。
// 启动时把最近 7 天里缺的补上，没有消息的就不生成空目录。
backfillArchive(7);

// 老会话没有名字：私聊用对方最近一次的昵称补上，界面不能只显示一串数字
try {
  for (const conv of store.recentConversations(200)) {
    if (store.getConversationTitle(conv.convKey)) continue;
    const name = store.latestSenderName(conv.convKey);
    if (name) store.setConversationTitle(conv.convKey, name, Date.now());
  }
} catch {
  // 补名字失败不影响启动
}

// 只留最近 7 天的日志，避免无限膨胀
try {
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  for (const file of readdirSync(LOG_DIR)) {
    if (!/^app-\d{8}\.log$/.test(file)) continue;
    const full = join(LOG_DIR, file);
    if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
  }
} catch {
  // 清理失败不影响启动
}

log.info("控制台启动");

interface Runtime {
  adapter: Adapter;
  orchestrator: Orchestrator;
  /** 与编排器共享同一个数组：绑定变化时原地改，避免重启连接 */
  bindings: Array<{ convKey: string; agentId: string; enabled: boolean }>;
  /** 与编排器共享同一个 Map：改人设时原地换，不用断线重连 */
  agents: Map<string, AgentConfig>;
  groups: Conversation[];
  status: "offline" | "connecting" | "online" | "error";
  error?: string;
  /** 最近一次探活是否成功 */
  lastPingOk?: boolean;
  /** 连续探活失败次数，两次判掉线 */
  failCount: number;
  /** 最近一条平台通知（撤回 / 禁言 / 被踢） */
  lastNotice?: { kind: string; message: string; at: number };
}

const runtimes = new Map<string, Runtime>();

// 每 30 秒探活一次：WebSocket 连着不代表 QQ 还在线
setInterval(() => {
  for (const rt of runtimes.values()) {
    if (!rt.adapter.ping) continue;
    void rt.adapter
      .ping()
      .then((ok) => {
        rt.lastPingOk = ok;
        if (ok) {
          rt.failCount = 0;
          rt.status = "online";
        } else {
          rt.failCount += 1;
          if (rt.failCount >= 2) rt.status = "offline";
        }
      })
      .catch(() => undefined);
  }
}, 30_000);

function save(): void {
  // 先写临时文件再原子替换：进程在写一半时被杀，原文件还是完整的，
  // 不会变成半截 JSON 导致下次启动配置被重置
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, CONFIG_PATH);
}

/** 合成一段语音；在线引擎失败就换另一个引擎兜底，宁可声音换个，也别哑掉 */
/** 先试独立子进程，再退回进程内合成 */
async function synthesizeOutOfProcess(
  text: string,
  preset: VoicePreset,
): Promise<{ file: string; engine: string } | undefined> {
  const dir = join(DATA_DIR, "voice");
  mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const presetPath = join(dir, `preset-${stamp}.json`);
  const textPath = join(dir, `text-${stamp}.txt`);
  writeFileSync(presetPath, JSON.stringify(preset), "utf8");
  writeFileSync(textPath, text, "utf8");

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [join(HERE, "tts-cli.ts"), presetPath, textPath, dir],
        { windowsHide: true, cwd: join(HERE, "..") },
      );

      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (err += d.toString()));

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("合成子进程超时"));
      }, 40_000);

      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(err.slice(-300) || `退出码 ${code}`));
      });
    });

    const parsed = JSON.parse(output.trim().split(/\r?\n/).pop() ?? "{}") as {
      file?: string;
      engine?: string;
    };
    if (parsed.file) return { file: parsed.file, engine: parsed.engine ?? preset.engine };
  } catch (err) {
    log.warn(`独立进程合成失败（${preset.name}）：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(presetPath, { force: true });
    rmSync(textPath, { force: true });
  }
  return undefined;
}

/** 直接合成，不做兜底链（preview 用，行为和诊断端点完全一致） */
async function speakToFileInline(text: string, preset: VoicePreset): Promise<string | undefined> {
  const viaChild = await synthesizeOutOfProcess(text, preset);
  if (viaChild) return viaChild.file;

  try {
    const result = await synthesize(text, preset, {
      outDir: join(DATA_DIR, "voice"),
      python: pythonPath,
    });
    return result.file;
  } catch (err) {
    log.warn(`preview 合成失败（${preset.name}）：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function synthToFile(text: string, preset: VoicePreset): Promise<string | undefined> {
  const options = { outDir: join(DATA_DIR, "voice"), python: pythonPath };
  log.info(
    `[语音] 合成 preset=${preset.id} engine=${preset.engine} voice=${preset.voice ?? "-"} len=${text.length} python=${pythonPath ?? "-"}`,
  );

  try {
    const result = await synthesize(text, preset, options);
    return result.file;
  } catch (err) {
    log.warn(`语音合成失败（${preset.name}）：${err instanceof Error ? err.message : String(err)}`);
  }

  // 实测同一个调用偶发空音频（引擎初始化竞争），隔一会儿重试一次基本都能过
  await new Promise((r) => setTimeout(r, 400));
  try {
    const result = await synthesize(text, preset, options);
    log.info(`重试成功：${preset.name}`);
    return result.file;
  } catch (err) {
    log.warn(`重试仍失败（${preset.name}）：${err instanceof Error ? err.message : String(err)}`);
  }

  // 兜底：优先用另一类引擎。edge 明显比系统 SAPI 稳，所以 sapi 失败反而要回到 edge
  const fallback = state.voices.find((v) => v.engine !== preset.engine && v.engine === "edge")
    ?? state.voices.find((v) => v.engine !== preset.engine);

  if (fallback) {
    try {
      const result = await synthesize(text, fallback, options);
      log.info(`已换用兜底音色：${fallback.name}`);
      return result.file;
    } catch (err) {
      log.warn(`兜底音色也失败了：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return undefined;
}

/** 前端传的是逗号分隔字符串，也接受数组 */
function parseTraits(raw: unknown): { likes: string[]; dislikes: string[]; habits: string[] } | undefined {
  if (raw === null || raw === undefined) return undefined;
  const obj = raw as Record<string, unknown>;
  const list = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (typeof v === "string") return v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    return [];
  };
  return { likes: list(obj.likes), dislikes: list(obj.dislikes), habits: list(obj.habits) };
}

function buildAgent(): AgentConfig {
  const base = defaultAgent();
  const keywords = state.agent.keywords.filter((k) => k.length > 0);

  // 名字（含常见简称）被叫到时就基本是在跟它说话
  const name = state.agent.name || base.name;
  const aliases = new Set<string>([name]);
  if (name.includes("肥鱼")) {
    aliases.add("大肥鱼");
    aliases.add("肥鱼");
    aliases.add("鱼");
  }

  return {
    ...base,
    name,
    persona: state.agent.persona || base.persona,
    traits: state.agent.traits ?? base.traits,
    model: state.model,
    maxContextTokens: 24_000,
    mentionSender: state.agent.mentionSender !== false,
    allowRecall: true,
    allowLeave: state.agent.allowLeave === true,
    emojiDir: state.agent.emojiDir || undefined,
    deep: {
      enabled: state.agent.deep?.enabled === true,
      maxTokens: state.agent.deep?.maxTokens ?? 2400,
    },
    trigger: {
      mode: state.agent.mode,
      keywords,
      cooldownSec: state.agent.cooldownSec,
      perUserPerHour: 10,
      ignorePrefixes: ["/"],
      interject:
        state.agent.mode === "interject"
          ? {
              rate: state.agent.interjectRate ?? 0.4,
              keywords,
              names: [...aliases],
              threshold: 0.85,
            }
          : undefined,
    },
  };
}

/**
 * Provider 代理：每次调用都按"当前"的 Key/模型创建一个新的 provider。
 *
 * 编排器是在连号时创建一次、长期存活的。如果直接把 provider 实例塞进去，
 * 用户改了 Key 就得重连才生效 —— 而且旧 provider 会一直报"没填 Key"。
 * 换成代理后，改 Key 立刻生效。
 */
const providerProxy: Provider = {
  get id(): string {
    return provider().id;
  },
  listModels: () => provider().listModels(),
  chat: (req) => provider().chat(req),
};
function provider(): Provider {
  if (!state.key) {
    // 没填 Key 也要能把号连上，否则用户第一步就卡住
    return {
      id: "none",
      async listModels() {
        return [];
      },
      async *chat() {
        throw new Error("还没有填写 DeepSeek API Key，去第 ④ 步填一下");
      },
    };
  }
  return new DeepSeekProvider({ apiKey: state.key, defaultModel: state.model });
}

function nextEventPort(): number {
  let port = 3001;
  const used = new Set(state.channels.map((c) => c.eventPort));
  while (used.has(port)) port += 1;
  return port;
}

/**
 * 把 "/语音 [音色] 文本" 解析成音频文件。
 * 音色名可以省略；写了就按名字或 id 匹配，长的优先（避免「晓晓」被「晓」抢先）。
 */
/** 归档完顺手打个 zip；失败不影响归档本身 */
function maybeZipDay(day: string): void {
  archiveDaysCache = null;
  if (state.archive.zip !== true) return;
  try {
    const packed = zipDay(ARCHIVE_ROOT, day);
    if (packed) log.info(`已打包 ${day}.zip（${packed.entries} 个文件）`);
  } catch (err) {
    log.warn(`打包 ${day}.zip 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 归档天数缓存：UI 每 5 秒轮询一次，不能每次都把目录树走一遍 */
function archivedDays(): Array<{ day: string; sizeKb: number }> {
  const now = Date.now();
  if (archiveDaysCache && now - archiveDaysCache.at < 60_000) return archiveDaysCache.days;
  const days = listArchivedDays(ARCHIVE_ROOT).slice(0, 14);
  archiveDaysCache = { at: now, days };
  return days;
}
/** 补归档：把最近 N 天里还没归档的日期补齐（关机/漏跑都会造成缺口） */
function backfillArchive(days: number): void {
  for (let i = 1; i <= days; i += 1) {
    const day = new Date();
    day.setDate(day.getDate() - i);
    const key = dayKey(day);
    if (existsSync(join(ARCHIVE_ROOT, key))) continue;

    try {
      const result = archiveDay({
        store,
        root: ARCHIVE_ROOT,
        day,
        keepDays: state.archive.keepDays,
        titles: store.conversationTitles(),
      });

      if (result.messages > 0) {
        log.info(`补归档 ${key}：${result.conversations} 个会话 / ${result.messages} 条消息`);
        maybeZipDay(result.day);
      } else {
        // 那天本来就没聊天：空目录和可能的空 zip 都别留
        rmSync(result.dir, { recursive: true, force: true });
        rmSync(join(ARCHIVE_ROOT, `${key}.zip`), { force: true });
      }
    } catch (err) {
      log.warn(`补归档 ${key} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function speakText(arg: string): Promise<string | undefined> {
  const voices = state.voices ?? [];
  if (voices.length === 0) return undefined;

  let preset = voices.find((v) => v.id === state.defaultVoiceId) ?? voices[0]!;
  let text = arg.trim();

  const candidates = voices
    .flatMap((v) => [
      { preset: v, key: v.name.trim() },
      { preset: v, key: v.id.trim() },
    ])
    .filter((c) => c.key.length > 0)
    .sort((a, b) => b.key.length - a.key.length);

  for (const { preset: p, key } of candidates) {
    if (text === key) {
      preset = p;
      text = "";
      break;
    }
    if (text.startsWith(`${key} `)) {
      preset = p;
      text = text.slice(key.length).trim();
      break;
    }
  }

  if (!text) return undefined;
  return synthToFile(text, preset);
}

async function connectChannel(rec: ChannelRec): Promise<Runtime> {  const adapter = new OneBotAdapter({
    channelId: rec.id,
    baseUrl: rec.baseUrl ?? "http://127.0.0.1:3000",
    token: rec.token,
    selfId: rec.selfId,
    eventPort: rec.eventPort ?? nextEventPort(),
    eventPath: "/onebot/events",
    wsUrl: rec.wsUrl,
  });

  // 这个数组会被编排器持有引用，绑定变化时原地改即可生效
  const bindings = state.bindings
    .filter((b) => b.convKey.startsWith(`${rec.id}:`))
    .map((b) => ({ convKey: b.convKey, agentId: "default", enabled: b.enabled }));

  const agents = new Map<string, AgentConfig>([["default", buildAgent()]]);

  const orchestrator = new Orchestrator({
    adapter,
    provider: providerProxy,
    store,
    agents,
    bindings,
    quota,
    safety,
    speak: speakText,
    logger: log,
    sendDelayMs: 0,
  });

  adapter.onMessage((env) => {
    void orchestrator.handleEnvelope(env);
  });

  // 好友申请 / 加群邀请：只登记，等人在界面上点同意
  adapter.onRequest?.((request) => {
    if (!state.requests.some((r) => r.id === request.id)) {
      state.requests.push(request);
      save();
      log.info(`收到申请 kind=${request.kind} user=${request.userId} comment=${request.comment ?? ""}`);
    }
  });

  const runtime: Runtime = {
    adapter,
    orchestrator,
    bindings,
    agents,
    groups: [],
    status: "connecting",
    failCount: 0,
  };

  // 断线期间的消息平台上还在，重连后补回来 —— 只入库，不回复
  const runBackfill = async (): Promise<void> => {
    const keys = store
      .recentConversations(30)
      .map((c) => c.convKey)
      .filter((k) => k.startsWith(`${rec.id}:`));
    if (keys.length === 0) return;

    const result = await backfillConversations({ store, adapter, convKeys: keys, count: 20 }).catch(
      () => ({ added: 0, scanned: 0 }),
    );
    if (result.added > 0) {
      log.info(`断线补拉：补回 ${result.added} 条消息（扫了 ${result.scanned} 条）`);
    }
  };

  // 撤回 / 禁言 / 被踢：既要让编排器知道，也要让界面看得见
  adapter.onNotice?.((notice) => {
    log.info(`通知[${notice.kind}] ${notice.message}`);
    runtime.lastNotice = { kind: notice.kind, message: notice.message, at: Date.now() };
    void orchestrator.handleNotice(notice);

    // 重连成功后补一次
    if (notice.kind === "online") void runBackfill();
  });

  try {
    await adapter.start();
    runtime.status = "online";
    runtime.groups = await adapter.listConversations().catch(() => []);
    // 群名存下来，界面上不能只显示 conv key
    for (const conv of runtime.groups) {
      if (conv.title) store.setConversationTitle(conv.key, conv.title, Date.now());
    }
    // 连上之后立刻探一次活，确认 QQ 真的在线（而不只是 WS 通了）
    runtime.lastPingOk = await adapter.ping?.().catch(() => false);
    log.info(`通道已连接 ${rec.id} ping=${runtime.lastPingOk}`);

    // 启动时也补一次：可能上次是关机/崩溃退出的
    void runBackfill();
  } catch (err) {
    runtime.status = "error";
    runtime.error = err instanceof Error ? err.message : String(err);
    log.error(`通道连接失败 ${rec.id}`, runtime.error);
  }

  runtimes.set(rec.id, runtime);
  return runtime;
}

// --------------------------------------------------------------------- HTTP

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleState(res: ServerResponse): Promise<void> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const spentUsd = store.costSince(dayStart.getTime());

  json(res, 200, {
    channels: state.channels.map((c) => {
      const rt = runtimes.get(c.id);
      return {
        ...c,
        status: rt?.status ?? "offline",
        lastPingOk: rt?.lastPingOk,
        error: rt?.error,
        lastNotice: rt?.lastNotice,
        eventUrl: c.wsUrl ? undefined : `http://127.0.0.1:${c.eventPort ?? 3001}/onebot/events`,
        groupCount: rt?.groups.length ?? 0,
      };
    }),
    agent: state.agent,
    model: state.model,
    keySet: state.key.length > 0,
    usage: { todayCny: usdToCny(spentUsd) },
    bindings: state.bindings,
    requests: state.requests,
    risk: {
      version: RISK_VERSION,
      accepted: state.riskAccepted?.version === RISK_VERSION ? state.riskAccepted : null,
    },
    archive: {
      ...state.archive,
      root: ARCHIVE_ROOT,
      days: archivedDays(),
    },
    facts: store.listAllFacts(100),
    titles: store.conversationTitles(),
    safety: state.safety,
    proactive: state.proactive,
    quota: { ...state.quota, spentToday: usdToCny(spentUsd) },
    voices: state.voices,
    defaultVoiceId: state.defaultVoiceId,
    gpu: gpuInfo ?? null,
  });
}

async function handleAddChannel(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const label = String(body.label ?? "").trim() || "我的小号";
  const wsUrl = String(body.wsUrl ?? "").trim();
  const baseUrl = String(body.baseUrl ?? "").trim();
  const selfId = String(body.selfId ?? "").trim();
  const token = String(body.token ?? "").trim();

  if (!wsUrl && !baseUrl) {
    json(res, 400, { error: "至少填一个：WebSocket 地址 或 HTTP 地址" });
    return;
  }

  const id = `qq:${selfId || Date.now().toString().slice(-6)}`;
  if (state.channels.some((c) => c.id === id)) {
    json(res, 400, { error: "这个号已经加过了" });
    return;
  }

  const rec: ChannelRec = {
    id,
    label,
    wsUrl: wsUrl || undefined,
    baseUrl: baseUrl || "http://127.0.0.1:3000",
    token: token || undefined,
    selfId: selfId || undefined,
    eventPort: wsUrl ? undefined : nextEventPort(),
  };

  state.channels.push(rec);
  save();

  const rt = await connectChannel(rec);
  json(res, 200, {
    id: rec.id,
    status: rt.status,
    error: rt.error,
    eventUrl: rec.wsUrl ? undefined : `http://127.0.0.1:${rec.eventPort}/onebot/events`,
  });
}

async function handleGroups(id: string, res: ServerResponse): Promise<void> {
  const rt = runtimes.get(id);
  if (!rt) {
    json(res, 404, { error: "号不在线" });
    return;
  }
  const bound = new Set(state.bindings.map((b) => b.convKey));

  const groups = rt.groups.map((g) => ({
    convKey: g.key,
    title: g.title ?? g.externalId,
    memberCount: g.memberCount ?? null,
    kind: "group" as const,
    bound: bound.has(g.key),
  }));

  // 私聊会话不在 get_group_list 里，只能从消息记录里捞出来
  const known = new Set(groups.map((g) => g.convKey));
  const titles = store.conversationTitles();
  const extras = store
    .recentConversations(100)
    .filter((c) => c.convKey.startsWith(`${id}:`) && !known.has(c.convKey))
    .map((c) => {
      const isPrivate = c.convKey.includes(":private:");
      const fallback = isPrivate ? `私聊 ${c.convKey.split(":").pop()}` : c.convKey;
      return {
        convKey: c.convKey,
        title: titles[c.convKey] ?? fallback,
        memberCount: null,
        kind: isPrivate ? ("private" as const) : ("group" as const),
        bound: bound.has(c.convKey),
      };
    });

  json(res, 200, [...groups, ...extras]);
}

function syncBindings(channelId: string): void {
  const rt = runtimes.get(channelId);
  if (!rt) return;
  const next = state.bindings
    .filter((b) => b.convKey.startsWith(`${channelId}:`))
    .map((b) => ({ convKey: b.convKey, agentId: "default", enabled: b.enabled }));
  rt.bindings.length = 0;
  rt.bindings.push(...next);
}

async function handleMessages(convKey: string, res: ServerResponse): Promise<void> {
  const rows = store.recentMessages(convKey, 30);
  json(res, 200, rows.map((r) => ({ sender: r.senderName, text: r.text, ts: r.ts, self: r.isSelf })));
}

const NAPCAT_DIR = process.env.NAPCAT_DIR ?? "C:\\napcat";

/** 找 QQ 装在哪 */
function findQq(): string | undefined {
  const candidates = [
    "C:\\Program Files\\Tencent\\QQNT\\QQ.exe",
    "C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Tencent\\QQNT\\QQ.exe`,
  ];
  return candidates.find((p) => p.length > 12 && existsSync(p));
}

/** 端口有没有人在听 */
function portOpen(port: number, host = "127.0.0.1", timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 当前平台是不是 Windows：Windows 走"本机注入"，服务器走容器 */
const IS_WINDOWS = process.platform === "win32";

/** NapCat 通不通：优先按已配置通道的 wsUrl 去探（服务器上 host 是 napcat 而不是 127.0.0.1） */
async function napcatReachable(): Promise<boolean> {
  const wsUrl = state.channels[0]?.wsUrl;
  if (wsUrl) {
    try {
      const u = new URL(wsUrl);
      const port = Number(u.port || (u.protocol === "wss:" ? 443 : 80));
      return await portOpen(port, u.hostname);
    } catch {
      // URL 不合法就退回默认端口
    }
  }
  return portOpen(3001);
}

/** 首次使用的自检：告诉界面上缺什么、点哪里 */
async function handleHealth(res: ServerResponse): Promise<void> {
  const napcatInstalled = existsSync(`${NAPCAT_DIR}\\launcher.bat`);
  const napcatRunning = await napcatReachable();
  const qqPath = findQq();
  const anyOnline = [...runtimes.values()].some((rt) => rt.status === "online");

  const baseSteps = IS_WINDOWS
    ? [
        {
          id: "qq",
          title: "安装 QQ（桌面版）",
          detail: qqPath ?? "没找到 QQ.exe，NapCat 需要它才能注入",
          ok: Boolean(qqPath),
          action: qqPath ? null : "download-qq",
        },
        {
          id: "napcat",
          title: "安装 NapCat",
          detail: napcatInstalled ? `已找到 ${NAPCAT_DIR}` : `没有找到 ${NAPCAT_DIR}\\launcher.bat`,
          ok: napcatInstalled,
          action: napcatInstalled ? null : "install-napcat",
        },
        {
          id: "napcat-run",
          title: "启动 NapCat（并注入 QQ）",
          detail: napcatRunning ? "端口已监听" : "还没启动",
          ok: napcatRunning,
          action: napcatRunning ? null : "start-napcat",
        },
      ]
    : [
        {
          id: "qq",
          title: "QQ 客户端",
          detail: "服务器模式：由容器镜像自带",
          ok: true,
          action: null,
        },
        {
          id: "napcat",
          title: "NapCat",
          detail: "服务器模式：由 docker compose 管理",
          ok: true,
          action: null,
        },
        {
          id: "napcat-run",
          title: "连接 NapCat",
          detail: napcatRunning ? "端口已通" : "连不上，检查容器是否在跑",
          ok: napcatRunning,
          action: napcatRunning ? null : "start-napcat",
        },
      ];

  const rest = [
    {
      id: "channel",
      title: "登录你的小号",
      detail: anyOnline ? "已有一个号在线" : state.channels.length ? "已添加，但没连上" : "还没有添加号",
      ok: anyOnline,
      action: anyOnline ? null : state.channels.length ? "restart-channel" : "add-channel",
    },
    {
      id: "key",
      title: "填 DeepSeek 密钥",
      detail: state.key ? "已填写" : "没填的话它不会说话",
      ok: state.key.length > 0,
      action: state.key ? null : "focus-key",
    },
    {
      id: "binding",
      title: "选一个群或私聊",
      detail: state.bindings.length ? `已启用 ${state.bindings.length} 个会话` : "还没选，它现在只会记录不会回",
      ok: state.bindings.length > 0,
      action: state.bindings.length ? null : "focus-groups",
    },
  ];

  const steps = [...baseSteps, ...rest];

  const allOk = steps.every((s) => s.ok);
  json(res, 200, {
    allOk,
    steps,
    env: {
      node: process.version,
      napcatDir: NAPCAT_DIR,
      napcatInstalled,
      napcatRunning,
      port: BASE_PORT,
    },
  });
}

/** 由控制台代劳启动 NapCat（省得用户去双击 bat） */
async function handleStartNapcat(res: ServerResponse): Promise<void> {
  if (!existsSync(`${NAPCAT_DIR}\\launcher.bat`)) {
    json(res, 400, { error: `没有找到 ${NAPCAT_DIR}\\launcher.bat` });
    return;
  }
  if (await portOpen(3001)) {
    json(res, 200, { ok: true, already: true });
    return;
  }

  const uin = state.channels[0]?.selfId;
  const args = uin ? [uin] : [];

  try {
    const child = spawn("cmd.exe", ["/c", "launcher.bat", ...args], {
      cwd: NAPCAT_DIR,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** 自动下载并解压 NapCat（交给 PowerShell 做，Node 不擅长解 zip） */
async function handleInstallNapcat(res: ServerResponse): Promise<void> {
  if (existsSync(`${NAPCAT_DIR}\\launcher.bat`)) {
    json(res, 200, { ok: true, already: true });
    return;
  }

  const script = [
    "$ErrorActionPreference='Stop'",
    "$tmp = Join-Path $env:TEMP 'napcat-shell.zip'",
    "Invoke-WebRequest -Uri 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip' -OutFile $tmp -UseBasicParsing -TimeoutSec 1800",
    `New-Item -ItemType Directory -Force '${NAPCAT_DIR}' | Out-Null`,
    `Expand-Archive -Path $tmp -DestinationPath '${NAPCAT_DIR}' -Force`,
    "Remove-Item $tmp -Force",
  ].join("; ");

  try {
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    json(res, 202, { started: true });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function tailFile(path: string, lines: number): string {
  try {
    const arr = readFileSync(path, "utf8").split(/\r?\n/);
    return arr.slice(Math.max(0, arr.length - lines)).join("\n");
  } catch {
    return `(读不到 ${path})`;
  }
}

function latestNapcatLog(): string | undefined {
  try {
    const files = readdirSync(NAPCAT_DIR).filter((f) => /^run\d*\.log$/.test(f));
    if (files.length === 0) return undefined;
    return files
      .map((f) => `${NAPCAT_DIR}\\${f}`)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

/** 把日志和环境信息打成一个 txt，用户发给你就能排查（不含 Key） */
async function handleExportLogs(res: ServerResponse): Promise<void> {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const dir = join(DATA_DIR, "exports");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `diagnose-${stamp}.txt`);

  const lines: string[] = [];
  lines.push("=== 群聊 AI 诊断包 ===");
  lines.push(`导出时间: ${now.toLocaleString()}`);
  lines.push(`Node: ${process.version}  ${process.platform}/${process.arch}`);
  lines.push(`控制台端口: ${BASE_PORT}`);
  lines.push("");

  lines.push("=== 通道（token 已隐藏）===");
  if (state.channels.length === 0) lines.push("(还没有号)");
  for (const c of state.channels) {
    const st = runtimes.get(c.id)?.status ?? "offline";
    lines.push(`${c.id}  ${c.label}  状态=${st}  ws=${c.wsUrl ?? "-"}`);
  }
  lines.push(`API Key: ${state.key ? `已填写（${state.key.length} 字符）` : "未填写"}`);
  lines.push(`绑定会话: ${state.bindings.length} 个`);
  lines.push(`待处理申请: ${state.requests.length} 个`);
  lines.push("");

  lines.push("=== 应用日志（最近 300 行）===");
  lines.push(tailFile(LOG_FILE, 300));
  lines.push("");

  const nap = latestNapcatLog();
  lines.push(`=== NapCat 日志（${nap ?? "未找到"}，最近 200 行）===`);
  lines.push(nap ? tailFile(nap, 200) : "(无)");

  // NapCat 启动日志里会打 WebUI token，导出前必须抹掉
  const text = lines
    .join("\n")
    .replace(/([Tt]oken[:：=]\s*)([A-Za-z0-9_\-]{6,})/g, "$1***")
    .replace(/(access_token=)([^&\s]+)/g, "$1***");

  writeFileSync(out, text, "utf8");
  log.info(`导出诊断包 -> ${out}`);
  json(res, 200, { ok: true, path: out });
}

// 每天定时归档：到点就把昨天写成分文件夹的聊天记录
setInterval(() => {
  if (!state.archive.enabled) return;

  const now = new Date();
  if (now.getHours() < state.archive.hour) return;

  // 只归档'昨天'的话，连着开机跨多天会漏，先把缺的补齐
  backfillArchive(7);

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const key = dayKey(yesterday);
  if (state.archive.lastDay === key) return;

  try {
    const result = archiveDay({
      store,
      root: ARCHIVE_ROOT,
      day: yesterday,
      keepDays: state.archive.keepDays,
      titles: store.conversationTitles(),
    });
    maybeZipDay(result.day);
    state.archive.lastDay = key;
    save();
    log.info(`自动归档 ${key}：${result.conversations} 个会话 / ${result.messages} 条`);
  } catch (err) {
    log.error("自动归档失败", err instanceof Error ? err.message : err);
  }
}, 10 * 60_000);

// 主动开口：每分钟看一次，群里安静够久就自己说一句
const proactiveLast = new Map<string, number>();

setInterval(() => {
  if (state.proactive?.enabled !== true) return;
  const now = Date.now();

  for (const [channelId, rt] of runtimes) {
    if (rt.status !== "online") continue;
    const agent = rt.agents.get("default");
    if (!agent) continue;

    // 群列表接口在 NapCat 上时好时坏，返回 0 就永远不开口。
    // 所以两路都要：接口给的群 + 我们自己记过消息的群。
    const convKeys = new Set<string>();
    for (const conv of rt.groups) convKeys.add(conv.key);
    for (const conv of store.recentConversations(50)) {
      if (conv.convKey.startsWith(`${channelId}:`) && conv.convKey.includes(":group:")) {
        convKeys.add(conv.convKey);
      }
    }

    for (const convKey of convKeys) {
      if (!state.bindings.some((b) => b.enabled && matchBinding(b, convKey))) continue;

      const last = store.lastMessageTs(convKey);
      if (last === 0) continue;
      if (now - last < state.proactive.quietMin * 60_000) continue;
      if (now - (proactiveLast.get(convKey) ?? 0) < state.proactive.intervalMin * 60_000) continue;

      proactiveLast.set(convKey, now);
      void rt.orchestrator
        .speakProactively(convKey, agent, state.proactive.quietMin)
        .catch(() => undefined);
    }
  }
}, 60_000);
const server = createServer((req, res) => {
  void route(req, res).catch((err: unknown) => {
    json(res, 500, { error: err instanceof Error ? err.message : "内部错误" });
  });
});

function authorized(req: IncomingMessage, url: URL): boolean {
  if (AUTH_TOKEN === "") return true;
  const header = req.headers["x-auth-token"];
  if (typeof header === "string" && header === AUTH_TOKEN) return true;
  return url.searchParams.get("token") === AUTH_TOKEN;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  // 放了令牌就挡住所有接口；HTML 本身不含机密，可以放行（前端会要求输入令牌）
  if (path.startsWith("/api/") && !authorized(req, url)) {
    json(res, 401, { error: "需要访问令牌" });
    return;
  }

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(HERE, "console.html"), "utf8"));
    return;
  }

  if (req.method === "GET" && path === "/api/state") return handleState(res);

  if (req.method === "GET" && path === "/api/health") return handleHealth(res);
  if (req.method === "POST" && path === "/api/napcat/start") return handleStartNapcat(res);
  if (req.method === "POST" && path === "/api/napcat/install") return handleInstallNapcat(res);  if (req.method === "POST" && path === "/api/logs/export") return handleExportLogs(res);

  if (req.method === "POST" && path === "/api/risk/accept") {
    state.riskAccepted = { version: RISK_VERSION, at: new Date().toISOString() };
    save();
    log.info("用户已确认风险条款");
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/api/channels") {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    return handleAddChannel(body, res);
  }

  if (req.method === "DELETE" && path.startsWith("/api/channels/")) {
    const id = decodeURIComponent(path.slice("/api/channels/".length));
    const rt = runtimes.get(id);
    if (rt) {
      await rt.adapter.stop();
      runtimes.delete(id);
    }
    state.channels = state.channels.filter((c) => c.id !== id);
    state.bindings = state.bindings.filter((b) => !b.convKey.startsWith(`${id}:`));
    save();
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && path === "/api/groups") {
    return handleGroups(url.searchParams.get("channel") ?? "", res);
  }

  if (req.method === "GET" && path === "/api/messages") {
    return handleMessages(url.searchParams.get("convKey") ?? "", res);
  }

  if (req.method === "POST" && path === "/api/requests/respond") {
    const body = JSON.parse(await readBody(req)) as { id?: string; approve?: boolean };
    const item = state.requests.find((r) => r.id === body.id);
    if (!item) {
      json(res, 404, { error: "这个申请已处理或不存在" });
      return;
    }
    const rt = runtimes.get(item.channelId);
    if (!rt?.adapter.respondRequest) {
      json(res, 400, { error: "当前通道不支持处理申请" });
      return;
    }
    try {
      await rt.adapter.respondRequest(item, body.approve === true);
      state.requests = state.requests.filter((r) => r.id !== item.id);
      save();
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "POST" && path === "/api/archive/run") {
    const body = JSON.parse(await readBody(req).catch(() => "{}")) as { day?: string };
    const day = body.day ? new Date(`${body.day}T12:00:00`) : new Date(Date.now() - 86400_000);
    const result = archiveDay({
      store,
      root: ARCHIVE_ROOT,
      day,
      keepDays: state.archive.keepDays,
      titles: store.conversationTitles(),
    });
    maybeZipDay(result.day);
    archiveDaysCache = null;
    log.info(`手动归档 ${result.day}：${result.conversations} 个会话 / ${result.messages} 条`);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && path === "/api/archive/config") {
    const body = JSON.parse(await readBody(req)) as {
      enabled?: boolean;
      hour?: number;
      keepDays?: number;
      zip?: boolean;
    };
    if (typeof body.enabled === "boolean") state.archive.enabled = body.enabled;
    if (typeof body.hour === "number") state.archive.hour = Math.max(0, Math.min(23, Math.floor(body.hour)));
    if (typeof body.keepDays === "number") state.archive.keepDays = Math.max(0, Math.floor(body.keepDays));
    if (typeof body.zip === "boolean") state.archive.zip = body.zip;
    save();
    json(res, 200, { ok: true, archive: state.archive });
    return;
  }

  if (req.method === "POST" && path === "/api/facts/delete") {
    const body = JSON.parse(await readBody(req)) as { id?: number };
    const ok = typeof body.id === "number" && store.deleteFact(body.id);
    if (ok) log.info(`删除事实 #${body.id}`);
    json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "这条记忆不存在或已删除" });
    return;
  }

  if (req.method === "POST" && path === "/api/safety") {
    const body = JSON.parse(await readBody(req)) as {
      enabled?: boolean;
      words?: string | string[];
      reply?: string;
    };

    if (typeof body.enabled === "boolean") {
      state.safety.enabled = body.enabled;
      safety.enabled = body.enabled;
    }
    if (body.words !== undefined) {
      const words = parseWordList(body.words);
      state.safety.words = words;
      safety.words = [...words];
    }
    if (typeof body.reply === "string" && body.reply.trim()) {
      state.safety.reply = body.reply.trim();
      safety.reply = body.reply.trim();
    }

    save();
    log.info(`内容安全已更新：${state.safety.enabled ? "开启" : "关闭"}，${state.safety.words.length} 个词`);
    json(res, 200, { ok: true, safety: state.safety });
    return;
  }

  if (req.method === "POST" && path === "/api/quota") {
    const body = JSON.parse(await readBody(req)) as {
      globalDailyCny?: number;
      bindingDailyCny?: number;
    };

    if (typeof body.globalDailyCny === "number" && body.globalDailyCny >= 0) {
      state.quota.globalDailyCny = body.globalDailyCny;
      quota.globalDailyCny = body.globalDailyCny;
    }
    if (typeof body.bindingDailyCny === "number" && body.bindingDailyCny >= 0) {
      state.quota.bindingDailyCny = body.bindingDailyCny;
      quota.bindingDailyCny = body.bindingDailyCny;
    }

    save();
    log.info(
      `预算已更新：全局 ¥${state.quota.globalDailyCny}/天，单群 ¥${state.quota.bindingDailyCny}/天`,
    );
    json(res, 200, { ok: true, quota: state.quota });
    return;
  }

  if (req.method === "POST" && path === "/api/voices") {
    const body = JSON.parse(await readBody(req)) as {
      voices?: VoicePreset[];
      defaultVoiceId?: string;
    };

    if (Array.isArray(body.voices)) {
      state.voices = body.voices
        .filter((v) => v && typeof v.id === "string" && typeof v.name === "string")
        .map((v) => ({
          id: String(v.id).slice(0, 40),
          name: String(v.name).slice(0, 40),
          engine:
            v.engine === "sapi" || v.engine === "custom" || v.engine === "http"
              ? v.engine
              : "edge",
          voice: typeof v.voice === "string" ? v.voice.slice(0, 120) : undefined,
          rate: typeof v.rate === "string" ? v.rate.slice(0, 12) : undefined,
          pitch: typeof v.pitch === "string" ? v.pitch.slice(0, 12) : undefined,
          command: typeof v.command === "string" ? v.command.slice(0, 500) : undefined,
          url: typeof v.url === "string" ? v.url.slice(0, 300) : undefined,
          emotion: typeof v.emotion === "string" ? v.emotion.slice(0, 40) : undefined,
          apiKey: typeof v.apiKey === "string" ? v.apiKey.slice(0, 200) : undefined,
          format: v.format === "openai" ? "openai" : undefined,
          model: typeof v.model === "string" ? v.model.slice(0, 60) : undefined,
        }));
    }
    if (typeof body.defaultVoiceId === "string") {
      state.defaultVoiceId = body.defaultVoiceId;
    } else if (!state.voices.some((v) => v.id === state.defaultVoiceId)) {
      state.defaultVoiceId = state.voices[0]?.id ?? "";
    }

    save();
    log.info(`音色已更新：${state.voices.length} 个，默认 ${state.defaultVoiceId}`);
    json(res, 200, { ok: true, voices: state.voices, defaultVoiceId: state.defaultVoiceId });
    return;
  }

  // 试听：合成一段并返回可播放的地址
  if (req.method === "POST" && path === "/api/voice/preview") {
    const body = JSON.parse(await readBody(req)) as { text?: string; presetId?: string };
    const text = String(body.text ?? "").trim().slice(0, 200);
    if (!text) {
      json(res, 400, { error: "先写一句要念的话" });
      return;
    }

    const preset =
      state.voices.find((v) => v.id === body.presetId) ??
      state.voices.find((v) => v.id === state.defaultVoiceId) ??
      state.voices[0];
    if (!preset) {
      json(res, 400, { error: "还没有音色" });
      return;
    }

    try {
      const file = await speakToFileInline(text, preset);
      if (!file) {
        json(res, 500, { error: "合成没产出音频，检查音色配置或网络" });
        return;
      }
      const name = basename(file);
      json(res, 200, {
        ok: true,
        url: `/api/voice/file?name=${encodeURIComponent(name)}`,
        engine: preset.engine,
      });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "GET" && path === "/api/voice/file") {
    const name = basename(url.searchParams.get("name") ?? "");
    const file = join(DATA_DIR, "voice", name);
    if (!name || !existsSync(file)) {
      json(res, 404, { error: "没有这个音频" });
      return;
    }
    const type = name.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(readFileSync(file));
    return;
  }

  // 诊断用：看看控制台进程里 python/edge_tts 到底是什么状态
  if (req.method === "GET" && path === "/api/debug/tts") {
    const probe = await new Promise<string>((resolve) => {
      const child = spawn(pythonPath ?? "python", [
        "-c",
        "import sys;print('exe',sys.executable);import edge_tts;print('edge',edge_tts.__version__ if hasattr(edge_tts,'__version__') else 'ok')",
      ], { windowsHide: true, env: process.env });
      let text = "";
      child.stdout?.on("data", (d: Buffer) => (text += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (text += d.toString()));
      child.on("error", (e) => resolve(`spawn error: ${e.message}`));
      child.on("close", (code) => resolve(`exit=${code}\n${text}`));
    });

    json(res, 200, {
      pythonPath: pythonPath ?? null,
      cwd: process.cwd(),
      proxy: {
        http: process.env.http_proxy ?? process.env.HTTP_PROXY ?? null,
        https: process.env.https_proxy ?? process.env.HTTPS_PROXY ?? null,
      },
      probe,
    });
    return;
  }

  // 诊断用：在控制台进程里直接合成一次，看是进程问题还是接口问题
  if (req.method === "GET" && path === "/api/debug/tts-run") {
    const id = url.searchParams.get("id") ?? state.defaultVoiceId;
    const preset = state.voices.find((v) => v.id === id) ?? state.voices[0];
    if (!preset) {
      json(res, 400, { error: "没有音色" });
      return;
    }
    try {
      const probeText = url.searchParams.get("text") ?? "诊断合成测试";
      const result = await synthesize(probeText, preset, {
        outDir: join(DATA_DIR, "voice"),
        python: pythonPath,
      });
      json(res, 200, { ok: true, file: basename(result.file), size: statSync(result.file).size });
    } catch (err) {
      json(res, 500, { id: preset.id, engine: preset.engine, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "POST" && path === "/api/proactive") {
    const body = JSON.parse(await readBody(req)) as {
      enabled?: boolean;
      quietMin?: number;
      intervalMin?: number;
    };
    if (typeof body.enabled === "boolean") state.proactive.enabled = body.enabled;
    if (typeof body.quietMin === "number") {
      state.proactive.quietMin = Math.min(Math.max(Math.floor(body.quietMin), 1), 1440);
    }
    if (typeof body.intervalMin === "number") {
      state.proactive.intervalMin = Math.min(Math.max(Math.floor(body.intervalMin), 1), 1440);
    }
    save();
    log.info(`主动开口：${state.proactive.enabled ? "开" : "关"}，安静 ${state.proactive.quietMin} 分钟后说，间隔 ${state.proactive.intervalMin} 分钟`);
    json(res, 200, { ok: true, proactive: state.proactive });
    return;
  }
  if (req.method === "POST" && path === "/api/bindings") {
    const body = JSON.parse(await readBody(req)) as { convKey?: string; enabled?: boolean };
    const convKey = body.convKey ?? "";
    state.bindings = state.bindings.filter((b) => b.convKey !== convKey);
    if (body.enabled) state.bindings.push({ convKey, enabled: true });
    save();

    // 原地同步给正在跑的编排器，不打断连接
    const channelId = convKey.split(":").slice(0, 2).join(":");
    syncBindings(channelId);

    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/api/agent") {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    state.agent = {
      name: String(body.name ?? state.agent.name),
      persona: String(body.persona ?? state.agent.persona),
      traits: parseTraits(body.traits) ?? state.agent.traits,
      mode: (body.mode as TriggerMode) ?? state.agent.mode,
      cooldownSec: Number(body.cooldownSec ?? state.agent.cooldownSec),
      keywords: Array.isArray(body.keywords)
        ? (body.keywords as string[]).filter((k) => typeof k === "string")
        : state.agent.keywords,
      interjectRate: typeof body.interjectRate === "number"
        ? Math.max(0.05, Math.min(0.8, body.interjectRate))
        : state.agent.interjectRate,
      // 布尔字段只有"显式传了"才改，否则局部更新会把开关重置掉
      mentionSender:
        typeof body.mentionSender === "boolean" ? body.mentionSender : state.agent.mentionSender,
      allowLeave:
        typeof body.allowLeave === "boolean" ? body.allowLeave : state.agent.allowLeave,
      emojiDir: typeof body.emojiDir === "string" ? body.emojiDir : state.agent.emojiDir,
      deep: {
        enabled: (() => {
          const v = (body.deep as { enabled?: boolean } | undefined)?.enabled;
          return typeof v === "boolean" ? v : state.agent.deep.enabled;
        })(),
        maxTokens: (() => {
          const v = (body.deep as { maxTokens?: number } | undefined)?.maxTokens;
          return typeof v === "number" && v > 0
            ? Math.min(Math.max(v, 800), 8000)
            : state.agent.deep.maxTokens;
        })(),
      },
    };
    save();

    // 原地替换人设，不重连、不掉线
    for (const rt of runtimes.values()) {
      rt.agents.set("default", buildAgent());
    }

    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/api/key") {
    const body = JSON.parse(await readBody(req)) as { key?: string; model?: string; clearKey?: boolean };
    // 只更新传了的字段：以前这里无条件赋值，导致"只改模型"会把 Key 清空
    if (typeof body.key === "string" && body.key.trim()) state.key = body.key.trim();
    if (body.clearKey === true) state.key = "";
    if (typeof body.model === "string" && body.model.trim()) state.model = body.model.trim();
    save();
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/api/key/test") {
    const body = JSON.parse(await readBody(req)) as { key?: string };
    const key = String(body.key ?? state.key).trim();
    if (!key) {
      json(res, 400, { error: "还没填 Key" });
      return;
    }
    try {
      const p = new DeepSeekProvider({ apiKey: key, defaultModel: state.model });
      let out = "";
      for await (const chunk of p.chat({
        model: state.model,
        messages: [{ role: "user", content: "只回复两个字：可以" }],
        maxOutputTokens: 20,
        thinking: false,
      })) {
        if (chunk.delta) out += chunk.delta;
      }
      json(res, 200, { ok: true, reply: out.trim() });
    } catch (err) {
      json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  res.writeHead(404).end();
}

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(`\n  控制台启动失败：${err.message}\n`);
  process.exit(1);
});

server.listen(BASE_PORT, LISTEN_HOST, () => {
  console.log("");
  console.log("  群聊 AI · 配置控制台");
  console.log("");
  console.log(`  监听：${LISTEN_HOST}:${BASE_PORT}`);
  if (AUTH_TOKEN === "") {
    console.log("  访问令牌：未设置（仅限本机使用）");
  } else {
    console.log("  访问令牌：已启用");
  }
  console.log("");
  console.log("  Ctrl+C 退出");
});

// 服务器模式：没配过号、但给了 NAPCAT_WS_URL，就自动建一个，省得用户在网页里手填
if (process.env.NAPCAT_WS_URL && state.channels.length === 0) {
  state.channels.push({
    id: "qq:server",
    label: "服务器上的号",
    wsUrl: process.env.NAPCAT_WS_URL,
  });
  save();
  log.info(`已按 NAPCAT_WS_URL 自动添加通道 ${process.env.NAPCAT_WS_URL}`);
}

// 启动时恢复上次添加的号
for (const rec of state.channels) {
  void connectChannel(rec).catch(() => undefined);
}

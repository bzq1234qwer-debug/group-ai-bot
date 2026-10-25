/**
 * 配置加载。JSON 文件 + 环境变量覆盖。
 *
 * 安全约定：API Key 永远不进 JSON 配置文件（那个文件会被用户到处发），
 * 只从环境变量或本地加密存储读取。
 */

import { readFileSync } from "node:fs";
import { defaultAgent, type AgentConfig, type AgentTraits, type Binding } from "./agent.ts";
import type { InterjectOptions, TriggerPolicy } from "./trigger.ts";
import type { LogLevel } from "./logger.ts";
import { DEFAULT_MODEL } from "./cost.ts";

export interface ChannelConfig {
  id: string;
  /** onebot11 = NapCat（需电脑）；qqbot = QQ 官方机器人（可在手机上跑） */
  kind: "onebot11" | "qqbot";
  label: string;
  selfId?: string;
  /** NapCat 的 HTTP API 地址 */
  baseUrl: string;
  token?: string;
  /** 接收事件上报的本地端口（仅 onebot11 反向 HTTP 模式） */
  eventPort: number;
  eventPath: string;
  eventToken?: string;
  /** onebot11 正向 WebSocket 地址；配了它就走 WS，忽略 eventPort */
  wsUrl?: string;
  /** QQ 官方机器人凭证（仅 qqbot）；appSecret 建议走环境变量 QQBOT_APP_SECRET */
  appId?: string;
  appSecret?: string;
  apiBase?: string;
}

export interface DeepSeekSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface QuotaConfig {
  globalDailyCny: number;
  bindingDailyCny: number;
  onExceed: "notify" | "degrade" | "silent";
}

export interface RuntimeConfig {
  /** mock = 不调真实 API，用于演示和离线测试 */
  mode: "mock" | "live";
  logLevel: LogLevel;
  dbPath: string;
  deepseek: DeepSeekSettings;
  channels: ChannelConfig[];
  agents: AgentConfig[];
  bindings: Binding[];
  quota: QuotaConfig;
  /** 分段发送之间的间隔；0 表示用内置拟人节奏 */
  sendDelayMs: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseTrigger(raw: unknown, fallback: TriggerPolicy): TriggerPolicy {
  const t = asRecord(raw);
  if (Object.keys(t).length === 0) return fallback;

  const strArray = (v: unknown, fb: string[] | undefined): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fb;

  return {
    mode: (typeof t.mode === "string" ? t.mode : fallback.mode) as TriggerPolicy["mode"],
    keywords: strArray(t.keywords, fallback.keywords),
    randomRate: num(t.randomRate, fallback.randomRate ?? 0.05),
    interject: Object.keys(asRecord(t.interject)).length > 0
      ? (asRecord(t.interject) as unknown as InterjectOptions)
      : fallback.interject,
    cooldownSec: num(t.cooldownSec, fallback.cooldownSec),
    perUserPerHour: num(t.perUserPerHour, fallback.perUserPerHour),
    quietHours: Array.isArray(t.quietHours)
      ? (t.quietHours as Array<[string, string]>)
      : fallback.quietHours,
    ignorePrefixes: strArray(t.ignorePrefixes, fallback.ignorePrefixes),
    denyUsers: strArray(t.denyUsers, fallback.denyUsers),
  };
}

export function buildConfig(raw: unknown): RuntimeConfig {  const root = asRecord(raw);
  const ds = asRecord(root.deepseek);
  const quota = asRecord(root.quota);

  const channelsRaw = Array.isArray(root.channels) ? root.channels : [];
  const channels: ChannelConfig[] = channelsRaw.map((c) => {
    const item = asRecord(c);
    const kind = item.kind === "qqbot" ? "qqbot" : "onebot11";
    return {
      id: str(item.id, "qq:unknown"),
      kind,
      label: str(item.label, kind === "qqbot" ? "QQ机器人" : "QQ"),
      selfId: typeof item.selfId === "string" ? item.selfId : undefined,
      baseUrl: str(item.baseUrl, "http://127.0.0.1:3000"),
      token: typeof item.token === "string" ? item.token : undefined,
      eventPort: num(item.eventPort, 3001),
      eventPath: str(item.eventPath, "/onebot/events"),
      eventToken: typeof item.eventToken === "string" ? item.eventToken : undefined,
      wsUrl: typeof item.wsUrl === "string" ? item.wsUrl : undefined,
      appId: typeof item.appId === "string" ? item.appId : undefined,
      appSecret: str(item.appSecret, str(process.env.QQBOT_APP_SECRET, "")) || undefined,
      apiBase: typeof item.apiBase === "string" ? item.apiBase : undefined,
    };
  });

  const agentsRaw = Array.isArray(root.agents) ? root.agents : [];
  const agents: AgentConfig[] = agentsRaw.length
    ? agentsRaw.map((a) => {
        const item = asRecord(a);
        return defaultAgent({
          id: str(item.id, "default"),
          name: str(item.name, "小D"),
          persona: str(item.persona, defaultAgent().persona),
          traits: parseTraits(item.traits),
          model: str(item.model, DEFAULT_MODEL),
          temperature: num(item.temperature, 1),
          maxOutputTokens: num(item.maxOutputTokens, 800),
          thinking: item.thinking === true,
          reasoningEffort: item.reasoningEffort as AgentConfig["reasoningEffort"],
          maxContextTokens: num(item.maxContextTokens, 24_000),
          trigger: parseTrigger(item.trigger, defaultAgent().trigger),
          mentionSender: item.mentionSender !== false,
          quoteThreshold: num(item.quoteThreshold, 8),
          allowRecall: item.allowRecall !== false,
          allowLeave: item.allowLeave === true,
          emojiDir: typeof item.emojiDir === "string" ? item.emojiDir : undefined,
          summarizeAfter: num(item.summarizeAfter, 30),
          deep: {
            enabled: asRecord(item.deep).enabled === true,
            maxTokens: num(asRecord(item.deep).maxTokens, 2400),
          },
        });
      })
    : [defaultAgent()];

  const bindingsRaw = Array.isArray(root.bindings) ? root.bindings : [];
  const bindings: Binding[] = bindingsRaw.map((b) => {
    const item = asRecord(b);
    return {
      convKey: str(item.convKey, ""),
      agentId: str(item.agentId, "default"),
      enabled: item.enabled !== false,
    };
  });

  const mode = root.mode === "mock" || root.mode === "live" ? root.mode : "mock";
  return {
    mode,
    logLevel: (str(root.logLevel, "info") as LogLevel) ?? "info",
    dbPath: str(root.dbPath, "data/bot.db"),
    deepseek: {
      baseUrl: str(ds.baseUrl, "https://api.deepseek.com"),
      apiKey: str(process.env.DEEPSEEK_API_KEY, ""),
      model: str(ds.model, DEFAULT_MODEL),
    },
    channels,
    agents,
    bindings,
    quota: {
      globalDailyCny: num(quota.globalDailyCny, 20),
      bindingDailyCny: num(quota.bindingDailyCny, 2),
      onExceed: (quota.onExceed as QuotaConfig["onExceed"]) ?? "notify",
    },
    // 0 = 用内置的拟人节奏（按字数随机）；>0 = 固定间隔，测试时用
    sendDelayMs: num(root.sendDelayMs, 0),
  };
}

export function loadConfig(path: string): RuntimeConfig {
  const text = readFileSync(path, "utf8");
  return buildConfig(JSON.parse(text) as unknown);
}

/** 从对象直接构建，供测试与 demo 使用 */
export function configFrom(overrides: Record<string, unknown>): RuntimeConfig {
  return buildConfig(overrides);
}

/** 解析喜好的三种写法：数组、逗号分隔字符串、缺省 */
function parseTraits(raw: unknown): AgentTraits {
  const item = asRecord(raw);
  const list = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (typeof v === "string") return v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    return [];
  };

  return {
    likes: list(item.likes),
    dislikes: list(item.dislikes),
    habits: list(item.habits),
  };
}

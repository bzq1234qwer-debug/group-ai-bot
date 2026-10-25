/**
 * QQ 官方机器人适配器（QQ Bot API v2）。
 *
 * 和 OneBot/NapCat 的本质区别：这是腾讯官方接口，走 WebSocket 出站长连接，
 * 不需要 QQ 客户端、不需要公网 IP、不会封号 —— 所以它能跑在手机上。
 *
 * 代价是平台规则：个人主体的机器人只能由创建者本人拉进自己当管理的群。
 *
 * 流程：appId + appSecret → access_token → /gateway → WebSocket → IDENTIFY → 收事件
 */

import type {
  Adapter,
  AdapterNotice,
  Capabilities,
  ChannelKind,
  Conversation,
  Envelope,
  OutboundMessage,
  SendResult,
} from "../types.ts";
import { makeConvKey, parseConvKey } from "../types.ts";

export interface QqBotConfig {
  /** 逻辑通道 id，形如 "qqbot:102030405" */
  channelId: string;
  appId: string;
  appSecret: string;
  /** 正式环境默认 https://api.sgroup.qq.com；沙箱用 https://sandbox.api.sgroup.qq.com */
  apiBase?: string;
  tokenUrl?: string;
}

/** GROUP_AND_C2C_EVENT：群聊 @ 消息 + 单聊消息 */
const INTENT_GROUP_AND_C2C = 1 << 25;

const CONNECT_TIMEOUT_MS = 15_000;
const PASSIVE_REPLY_WINDOW_MS = 4 * 60_000; // 官方窗口 5 分钟，留 1 分钟余量
const MAX_PASSIVE_REPLIES = 5;

// ---------------------------------------------------------------------------
// access_token 管理
// ---------------------------------------------------------------------------

class TokenManager {
  #appId: string;
  #appSecret: string;
  #tokenUrl: string;
  #token = "";
  #expiresAt = 0;
  #inflight: Promise<string> | undefined;

  constructor(appId: string, appSecret: string, tokenUrl: string) {
    this.#appId = appId;
    this.#appSecret = appSecret;
    this.#tokenUrl = tokenUrl;
  }

  invalidate(): void {
    this.#token = "";
    this.#expiresAt = 0;
  }

  async get(): Promise<string> {
    if (this.#token && Date.now() < this.#expiresAt - 60_000) return this.#token;
    // 并发调用只发一次请求
    this.#inflight ??= this.#fetchToken().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #fetchToken(): Promise<string> {
    const res = await fetch(this.#tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: this.#appId, clientSecret: this.#appSecret }),
    });

    const text = await res.text();
    let json: { access_token?: string; expires_in?: number | string; code?: number; message?: string };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new Error(`获取 access_token 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    }

    if (!res.ok || !json.access_token) {
      throw new Error(
        `获取 access_token 失败：HTTP ${res.status} ${json.code ?? ""} ${json.message ?? ""}`.trim(),
      );
    }

    this.#token = json.access_token;
    this.#expiresAt = Date.now() + Number(json.expires_in ?? 7200) * 1000;
    return this.#token;
  }
}

// ---------------------------------------------------------------------------
// 事件归一化（纯函数，方便单测）
// ---------------------------------------------------------------------------

interface QqBotAuthor {
  id?: string;
  member_openid?: string;
  user_openid?: string;
  union_openid?: string;
  username?: string;
}

/** 去掉官方消息里的 <@!123> / <@123> 提及标记 */
export function stripQqBotMentions(text: string): string {
  return text.replace(/<@!?[^>]+>/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

export function normalizeQqBotEvent(
  type: string,
  d: Record<string, unknown>,
  channelId: string,
  now: number = Date.now(),
): Envelope | null {
  if (type !== "GROUP_AT_MESSAGE_CREATE" && type !== "C2C_MESSAGE_CREATE") return null;

  const isGroup = type === "GROUP_AT_MESSAGE_CREATE";
  const author = (d.author ?? {}) as QqBotAuthor;
  const externalId = String(isGroup ? d.group_openid ?? "" : author.user_openid ?? "");
  if (!externalId) return null;

  const rawContent = String(d.content ?? "");
  const text = stripQqBotMentions(rawContent);
  if (!text) return null;

  const senderId = String(author.member_openid ?? author.id ?? author.user_openid ?? "");
  const tsSec = Number(d.timestamp ?? 0);

  return {
    id: String(d.id ?? ""),
    convKey: makeConvKey(channelId, isGroup ? "group" : "private", externalId),
    channelId,
    sender: {
      id: senderId,
      name: String(author.username ?? senderId.slice(0, 8)),
      isSelf: false,
      role: "member",
    },
    text,
    // 群聊事件本身就是"@机器人"才会推送，所以恒为 true
    mentions: { self: isGroup, users: [], all: false },
    media: [],
    ts: tsSec > 0 ? tsSec * 1000 : now,
  };
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

interface PassiveState {
  msgId: string;
  ts: number;
  seq: number;
}

export class QqBotAdapter implements Adapter {
  readonly kind: ChannelKind = "qqbot";
  #cfg: QqBotConfig;
  #token: TokenManager;
  #apiBase: string;
  #ws: WebSocket | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #lastSeq = 0;
  #stopped = false;
  #retry = 0;
  #passive = new Map<string, PassiveState>();
  #convs = new Map<string, Conversation>();
  #onMessage: ((env: Envelope) => void) | undefined;
  #onNotice: ((n: AdapterNotice) => void) | undefined;

  constructor(cfg: QqBotConfig) {
    this.#cfg = cfg;
    this.#apiBase = (cfg.apiBase ?? "https://api.sgroup.qq.com").replace(/\/+$/, "");
    this.#token = new TokenManager(
      cfg.appId,
      cfg.appSecret,
      cfg.tokenUrl ?? "https://bots.qq.com/app/getAppAccessToken",
    );
  }

  capabilities(): Capabilities {
    return {
      sendText: true,
      sendImage: true,
      mention: true,
      quote: false, // 官方接口没有"引用回复"
      recall: false,
      typing: false,
      maxTextLength: 1500,
      rateLimit: { perMinute: 20, burst: 5 },
    };
  }

  onMessage(handler: (env: Envelope) => void): void {
    this.#onMessage = handler;
  }

  onNotice(handler: (n: AdapterNotice) => void): void {
    this.#onNotice = handler;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#token.get();
    await this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
    const ws = this.#ws;
    this.#ws = undefined;
    if (ws) {
      try {
        ws.close(1000, "bye");
      } catch {
        // 已经关了
      }
    }
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.#convs.values()];
  }

  async send(convKey: string, msg: OutboundMessage): Promise<SendResult> {
    const { type, externalId } = parseConvKey(convKey);
    const content = msg.segments.filter(Boolean).join("").trim();
    if (!content) return { messageId: "" };

    const body: Record<string, unknown> = { content, msg_type: 0 };
    const passive = this.#nextPassive(convKey, msg.replyTo);
    if (passive) {
      body.msg_id = passive.msgId;
      body.msg_seq = passive.seq;
    }

    const path = type === "group" ? `/v2/groups/${externalId}/messages` : `/v2/users/${externalId}/messages`;
    const data = await this.#api("POST", path, body);
    return { messageId: String((data as { id?: unknown })?.id ?? "") };
  }

  // -------------------------------------------------------------------------

  /**
   * 被动回复配额：同一条用户消息在 5 分钟内最多回 5 条。
   * 我们把连续发出的分段都挂在同一个 msg_id 上，避免后面的段落被当成"主动推送"
   * （主动推送需要群主额外授权，否则发不出去）。
   */
  #nextPassive(convKey: string, replyTo: string | undefined): PassiveState | undefined {
    const now = Date.now();

    if (replyTo) {
      const state: PassiveState = { msgId: replyTo, ts: now, seq: 1 };
      this.#passive.set(convKey, state);
      return state;
    }

    const last = this.#passive.get(convKey);
    if (!last) return undefined;
    if (now - last.ts > PASSIVE_REPLY_WINDOW_MS) {
      this.#passive.delete(convKey);
      return undefined;
    }
    if (last.seq >= MAX_PASSIVE_REPLIES) return undefined;
    last.seq += 1;
    last.ts = now;
    return last;
  }

  async #api(method: string, path: string, body?: unknown): Promise<unknown> {
    const attempt = async (): Promise<Response> => {
      const token = await this.#token.get();
      return fetch(`${this.#apiBase}${path}`, {
        method,
        headers: {
          authorization: `QQBot ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };

    let res = await attempt();
    if (res.status === 401) {
      // token 提前失效，刷新后重试一次
      this.#token.invalidate();
      res = await attempt();
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        detail = "";
      }
      throw new Error(`QQBot API ${method} ${path} 失败：HTTP ${res.status} ${detail}`);
    }

    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return {};
    }
  }

  async #connect(): Promise<void> {
    const gateway = await this.#api("GET", "/gateway");
    const url = (gateway as { url?: string })?.url;
    if (!url) throw new Error("获取 WebSocket 网关失败");

    const ws = new WebSocket(url);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket 连接超时")), CONNECT_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebSocket 连接错误"));
      });
      ws.addEventListener("message", (event: MessageEvent) => {
        this.#onPayload(event.data);
      });
      ws.addEventListener("close", (event: CloseEvent) => {
        clearTimeout(timer);
        if (this.#heartbeat) {
          clearInterval(this.#heartbeat);
          this.#heartbeat = undefined;
        }
        if (!this.#stopped) {
          this.#onNotice?.({
            channelId: this.#cfg.channelId,
            kind: "offline",
            message: `连接断开（${event.code}），准备重连`,
          });
          this.#scheduleReconnect();
        }
      });
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    this.#retry += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.#retry, 5));
    setTimeout(() => {
      if (this.#stopped) return;
      this.#connect().catch(() => this.#scheduleReconnect());
    }, delay);
  }

  #onPayload(raw: unknown): void {
    if (typeof raw !== "string") return;

    let payload: { op?: number; d?: unknown; s?: number; t?: string };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return;
    }

    if (typeof payload.s === "number") this.#lastSeq = payload.s;

    switch (payload.op) {
      case 10: {
        // HELLO：拿心跳间隔，然后 IDENTIFY
        const hello = (payload.d ?? {}) as { heartbeat_interval?: number };
        const interval = Math.max(5_000, hello.heartbeat_interval ?? 30_000);
        this.#identify();
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        this.#heartbeat = setInterval(() => this.#heartbeatTick(), interval);
        break;
      }
      case 11:
        break; // 心跳 ACK
      case 7:
      case 9:
        // 要求重连 / 会话失效
        this.#lastSeq = 0;
        this.#ws?.close(4000, "reconnect");
        break;
      case 0:
        this.#dispatch(payload.t ?? "", (payload.d ?? {}) as Record<string, unknown>);
        break;
      default:
        break;
    }
  }

  #identify(): void {
    void this.#identifyAsync();
  }

  async #identifyAsync(): Promise<void> {
    try {
      const token = await this.#token.get();
      this.#send({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: INTENT_GROUP_AND_C2C,
          shard: [0, 1],
          properties: {},
        },
      });
    } catch (err) {
      this.#onNotice?.({
        channelId: this.#cfg.channelId,
        kind: "error",
        message: `IDENTIFY 失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  #heartbeatTick(): void {
    this.#send({ op: 1, d: this.#lastSeq });
  }

  #send(obj: unknown): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(obj));
  }

  #dispatch(type: string, d: Record<string, unknown>): void {
    if (type === "READY") {
      this.#retry = 0;
      this.#onNotice?.({
        channelId: this.#cfg.channelId,
        kind: "online",
        message: "已连接 QQ 机器人网关",
      });
      return;
    }

    const env = normalizeQqBotEvent(type, d, this.#cfg.channelId);
    if (!env) return;

    const title = env.convKey.split(":").join(" · ");
    const existing = this.#convs.get(env.convKey);
    this.#convs.set(env.convKey, {
      key: env.convKey,
      channelId: env.channelId,
      type: env.convKey.includes(":group:") ? "group" : "private",
      externalId: env.convKey.split(":").at(-1) ?? "",
      title: existing?.title ?? title,
      memberCount: existing?.memberCount,
    });

    this.#onMessage?.(env);
  }
}

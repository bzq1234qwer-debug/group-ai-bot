/**
 * OneBot 11 适配器（对接 NapCat / LLOneBot）。
 *
 * 采用「HTTP API 发消息 + 反向 HTTP 上报收消息」，全程只用 fetch 和 node:http，
 * 不引入 ws 依赖。NapCat 侧配置：HTTP 服务 3000，HTTP 上报地址 http://127.0.0.1:3001/onebot/events。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  Adapter,
  AdapterNotice,
  Capabilities,
  ChannelKind,
  Conversation,
  Envelope,
  MediaRef,
  OutboundMessage,
  PendingRequest,
  ReplyRef,
  SendResult,
} from "../types.ts";
import { makeConvKey, parseConvKey } from "../types.ts";

export interface OneBotConfig {
  /** 逻辑通道 id，形如 "qq:10001" */
  channelId: string;
  /** NapCat / SnowLuma 的 HTTP API 基地址（反向 HTTP 模式用） */
  baseUrl: string;
  token?: string;
  selfId?: string;
  eventPort: number;
  eventPath: string;
  eventToken?: string;
  /**
   * 正向 WebSocket 地址，如 ws://127.0.0.1:3001。
   * 配了就用 WS 模式（我们主动连过去），忽略 eventPort —— SnowLuma / LLOneBot 默认是这种形态。
   */
  wsUrl?: string;
}

interface OB11Segment {
  type: string;
  data?: Record<string, unknown>;
}

interface OB11Event {
  post_type?: string;
  message_type?: string;
  self_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  message_id?: number | string;
  message?: string | OB11Segment[];
  raw_message?: string;
  time?: number;
  sender?: {
    user_id?: number | string;
    nickname?: string;
    card?: string;
    role?: string;
  };
}

const MAX_BODY = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function asId(value: string): number | string {
  return /^\d{1,15}$/.test(value) ? Number(value) : value;
}

function senderNameOf(event: OB11Event): string {
  return event.sender?.card || event.sender?.nickname || String(event.sender?.user_id ?? "unknown");
}

function roleOf(event: OB11Event): "owner" | "admin" | "member" | undefined {
  const role = event.sender?.role;
  if (role === "owner" || role === "admin" || role === "member") return role;
  return undefined;
}

/**
 * 把 OneBot 原始事件翻译成 Envelope。
 * 单独导出是为了能脱离网络直接测。
 */
export function normalizeOneBotEvent(
  event: OB11Event,
  channelId: string,
  selfId: string,
  now: number = Date.now(),
): Envelope | null {
  if (event.post_type !== "message") return null;
  if (event.message_type !== "group" && event.message_type !== "private") return null;

  const isGroup = event.message_type === "group";
  const externalId = String(isGroup ? event.group_id : event.user_id);
  if (!externalId || externalId === "undefined") return null;

  const convKey = makeConvKey(channelId, isGroup ? "group" : "private", externalId);

  const mentions = { self: false, users: [] as string[], all: false };
  const media: MediaRef[] = [];
  let replyTo: ReplyRef | undefined;
  const textParts: string[] = [];

  const segments: OB11Segment[] =
    typeof event.message === "string"
      ? [{ type: "text", data: { text: event.message } }]
      : (event.message ?? []);

  for (const seg of segments) {
    const data = seg.data ?? {};
    switch (seg.type) {
      case "text":
        textParts.push(String(data.text ?? ""));
        break;
      case "at": {
        const qq = String(data.qq ?? "");
        if (qq === "all") {
          mentions.all = true;
          textParts.push("@全体成员 ");
        } else if (qq === selfId) {
          // 被 @ 的是它自己：不要把自己的名字写进正文。
          // 写进去模型会以为对方在叫名字，还可能学着用 "@名字 内容" 的格式说话。
          mentions.self = true;
        } else if (qq) {
          mentions.users.push(qq);
          const name = String(data.name ?? "").trim();
          textParts.push(name ? `@${name} ` : `@${qq} `);
        }
        break;
      }
      case "reply":
        replyTo = {
          id: String(data.id ?? ""),
          senderName: "",
          excerpt: "",
          senderIsSelf: false,
        };
        break;
      case "image":
        media.push({ kind: "image", url: typeof data.url === "string" ? data.url : undefined });
        textParts.push("[图片]");
        break;
      case "face":
        textParts.push("[表情]");
        break;
      case "record":
        media.push({ kind: "voice" });
        textParts.push("[语音]");
        break;
      case "file":
        media.push({ kind: "file" });
        textParts.push("[文件]");
        break;
      default:
        break;
    }
  }

  // 消息段拼接后会留下多余空格（"@小D " + " 内容"），压成单个空格
  const text = textParts.join("").replace(/[ \t]{2,}/g, " ").trim();
  if (!text && media.length === 0) return null;

  const userId = String(event.user_id ?? event.sender?.user_id ?? "");

  return {
    id: String(event.message_id ?? `${convKey}:${now}`),
    convKey,
    channelId,
    sender: {
      id: userId,
      name: senderNameOf(event),
      isSelf: userId === selfId,
      role: roleOf(event),
    },
    text,
    mentions,
    replyTo,
    media,
    ts: event.time ? event.time * 1000 : now,
  };
}

/** 好友申请 / 加群邀请。这些必须由人来拍板，AI 不碰 */
export function normalizeOneBotRequest(
  event: Record<string, unknown>,
  channelId: string,
  now: number = Date.now(),
): PendingRequest | null {
  if (event.post_type !== "request") return null;

  const requestType = event.request_type;
  const kind = requestType === "friend" ? "friend" : requestType === "group" ? "group" : null;
  if (!kind) return null;

  const flag = String(event.flag ?? "");
  if (!flag) return null;

  return {
    id: flag,
    channelId,
    kind,
    subType: typeof event.sub_type === "string" ? event.sub_type : undefined,
    userId: String(event.user_id ?? ""),
    groupId: event.group_id != null ? String(event.group_id) : undefined,
    comment: typeof event.comment === "string" && event.comment ? event.comment : undefined,
    ts: now,
  };
}

/** 把消息段压成纯文本，用于"被引用的那句话"摘要 */
function flattenMessageText(message: unknown): string {
  if (typeof message === "string") return message.trim();
  if (!Array.isArray(message)) return "";

  const parts: string[] = [];
  for (const seg of message) {
    const item = seg as { type?: string; data?: Record<string, unknown> };
    switch (item?.type) {
      case "text":
        parts.push(String(item.data?.text ?? ""));
        break;
      case "image":
        parts.push("[图片]");
        break;
      case "face":
        parts.push("[表情]");
        break;
      case "file":
        parts.push("[文件]");
        break;
      default:
        break;
    }
  }
  return parts.join("").trim();
}

/** 群里的"发生了什么"：撤回、禁言、进出群。不处理这些，它会活在一个假世界里 */
export function normalizeOneBotNotice(
  event: Record<string, unknown>,
  channelId: string,
  selfId: string,
): AdapterNotice | null {
  if (event.post_type !== "notice") return null;

  const type = String(event.notice_type ?? "");
  const groupId = event.group_id != null ? String(event.group_id) : undefined;
  const userId = String(event.user_id ?? "");
  const messageId = event.message_id != null ? String(event.message_id) : undefined;

  const convKey = groupId
    ? makeConvKey(channelId, "group", groupId)
    : type === "friend_recall" && userId
      ? makeConvKey(channelId, "private", userId)
      : undefined;

  switch (type) {
    case "group_recall":
    case "friend_recall":
      return {
        channelId,
        kind: "recall",
        convKey,
        userId,
        messageId,
        message: `消息被撤回（${messageId ?? "?"}）`,
      };

    case "group_ban": {
      const subType = String(event.sub_type ?? "");
      const durationSec = Number(event.duration ?? 0);
      return {
        channelId,
        kind: subType === "lift_ban" ? "unmuted" : "muted",
        convKey,
        userId,
        durationSec,
        message:
          subType === "lift_ban"
            ? "禁言解除"
            : userId === selfId
              ? `我自己被禁言 ${durationSec} 秒`
              : `${userId} 被禁言 ${durationSec} 秒`,
      };
    }

    case "group_decrease": {
      const kicked = userId === selfId;
      return {
        channelId,
        kind: kicked ? "kicked" : "member_leave",
        convKey,
        userId,
        message: kicked ? "我被移出群了" : `${userId} 退群`,
      };
    }

    case "group_increase":
      return {
        channelId,
        kind: "member_join",
        convKey,
        userId,
        message: `${userId} 入群`,
      };

    default:
      return null;
  }
}

export class OneBotAdapter implements Adapter {  readonly kind: ChannelKind = "onebot11";
  #cfg: OneBotConfig;
  #server: Server | undefined;
  #onMessage: ((env: Envelope) => void) | undefined;
  #onNotice: ((n: AdapterNotice) => void) | undefined;
  #onRequest: ((req: PendingRequest) => void) | undefined;

  // 正向 WS 模式的状态
  #ws: WebSocket | undefined;
  #stopped = false;
  #retry = 0;
  #echoSeq = 0;
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(cfg: OneBotConfig) {
    this.#cfg = cfg;
  }

  capabilities(): Capabilities {
    return {
      sendText: true,
      sendImage: true,
      mention: true,
      quote: true,
      recall: true,
      typing: false,
      maxTextLength: 4500,
      // 保守值：QQ 对同号短时间高频发言有风控
      rateLimit: { perMinute: 6, burst: 3 },
    };
  }

  onMessage(handler: (env: Envelope) => void): void {
    this.#onMessage = handler;
  }

  onNotice(handler: (n: AdapterNotice) => void): void {
    this.#onNotice = handler;
  }

  onRequest(handler: (req: PendingRequest) => void): void {
    this.#onRequest = handler;
  }

  /** 探活：问一次登录信息。QQ 掉线时这条会失败，即使 WS 还连着 */
  async ping(): Promise<boolean> {
    try {
      const info = await this.#call("get_login_info", {});
      return Boolean(info && (info as { user_id?: unknown }).user_id);
    } catch {
      return false;
    }
  }

  /**
   * 取回被引用的那条消息。
   * QQ 的引用段只给 message_id，正文得另外问一次 —— 不问的话模型看到的引用是空的。
   */
  async getMessage(
    id: string,
  ): Promise<{ senderName: string; excerpt: string; senderIsSelf: boolean } | undefined> {
    if (!id) return undefined;

    try {
      const data = (await this.#call("get_msg", { message_id: id })) as
        | { sender?: { nickname?: string; card?: string; user_id?: string | number }; message?: unknown; raw_message?: string }
        | undefined;
      if (!data) return undefined;

      const name = String(data.sender?.card || data.sender?.nickname || "").trim();
      const text = flattenMessageText(data.message) || String(data.raw_message ?? "").trim();
      if (!text && !name) return undefined;

      const selfId = this.#cfg.selfId ?? "";
      const senderId = String(data.sender?.user_id ?? "");

      return {
        senderName: name || senderId,
        excerpt: text.replace(/\s+/g, " ").slice(0, 200),
        senderIsSelf: Boolean(selfId) && senderId === selfId,
      };
    } catch {
      // 消息可能已经撤回或超出时限，取不到就算了
      return undefined;
    }
  }

  /** 拉最近聊天记录，断线重连后补漏用 */
  async getHistory(
    convKey: string,
    count = 20,
  ): Promise<
    Array<{ id: string; senderId: string; senderName: string; isSelf: boolean; text: string; ts: number }>
  > {
    const { type, externalId } = parseConvKey(convKey);
    if (type !== "group" && type !== "private") return [];

    const action = type === "group" ? "get_group_msg_history" : "get_friend_msg_history";
    const params =
      type === "group" ? { group_id: externalId, count } : { user_id: externalId, count };

    try {
      const data = (await this.#call(action, params)) as { messages?: unknown[] } | undefined;
      const list = Array.isArray(data?.messages) ? data!.messages : [];

      const out: Array<{
        id: string;
        senderId: string;
        senderName: string;
        isSelf: boolean;
        text: string;
        ts: number;
      }> = [];

      for (const raw of list) {
        const item = raw as Record<string, unknown>;
        // 历史消息的形状和事件差不多，复用同一套解析，省得维护两份
        const event = {
          ...item,
          post_type: "message",
          message_type: type,
          self_id: item.self_id ?? this.#cfg.selfId,
          group_id: type === "group" ? externalId : undefined,
        };
        const env = normalizeOneBotEvent(
          event as unknown as OB11Event,
          this.#cfg.channelId,
          this.#cfg.selfId ?? String(item.self_id ?? ""),
        );
        if (!env) continue;

        out.push({
          id: env.id,
          senderId: env.sender.id,
          senderName: env.sender.name,
          isSelf: env.sender.isSelf,
          text: env.text,
          ts: env.ts,
        });
      }

      return out;
    } catch {
      // 有些实现不支持这个 action，取不到就算了，不该影响正常收发
      return [];
    }
  }

  /** 同意 / 拒绝好友申请或加群邀请 */
  async respondRequest(req: PendingRequest, approve: boolean): Promise<void> {
    if (req.kind === "friend") {
      await this.#call("set_friend_add_request", { flag: req.id, approve });
      return;
    }
    await this.#call("set_group_add_request", {
      flag: req.id,
      sub_type: req.subType ?? "add",
      approve,
    });
  }
  async start(): Promise<void> {
    if (this.#cfg.wsUrl) {
      this.#stopped = false;
      await this.#connectWs();
      return;
    }

    if (this.#server) return;

    const server = createServer((req, res) => {
      void this.#handleHttp(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#cfg.eventPort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.#server = server;
    this.#onNotice?.({
      channelId: this.#cfg.channelId,
      kind: "online",
      message: `事件上报已监听 127.0.0.1:${this.#cfg.eventPort}${this.#cfg.eventPath}`,
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;

    for (const [echo, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`连接已关闭，请求 ${echo} 取消`));
    }
    this.#pending.clear();

    const ws = this.#ws;
    this.#ws = undefined;
    if (ws) {
      try {
        ws.close(1000, "bye");
      } catch {
        // 已经关了
      }
    }

    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async send(convKey: string, msg: OutboundMessage): Promise<SendResult> {
    const { type, externalId } = parseConvKey(convKey);

    const segments: OB11Segment[] = [];
    if (msg.replyTo) segments.push({ type: "reply", data: { id: msg.replyTo } });
    for (const uid of msg.mentionUserIds ?? []) segments.push({ type: "at", data: { qq: uid } });
    for (const text of msg.segments) {
      if (!text) continue;
      segments.push({ type: "text", data: { text } });
    }
    if (segments.length === 0) return { messageId: "" };

    const isGroup = type === "group";
    const action = isGroup ? "send_group_msg" : "send_private_msg";
    const params = isGroup
      ? { group_id: asId(externalId), message: segments }
      : { user_id: asId(externalId), message: segments };

    const data = await this.#call(action, params);
    return { messageId: String((data as { message_id?: unknown })?.message_id ?? "") };
  }

  /** 撤回自己发的消息（只能撤自己发的，撤别人的需要管理员权限） */
  async recall(_convKey: string, messageId: string): Promise<void> {
    await this.#call("delete_msg", { message_id: asId(messageId) });
  }

  /** 发图片：image 可以是本地绝对路径、http(s) 链接，或 NapCat 支持的 base64 */
  async sendImage(convKey: string, image: string): Promise<SendResult> {
    const { type, externalId } = parseConvKey(convKey);
    const message: OB11Segment[] = [{ type: "image", data: { file: image } }];
    const isGroup = type === "group";
    const action = isGroup ? "send_group_msg" : "send_private_msg";
    const params = isGroup
      ? { group_id: asId(externalId), message }
      : { user_id: asId(externalId), message };

    const data = await this.#call(action, params);
    return { messageId: String((data as { message_id?: unknown })?.message_id ?? "") };
  }

  /** 发一条语音。mp3 直接发，NapCat 会自己转格式（实测可用） */
  async sendVoice(convKey: string, file: string): Promise<SendResult> {
    const { type, externalId } = parseConvKey(convKey);
    const message: OB11Segment[] = [{ type: "record", data: { file } }];
    const isGroup = type === "group";
    const action = isGroup ? "send_group_msg" : "send_private_msg";
    const params = isGroup
      ? { group_id: asId(externalId), message }
      : { user_id: asId(externalId), message };

    const data = await this.#call(action, params);
    return { messageId: String((data as { message_id?: unknown })?.message_id ?? "") };
  }

  /** 主动退群：不可逆，退了要群主重新同意才能回来 */
  async leaveGroup(convKey: string): Promise<void> {
    const { type, externalId } = parseConvKey(convKey);
    if (type !== "group") throw new Error("只能退群，私聊退不了");
    await this.#call("set_group_leave", { group_id: asId(externalId) });
  }

  async listConversations(): Promise<Conversation[]> {    const data = await this.#call("get_group_list", {});
    const list = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    return list.map((g) => {
      const id = String(g.group_id ?? "");
      return {
        key: makeConvKey(this.#cfg.channelId, "group", id),
        channelId: this.#cfg.channelId,
        type: "group" as const,
        externalId: id,
        title: typeof g.group_name === "string" ? g.group_name : undefined,
        memberCount: typeof g.member_count === "number" ? g.member_count : undefined,
      };
    });
  }

  async #call(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#cfg.wsUrl) {
      return this.#callWs(action, params);
    }

    const url = `${this.#cfg.baseUrl.replace(/\/+$/, "")}/${action}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#cfg.token) headers.authorization = `Bearer ${this.#cfg.token}`;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(params) });
    if (!res.ok) {
      throw new Error(`OneBot ${action} 失败: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { status?: string; retcode?: number; data?: unknown; message?: string };
    if (json.status === "failed" || (typeof json.retcode === "number" && json.retcode !== 0)) {
      throw new Error(`OneBot ${action} 返回错误: ${json.retcode} ${json.message ?? ""}`);
    }
    return json.data;
  }

  // ------------------------------------------------------------------ 正向 WebSocket

  async #connectWs(): Promise<void> {
    const url = this.#cfg.wsUrl;
    if (!url) throw new Error("缺少 wsUrl");

    const ws = new WebSocket(url);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`WebSocket 连接超时：${url}`));
      }, 15_000);

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#retry = 0;
        this.#onNotice?.({
          channelId: this.#cfg.channelId,
          kind: "online",
          message: `已连接 ${url}`,
        });
        resolve();
      });

      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`WebSocket 连接失败：${url}`));
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        this.#onWsMessage(event.data);
      });

      ws.addEventListener("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket 提前关闭：${url}`));
          return;
        }
        if (this.#stopped) return;
        this.#onNotice?.({
          channelId: this.#cfg.channelId,
          kind: "offline",
          message: "连接断开，准备重连",
        });
        this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    this.#retry += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.#retry, 5));
    setTimeout(() => {
      if (this.#stopped) return;
      this.#connectWs().catch(() => this.#scheduleReconnect());
    }, delay);
  }

  #onWsMessage(raw: unknown): void {
    if (typeof raw !== "string") return;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    // 带 echo 的是动作响应，不是事件
    const echo = payload.echo;
    if (typeof echo === "string" && this.#pending.has(echo)) {
      const pending = this.#pending.get(echo)!;
      this.#pending.delete(echo);
      clearTimeout(pending.timer);

      const retcode = typeof payload.retcode === "number" ? payload.retcode : 0;
      if (payload.status === "failed" || retcode !== 0) {
        pending.reject(
          new Error(`OneBot 动作失败：${retcode} ${String(payload.message ?? payload.wording ?? "")}`),
        );
      } else {
        pending.resolve(payload.data);
      }
      return;
    }

    const selfId = this.#cfg.selfId ?? String(payload.self_id ?? "");
    const envelope = normalizeOneBotEvent(payload as unknown as OB11Event, this.#cfg.channelId, selfId);
    if (envelope) {
      this.#onMessage?.(envelope);
      return;
    }
    const request = normalizeOneBotRequest(payload, this.#cfg.channelId);
    if (request) {
      this.#onRequest?.(request);
      return;
    }

    const notice = normalizeOneBotNotice(payload, this.#cfg.channelId, selfId);
    if (notice) this.#onNotice?.(notice);
  }

  async #callWs(action: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`OneBot WS 未连接，无法执行 ${action}`);
    }

    this.#echoSeq += 1;
    const echo = `e${this.#echoSeq}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`OneBot 动作超时：${action}`));
      }, 15_000);

      this.#pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        this.#pending.delete(echo);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }

    if (url.pathname !== this.#cfg.eventPath) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    if (this.#cfg.eventToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${this.#cfg.eventToken}`) {
        res.writeHead(401).end();
        return;
      }
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }

    // 先回 200，避免 NapCat 因超时重推同一条消息
    res.writeHead(204).end();

    let event: OB11Event;
    try {
      event = JSON.parse(raw) as OB11Event;
    } catch {
      return;
    }

    const selfId = this.#cfg.selfId ?? String(event.self_id ?? "");
    const envelope = normalizeOneBotEvent(event, this.#cfg.channelId, selfId);
    if (envelope) {
      this.#onMessage?.(envelope);
      return;
    }
    const request = normalizeOneBotRequest(event as unknown as Record<string, unknown>, this.#cfg.channelId);
    if (request) {
      this.#onRequest?.(request);
      return;
    }

    const notice = normalizeOneBotNotice(event as unknown as Record<string, unknown>, this.#cfg.channelId, selfId);
    if (notice) this.#onNotice?.(notice);
  }
}

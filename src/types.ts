/**
 * 领域模型：整个系统只有这一份类型定义，适配器 / 内核 / Provider 都依赖它。
 * 设计原则：不出现任何平台特有字段，平台差异全部收敛在 Adapter 内部。
 */

export type ChannelKind = "onebot11" | "qqbot" | "wecom" | "wechatpy";
export type ConvType = "group" | "private" | "channel";
export type ChannelStatus = "online" | "offline" | "login_required" | "error";

/** 平台能力声明。UI 按能力裁剪，不做"假装支持"。 */
export interface Capabilities {
  sendText: boolean;
  sendImage: boolean;
  mention: boolean;
  quote: boolean;
  recall: boolean;
  typing: boolean;
  maxTextLength: number;
  rateLimit: { perMinute: number; burst: number };
}

export interface Channel {
  id: string;
  kind: ChannelKind;
  label: string;
  status: ChannelStatus;
  selfId?: string;
}

export interface Conversation {
  key: string;
  channelId: string;
  type: ConvType;
  externalId: string;
  title?: string;
  memberCount?: number;
}

export interface Sender {
  id: string;
  name: string;
  isSelf: boolean;
  role?: "owner" | "admin" | "member";
}

export interface ReplyRef {
  id: string;
  senderName: string;
  excerpt: string;
  senderIsSelf: boolean;
}

export interface MediaRef {
  kind: "image" | "file" | "voice";
  url?: string;
}

/** 归一化后的入站消息。适配器的唯一产出物。 */
export interface Envelope {
  id: string;
  convKey: string;
  channelId: string;
  sender: Sender;
  text: string;
  mentions: { self: boolean; users: string[]; all: boolean };
  replyTo?: ReplyRef;
  media: MediaRef[];
  ts: number;
}

export interface OutboundMessage {
  segments: string[];
  replyTo?: string;
  mentionUserIds?: string[];
}

export type NoticeKind =
  | "online"
  | "offline"
  | "error"
  | "kicked"
  | "login_required"
  /** 有人撤回了消息 */
  | "recall"
  /** 被禁言（durationSec 为时长） */
  | "muted"
  | "unmuted"
  | "member_join"
  | "member_leave";

export interface AdapterNotice {
  channelId: string;
  kind: NoticeKind;
  message: string;
  /** 相关的会话（群或私聊） */
  convKey?: string;
  userId?: string;
  /** recall 用：被撤回的消息 id */
  messageId?: string;
  /** muted 用：禁言时长（秒） */
  durationSec?: number;
}

/** 好友申请 / 加群邀请。需要人来拍板，不该让 AI 自动同意 */
export interface PendingRequest {
  /** 平台给的标识，同意/拒绝时原样回传 */
  id: string;
  channelId: string;
  kind: "friend" | "group";
  /** group 场景下：add = 申请入群，invite = 邀请机器人入群 */
  subType?: string;
  userId: string;
  groupId?: string;
  nickname?: string;
  comment?: string;
  ts: number;
}

/** 多模态内容片段：群里有人发图时，把它作为图片喂给模型 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** 文本部分；图片放在 images 里，序列化时再拼成多模态数组 */
  content: string;
  /** data URL 形式的图片，最多两三张 */
  images?: string[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  thinking: boolean;
  reasoningEffort?: "low" | "high" | "max";
  /** 传给 API 的 user_id：用于缓存隔离与内容安全审核，必须是脱敏值 */
  userId?: string;
  signal?: AbortSignal;
}

export interface ChatChunk {
  delta?: string;
  reasoningDelta?: string;
  usage?: Usage;
  finishReason?: string;
}

export interface Provider {
  readonly id: string;
  listModels(): Promise<string[]>;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
}

export interface SendResult {
  messageId: string;
}

export interface Adapter {
  readonly kind: ChannelKind;
  capabilities(): Capabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (env: Envelope) => void): void;
  onNotice(handler: (n: AdapterNotice) => void): void;
  send(convKey: string, msg: OutboundMessage): Promise<SendResult>;
  listConversations(): Promise<Conversation[]>;

  /** 撤回自己发的消息。平台不支持就不实现 */
  recall?(convKey: string, messageId: string): Promise<void>;
  /** 发一张图（本地路径、URL 或平台支持的 file 标识） */
  sendImage?(convKey: string, image: string): Promise<SendResult>;
  /** 发一条语音（本地音频文件路径） */
  sendVoice?(convKey: string, file: string): Promise<SendResult>;
  /** 主动退出群（不可逆） */
  leaveGroup?(convKey: string): Promise<void>;

  /** 收到好友申请 / 加群邀请 */
  onRequest?(handler: (req: PendingRequest) => void): void;
  /** 同意或拒绝一个申请 */
  respondRequest?(req: PendingRequest, approve: boolean): Promise<void>;

  /**
   * 探活：通道真的还能收发吗。
   * 注意这和"WebSocket 还连着"不是一回事 —— QQ 可能已经掉线，但 WS 还在。
   */
  ping?(): Promise<boolean>;

  /**
   * 按消息 id 取回原消息。被引用时用：QQ 只给一个 id，
   * 不给内容的话模型看到的引用就是空的。
   */
  getMessage?(id: string): Promise<
    { senderName: string; excerpt: string; senderIsSelf: boolean } | undefined
  >;

  /**
   * 拉最近的聊天记录。断线期间的消息平台上还在，
   * 不补回来的话它会完全不知道那段时间发生过什么。
   */
  getHistory?(convKey: string, count: number): Promise<
    Array<{
      id: string;
      senderId: string;
      senderName: string;
      isSelf: boolean;
      text: string;
      ts: number;
    }>
  >;
}

// ---------------------------------------------------------------------------
// 会话键：`<channelId>:<type>:<externalId>`，例如 "qq:10001:group:20002"
// ---------------------------------------------------------------------------

export interface ParsedConvKey {
  channelId: string;
  type: ConvType;
  externalId: string;
}

export function makeConvKey(channelId: string, type: ConvType, externalId: string): string {
  return `${channelId}:${type}:${externalId}`;
}

export function parseConvKey(key: string): ParsedConvKey {
  const parts = key.split(":");
  // channelId 自身可能带冒号（如 "qq:10001"），所以从右往左切
  if (parts.length < 3) {
    throw new Error(`invalid convKey: ${key}`);
  }
  const externalId = parts[parts.length - 1]!;
  const type = parts[parts.length - 2] as ConvType;
  const channelId = parts.slice(0, parts.length - 2).join(":");
  if (type !== "group" && type !== "private" && type !== "channel") {
    throw new Error(`invalid conv type in convKey: ${key} (got "${type}")`);
  }
  if (!channelId || !externalId) {
    throw new Error(`invalid convKey: ${key}`);
  }
  return { channelId, type, externalId };
}

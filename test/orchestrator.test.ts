import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  Adapter,
  Capabilities,
  ChannelKind,
  Conversation,
  Envelope,
  OutboundMessage,
  SendResult,
} from "../src/types.ts";
import { Store } from "../src/store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { defaultAgent } from "../src/agent.ts";
import { createLogger } from "../src/logger.ts";

const CONV = "qq:10001:group:30003";
const NOW = new Date(2026, 9, 24, 15, 0, 0).getTime();

class FakeAdapter implements Adapter {
  readonly kind: ChannelKind = "onebot11";
  sent: Array<{ convKey: string; msg: OutboundMessage }> = [];
  recalled: string[] = [];
  images: string[] = [];
  left: string[] = [];

  capabilities(): Capabilities {
    return {
      sendText: true,
      sendImage: false,
      mention: true,
      quote: true,
      recall: false,
      typing: false,
      maxTextLength: 4500,
      rateLimit: { perMinute: 60, burst: 10 },
    };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(): void {}
  onNotice(): void {}
  async send(convKey: string, msg: OutboundMessage): Promise<SendResult> {
    this.sent.push({ convKey, msg });
    return { messageId: String(this.sent.length) };
  }
  async recall(_convKey: string, messageId: string): Promise<void> {
    this.recalled.push(messageId);
  }
  async sendImage(_convKey: string, image: string): Promise<SendResult> {
    this.images.push(image);
    return { messageId: `img${this.images.length}` };
  }
  async leaveGroup(convKey: string): Promise<void> {
    this.left.push(convKey);
  }
  async listConversations(): Promise<Conversation[]> {
    return [];
  }
}

function makeEnv(id: string, text: string, mentioned: boolean, role: "owner" | "admin" | "member" = "member"): Envelope {
  return {
    id,
    convKey: CONV,
    channelId: "qq:10001",
    sender: { id: "20002", name: "小明", isSelf: false, role },
    text,
    mentions: { self: mentioned, users: [], all: false },
    media: [],
    ts: NOW,
  };
}

function setup(
  bindings: Array<{ convKey: string; agentId: string; enabled: boolean }> = [
    { convKey: CONV, agentId: "default", enabled: true },
  ],
  agentOverrides: Partial<ReturnType<typeof defaultAgent>> = {},
) {
  const store = new Store(":memory:");
  const adapter = new FakeAdapter();
  let clock = NOW;

  const orchestrator = new Orchestrator({
    adapter,
    provider: new MockProvider({ delayMs: 0, reply: () => "好的" }),
    store,
    agents: new Map([
      [
        "default",
        defaultAgent({
          trigger: { mode: "mention", cooldownSec: 10, perUserPerHour: 5 },
          ...agentOverrides,
        }),
      ],
    ]),
    bindings,
    quota: { globalDailyCny: 100, bindingDailyCny: 100, onExceed: "notify" },
    logger: createLogger("error", "test"),
    sendDelayMs: 0,
    sleep: async () => {},
    now: () => clock,
  });

  return {
    store,
    adapter,
    orchestrator,
    advance(ms: number) {
      clock += ms;
    },
  };
}

test("引用回复会补上被引用消息的正文（否则模型看到的是空引用）", async () => {
  const { orchestrator } = setup();

  // 先让被引用的那条进入库
  await orchestrator.handleEnvelope(makeEnv("m1", "方案改到周三交", false));

  const env = makeEnv("m2", "这个什么意思", true);
  env.replyTo = { id: "m1", senderName: "", excerpt: "", senderIsSelf: false };

  await orchestrator.handleEnvelope(env);
  await orchestrator.drain();

  assert.equal(env.replyTo?.excerpt, "方案改到周三交");
  assert.equal(env.replyTo?.senderName, "小明");
  assert.equal(env.replyTo?.senderIsSelf, false);
});

test("引用它自己说过的话，能识别出 senderIsSelf", async () => {
  const { store, orchestrator } = setup();

  store.appendMessage({
    id: "bot1",
    convKey: CONV,
    senderId: "self",
    senderName: "大肥鱼",
    isSelf: true,
    text: "本鱼蹲着等",
    ts: NOW - 1000,
  });

  const env = makeEnv("m2", "你刚才说啥", true);
  env.replyTo = { id: "bot1", senderName: "", excerpt: "", senderIsSelf: false };

  await orchestrator.handleEnvelope(env);
  await orchestrator.drain();

  assert.equal(env.replyTo?.excerpt, "本鱼蹲着等");
  assert.equal(env.replyTo?.senderIsSelf, true);
});

test("被禁言时不回复，日志能看出原因", async () => {
  const { adapter, orchestrator } = setup();

  await orchestrator.handleNotice({
    channelId: "qq:10001",
    kind: "muted",
    message: "我自己被禁言 600 秒",
    convKey: CONV,
    durationSec: 600,
  });

  await orchestrator.handleEnvelope(makeEnv("m1", "在吗", true));
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 0, "禁言期间不该发任何消息");
});

test("禁言解除后恢复说话", async () => {
  const { adapter, orchestrator } = setup();

  await orchestrator.handleNotice({
    channelId: "qq:10001",
    kind: "muted",
    message: "禁言",
    convKey: CONV,
    durationSec: 1,
  });
  await orchestrator.handleNotice({ channelId: "qq:10001", kind: "unmuted", message: "解除", convKey: CONV });

  await orchestrator.handleEnvelope(makeEnv("m1", "在吗", true));
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 1);
});

test("传出撤回通知后，那条消息被标记且不再当上下文", async () => {
  const { store, orchestrator } = setup();

  await orchestrator.handleEnvelope(makeEnv("m1", "这句话等一下撤回", false));
  assert.equal(store.getMessage("m1")?.text, "这句话等一下撤回");

  await orchestrator.handleNotice({
    channelId: "qq:10001",
    kind: "recall",
    message: "撤回",
    convKey: CONV,
    messageId: "m1",
  });

  assert.equal(store.getMessage("m1")?.text, "[已撤回]");
});

test("被移出群后不再尝试发言", async () => {
  const { adapter, orchestrator } = setup();

  await orchestrator.handleNotice({ channelId: "qq:10001", kind: "kicked", message: "被移出群", convKey: CONV });
  await orchestrator.handleEnvelope(makeEnv("m1", "在吗", true));
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 0);
});

test("消息少的时候不引用上一句（人少时引用是废话）", async () => {
  const { adapter, orchestrator } = setup();
  await orchestrator.handleEnvelope(makeEnv("m1", "讲个笑话", true));
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]!.msg.segments.join(""), "好的");
  assert.equal(adapter.sent[0]!.msg.replyTo, undefined, "只有一条历史，不该引用");
});

test("历史够多时才会引用原消息", async () => {
  const { adapter, orchestrator, store } = setup();
  for (let i = 0; i < 10; i += 1) {
    store.appendMessage({
      id: `h${i}`,
      convKey: CONV,
      senderId: "20003",
      senderName: "小红",
      isSelf: false,
      text: `历史消息 ${i}`,
      ts: NOW + i,
    });
  }

  await orchestrator.handleEnvelope(makeEnv("m2", "你还记得吗", true));
  await orchestrator.drain();

  assert.equal(adapter.sent[0]!.msg.replyTo, "m2", "消息多了应该引用");
});

test("同一 message_id 重复上报不会重复回复", async () => {
  const { adapter, orchestrator } = setup();
  await orchestrator.handleEnvelope(makeEnv("m1", "在吗", true));
  await orchestrator.drain();
  await orchestrator.handleEnvelope(makeEnv("m1", "在吗", true));
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 1);
});

test("没被 @ 时不回复", async () => {
  const { adapter, orchestrator } = setup();
  await orchestrator.handleEnvelope(makeEnv("m2", "今天吃啥", false));
  await orchestrator.drain();
  assert.equal(adapter.sent.length, 0);
});

test("冷却期内第二条不回复，时间推进后恢复", async () => {
  const { adapter, orchestrator, advance } = setup();

  await orchestrator.handleEnvelope(makeEnv("m3", "问题一", true));
  await orchestrator.drain();
  assert.equal(adapter.sent.length, 1);

  await orchestrator.handleEnvelope(makeEnv("m4", "问题二", true));
  await orchestrator.drain();
  assert.equal(adapter.sent.length, 1, "冷却期内不应回复");

  advance(11_000);
  await orchestrator.handleEnvelope(makeEnv("m5", "问题三", true));
  await orchestrator.drain();
  assert.equal(adapter.sent.length, 2);
});

test("机器人自己的消息不触发", async () => {
  const { adapter, orchestrator } = setup();
  const env = makeEnv("m6", "我是机器人", true);
  env.sender = { id: "10001", name: "小D", isSelf: true };
  await orchestrator.handleEnvelope(env);
  await orchestrator.drain();
  assert.equal(adapter.sent.length, 0);
});

test("/reset 仅群主或管理员可用", async () => {
  const { adapter, orchestrator, store } = setup();
  store.setSummary(CONV, "之前的摘要", 0, NOW);

  await orchestrator.handleEnvelope(makeEnv("m7", "/reset", false, "member"));
  await orchestrator.drain();
  assert.equal(store.getSummary(CONV), "之前的摘要", "普通成员不能清空");
  assert.equal(adapter.sent.length, 1);

  await orchestrator.handleEnvelope(makeEnv("m8", "/reset", false, "owner"));
  await orchestrator.drain();
  assert.equal(store.getSummary(CONV), undefined);
});

test("未绑定的群：消息要记录下来，但不能回复", async () => {
  const { adapter, orchestrator, store } = setup();
  const env = makeEnv("m9", "在吗", true);
  env.convKey = "qq:10001:group:99999";
  await orchestrator.handleEnvelope(env);
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 0, "未绑定就不该回复");
  assert.equal(store.messageCount("qq:10001:group:99999"), 1, "但消息应当被记录");
});

test("通配符绑定匹配该通道下任意群（QQ 官方机器人首次配置靠它）", async () => {
  const { adapter, orchestrator } = setup([
    { convKey: "qqbot:102030405:group:*", agentId: "default", enabled: true },
  ]);

  const env = makeEnv("w1", "第一次 @ 机器人", true);
  env.convKey = "qqbot:102030405:group:SOME_OPENID";
  env.channelId = "qqbot:102030405";

  await orchestrator.handleEnvelope(env);
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]!.convKey, "qqbot:102030405:group:SOME_OPENID");
});

test("回复时会 @ 提问的人（只 @ 第一条）", async () => {
  const { adapter, orchestrator } = setup();
  await orchestrator.handleEnvelope(makeEnv("a1", "你好", true));
  await orchestrator.drain();

  assert.deepEqual(adapter.sent[0]!.msg.mentionUserIds, ["20002"]);
});

test("/help：带 @ 前缀也能识别（群里正常用法）", async () => {
  const { adapter, orchestrator } = setup();
  await orchestrator.handleEnvelope(makeEnv("h1", "@大肥鱼 /help", true));
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 1);
  assert.ok(adapter.sent[0]!.msg.segments.join("").includes("/reset"), "应当回帮助文本");
});

test("/撤回：管理员能收回上一条", async () => {
  const { adapter, orchestrator } = setup();
  await orchestrator.handleEnvelope(makeEnv("a2", "你好", true));
  await orchestrator.drain();
  assert.equal(adapter.sent.length, 1);

  await orchestrator.handleEnvelope(makeEnv("a3", "/撤回", false, "owner"));
  await orchestrator.drain();

  assert.deepEqual(adapter.recalled, ["1"]);
});

test("/撤回：普通成员没权限", async () => {
  const { adapter, orchestrator } = setup();
  await orchestrator.handleEnvelope(makeEnv("a4", "你好", true));
  await orchestrator.drain();

  await orchestrator.handleEnvelope(makeEnv("a5", "/撤回", false, "member"));
  await orchestrator.drain();

  assert.equal(adapter.recalled.length, 0);
  assert.ok(adapter.sent.some((s) => s.msg.segments.join("").includes("只有群主")));
});

test("/撤回：能收回刚发出的命令回复", async () => {
  const { adapter, orchestrator } = setup();

  await orchestrator.handleEnvelope(makeEnv("h2", "@大肥鱼 /help", true));
  await orchestrator.drain();
  const helpId = adapter.sent.at(-1)!.msg && String(adapter.sent.length);
  assert.equal(adapter.sent.length, 1);

  await orchestrator.handleEnvelope(makeEnv("h3", "/撤回", false, "owner"));
  await orchestrator.drain();

  assert.deepEqual(adapter.recalled, [helpId]);
});

test("/退群：没确认就不退，确认后才退", async () => {
  const { adapter, orchestrator } = setup(undefined, { allowLeave: true });

  await orchestrator.handleEnvelope(makeEnv("b1", "/退群", false, "owner"));
  await orchestrator.drain();
  assert.equal(adapter.left.length, 0, "没确认不该退");
  assert.ok(adapter.sent.some((s) => s.msg.segments.join("").includes("确认")));

  await orchestrator.handleEnvelope(makeEnv("b2", "/退群 确认", false, "owner"));
  await orchestrator.drain();
  assert.equal(adapter.left.length, 1, "确认后应该退");
});

test("/退群：开关没开时拒绝", async () => {
  const { adapter, orchestrator } = setup(); // allowLeave 默认 false
  await orchestrator.handleEnvelope(makeEnv("b3", "/退群 确认", false, "owner"));
  await orchestrator.drain();
  assert.equal(adapter.left.length, 0);
});

test("/表情：没配目录时给出提示，不报错", async () => {
  const { adapter, orchestrator } = setup();
  await orchestrator.handleEnvelope(makeEnv("c1", "/表情", false, "owner"));
  await orchestrator.drain();

  assert.equal(adapter.images.length, 0);
  assert.ok(adapter.sent.some((s) => s.msg.segments.join("").includes("表情包")));
});

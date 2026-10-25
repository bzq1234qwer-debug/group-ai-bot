import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText, parseWordList, DEFAULT_BLOCKLIST } from "../src/safety.ts";
import { Store } from "../src/store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { defaultAgent } from "../src/agent.ts";
import { createLogger } from "../src/logger.ts";
import type { Adapter, Capabilities, Envelope, OutboundMessage, SendResult } from "../src/types.ts";

const CONV = "qq:10001:group:30003";
const NOW = 1_700_000_000_000;

test("命中屏蔽词能识别出来", () => {
  const r = scanText("有人要买毒品吗", DEFAULT_BLOCKLIST);
  assert.equal(r.hit, true);
  assert.ok(r.matched.includes("毒品"));
});

test("正常聊天不会误伤", () => {
  const r = scanText("今天中午吃什么，食堂的鱼还行", DEFAULT_BLOCKLIST);
  assert.equal(r.hit, false);
});

test("词表解析：逗号、顿号、换行都能分开，短词丢弃", () => {
  assert.deepEqual(parseWordList("毒品，赌博、诈骗\n刷单, 好"), ["毒品", "赌博", "诈骗", "刷单"]);
});

class FakeAdapter implements Adapter {
  readonly kind = "onebot11" as const;
  sent: OutboundMessage[] = [];
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
  async send(_c: string, msg: OutboundMessage): Promise<SendResult> {
    this.sent.push(msg);
    return { messageId: String(this.sent.length) };
  }
  async listConversations() {
    return [];
  }
}

function makeEnv(text: string): Envelope {
  return {
    id: `m-${text}`,
    convKey: CONV,
    channelId: "qq:10001",
    sender: { id: "20002", name: "小明", isSelf: false, role: "member" },
    text,
    mentions: { self: true, users: [], all: false },
    media: [],
    ts: NOW,
  } as unknown as Envelope;
}

function setup(reply: string) {
  const store = new Store(":memory:");
  const adapter = new FakeAdapter();
  const orchestrator = new Orchestrator({
    adapter,
    provider: new MockProvider({ delayMs: 0, reply: () => reply }),
    store,
    agents: new Map([["default", defaultAgent({ trigger: { mode: "mention", cooldownSec: 0, perUserPerHour: 10 } })]]),
    bindings: [{ convKey: CONV, agentId: "default", enabled: true }],
    quota: { globalDailyCny: 100, bindingDailyCny: 100, onExceed: "notify" },
    logger: createLogger("error", "test"),
    safety: { enabled: true, words: ["毒品", "赌博"], reply: "这个不接。" },
    sendDelayMs: 0,
    sleep: async () => {},
    now: () => NOW,
  });
  return { store, adapter, orchestrator };
}

test("入站：话题命中屏蔽词就不回", async () => {
  const { adapter, orchestrator } = setup("好的");
  await orchestrator.handleEnvelope(makeEnv("哪里能买毒品"));
  await orchestrator.drain();
  assert.equal(adapter.sent.length, 0);
});

test("出站：模型说了违规内容会被挡下，换成安全回应", async () => {
  const { adapter, orchestrator } = setup("想赌一把吗，我这儿能赌博");
  await orchestrator.handleEnvelope(makeEnv("在吗"));
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]!.segments[0], "这个不接。");
});

test("关闭安全后不拦截", async () => {
  const store = new Store(":memory:");
  const adapter = new FakeAdapter();
  const orchestrator = new Orchestrator({
    adapter,
    provider: new MockProvider({ delayMs: 0, reply: () => "我这儿能赌博" }),
    store,
    agents: new Map([["default", defaultAgent({ trigger: { mode: "mention", cooldownSec: 0, perUserPerHour: 10 } })]]),
    bindings: [{ convKey: CONV, agentId: "default", enabled: true }],
    quota: { globalDailyCny: 100, bindingDailyCny: 100, onExceed: "notify" },
    logger: createLogger("error", "test"),
    safety: { enabled: false, words: ["赌博"], reply: "这个不接。" },
    sendDelayMs: 0,
    sleep: async () => {},
    now: () => NOW,
  });

  await orchestrator.handleEnvelope(makeEnv("在吗"));
  await orchestrator.drain();
  assert.equal(adapter.sent[0]!.segments[0], "我这儿能赌博");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.ts";
import { Store } from "../src/store.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { defaultAgent } from "../src/agent.ts";
import { createLogger } from "../src/logger.ts";
import type { Adapter, Capabilities, Envelope, OutboundMessage, SendResult } from "../src/types.ts";

const CONV = "qq:10001:group:30003";
const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();

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
  async send(_c: string, m: OutboundMessage): Promise<SendResult> {
    this.sent.push(m);
    return { messageId: String(this.sent.length) };
  }
  async listConversations() {
    return [];
  }
}

function makeEnv(): Envelope {
  return {
    id: "m1",
    convKey: CONV,
    channelId: "qq:10001",
    sender: { id: "20002", name: "小明", isSelf: false, role: "member" },
    text: "在吗",
    mentions: { self: true, users: [], all: false },
    media: [],
    ts: NOW,
  } as unknown as Envelope;
}

function setup(globalDailyCny: number, bindingDailyCny: number) {
  const store = new Store(":memory:");
  const adapter = new FakeAdapter();

  // 先记一笔已经花掉的钱，模拟今天已经用过额度
  store.recordUsage({
    bindingId: CONV,
    model: "deepseek-flash",
    tokensIn: 1000,
    tokensOut: 1000,
    reasoningTokens: 0,
    cacheHit: 0,
    costUsd: 0.5,
    ts: NOW - 60_000,
  });

  const orchestrator = new Orchestrator({
    adapter,
    provider: new MockProvider({ delayMs: 0, reply: () => "好的" }),
    store,
    agents: new Map([["default", defaultAgent({ trigger: { mode: "mention", cooldownSec: 0, perUserPerHour: 10 } })]]),
    bindings: [{ convKey: CONV, agentId: "default", enabled: true }],
    quota: { globalDailyCny, bindingDailyCny, onExceed: "notify" },
    logger: createLogger("error", "test"),
    sendDelayMs: 0,
    sleep: async () => {},
    now: () => NOW,
  });

  return { store, adapter, orchestrator };
}

test("预算已用尽时不再花钱（回一句提醒就停）", async () => {
  const { adapter, orchestrator } = setup(1, 1);
  await orchestrator.handleEnvelope(makeEnv());
  await orchestrator.drain();

  // 只该有一条"额度用完了"的提醒，不该有正常回复
  assert.equal(adapter.sent.length, 1);
  assert.ok(adapter.sent[0]!.segments[0]!.includes("额度"));
});

test("上限填 0 表示不限，照常回复", async () => {
  const { adapter, orchestrator } = setup(0, 0);
  await orchestrator.handleEnvelope(makeEnv());
  await orchestrator.drain();

  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]!.segments[0], "好的");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { backfillConversations } from "../src/backfill.ts";
import type { Adapter, Capabilities, Conversation, Envelope, OutboundMessage, SendResult } from "../src/types.ts";

const CONV = "qq:10001:group:30003";
const NOW = 1_700_000_000_000;

class FakeAdapter implements Adapter {
  readonly kind = "onebot11" as const;
  history: Array<{ id: string; senderId: string; senderName: string; isSelf: boolean; text: string; ts: number }> = [];
  asks: Array<{ convKey: string; count: number }> = [];

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
  async send(_c: string, _m: OutboundMessage): Promise<SendResult> {
    return { messageId: "1" };
  }
  async listConversations(): Promise<Conversation[]> {
    return [];
  }
  async getHistory(convKey: string, count: number) {
    this.asks.push({ convKey, count });
    return this.history;
  }
}

test("补拉：只补比本地更新的消息", async () => {
  const store = new Store(":memory:");
  const adapter = new FakeAdapter();

  // 本地已经有一条更早的消息
  store.appendMessage({
    id: "old",
    convKey: CONV,
    senderId: "u1",
    senderName: "小明",
    isSelf: false,
    text: "断线前的话",
    ts: NOW - 10_000,
  });

  adapter.history = [
    { id: "old", senderId: "u1", senderName: "小明", isSelf: false, text: "断线前的话", ts: NOW - 10_000 },
    { id: "new1", senderId: "u2", senderName: "小红", isSelf: false, text: "断线期间说的话", ts: NOW - 5_000 },
  ];

  const result = await backfillConversations({ store, adapter, convKeys: [CONV] });
  assert.equal(result.added, 1, "只该补新的那条");
  assert.equal(store.getMessage("new1")?.text, "断线期间说的话");
  store.close();
});

test("补拉：重复调用不会写重复消息", async () => {
  const store = new Store(":memory:");
  const adapter = new FakeAdapter();
  adapter.history = [
    { id: "m1", senderId: "u1", senderName: "小明", isSelf: false, text: "第一条", ts: NOW - 1000 },
  ];

  await backfillConversations({ store, adapter, convKeys: [CONV] });
  const second = await backfillConversations({ store, adapter, convKeys: [CONV] });

  assert.equal(second.added, 0);
  store.close();
});

test("补拉：平台不支持时安静返回，不抛错", async () => {
  const store = new Store(":memory:");
  const adapter = new FakeAdapter();
  // @ts-expect-error 故意去掉能力
  adapter.getHistory = undefined;

  const result = await backfillConversations({ store, adapter, convKeys: [CONV] });
  assert.deepEqual(result, { added: 0, scanned: 0 });
  store.close();
});

test("补拉：空文本（纯图片等）不写入", async () => {
  const store = new Store(":memory:");
  const adapter = new FakeAdapter();
  adapter.history = [
    { id: "m1", senderId: "u1", senderName: "小明", isSelf: false, text: "", ts: NOW },
  ];

  const result = await backfillConversations({ store, adapter, convKeys: [CONV] });
  assert.equal(result.added, 0);
  store.close();
});

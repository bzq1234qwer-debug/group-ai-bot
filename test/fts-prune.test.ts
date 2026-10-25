import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";

const CONV = "qq:1:group:100";

function add(store: Store, i: number, text: string): void {
  store.appendMessage({
    id: `m${i}`,
    convKey: CONV,
    senderId: "u1",
    senderName: "小明",
    isSelf: false,
    text,
    ts: 1_700_000_000_000 + i * 1000,
  });
}

test("全文索引有总容量上限，超了丢最旧的", () => {
  const store = new Store(":memory:", { ftsMaxRows: 100 });
  for (let i = 0; i < 1200; i += 1) add(store, i, `第${i}条消息`);

  // 每 500 条才清理一次，所以允许超出上限一点点
  assert.ok(store.countFts() <= 600, `索引不该无限增长，实际 ${store.countFts()}`);
  // 最新的一条必须还能搜到
  assert.ok(store.searchMemory(CONV, "第1199条消息", 3).length > 0);
  store.close();
});

test("容量设 0 表示不清理", () => {
  const store = new Store(":memory:", { ftsMaxRows: 0 });
  for (let i = 0; i < 520; i += 1) add(store, i, `第${i}条`);

  assert.equal(store.countFts(), 520);
  store.close();
});

test("消息表按会话封顶，但索引仍然保留旧话（长期记忆的意义）", () => {
  const store = new Store(":memory:", { ftsMaxRows: 100_000 });

  add(store, 0, "很久以前说过要还钱");
  for (let i = 1; i < 2300; i += 1) add(store, i, `普通消息${i}`);

  // 工作副本封顶 2000 条，最早那条已经被清出 messages
  assert.equal(store.getMessage("m0"), undefined, "旧消息应当被清出工作副本");

  // 但全文索引里还在，所以"想得起来"
  const hits = store.searchMemory(CONV, "还钱", 3);
  assert.ok(hits.length > 0, "被清出消息表的旧话应当仍可检索");
  store.close();
});

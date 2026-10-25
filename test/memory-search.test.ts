import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, extractSearchTerms, segmentForFts } from "../src/store.ts";

function add(store: Store, convKey: string, id: string, text: string, ts: number, isSelf = false): void {
  store.appendMessage({
    id,
    convKey,
    senderId: isSelf ? "self" : "u1",
    senderName: isSelf ? "AI" : "小明",
    isSelf,
    text,
    ts,
  });
}

test("分词：中文按字拆开，英文保持原样", () => {
  assert.equal(segmentForFts("方案A"), "方 案 A");
  assert.equal(segmentForFts("hello 世界"), "hello 世 界");
});

test("检索词：中文取二字片段", () => {
  const terms = extractSearchTerms("这个报错怎么修");
  assert.ok(terms.includes("报错"));
  assert.ok(terms.includes("怎么"));
  assert.ok(terms.length <= 8);
});

test("能从历史里搜到相关的一句话", () => {
  const store = new Store(":memory:");
  add(store, "g1", "m1", "上周说好周三交方案的", 1000);
  add(store, "g1", "m2", "今天中午吃什么", 2000);

  const hits = store.searchMemory("g1", "方案还没交", 5);
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.text.includes("方案"));

  store.close();
});

test("检索只在本会话内查，不串群", () => {
  const store = new Store(":memory:");
  add(store, "g1", "m1", "这是A群说的方案", 1000);
  add(store, "g2", "m2", "这是B群说的方案", 2000);

  const hits = store.searchMemory("g1", "方案", 5);
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.text.includes("A群"));

  store.close();
});

test("搜不到就返回空，不抛错", () => {
  const store = new Store(":memory:");
  add(store, "g1", "m1", "完全无关的内容", 1000);
  assert.deepEqual(store.searchMemory("g1", "量子力学", 5), []);
  store.close();
});

test("消息被 200 条上限挤掉后，仍然能被检索到", () => {
  const store = new Store(":memory:");
  add(store, "g1", "old", "三个月前约定过要还钱这件事", 1000);

  // 再塞 250 条，把最早的挤出 messages 表
  for (let i = 0; i < 250; i += 1) {
    add(store, "g1", `bulk${i}`, `普通消息 ${i}`, 2000 + i);
  }

  const hits = store.searchMemory("g1", "还钱", 5);
  assert.equal(hits.length, 1, "原文虽然被删了，索引里还在");
  assert.ok(hits[0]!.text.includes("还钱"));

  store.close();
});

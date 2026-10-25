import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();

function add(store: Store, id: string, sender: string, text: string, ts: number): void {
  store.appendMessage({
    id,
    convKey: "g1",
    senderId: sender,
    senderName: sender,
    isSelf: false,
    text,
    ts,
  });
}

test("多路召回：同一个人说过的话会被顶上来", () => {
  const store = new Store(":memory:");
  add(store, "a", "小红", "方案已经发你了", NOW - 3 * DAY);
  add(store, "b", "小明", "方案我看过了", NOW - 3 * DAY);

  const fromXiaoming = store.recallMemory("g1", "方案", { senderName: "小明", now: NOW, limit: 2 });
  assert.equal(fromXiaoming[0]!.sender, "小明", "提问的人说过的话应当优先");

  store.close();
});

test("多路召回：最近说的话权重更高", () => {
  const store = new Store(":memory:");
  add(store, "old", "小红", "方案在旧文件里", NOW - 60 * DAY);
  add(store, "new", "小红", "方案在今天的文件里", NOW - 1 * DAY);

  const hits = store.recallMemory("g1", "方案", { now: NOW, limit: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.text, "方案在今天的文件里", "更新的一句应当排在前面");

  store.close();
});

test("多路召回：没命中就是空，不乱给", () => {
  const store = new Store(":memory:");
  add(store, "a", "小红", "今天天气不错", NOW - DAY);

  assert.deepEqual(store.recallMemory("g1", "量子力学", { now: NOW }), []);
  store.close();
});

test("多路召回：返回结果带分数且从高到低", () => {
  const store = new Store(":memory:");
  add(store, "a", "小明", "方案一", NOW - DAY);
  add(store, "b", "小明", "方案二", NOW - 2 * DAY);
  add(store, "c", "小红", "方案三", NOW - 3 * DAY);

  const hits = store.recallMemory("g1", "方案", { senderName: "小明", now: NOW, limit: 3 });
  assert.equal(hits.length, 3);
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i - 1]!.score >= hits[i]!.score, "分数必须非递增");
  }
  store.close();
});

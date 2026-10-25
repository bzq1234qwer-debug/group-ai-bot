import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTrigger, createTriggerState } from "../src/trigger.ts";
import type { Envelope } from "../src/types.ts";

const NOW = 1_700_000_000_000;
const CONV = "qq:1:group:100";

function make(text: string, self = false, replyToSelf = false): Envelope {
  return {
    id: "m1",
    channelId: "qq:1",
    convKey: CONV,
    conv: { key: CONV, channelId: "qq:1", type: "group", externalId: "100" },
    sender: { id: "u1", name: "小明" },
    text,
    mentions: { self, all: false, users: [] },
    media: [],
    ts: NOW,
    replyTo: replyToSelf
      ? { id: "r", senderName: "AI", excerpt: "嗯", senderIsSelf: true }
      : undefined,
  } as unknown as Envelope;
}

const policy = {
  mode: "interject" as const,
  cooldownSec: 20,
  perUserPerHour: 10,
  interject: { rate: 0.4, threshold: 0.85, names: ["大肥鱼"] },
};

test("刚回过话，别人立刻 @ 它 —— 不该被 20 秒冷却挡住", () => {
  const state = createTriggerState();
  // 正在聊天时冷却只有 4 秒，所以取 2 秒前（仍在冷却内） // 5 秒前刚回过
    state.lastReplyAt.set(CONV, NOW - 2_000);

  const result = evaluateTrigger(make("@我 这个怎么弄", true), policy, state, NOW, () => 0);
  assert.equal(result.respond, true, `被挡住了：${result.reason}`);
});

test("刚回过话，普通闲聊在冷却内仍然不接（防刷屏）", () => {
  const state = createTriggerState();
  // 正在聊天时冷却只有 4 秒，所以取 2 秒前（仍在冷却内）
  state.lastReplyAt.set(CONV, NOW - 2_000);

  const result = evaluateTrigger(make("今天天气不错"), policy, state, NOW, () => 1);
  assert.equal(result.respond, false);
  assert.equal(result.reason, "cooldown");
});

test("私聊不受 20 秒冷却限制", () => {
  const state = createTriggerState();
  const privateConv = "qq:1:private:20002";
  state.lastReplyAt.set(privateConv, NOW - 4_000);

  const env = {
    ...make("在吗", false),
    convKey: privateConv,
    conv: { key: privateConv, channelId: "qq:1", type: "private", externalId: "20002" },
  } as unknown as Envelope;

  const result = evaluateTrigger(env, policy, state, NOW, () => 0);
  assert.equal(result.respond, true);
});

test("@ 它的冷却仍然存在，只是缩短到 3 秒", () => {
  const state = createTriggerState();
  state.lastReplyAt.set(CONV, NOW - 1_000); // 1 秒前刚回过

  const result = evaluateTrigger(make("@我 在吗", true), policy, state, NOW, () => 0);
  assert.equal(result.respond, false);
  assert.equal(result.reason, "cooldown");
});

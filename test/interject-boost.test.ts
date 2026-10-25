import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTrigger, createTriggerState, shouldInterject } from "../src/trigger.ts";
import type { Envelope } from "../src/types.ts";

const NOW = 1_700_000_000_000;
const CONV = "qq:1:group:100";

function make(text: string, opts: Partial<Envelope> = {}): Envelope {
  return {
    id: "m1",
    channelId: "qq:1",
    convKey: CONV,
    conv: { key: CONV, channelId: "qq:1", type: "group", externalId: "100" },
    sender: { id: "u1", name: "小明" },
    text,
    mentions: { self: false, all: false, users: [] },
    media: [],
    ts: NOW,
    ...opts,
  } as unknown as Envelope;
}

const policy = {
  mode: "interject" as const,
  cooldownSec: 20,
  perUserPerHour: 10,
  interject: { rate: 0.4, threshold: 0.85, names: ["大肥鱼", "鱼"] },
};

test("正在聊天时，陈述句也能接上话", () => {
  // 刚说完话 30 秒，陈述句 + 动量加成应当开口
  const state = createTriggerState();
  state.lastReplyAt.set(CONV, NOW - 30_000);

  const result = evaluateTrigger(make("我目前还没给他安装表情包"), policy, state, NOW, () => 1);
  assert.equal(result.respond, true, `应当接话，实际 ${result.reason}`);
});

test("冷启动时，纯陈述句不接话", () => {
  const state = createTriggerState();
  const result = evaluateTrigger(make("我目前还没给他安装表情包"), policy, state, NOW, () => 0);
  assert.equal(result.respond, false);
});

test("叫到名字时基本都会接", () => {
  const state = createTriggerState();
  const result = evaluateTrigger(make("大肥鱼你去哪了"), policy, state, NOW, () => 0);
  assert.equal(result.respond, true);
});

test("有人回复它说过的话，一定会接（哪怕内容只是个「嗯」）", () => {
  const state = createTriggerState();
  const env = make("嗯", {
    replyTo: { id: "x", senderName: "小明", senderIsSelf: true, excerpt: "本鱼蹲着等" },
  });
  const result = evaluateTrigger(env, policy, state, NOW, () => 0);
  assert.equal(result.respond, true);
});

test("名字加分不会让纯喊名字的家常话失控（有冷却）", () => {
  const state = createTriggerState();
  state.lastReplyAt.set(CONV, NOW - 2_000); // 2 秒前刚说过（正在聊天，冷却 4 秒）
  const result = evaluateTrigger(make("大肥鱼你在吗"), policy, state, NOW, () => 0);
  assert.equal(result.respond, false);
  assert.equal(result.reason, "cooldown");
});

test("shouldInterject：动量加成生效", () => {
  const env = make("今天好热啊");
  const base = shouldInterject(env, { rate: 0.4, threshold: 0.85 }, () => 0);
  const hot = shouldInterject(env, { rate: 0.4, threshold: 0.85, inConversation: true }, () => 1);
  assert.equal(base, false);
  assert.equal(hot, true);
});

test("让它说话（说句话 / 喊我哥哥）一定会开口", () => {
  const opt = { rate: 0.1, threshold: 0.85, names: ["大肥鱼"] };
  for (const text of ["说句话", "喊我哥哥", "整活一下", "评价一下"]) {
    assert.equal(shouldInterject(make(text), opt, () => 0), true, `「${text}」应当开口`);
  }
});

test("纯刷屏不接（666 / 标点）", () => {
  const opt = { rate: 0.6, threshold: 0.85, names: ["大肥鱼"], inConversation: true };
  for (const text of ["666", "。。。", "233333"]) {
    assert.equal(shouldInterject(make(text), opt, () => 1), false, `「${text}」不该接`);
  }
});

test("一两个字的应答基本不接", () => {
  const opt = { rate: 0.6, threshold: 0.85, names: ["大肥鱼"] };
  assert.equal(shouldInterject(make("嗯"), opt, () => 1), false);
  assert.equal(shouldInterject(make("哦"), opt, () => 1), false);
});

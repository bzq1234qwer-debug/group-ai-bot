import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeQuestion, shouldInterject } from "../src/trigger.ts";
import type { Envelope } from "../src/types.ts";

function make(text: string, all = false): Envelope {
  return {
    id: "m1",
    channelId: "qq:1",
    convKey: "qq:1:group:100",
    conv: { key: "qq:1:group:100", channelId: "qq:1", type: "group", externalId: "100" },
    sender: { id: "u1", name: "小明" },
    text,
    mentions: { self: false, all, users: [] },
    media: [],
    ts: 1000,
  } as unknown as Envelope;
}

test("疑问词识别：中文不打问号也算问句", () => {
  assert.equal(looksLikeQuestion("在吗"), true);
  assert.equal(looksLikeQuestion("这个报错怎么回事"), true);
  assert.equal(looksLikeQuestion("谁有那个文档"), true);
  assert.equal(looksLikeQuestion("帮我看看这个"), true);
  assert.equal(looksLikeQuestion("今天好热啊"), false);
  assert.equal(looksLikeQuestion("666"), false);
});

test("插话：问句在积极性 0.4 下会触发", () => {
  const opt = { rate: 0.4, threshold: 0.85, keywords: [] as string[] };
  // 随机数拉满：0.8 + 问句 0.6 = 1.4 > 0.85
  assert.equal(shouldInterject(make("在吗"), opt, () => 1), true);
});

test("插话：纯感叹不会触发（避免变成刷屏机器）", () => {
  const opt = { rate: 0.4, threshold: 0.85, keywords: [] as string[] };
  assert.equal(shouldInterject(make("666"), opt, () => 1), false);
  assert.equal(shouldInterject(make("今天好热啊"), opt, () => 1), false);
});

test("插话：命中话题词几乎一定开口", () => {
  const opt = { rate: 0.1, threshold: 0.85, keywords: ["报错"] };
  assert.equal(shouldInterject(make("又报错了"), opt, () => 0), true);
});

test("插话：@所有人 单独不够（通知类不该接话），配上问句才会开口", () => {
  const opt = { rate: 0.1, threshold: 0.85, keywords: [] as string[] };
  assert.equal(shouldInterject(make("大家看下", true), opt, () => 0), false);
  assert.equal(shouldInterject(make("@所有人 这个怎么弄", true), opt, () => 0), true);
});

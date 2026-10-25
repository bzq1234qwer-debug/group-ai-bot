import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, splitForChat, redactSecrets } from "../src/text.ts";
import { SentenceSplitter } from "../src/stream.ts";

test("estimateTokens：空串为 0", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens：中文约为字数的 2/3", () => {
  const n = estimateTokens("这是一个中文句子");
  assert.ok(n >= 4 && n <= 9, `got ${n}`);
});

test("estimateTokens：英文按 4 字符 1 token", () => {
  const n = estimateTokens("hello world");
  assert.ok(n >= 2 && n <= 4, `got ${n}`);
});

test("splitForChat：短文本不切分", () => {
  assert.deepEqual(splitForChat("你好呀"), ["你好呀"]);
});

test("splitForChat：长文本最多 3 段且每段不超限", () => {
  const text = "第一句话。".repeat(300);
  const segments = splitForChat(text, 200, 3);
  assert.equal(segments.length, 3);
  for (const s of segments) {
    assert.ok(s.length <= 200, `segment too long: ${s.length}`);
  }
});

test("splitForChat：空文本返回空数组", () => {
  assert.deepEqual(splitForChat("   "), []);
});

test("SentenceSplitter：按句号切分，最后一段留到 flush", () => {
  const splitter = new SentenceSplitter(600, 3);
  const out: string[] = [];
  out.push(...splitter.push("你好。"));
  out.push(...splitter.push("世界。"));
  out.push(...splitter.push("再见。"));
  assert.deepEqual(out, ["你好。", "世界。"]);
  assert.equal(splitter.flush(), "再见。");
});

test("SentenceSplitter：maxSegments=1 时全部留到 flush", () => {
  const splitter = new SentenceSplitter(600, 1);
  assert.deepEqual(splitter.push("第一句。第二句。"), []);
  assert.equal(splitter.flush(), "第一句。第二句。");
});

test("redactSecrets：掩掉 sk- 开头的 Key", () => {
  const masked = redactSecrets("Bearer sk-abcdef1234567890 失效了");
  assert.ok(!masked.includes("abcdef1234567890"));
  assert.ok(masked.includes("sk-***"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldThinkDeeply } from "../src/deep.ts";

test("被 @ 的技术问题才进认真模式", () => {
  const d = shouldThinkDeeply("这个报错怎么解决，我试了好几次都不行", true);
  assert.equal(d.deep, true);
});

test("没被 @ 就不想太多（群里闲聊要快）", () => {
  const d = shouldThinkDeeply("这个报错怎么解决，我试了好几次都不行", false);
  assert.equal(d.deep, false);
});

test("寒暄不触发，哪怕被 @", () => {
  for (const text of ["在吗", "谢谢啦", "哈哈哈哈", "晚安"]) {
    assert.equal(shouldThinkDeeply(text, true).deep, false, `「${text}」不该触发`);
  }
});

test("太短的不触发", () => {
  assert.equal(shouldThinkDeeply("在吗在吗", true).deep, false);
});

test("不像技术问题的长句不触发", () => {
  assert.equal(shouldThinkDeeply("今天天气不错我们出去走走吧", true).deep, false);
});

test("英文技术词也算", () => {
  assert.equal(shouldThinkDeeply("这个 api 一直报 error，怎么排查", true).deep, true);
});

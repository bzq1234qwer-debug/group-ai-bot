import { test } from "node:test";
import assert from "node:assert/strict";
import { clampSegment, firstReplyDelayMs, segmentGapMs, stripAiTells, stripTranscriptPrefix } from "../src/humanize.ts";

const fixed = (v: number) => () => v;

test("首条延迟落在 1.2~6.5 秒之间，且随字数增长", () => {
  const short = firstReplyDelayMs(5, fixed(0));
  const long = firstReplyDelayMs(120, fixed(0));
  assert.ok(short >= 1200 && short <= 6500, `short=${short}`);
  assert.ok(long >= 1200 && long <= 6500, `long=${long}`);
  assert.ok(long > short, `长句应该等更久：${long} vs ${short}`);
});

test("分段间隔落在 0.7~2.6 秒之间", () => {
  for (const chars of [0, 10, 50, 200]) {
    const gap = segmentGapMs(chars, fixed(0.5));
    assert.ok(gap >= 700 && gap <= 2600, `chars=${chars} gap=${gap}`);
  }
});

test("清掉 AI 口头禅", () => {
  const cases = [
    "作为一个AI语言模型，我不能确定。",
    "作为AI，我建议你先备份。",
    "希望对你有帮助！",
    "有什么我可以帮你的吗？",
    "总之，先跑起来再说。",
  ];
  for (const input of cases) {
    const out = stripAiTells(input);
    assert.ok(!/作为一个?AI|作为AI|希望.*帮.*你|有什么我可以|^总之/.test(out), `未清干净：${out}`);
  }
});

test("清完之后不会留下多余的空格和逗号", () => {
  const out = stripAiTells("作为一个AI，  这个方案可行。");
  assert.equal(out, "这个方案可行。");
});

test("正常文本不被误伤", () => {
  const input = "这个报错是你没装依赖，先 npm i。";
  assert.equal(stripAiTells(input), input);
});

test("单条超过上限时在标点处截断", () => {
  const long = "第一句话说完了。第二句话也还行。第三句开始就有点长了，应该被砍掉。";
  const out = clampSegment(long, 30);
  assert.ok(out.length <= 31, `out=${out}`);
  assert.ok(out.endsWith("…"), `应当以省略号结尾：${out}`);
});

test("短文本不被截断", () => {
  assert.equal(clampSegment("在吗", 120), "在吗");
});

test("剥掉模型模仿出来的 [昵称 时间] 前缀", () => {
  assert.equal(stripTranscriptPrefix("[大肥鱼 14:34] 冒泡"), "冒泡");
  assert.equal(stripTranscriptPrefix("[小明 9:05] 你说啥"), "你说啥");
  assert.equal(stripTranscriptPrefix("  [群主 23:59]   晚安 "), "晚安");
});

test("不误删正文里的方括号", () => {
  assert.equal(stripTranscriptPrefix("这个[功能]不能用"), "这个[功能]不能用");
  assert.equal(stripTranscriptPrefix("[重要] 记得备份"), "[重要] 记得备份");
});

test("全角冒号和全角括号也要能剥（模型常混用）", () => {
  assert.equal(stripTranscriptPrefix("[大肥鱼 14：35] 会一点"), "会一点");
  assert.equal(stripTranscriptPrefix("【大肥鱼 14：35】会一点"), "会一点");
});

test("连写两层前缀也只剥干净", () => {
  assert.equal(stripTranscriptPrefix("[大肥鱼 14:35] [大肥鱼 14:35] 在的"), "在的");
});

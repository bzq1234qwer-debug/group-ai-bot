import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, type HistoryRow } from "../src/context.ts";

const NOW = new Date(2026, 9, 24, 15, 30, 0).getTime();

function row(id: string, name: string, text: string, tsOffset: number, isSelf = false): HistoryRow {
  return {
    id,
    convKey: "qq:10001:group:30003",
    senderId: name,
    senderName: name,
    isSelf,
    text,
    ts: NOW - tsOffset,
  };
}

function baseInput(history: HistoryRow[]) {
  return {
    botName: "小D",
    persona: "你是技术顾问。",
    groupTitle: "前端摸鱼群",
    memberCount: 48,
    history,
    current: row("cur", "小明", "什么是 RAG", 0),
    now: NOW,
    maxContextTokens: 24_000,
    maxOutputTokens: 800,
  };
}

test("结构：system 打头，当前消息收尾", () => {
  const built = buildContext(baseInput([row("a", "小红", "早上好", 60_000)]));
  assert.equal(built.messages[0]!.role, "system");
  assert.ok(built.messages[0]!.content.includes("小D"));
  assert.ok(built.messages[0]!.content.includes("前端摸鱼群"));

  const last = built.messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.ok(last.content.includes("什么是 RAG"));
  assert.equal(built.droppedCount, 0);
  assert.equal(built.truncated, false);
});

test("每条历史都带发言人昵称（否则模型会串台）", () => {
  const built = buildContext(baseInput([row("a", "小红", "早上好", 60_000), row("b", "小刚", "早", 30_000)]));
  const historyMessages = built.messages.filter((m) => m.role === "user" || m.role === "assistant");
  assert.ok(historyMessages[0]!.content.includes("小红"));
  assert.ok(historyMessages[1]!.content.includes("小刚"));
});

test("机器人自己的历史标为 assistant", () => {
  const built = buildContext(baseInput([row("a", "小D", "我之前说过", 60_000, true)]));
  assert.equal(built.messages[1]!.role, "assistant");
});

test("超出预算时丢弃最旧的历史，保留最近的", () => {
  const history: HistoryRow[] = [];
  for (let i = 0; i < 40; i += 1) {
    history.push(row(`h${i}`, `用户${i}`, `这是第 ${i} 条消息，内容稍微长一点以便占用 token。`, (40 - i) * 60_000));
  }
  const built = buildContext({ ...baseInput(history), maxContextTokens: 900, maxOutputTokens: 200 });

  assert.equal(built.truncated, true);
  assert.ok(built.droppedCount > 0, "应当丢弃了部分历史");

  const kept = built.messages.filter((m) => m.role === "user" || m.role === "assistant");
  // 最后一条历史（h39）应当被保留，最早的不应出现
  assert.ok(kept.some((m) => m.content.includes("第 39 条")));
  assert.ok(!kept.some((m) => m.content.includes("第 0 条")));
});

test("有摘要时注入为独立 system 消息", () => {
  const built = buildContext({
    ...baseInput([]),
    summary: "之前聊过数据库选型和一次线上故障排查。",
  });
  assert.equal(built.messages[1]!.role, "system");
  assert.ok(built.messages[1]!.content.includes("此前对话摘要"));
});

test("引用回复会把被引原文带进上下文", () => {
  const built = buildContext({
    ...baseInput([]),
    replyTo: { senderName: "小红", excerpt: "数据库选哪个好" },
  });
  const last = built.messages.at(-1)!;
  assert.ok(last.content.includes("数据库选哪个好"));
  assert.ok(last.content.includes("小红"));
});

test("系统提示包含防注入规则", () => {
  const built = buildContext(baseInput([]));
  const system = built.messages[0]!.content;
  assert.ok(system.includes("不可信"));
  assert.ok(system.includes("不要复述"));
});

test("检索到的旧对话会作为独立系统消息注入，并标注仅供参考", () => {
  const built = buildContext({
    ...baseInput([]),
    recalled: [{ sender: "小明", ts: NOW - 86_400_000, text: "上周说好周三交方案" }],
  });

  const systemMessages = built.messages.filter((m) => m.role === "system");
  assert.ok(systemMessages.some((m) => m.content.includes("可能相关的旧对话")));
  assert.ok(systemMessages.some((m) => m.content.includes("周三交方案")));
});

test("没有检索结果时不注入多余的系统消息", () => {
  const built = buildContext({ ...baseInput([]), recalled: [] });
  const systemMessages = built.messages.filter((m) => m.role === "system");
  assert.ok(!systemMessages.some((m) => m.content.includes("可能相关的旧对话")));
});

test("结构化事实会作为系统消息注入", () => {
  const built = buildContext({
    ...baseInput([]),
    facts: [{ subject: "张三", attribute: "身份", value: "群主，做外贸" }],
  });

  const systemMessages = built.messages.filter((m) => m.role === "system");
  assert.ok(systemMessages.some((m) => m.content.includes("长期事实")));
  assert.ok(systemMessages.some((m) => m.content.includes("张三：身份 = 群主，做外贸")));
});

test("喜好与习惯写进系统提示，并带上「不要每条都提」的约束", () => {
  const built = buildContext({
    ...baseInput([]),
    traits: {
      likes: ["token", "被夸"],
      dislikes: ["被叫全名"],
      habits: ["先给结论再补一句嘴"],
    },
  });

  const system = built.messages[0]!.content;
  assert.ok(system.includes("喜欢：token、被夸"));
  assert.ok(system.includes("讨厌：被叫全名"));
  assert.ok(system.includes("习惯：先给结论再补一句嘴"));
  assert.ok(system.includes("不要每条都提"));
});

test("没配置喜好时不注入这一段", () => {
  const built = buildContext({
    ...baseInput([]),
    traits: { likes: [], dislikes: [], habits: [] },
  });
  assert.ok(!built.messages[0]!.content.includes("喜好与习惯"));
});

test("当前消息带图时，图片挂在最后一条上", () => {
  const built = buildContext({
    ...baseInput([]),
    images: ["data:image/png;base64,AAAA"],
  });

  const last = built.messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.deepEqual(last.images, ["data:image/png;base64,AAAA"]);
});

test("没有图片时不带 images 字段", () => {
  const built = buildContext(baseInput([]));
  assert.equal(built.messages.at(-1)!.images, undefined);
});

test("认真模式会在系统提示里放宽长度，但仍禁止 Markdown", () => {
  const normal = buildContext(baseInput([])).messages[0]!.content;
  const deep = buildContext({ ...baseInput([]), deep: true }).messages[0]!.content;

  assert.ok(!normal.includes("认真问问题"));
  assert.ok(deep.includes("认真问问题"));
  assert.ok(deep.includes("不要用 Markdown"));
});

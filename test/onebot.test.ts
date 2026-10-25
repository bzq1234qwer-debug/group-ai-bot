import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOneBotEvent, normalizeOneBotNotice, normalizeOneBotRequest } from "../src/adapters/onebot.ts";

const SELF = "10001";
const CHANNEL = "qq:10001";

test("群消息：@机器人时标记 mentions.self", () => {
  const env = normalizeOneBotEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      user_id: 20002,
      group_id: 30003,
      message_id: 40004,
      time: 1_700_000_000,
      sender: { user_id: 20002, nickname: "小明", card: "小明同学", role: "member" },
      message: [
        { type: "at", data: { qq: "10001", name: "小D" } },
        { type: "text", data: { text: " 帮我看下这个报错" } },
      ],
    },
    CHANNEL,
    SELF,
  );

  assert.ok(env);
  assert.equal(env.convKey, "qq:10001:group:30003");
  assert.equal(env.mentions.self, true);
  // 被 @ 的是它自己，名字不该留在正文里：模型会以为对方在叫名字，
  // 还可能学成 "@名字 内容" 的说话格式
  assert.equal(env.text, "帮我看下这个报错");
  assert.equal(env.sender.name, "小明同学"); // 群名片优先于昵称
  assert.equal(env.sender.isSelf, false);
  assert.equal(env.ts, 1_700_000_000_000);
});

test("群消息：@全体成员", () => {
  const env = normalizeOneBotEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      user_id: 20002,
      group_id: 30003,
      message_id: 1,
      message: [{ type: "at", data: { qq: "all" } }, { type: "text", data: { text: "开会了" } }],
    },
    CHANNEL,
    SELF,
  );
  assert.ok(env);
  assert.equal(env.mentions.all, true);
  assert.equal(env.mentions.self, false);
});

test("群消息：引用回复保留 reply 段", () => {
  const env = normalizeOneBotEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      user_id: 20002,
      group_id: 30003,
      message_id: 2,
      message: [{ type: "reply", data: { id: "999" } }, { type: "text", data: { text: "这个" } }],
    },
    CHANNEL,
    SELF,
  );
  assert.ok(env);
  assert.equal(env.replyTo?.id, "999");
});

test("图片消息转成占位文本", () => {
  const env = normalizeOneBotEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      user_id: 20002,
      group_id: 30003,
      message_id: 3,
      message: [{ type: "image", data: { url: "http://x/y.png" } }],
    },
    CHANNEL,
    SELF,
  );
  assert.ok(env);
  assert.equal(env.text, "[图片]");
  assert.equal(env.media[0]?.kind, "image");
});

test("纯字符串 message 也能解析", () => {
  const env = normalizeOneBotEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      user_id: 20002,
      group_id: 30003,
      message_id: 4,
      message: "直接是文本",
    },
    CHANNEL,
    SELF,
  );
  assert.equal(env?.text, "直接是文本");
});

test("私聊消息映射为 private 会话", () => {
  const env = normalizeOneBotEvent(
    {
      post_type: "message",
      message_type: "private",
      self_id: 10001,
      user_id: 20002,
      message_id: 5,
      message: "在吗",
    },
    CHANNEL,
    SELF,
  );
  assert.equal(env?.convKey, "qq:10001:private:20002");
});

test("自己发的消息标记 isSelf", () => {
  const env = normalizeOneBotEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: 10001,
      user_id: 10001,
      group_id: 30003,
      message_id: 6,
      sender: { user_id: 10001, nickname: "小D" },
      message: "我说的话",
    },
    CHANNEL,
    SELF,
  );
  assert.equal(env?.sender.isSelf, true);
});

test("非 message 类型事件返回 null", () => {
  assert.equal(
    normalizeOneBotEvent({ post_type: "notice", message_type: "group" }, CHANNEL, SELF),
    null,
  );
});

test("群撤回通知能解析", () => {
  const n = normalizeOneBotNotice(
    {
      post_type: "notice",
      notice_type: "group_recall",
      group_id: 30003,
      user_id: 20002,
      message_id: 40004,
    },
    CHANNEL,
    SELF,
  );

  assert.equal(n?.kind, "recall");
  assert.equal(n?.messageId, "40004");
  assert.equal(n?.convKey, "qq:10001:group:30003");
});

test("自己被禁言能识别", () => {
  const n = normalizeOneBotNotice(
    {
      post_type: "notice",
      notice_type: "group_ban",
      sub_type: "ban",
      group_id: 30003,
      user_id: 10001,
      duration: 600,
    },
    CHANNEL,
    SELF,
  );

  assert.equal(n?.kind, "muted");
  assert.equal(n?.durationSec, 600);
  assert.ok(n?.message.includes("我自己"));
});

test("别人被禁言不当作自己被禁言", () => {
  const n = normalizeOneBotNotice(
    { post_type: "notice", notice_type: "group_ban", sub_type: "ban", group_id: 30003, user_id: 20002, duration: 600 },
    CHANNEL,
    SELF,
  );
  assert.equal(n?.kind, "muted");
  assert.ok(!n?.message.includes("我自己"));
});

test("被移出群能识别", () => {
  const n = normalizeOneBotNotice(
    { post_type: "notice", notice_type: "group_decrease", sub_type: "kick_me", group_id: 30003, user_id: 10001 },
    CHANNEL,
    SELF,
  );
  assert.equal(n?.kind, "kicked");
});

test("普通消息不会被当成通知", () => {
  assert.equal(normalizeOneBotNotice({ post_type: "message" }, CHANNEL, SELF), null);
  assert.equal(normalizeOneBotNotice({ post_type: "notice", notice_type: "unknown_thing" }, CHANNEL, SELF), null);
});

test("好友申请归一化", () => {
  const r = normalizeOneBotRequest(
    { post_type: "request", request_type: "friend", user_id: 20002, comment: "我是小明", flag: "flag-1" },
    CHANNEL,
    1_700_000_000_000,
  );
  assert.ok(r);
  assert.equal(r.kind, "friend");
  assert.equal(r.id, "flag-1");
  assert.equal(r.userId, "20002");
  assert.equal(r.comment, "我是小明");
});

test("加群邀请归一化", () => {
  const r = normalizeOneBotRequest(
    {
      post_type: "request",
      request_type: "group",
      sub_type: "invite",
      group_id: 30003,
      user_id: 20002,
      flag: "flag-2",
    },
    CHANNEL,
  );
  assert.ok(r);
  assert.equal(r.kind, "group");
  assert.equal(r.subType, "invite");
  assert.equal(r.groupId, "30003");
});

test("普通消息不会被当成申请", () => {
  assert.equal(normalizeOneBotRequest({ post_type: "message" }, CHANNEL), null);
});

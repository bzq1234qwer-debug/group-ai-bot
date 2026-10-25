import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeQqBotEvent, stripQqBotMentions, QqBotAdapter } from "../src/adapters/qqbot.ts";
import { makeConvKey, parseConvKey } from "../src/types.ts";

const CHANNEL = "qqbot:102030405";

test("stripQqBotMentions：去掉 <@!openid> 标记", () => {
  assert.equal(stripQqBotMentions("<@!abc123> 你好呀"), "你好呀");
  assert.equal(stripQqBotMentions("<@abc>  <@def> 两个"), "两个");
  assert.equal(stripQqBotMentions("没有标记"), "没有标记");
});

test("群聊 @ 事件归一化", () => {
  const env = normalizeQqBotEvent(
    "GROUP_AT_MESSAGE_CREATE",
    {
      id: "MSG_1",
      content: "<@!bot> 帮我写个正则",
      group_openid: "GO_AAA",
      timestamp: "1700000000",
      author: { id: "U1", member_openid: "M_1", username: "小明" },
    },
    CHANNEL,
    1_700_000_000_000,
  );

  assert.ok(env);
  assert.equal(env.convKey, "qqbot:102030405:group:GO_AAA");
  assert.equal(env.text, "帮我写个正则");
  assert.equal(env.sender.name, "小明");
  assert.equal(env.mentions.self, true);
  assert.equal(env.ts, 1_700_000_000_000);
});

test("单聊事件归一化为 private 会话", () => {
  const env = normalizeQqBotEvent(
    "C2C_MESSAGE_CREATE",
    { id: "MSG_2", content: "在吗", author: { user_openid: "U_OPENID", id: "U2" } },
    CHANNEL,
  );
  assert.equal(env?.convKey, "qqbot:102030405:private:U_OPENID");
});

test("其他事件类型返回 null", () => {
  assert.equal(normalizeQqBotEvent("READY", {}, CHANNEL), null);
  assert.equal(normalizeQqBotEvent("GROUP_ADD_ROBOT", {}, CHANNEL), null);
});

test("空内容返回 null", () => {
  const env = normalizeQqBotEvent(
    "GROUP_AT_MESSAGE_CREATE",
    { id: "M", content: "<@!bot>", group_openid: "G", author: { id: "U" } },
    CHANNEL,
  );
  assert.equal(env, null);
});

test("qqbot 的 convKey 能被正确解析（channelId 也含冒号）", () => {
  const key = makeConvKey("qqbot:102030405", "group", "GO_AAA");
  const parsed = parseConvKey(key);
  assert.deepEqual(parsed, { channelId: "qqbot:102030405", type: "group", externalId: "GO_AAA" });
});

// ---------------------------------------------------------------------------
// 被动回复：分段必须挂在同一个 msg_id 上，否则第二段会被当成"主动推送"
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string;
  body: Record<string, unknown> | undefined;
}

function installFetchMock(): { calls: CapturedCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];

  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url.includes("getAppAccessToken")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    calls.push({
      url,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    return new Response(JSON.stringify({ id: `sent_${calls.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("send：第一段用 msg_id，后续分段复用并递增 msg_seq", async () => {
  const mock = installFetchMock();
  try {
    const adapter = new QqBotAdapter({
      channelId: CHANNEL,
      appId: "102030405",
      appSecret: "secret",
      apiBase: "https://api.example",
    });

    const conv = "qqbot:102030405:group:GO_AAA";

    await adapter.send(conv, { segments: ["第一段。"], replyTo: "USER_MSG_1" });
    await adapter.send(conv, { segments: ["第二段。"] });
    await adapter.send(conv, { segments: ["第三段。"] });

    assert.equal(mock.calls.length, 3);
    assert.ok(mock.calls[0]!.url.endsWith("/v2/groups/GO_AAA/messages"));

    assert.equal(mock.calls[0]!.body?.msg_id, "USER_MSG_1");
    assert.equal(mock.calls[0]!.body?.msg_seq, 1);
    assert.equal(mock.calls[1]!.body?.msg_id, "USER_MSG_1");
    assert.equal(mock.calls[1]!.body?.msg_seq, 2);
    assert.equal(mock.calls[2]!.body?.msg_seq, 3);
    assert.equal(mock.calls[0]!.body?.content, "第一段。");
  } finally {
    mock.restore();
  }
});

test("send：没有可复用的 msg_id 时不带 msg_id（走主动推送）", async () => {
  const mock = installFetchMock();
  try {
    const adapter = new QqBotAdapter({
      channelId: CHANNEL,
      appId: "102030405",
      appSecret: "secret",
      apiBase: "https://api.example",
    });

    await adapter.send("qqbot:102030405:group:GO_BBB", { segments: ["主动说一句"] });
    assert.equal(mock.calls[0]!.body?.msg_id, undefined);
    assert.equal(mock.calls[0]!.body?.msg_seq, undefined);
  } finally {
    mock.restore();
  }
});

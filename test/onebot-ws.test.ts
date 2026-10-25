import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { OneBotAdapter } from "../src/adapters/onebot.ts";
import type { Envelope } from "../src/types.ts";

const SELF = "10001";
const CHANNEL = "qq:10001";

interface FakeServer {
  url: string;
  /** 等客户端连上来（adapter.start() 之后再 await） */
  connected: Promise<WebSocket>;
  actions: Array<{ action: string; params: Record<string, unknown>; echo: string }>;
  pushEvent: (payload: unknown) => void;
  respond: (echo: string, data: unknown) => void;
  close: () => Promise<void>;
}

/** 假 OneBot 正向 WS 服务端（模拟 SnowLuma / LLOneBot） */
async function startFakeServer(): Promise<FakeServer> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const actions: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  let socket: WebSocket | undefined;

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });

  const connected = new Promise<WebSocket>((resolve) => {
    wss.once("connection", (client) => {
      socket = client;
      client.on("message", (raw) => {
        actions.push(
          JSON.parse(String(raw)) as { action: string; params: Record<string, unknown>; echo: string },
        );
      });
      resolve(client);
    });
  });

  const port = (wss.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}`,
    connected,
    actions,
    pushEvent: (payload) => socket?.send(JSON.stringify(payload)),
    respond: (echo, data) =>
      socket?.send(JSON.stringify({ status: "ok", retcode: 0, data, echo })),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

test("正向 WS：能连上、收事件、发动作并拿到响应", async () => {
  const server = await startFakeServer();

  const adapter = new OneBotAdapter({
    channelId: CHANNEL,
    baseUrl: "http://127.0.0.1:1", // WS 模式下不该被用到
    selfId: SELF,
    eventPort: 0,
    eventPath: "/unused",
    wsUrl: server.url,
  });

  const received: Envelope[] = [];
  adapter.onMessage((env) => received.push(env));

  await adapter.start();
  await server.connected;

  // 服务端推一条群里 @ 机器人的消息
  server.pushEvent({
    post_type: "message",
    message_type: "group",
    self_id: Number(SELF),
    user_id: 20002,
    group_id: 30003,
    message_id: 40004,
    time: 1_700_000_000,
    sender: { user_id: 20002, nickname: "小明", card: "小明", role: "member" },
    message: [
      { type: "at", data: { qq: SELF, name: "小D" } },
      { type: "text", data: { text: " 在吗" } },
    ],
  });

  await new Promise((r) => setTimeout(r, 120));

  assert.equal(received.length, 1);
  assert.equal(received[0]!.convKey, "qq:10001:group:30003");
  assert.equal(received[0]!.mentions.self, true);

  // send() 应该通过 WS 发出去，并等到 echo 对应的响应
  const pending = adapter.send("qq:10001:group:30003", { segments: ["好的"] });
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(server.actions.length, 1);
  assert.equal(server.actions[0]!.action, "send_group_msg");
  assert.deepEqual(server.actions[0]!.params.group_id, 30003);

  server.respond(server.actions[0]!.echo, { message_id: 555 });
  const result = await pending;
  assert.equal(result.messageId, "555");

  await adapter.stop();
  await server.close();
});

test("正向 WS：动作失败时抛错", async () => {
  const server = await startFakeServer();

  const adapter = new OneBotAdapter({
    channelId: CHANNEL,
    baseUrl: "http://127.0.0.1:1",
    selfId: SELF,
    eventPort: 0,
    eventPath: "/unused",
    wsUrl: server.url,
  });
  adapter.onMessage(() => {});

  await adapter.start();
  await server.connected;

  const pending = adapter.send("qq:10001:group:30003", { segments: ["x"] });
  await new Promise((r) => setTimeout(r, 100));

  server.pushEvent({
    status: "failed",
    retcode: 100,
    message: "群号不存在",
    echo: server.actions[0]!.echo,
  });

  await assert.rejects(pending, /OneBot 动作失败/);

  await adapter.stop();
  await server.close();
});

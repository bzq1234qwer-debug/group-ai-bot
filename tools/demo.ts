/**
 * 一条命令跑通全链路，不需要 QQ、不需要 API Key。
 *
 *   node tools/demo.ts
 *
 * 做的事：起一个假的 NapCat 服务端 → 起 Runtime → 投递一条群消息（带 @）
 *        → 看机器人怎么回、怎么分段、花多少钱。
 */

import { createServer, type Server } from "node:http";
import { buildConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { Store } from "../src/store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { OneBotAdapter } from "../src/adapters/onebot.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { DeepSeekProvider } from "../src/providers/deepseek.ts";
import type { Adapter, Envelope, OutboundMessage, SendResult } from "../src/types.ts";

const SELF_ID = "10001";
const GROUP_ID = "30003";
const CHANNEL_ID = `qq:${SELF_ID}`;
const CONV_KEY = `${CHANNEL_ID}:group:${GROUP_ID}`;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface FakeNapCat {
  server: Server;
  sent: Array<{ convKey: string; msg: OutboundMessage }>;
  close: () => Promise<void>;
}

/** 假 NapCat：只实现演示用到的两个 API，并记录机器人发出的内容 */
function startFakeNapCat(port: number): Promise<FakeNapCat> {
  const sent: Array<{ convKey: string; msg: OutboundMessage }> = [];
  let seq = 1000;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && (url.pathname === "/send_group_msg" || url.pathname === "/send_private_msg")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            group_id?: number | string;
            user_id?: number | string;
            message?: Array<{ type: string; data?: Record<string, unknown> }>;
          };
          const segments = (body.message ?? [])
            .filter((s) => s.type === "text")
            .map((s) => String(s.data?.text ?? ""));
          const replyTo = (body.message ?? []).find((s) => s.type === "reply");
          const isGroup = url.pathname === "/send_group_msg";
          sent.push({
            convKey: isGroup ? `group:${String(body.group_id)}` : `private:${String(body.user_id)}`,
            msg: {
              segments,
              replyTo: replyTo ? String(replyTo.data?.id ?? "") : undefined,
            },
          });
          seq += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: seq } }));
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/get_group_list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: [{ group_id: Number(GROUP_ID), group_name: "前端摸鱼群", member_count: 48 }],
        }),
      );
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        sent,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function makeEvent(overrides: {
  userId: string;
  name: string;
  text: string;
  atBot: boolean;
  messageId: string;
  role?: "owner" | "admin" | "member";
}): Record<string, unknown> {
  const message: Array<{ type: string; data: Record<string, unknown> }> = [];
  if (overrides.atBot) message.push({ type: "at", data: { qq: SELF_ID, name: "小D" } });
  message.push({ type: "text", data: { text: overrides.atBot ? ` ${overrides.text}` : overrides.text } });

  return {
    post_type: "message",
    message_type: "group",
    self_id: Number(SELF_ID),
    user_id: Number(overrides.userId),
    group_id: Number(GROUP_ID),
    message_id: Number(overrides.messageId),
    time: Math.floor(Date.now() / 1000),
    sender: {
      user_id: Number(overrides.userId),
      nickname: overrides.name,
      card: overrides.name,
      role: overrides.role ?? "member",
    },
    message,
  };
}

async function postEvent(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`投递事件失败: ${res.status}`);
}

async function main(): Promise<void> {
  const apiPort = await getFreePort();
  const eventPort = await getFreePort();

  const useLive = process.argv.includes("--live") && !!process.env.DEEPSEEK_API_KEY;

  console.log("");
  console.log("  ┌──────────────────────────────────────────────┐");
  console.log("  │  群聊 AI 助手 · 本地全链路演示                │");
  console.log("  └──────────────────────────────────────────────┘");
  console.log("");

  const napcat = await startFakeNapCat(apiPort);

  const log = createLogger("info", "demo");
  const store = new Store(":memory:");

  const adapter = new OneBotAdapter({
    channelId: CHANNEL_ID,
    baseUrl: `http://127.0.0.1:${apiPort}`,
    selfId: SELF_ID,
    eventPort,
    eventPath: "/onebot/events",
  });

  const provider = useLive
    ? new DeepSeekProvider({
        apiKey: process.env.DEEPSEEK_API_KEY ?? "",
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      })
    : new MockProvider({ delayMs: 4 });

  const cfg = buildConfig({
    mode: useLive ? "live" : "mock",
    agents: [
      {
        id: "default",
        name: "小D",
        persona: "你是群里的技术顾问，说话简短、口语化，最多三句话。",
        maxOutputTokens: 800,
        thinking: false,
      },
    ],
    bindings: [{ convKey: CONV_KEY, agentId: "default", enabled: true }],
  });

  const orchestrator = new Orchestrator({
    adapter,
    provider,
    store,
    agents: new Map(cfg.agents.map((a) => [a.id, a])),
    bindings: cfg.bindings,
    quota: cfg.quota,
    logger: log,
    sendDelayMs: 0,
    sleep: async () => {}, // 演示不等拟人化延迟
  });

  adapter.onMessage((env: Envelope) => {
    void orchestrator.handleEnvelope(env);
  });

  await adapter.start();
  const eventUrl = `http://127.0.0.1:${eventPort}/onebot/events`;

  console.log(`  模型     ${useLive ? "DeepSeek (真实)" : "Mock (离线，不花钱)"}`);
  console.log(`  假 NapCat :${apiPort}`);
  console.log(`  绑定会话  ${CONV_KEY}`);
  console.log("");

  const steps: Array<{ label: string; event: Record<string, unknown>; note: string }> = [
    {
      label: "① 群友 @ 机器人",
      event: makeEvent({
        userId: "20002",
        name: "小明",
        text: "小D，帮我用一句话解释什么是向量数据库",
        atBot: true,
        messageId: "5001",
      }),
      note: "应当回复",
    },
    {
      label: "② 另一个群友没 @ 它",
      event: makeEvent({
        userId: "20003",
        name: "小红",
        text: "今天天气不错",
        atBot: false,
        messageId: "5002",
      }),
      note: "默认策略下应当沉默",
    },
    {
      label: "③ 同一条消息重复上报",
      event: makeEvent({
        userId: "20002",
        name: "小明",
        text: "小D，帮我用一句话解释什么是向量数据库",
        atBot: true,
        messageId: "5001",
      }),
      note: "幂等去重，应当不重复回复",
    },
  ];

  for (const step of steps) {
    console.log(`  ${step.label} —— ${step.note}`);
    const before = napcat.sent.length;
    await postEvent(eventUrl, step.event);
    await new Promise((r) => setTimeout(r, 300));
    await orchestrator.drain();
    const produced = napcat.sent.slice(before);
    if (produced.length === 0) {
      console.log("     （没有回复）");
    }
    for (const item of produced) {
      console.log(`     → ${item.msg.segments.join(" / ")}`);
    }
    console.log("");
  }

  const total = napcat.sent.length;
  console.log(`  共发出 ${total} 条消息。`);
  console.log("");

  await adapter.stop();
  await napcat.close();
  store.close();
}

main().catch((err: unknown) => {
  console.error("演示失败：", err);
  process.exit(1);
});

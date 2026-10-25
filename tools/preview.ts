/**
 * 效果预览：本地网页，不连 QQ，直接用真实 DeepSeek 看这个"群友"怎么说话。
 *
 *   node tools/preview.ts            # 然后浏览器打开 http://127.0.0.1:8787
 *   PORT=9000 node tools/preview.ts
 *
 * 它跑的是和正式 bot 完全同一套内核（buildContext + DeepSeekProvider + 分段 + 计费），
 * 所以这里看到的效果，就是接进 QQ 后的效果。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { buildContext } from "../src/context.ts";
import { DeepSeekProvider } from "../src/providers/deepseek.ts";
import { splitForChat } from "../src/text.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { clampSegment, firstReplyDelayMs, segmentGapMs, stripAiTells, stripTranscriptPrefix, voiceHint } from "../src/humanize.ts";
import { estimateCostUsd, usdToCny } from "../src/cost.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8899);

const MAX_CONTEXT_TOKENS = 24_000;
const MAX_OUTPUT_TOKENS = 800;
const BOT_NAME = "小D";

const store = new Store(":memory:");

interface ChatBody {
  apiKey?: string;
  model?: string;
  persona?: string;
  convKey?: string;
  sender?: string;
  text?: string;
  botName?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

async function handleChat(body: ChatBody, res: ServerResponse): Promise<void> {
  const apiKey = (body.apiKey ?? "").trim();
  if (!apiKey) {
    json(res, 400, { error: "缺少 API Key" });
    return;
  }
  const text = (body.text ?? "").trim();
  if (!text) {
    json(res, 400, { error: "消息为空" });
    return;
  }

  const convKey = body.convKey || "qq:10001:group:30003";
  const sender = body.sender || "群友";
  const model = body.model || "deepseek-flash";
  const persona = (body.persona ?? "").trim() || "你是群里的技术顾问，说话简短。";
  const botName = (body.botName ?? "").trim() || BOT_NAME;
  const now = Date.now();

  const userRow = {
    id: `p:${convKey}:${now}:${Math.random().toString(36).slice(2, 8)}`,
    convKey,
    senderId: sender,
    senderName: sender,
    isSelf: false,
    text,
    ts: now,
  };
  store.appendMessage(userRow);

  // 当前这条已经入库，从历史里摘掉，避免模型看到重复
  const history = store.recentMessages(convKey, 60).filter((row) => row.id !== userRow.id);

  const built = buildContext({
    botName,
    persona,
    groupTitle: convKey,
    history,
    current: userRow,
    now,
    maxContextTokens: MAX_CONTEXT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const provider =
    apiKey === "mock"
      ? new MockProvider({ delayMs: 0 })
      : new DeepSeekProvider({ apiKey, defaultModel: model });
  const controller = new AbortController();

  // 和正式 bot 一样：由代码掷骰子决定这轮要不要提示带心声
  const hint = voiceHint();
  const messages = hint
    ? [...built.messages.slice(0, -1), { role: "system" as const, content: hint }, built.messages.at(-1)!]
    : built.messages;

  let reply = "";
  let usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };

  try {
    for await (const chunk of provider.chat({
      model,
      messages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 1,
      thinking: false, // 群聊必须关，否则成本和延迟都不可接受
      signal: controller.signal,
    })) {
      if (chunk.delta) reply += chunk.delta;
      if (chunk.usage) usage = chunk.usage;
    }
  } catch (err) {
    json(res, 502, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (!reply.trim()) {
    json(res, 502, { error: "模型返回空内容" });
    return;
  }

  store.appendMessage({
    id: `p:${convKey}:bot:${now}`,
    convKey,
    senderId: "self",
    senderName: botName,
    isSelf: true,
    text: reply,
    ts: now,
  });

  const costUsd = estimateCostUsd(model, usage, now);
  const cny = usdToCny(costUsd);
  // 和正式 bot 一样：去掉 AI 口头禅、砍掉超长句，再按人味节奏排延迟
  const segments = splitForChat(reply, 600, 3)
    .map((s) => clampSegment(stripAiTells(stripTranscriptPrefix(s))))
    .filter((s) => s.length > 0);
  const delays = segments.map((s, i) => (i === 0 ? firstReplyDelayMs(s.length) : segmentGapMs(s.length)));

  const debug = built.messages
    .map((m) => `[${m.role}]\n${m.content.length > 900 ? `${m.content.slice(0, 900)}…` : m.content}`)
    .join("\n\n──────────\n\n");

  json(res, 200, {
    segments,
    delays,
    usage,
    costUsd,
    cny,
    contextTokens: built.estimatedTokens,
    dropped: built.droppedCount,
    debug,
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    // 每次请求都重读文件，改 html 刷新页面就生效，不用重启
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(HERE, "preview.html"), "utf8"));
    } catch {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("preview.html 读不到");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    void readBody(req)
      .then((raw) => {
        const body = JSON.parse(raw) as { convKey?: string };
        if (body.convKey) {
          store.clearMessages(body.convKey);
          store.clearSummary(body.convKey, Date.now());
        }
        json(res, 200, { ok: true });
      })
      .catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    void readBody(req)
      .then((raw) => handleChat(JSON.parse(raw) as ChatBody, res))
      .catch((err: unknown) => {
        json(res, 400, { error: err instanceof Error ? err.message : "bad request" });
      });
    return;
  }

  res.writeHead(404).end();
});

let attemptPort = PORT;
let attemptsLeft = 20;
let started = false;

function listen(): void {
  server.listen(attemptPort, "127.0.0.1", () => {
    if (started) return;
    started = true;
    console.log("");
    console.log("  群聊 AI · 效果预览已启动");
    console.log("");
    console.log(`  打开浏览器：http://127.0.0.1:${attemptPort}`);
    console.log("");
    console.log("  填上 DeepSeek API Key，就能以不同群友身份说话看效果。");
    console.log("  Key 只存在浏览器 localStorage，服务端不落盘。");
    console.log("");
    console.log("  Ctrl+C 退出");
  });
}

server.on("error", (err: NodeJS.ErrnoException) => {
  // 端口被占就自动往后找，最多试 20 个
  if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
    attemptsLeft -= 1;
    attemptPort += 1;
    setTimeout(listen, 30);
    return;
  }
  if (err.code === "EADDRINUSE") {
    console.error(`\n  连续 20 个端口都被占用，换个起始端口：PORT=19000 node tools/preview.ts\n`);
  } else {
    console.error("\n  启动失败：", err.message, "\n");
  }
  process.exit(1);
});

listen();

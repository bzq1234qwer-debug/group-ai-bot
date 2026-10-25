/**
 * 假 NapCat：在终端里手动模拟群聊，用来调触发规则和人格，不用真的挂 QQ。
 *
 *   node tools/mock-onebot.ts
 *
 * 然后在提示符后面直接打字，回车就是一条"群里 @ 机器人"的消息。
 */

import { createServer } from "node:http";
import { createInterface } from "node:readline";

const API_PORT = Number(process.env.MOCK_API_PORT ?? 3000);
const EVENT_URL = process.env.MOCK_EVENT_URL ?? "http://127.0.0.1:3001/onebot/events";
const SELF_ID = process.env.MOCK_SELF_ID ?? "10001";
const GROUP_ID = process.env.MOCK_GROUP_ID ?? "30003";
const GROUP_NAME = "本地调试群";

let seq = 1000;
let messageId = 5000;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "POST" && url.pathname === "/get_group_list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: [{ group_id: Number(GROUP_ID), group_name: GROUP_NAME, member_count: 2 }],
      }),
    );
    return;
  }

  if (req.method === "POST" && (url.pathname === "/send_group_msg" || url.pathname === "/send_private_msg")) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          message?: Array<{ type: string; data?: Record<string, unknown> }>;
        };
        const text = (body.message ?? [])
          .filter((s) => s.type === "text")
          .map((s) => String(s.data?.text ?? ""))
          .join("");
        console.log(`\n  🤖 小D: ${text}\n`);
        seq += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: seq } }));
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }

  res.writeHead(404).end();
});

async function emit(text: string): Promise<void> {
  messageId += 1;
  const payload = {
    post_type: "message",
    message_type: "group",
    self_id: Number(SELF_ID),
    user_id: 20002,
    group_id: Number(GROUP_ID),
    message_id: messageId,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 20002, nickname: "你", card: "你", role: "owner" },
    message: [
      { type: "at", data: { qq: SELF_ID, name: "小D" } },
      { type: "text", data: { text: ` ${text}` } },
    ],
  };

  const res = await fetch(EVENT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`  ✗ 投递失败 ${res.status}，Runtime 起来了吗？`);
  }
}

server.listen(API_PORT, "127.0.0.1", () => {
  console.log("");
  console.log("  假 NapCat 已启动");
  console.log(`  API      http://127.0.0.1:${API_PORT}`);
  console.log(`  事件上报  ${EVENT_URL}`);
  console.log("");
  console.log("  先在另一个终端运行：node src/main.ts --mock");
  console.log("  然后在这里直接打字，回车发一条 @机器人 的群消息。Ctrl+C 退出。");
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("  你 > ");
  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    if (text) {
      void emit(text).then(() => rl.prompt());
    } else {
      rl.prompt();
    }
  });

  rl.on("close", () => {
    server.close();
    process.exit(0);
  });
});

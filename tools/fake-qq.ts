/**
 * 假 QQ 后端：模拟 SnowLuma / NapCat 的 OneBot v11 正向 WebSocket。
 *
 *   node tools/fake-qq.ts          # ws://127.0.0.1:3901
 *   curl -X POST localhost:3902/push -d '{"text":"在吗"}'   # 往群里推一条消息
 *   curl localhost:3902/sent                                  # 看它收到了哪些回复
 *
 * 只用来验证控制台接线，不接真 QQ。
 */

import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

const WS_PORT = Number(process.env.FAKE_WS_PORT ?? 3901);
const HTTP_PORT = Number(process.env.FAKE_HTTP_PORT ?? 3902);
const SELF_ID = "10001";
const GROUP_ID = 30003;

const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
const sent: Array<Record<string, unknown>> = [];
const recalls: string[] = [];
const leaves: string[] = [];
let client: WebSocket | undefined;
let seq = 1000;

wss.on("connection", (socket) => {
  client = socket;
  console.log(`[fake-qq] 客户端已连接（共 ${wss.clients.size}）`);

  socket.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as {
      action: string;
      params: Record<string, unknown>;
      echo: string;
    };

    if (msg.action === "get_group_list") {
      socket.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          echo: msg.echo,
          data: [{ group_id: GROUP_ID, group_name: "测试群", member_count: 12 }],
        }),
      );
      return;
    }

    if (msg.action === "delete_msg") {
      recalls.push(String(msg.params.message_id));
      console.log(`[fake-qq] 机器人撤回了消息 ${msg.params.message_id}`);
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: msg.echo, data: null }));
      return;
    }

    if (msg.action === "set_group_leave") {
      leaves.push(String(msg.params.group_id));
      console.log(`[fake-qq] 机器人退出了群 ${msg.params.group_id}`);
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: msg.echo, data: null }));
      return;
    }

    if (msg.action === "send_group_msg") {
      const segments = (msg.params.message as Array<{ type: string; data?: Record<string, unknown> }>) ?? [];
      const text = segments
        .filter((s) => s.type === "text")
        .map((s) => String(s.data?.text ?? ""))
        .join("");
      const images = segments.filter((s) => s.type === "image").length;
      sent.push({ text, images, at: Date.now() });
      console.log(`[fake-qq] 机器人发出：「${text}」${images ? `（含 ${images} 张图）` : ""}`);
      seq += 1;
      socket.send(
        JSON.stringify({ status: "ok", retcode: 0, echo: msg.echo, data: { message_id: seq } }),
      );
      return;
    }

    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: msg.echo, data: null }));
  });
});

// 提供一个 HTTP 口，用来"往群里说一句"和查看回复
const http = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/sent") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sent, recalls, leaves, clients: wss.clients.size }));
    return;
  }

  if (req.method === "POST" && req.url === "/push") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        text?: string;
        sender?: string;
        role?: string;
        noAt?: boolean;
      };
      if (!client) {
        res.writeHead(409).end('{"error":"还没有客户端连上来"}');
        return;
      }
      const message: Array<{ type: string; data?: Record<string, unknown> }> = [];
      if (!body.noAt) {
        message.push({ type: "at", data: { qq: SELF_ID, name: "AI" } });
      }
      message.push({ type: "text", data: { text: ` ${body.text ?? "在吗"}` } });

      seq += 1;
      client.send(
        JSON.stringify({
          post_type: "message",
          message_type: "group",
          self_id: Number(SELF_ID),
          user_id: 20002,
          group_id: GROUP_ID,
          message_id: seq,
          time: Math.floor(Date.now() / 1000),
          sender: {
            user_id: 20002,
            nickname: body.sender ?? "小明",
            card: body.sender ?? "小明",
            role: body.role ?? "member",
          },
          message,
        }),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    return;
  }

  res.writeHead(404).end();
});

http.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log("");
  console.log(`  假 QQ 后端已启动`);
  console.log(`    WebSocket   ws://127.0.0.1:${WS_PORT}`);
  console.log(`    推一条消息  curl -X POST http://127.0.0.1:${HTTP_PORT}/push -d '{"text":"在吗"}'`);
  console.log(`    看回复      curl http://127.0.0.1:${HTTP_PORT}/sent`);
  console.log("");
});

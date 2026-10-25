/**
 * 假的 TTS 服务，用来验证 http 引擎的接线（不需要装 whale-voice）。
 *
 * 它模拟 whale-voice 的约定：POST /tts {text, emotion} → 返回 wav 字节。
 * 返回的是一段 1 秒静音 WAV（体积够大，能通过"空音频"检查）。
 */

import { createServer } from "node:http";

const SAMPLE_RATE = 22050;
const SECONDS = 1;
const samples = SAMPLE_RATE * SECONDS;

// 16-bit PCM 单声道 WAV
const dataSize = samples * 2;
const buf = Buffer.alloc(44 + dataSize);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // 单声道
buf.writeUInt32LE(SAMPLE_RATE, 24);
buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(dataSize, 40);

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/tts")) {
    res.writeHead(404).end("not found");
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c.toString()));
  req.on("end", () => {
    let text = "";
    let emotion = "";
    try {
      const parsed = JSON.parse(body) as { text?: string; emotion?: string };
      text = parsed.text ?? "";
      emotion = parsed.emotion ?? "";
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }

    // 把收到的内容写进日志，方便确认参数真的传过来了
    console.log(`[fake-tts] text=${JSON.stringify(text)} emotion=${emotion}`);

    res.writeHead(200, { "content-type": "audio/wav", "content-length": buf.length });
    res.end(buf);
  });
});

const port = Number(process.env.FAKE_TTS_PORT ?? 7865);
server.listen(port, "127.0.0.1", () => {
  console.log(`fake tts listening on http://127.0.0.1:${port}/tts`);
});

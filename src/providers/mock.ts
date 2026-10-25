/**
 * 离线 Mock Provider：不花钱、不联网，用来演示和跑测试。
 * 它的存在让"下载即用"的体验成为可能 —— 用户没填 Key 也能看到机器人在群里说话。
 */

import type { ChatChunk, ChatRequest, Provider, Usage } from "../types.ts";
import { estimateTokens } from "../text.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export interface MockOptions {
  /** 每个字符块的延迟，测试时设 0 */
  delayMs?: number;
  reply?: (lastUserText: string) => string;
}

export class MockProvider implements Provider {
  readonly id = "mock";
  #delayMs: number;
  #reply: (lastUserText: string) => string;

  constructor(options: MockOptions = {}) {
    this.#delayMs = options.delayMs ?? 8;
    this.#reply =
      options.reply ?? ((text) => `（模拟回复）我收到了：「${text.slice(0, 120)}」。填上 API Key 我就真的会思考了。`);
  }

  async listModels(): Promise<string[]> {
    return ["mock-echo"];
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    // 上下文里的消息带 "[昵称 14:32] " 前缀，回显前要剥掉，否则模拟回复像在背日志
    const rawLine = (lastUser?.content ?? "").split("\n").at(-1) ?? "";
    const input = rawLine.replace(/^\[[^\]]*\]\s*/, "").trim();
    const text = this.#reply(input);

    let emitted = "";
    for (const piece of chunkText(text, 6)) {
      emitted += piece;
      yield { delta: piece };
      if (this.#delayMs > 0) await sleep(this.#delayMs);
    }

    const promptTokens = req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const usage: Usage = {
      promptTokens,
      completionTokens: estimateTokens(emitted),
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: promptTokens,
    };
    yield { finishReason: "stop", usage };
  }
}

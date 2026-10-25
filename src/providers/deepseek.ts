/**
 * DeepSeek Provider（OpenAI 兼容格式，直接走 fetch，不依赖 SDK）。
 *
 * 两个容易踩的坑，这里都处理了：
 * 1. 思考模式默认开启 —— 群聊场景必须显式传 {"thinking":{"type":"disabled"}}。
 * 2. 流式 usage 只出现在 [DONE] 前的最后一个 chunk，必须开 stream_options.include_usage。
 */

import type { ChatChunk, ChatMessage, ChatRequest, Provider, Usage } from "../types.ts";
import { DEFAULT_MODEL } from "../cost.ts";

/**
 * 把内部消息转成 API 格式。
 * 带图片时 content 变成多模态数组，否则保持纯字符串（省得平台嫌格式啰嗦）。
 */
function toApiMessage(msg: ChatMessage): Record<string, unknown> {
  if (!msg.images || msg.images.length === 0) {
    return { role: msg.role, content: msg.content };
  }

  return {
    role: msg.role,
    content: [
      { type: "text", text: msg.content },
      ...msg.images.map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  };
}

export class ProviderError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status = 0, retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

interface UsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

function mapUsage(raw: UsagePayload): Usage {
  const promptTokens = raw.prompt_tokens ?? 0;
  const cacheHitTokens = raw.prompt_cache_hit_tokens ?? 0;
  const cacheMissTokens = raw.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens);
  return {
    promptTokens,
    completionTokens: raw.completion_tokens ?? 0,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? 0,
    cacheHitTokens,
    cacheMissTokens,
  };
}

interface StreamEnvelope {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: UsagePayload | null;
}

export class DeepSeekProvider implements Provider {
  readonly id = "deepseek";
  #apiKey: string;
  #baseUrl: string;
  #defaultModel: string;
  #timeoutMs: number;
  #maxRetries: number;

  constructor(options: DeepSeekOptions) {
    if (!options.apiKey) {
      throw new ProviderError("缺少 DeepSeek API Key", 401, false);
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
    this.#defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.#baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.#apiKey}` },
    });
    if (!res.ok) {
      throw new ProviderError(`listModels failed: ${res.status}`, res.status, isRetryableStatus(res.status));
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const body = this.#buildBody(req);
    let attempt = 0;

    for (;;) {
      let yieldedAny = false;
      try {
        for await (const chunk of this.#streamOnce(body, req.signal)) {
          yieldedAny = true;
          yield chunk;
        }
        return;
      } catch (err) {
        const retryable = err instanceof ProviderError ? err.retryable : true;
        if (yieldedAny || attempt >= this.#maxRetries || !retryable) {
          throw err;
        }
        attempt += 1;
        await sleep(400 * 2 ** attempt);
      }
    }
  }

  #buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model || this.#defaultModel,
      messages: req.messages.map((m) => toApiMessage(m)),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxOutputTokens,
    };

    if (req.thinking) {
      body.thinking = { type: "enabled" };
      if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
      // 思考模式下 temperature 无效，不传
    } else {
      body.thinking = { type: "disabled" };
      if (typeof req.temperature === "number") body.temperature = req.temperature;
    }

    // user_id 用于 KV 缓存隔离与内容安全审核，必须是脱敏值
    if (req.userId) body.user_id = req.userId;

    return body;
  }

  async *#streamOnce(body: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const res = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combined,
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        detail = "";
      }
      throw new ProviderError(
        `DeepSeek API ${res.status}: ${detail}`,
        res.status,
        isRetryableStatus(res.status),
      );
    }
    if (!res.body) {
      throw new ProviderError("DeepSeek API 返回空响应体", 0, true);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        for (;;) {
          const idx = buffer.indexOf("\n\n");
          if (idx < 0) break;
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const parsed = this.#parseSseBlock(block);
          if (parsed === "done") return;
          if (parsed) yield parsed;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  #parseSseBlock(block: string): ChatChunk | "done" | null {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return null;

    const payload = dataLines.join("");
    if (payload === "[DONE]") return "done";
    if (!payload) return null;

    let json: StreamEnvelope;
    try {
      json = JSON.parse(payload) as StreamEnvelope;
    } catch {
      return null; // 半包/杂散数据，忽略
    }

    const choice = json.choices?.[0];
    const chunk: ChatChunk = {};

    const content = choice?.delta?.content;
    if (typeof content === "string" && content.length > 0) chunk.delta = content;

    const reasoning = choice?.delta?.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) chunk.reasoningDelta = reasoning;

    if (choice?.finish_reason) chunk.finishReason = choice.finish_reason;
    if (json.usage) chunk.usage = mapUsage(json.usage);

    return Object.keys(chunk).length > 0 ? chunk : null;
  }
}

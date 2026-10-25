/**
 * 流式输出 → 可发送的消息段。
 *
 * 为什么不能"来一个 token 就发一条"：既刷屏又浪费。
 * 策略：句子边界一到就发，最多发 maxSegments 条，剩余在 flush 时一次发出。
 */

import { safeSlice } from "./text.ts";

const BOUNDARY = new Set(["。", "！", "？", "!", "?", "…", "\n"]);

export class SentenceSplitter {
  #buf = "";
  #maxLen: number;
  #maxSegments: number;
  #emitted = 0;

  constructor(maxLen = 600, maxSegments = 3) {
    this.#maxLen = Math.max(20, maxLen);
    this.#maxSegments = Math.max(1, maxSegments);
  }

  get emittedCount(): number {
    return this.#emitted;
  }

  push(delta: string): string[] {
    if (!delta) return [];
    this.#buf += delta;

    const out: string[] = [];
    // 最后一段留给 flush，避免把"半句话"提前发出去
    const limit = this.#maxSegments - 1;
    while (this.#emitted < limit) {
      const idx = this.#findBoundary();
      if (idx < 0) break;
      const seg = this.#buf.slice(0, idx).trim();
      this.#buf = this.#buf.slice(idx);
      if (seg) {
        out.push(seg);
        this.#emitted += 1;
      }
    }
    return out;
  }

  flush(): string | undefined {
    const rest = this.#buf.trim();
    this.#buf = "";
    if (!rest) return undefined;
    return safeSlice(rest, this.#maxLen);
  }

  /** 返回切分位置（不含），-1 表示还没到边界 */
  #findBoundary(): number {
    for (let i = 0; i < this.#buf.length; i += 1) {
      const ch = this.#buf[i]!;
      if (BOUNDARY.has(ch)) {
        // 连续标点一起切掉，如 "？！"
        let j = i + 1;
        while (j < this.#buf.length && BOUNDARY.has(this.#buf[j]!)) j += 1;
        return j;
      }
      if (i + 1 >= this.#maxLen) return this.#maxLen;
    }
    return -1;
  }
}

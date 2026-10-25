/**
 * 文本工具：token 估算、消息分段、拟人化延迟。
 *
 * 这里的 token 估算只是启发式，用于控制上下文预算。真实计费以 API 返回的
 * usage 为准，二者不要混用。
 */

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;

/**
 * 粗估 token 数。
 * 经验值：中文约 1 token / 1.5 字，ASCII 约 1 token / 4 字符，其余按 1 字符 1 token。
 * 会系统性低估长英文，但用于"预算裁剪"足够（宁可多留余量）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      cjk += 1;
    } else if ((ch.codePointAt(0) ?? 0) < 128) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk / 1.5 + ascii / 4 + other);
}

/**
 * 把一段回复切成适合聊天软件发送的多条短消息。
 *
 * 为什么需要：QQ 单条有长度上限，且真人不会一次发 2000 字。
 * 策略：按句切分 → 贪心打包到 maxLen → 超过 maxSegments 时把尾部合并并截断。
 */
export function splitForChat(text: string, maxLen = 1800, maxSegments = 3): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxLen) return [normalized];

  const sentences = normalized.split(/(?<=[。！？!?…\n；;])/);
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length <= maxLen) {
      buf += s;
    } else {
      if (buf) chunks.push(buf);
      buf = s;
    }
  }
  if (buf) chunks.push(buf);

  // 单句本身超长时硬切
  const hard: string[] = [];
  for (const c of chunks) {
    if (c.length <= maxLen) {
      hard.push(c);
    } else {
      for (let i = 0; i < c.length; i += maxLen) hard.push(c.slice(i, i + maxLen));
    }
  }

  if (hard.length <= maxSegments) return hard.map((s) => s.trim()).filter(Boolean);

  const head = hard.slice(0, maxSegments - 1).map((s) => s.trim());
  const tailRaw = hard.slice(maxSegments - 1).join("");
  const tail = tailRaw.length > maxLen ? `${tailRaw.slice(0, maxLen - 1)}…` : tailRaw;
  return [...head, tail].filter(Boolean);
}

/**
 * 模拟打字时间：按字数算，夹在 300ms ~ 3000ms。
 * rng 可注入，测试时可固定。
 */
export function typingDelayMs(chars: number, rng: () => number = Math.random): number {
  const perChar = 20 + rng() * 20;
  const raw = chars * perChar;
  return Math.max(300, Math.min(3000, Math.round(raw)));
}

/** 把毫秒格式化成 "14:32" */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 日志脱敏：任何 sk- 开头的凭证都不允许出现在日志里 */
export function redactSecrets(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***");
}

/** 以 \n 安全截断，避免切坏 UTF-16 代理对 */
export function safeSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

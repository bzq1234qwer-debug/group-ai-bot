/**
 * 记忆系统 · 第一层：滚动摘要。
 *
 * 没有它，聊到第 61 条就会忘记第 1 条；有了它，60 条之前的内容会被压成一段话，
 * 关键事实（谁是谁、约定了什么、这个群的规矩）能一直带着走。
 *
 * 触发时机：每轮对话结束后检查一次，累积够多才真的一次模型调用 —— 不是每条都调。
 */

import type { Provider } from "./types.ts";
import type { Store } from "./store.ts";
import type { HistoryRow } from "./context.ts";
import { estimateTokens, formatClock, safeSlice } from "./text.ts";

const SUMMARY_SYSTEM = [
  "你在维护一个群聊 AI 的长期记忆。把下面这段聊天压缩成摘要。",
  "",
  "最高优先（丢了就是事故，必须逐条写清楚）：",
  "- 人名/昵称，以及各自身份、职业、和「我」的关系",
  "- 数字：金额、数量、日期、时间点、截止期",
  "- 承诺与约定：谁答应了什么、什么时候、什么条件",
  "- 明确表态的偏好和禁忌：「别叫我全名」「这群不许发广告」",
  "",
  "次优先：",
  "- 主要话题和结论（一句话一条）",
  "- 正在进行、还没结束的待办",
  "",
  "直接丢掉：",
  "- 寒暄、重复内容、情绪宣泄、「哈哈哈」这类",
  "",
  "写法：",
  "- 一条一句，第三人称，每行以「- 」开头",
  "- 写成「谁 + 是什么/做了什么 + 关键数字」，例如「- 张三 是群主，做外贸，周三前交方案」",
  "- 总长不超过 400 字",
  "- 只写聊天里真实出现过的信息，不许推测或编造",
  "",
  "输出格式（必须严格遵守，两段都要有）：",
  "【摘要】",
  "- ……",
  "",
  "【事实】",
  "- 主体 | 属性 | 值",
  "",
  "事实段的规则：",
  "- 只写长期有用的属性：身份/职业、称呼偏好、禁忌、群规、承诺、待办",
  "- 主体写具体的人名；提到你自己时用你的名字，不要写「我」；群级规则写「本群」",
  "- 属性用短词：身份、职业、偏好、禁忌、群规、承诺、待办",
  "- 一行一条，最多 12 条；没有值得记的就写「【事实】」后面空着",
  "- 不要写寒暄、情绪、一次性的话题",
].join("\n");

export interface SummarizeOptions {
  store: Store;
  provider: Provider;
  convKey: string;
  model: string;
  /** 至少积累多少条才开始压缩 */
  minMessages?: number;
  /** 最近多少条留在短期窗口里，不参与压缩 */
  keepRecent?: number;
  /** 一次最多压缩多少条，防止 prompt 过长 */
  maxBatch?: number;
  /** AI 自己的名字，用于在 transcript 里代替「我」 */
  botName?: string;
  now?: () => number;
}

export interface SummarizeResult {
  summarized: boolean;
  covered: number;
  reason?: string;
  /** 这次顺带写入/更新了多少条事实 */
  facts?: number;
}

export async function summarizeIfNeeded(opts: SummarizeOptions): Promise<SummarizeResult> {
  const minMessages = opts.minMessages ?? 30;
  const keepRecent = opts.keepRecent ?? 20;
  const maxBatch = opts.maxBatch ?? 120;
  const now = opts.now ?? Date.now;

  const upto = opts.store.getSummaryUpto(opts.convKey);
  const rows = opts.store.messagesSince(opts.convKey, upto, maxBatch + keepRecent);

  // 留出一截在短期窗口里，只压缩"已经快要掉出去"的部分
  const pending = rows.length - keepRecent;
  if (pending < minMessages) {
    return { summarized: false, covered: 0, reason: "还不够多" };
  }

  const batch = rows.slice(0, Math.min(pending, maxBatch));
  if (batch.length === 0) return { summarized: false, covered: 0 };

  const previous = opts.store.getSummary(opts.convKey);
  const transcript = renderTranscript(batch, opts.botName);

  const userContent = [
    previous ? `【此前的摘要】\n${previous}\n` : "",
    "【新的聊天记录】",
    transcript,
  ]
    .filter(Boolean)
    .join("\n");

  let text = "";
  const controller = new AbortController();
  for await (const chunk of opts.provider.chat({
    model: opts.model,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: userContent },
    ],
    maxOutputTokens: 600,
    temperature: 0.3,
    thinking: false,
    signal: controller.signal,
  })) {
    if (chunk.delta) text += chunk.delta;
  }

  const parsed = parseSummaryOutput(text);
  if (!parsed.summary) {
    return { summarized: false, covered: 0, reason: "模型返回空" };
  }

  const lastTs = batch[batch.length - 1]!.ts;
  opts.store.setSummary(opts.convKey, safeSlice(parsed.summary, 1200), lastTs, now());

  // 同一次调用顺手拿到结构化事实，不额外花钱
  const facts = opts.store.upsertFacts(opts.convKey, parsed.facts, lastTs, now());

  return { summarized: true, covered: batch.length, facts };
}

export interface ParsedSummary {
  summary: string;
  facts: Array<{ subject: string; attribute: string; value: string }>;
}

/**
 * 把模型输出拆成「摘要」和「事实」两段。
 * 解析失败时整段当摘要用 —— 宁可退化成旧行为，也不能丢内存。
 */
export function parseSummaryOutput(raw: string): ParsedSummary {
  const marker = "【事实】";
  const index = raw.indexOf(marker);

  if (index < 0) {
    return { summary: cleanSummary(raw), facts: [] };
  }

  const summaryPart = cleanSummary(raw.slice(0, index));
  const factsPart = raw.slice(index + marker.length);

  const facts: ParsedSummary["facts"] = [];
  for (const line of factsPart.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*[-•*]\s*/, "").trim();
    if (!cleaned || !cleaned.includes("|")) continue;

    const [subject, attribute, ...rest] = cleaned.split("|").map((s) => s.trim());
    if (!subject || !attribute || rest.length === 0) continue;
    const value = rest.join("|").trim();
    if (!value) continue;

    facts.push({ subject, attribute, value });
  }

  return { summary: summaryPart, facts };
}

function cleanSummary(text: string): string {
  return text
    .replace(/【摘要】/g, "")
    .replace(/^\s*【.*?】\s*$/gm, "")
    .trim();
}

function renderTranscript(rows: HistoryRow[], botName?: string): string {
  const self = botName && botName.trim() ? botName.trim() : "AI";
  return rows
    .map((r) => `[${formatClock(r.ts)}] ${r.isSelf ? self : r.senderName}：${r.text}`)
    .join("\n");
}

/** 粗略估算一次压缩要花多少 token，给控制台做提示用 */
export function estimateSummaryTokens(rows: HistoryRow[]): number {
  return rows.reduce((sum, r) => sum + estimateTokens(r.text) + 8, 0);
}

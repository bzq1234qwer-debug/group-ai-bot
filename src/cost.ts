/**
 * 成本计算。价格按 DeepSeek 官方定价页（2026-10）。
 *
 * 注意：官方标价是「非峰时」，峰时翻倍。峰时是 UTC 01:00-04:00 / 06:00-10:00 的工作日，
 * 换算到北京时间正好是 09:00-12:00 和 14:00-18:00 —— 群聊最活跃的时段。
 */

import type { Usage } from "./types.ts";

interface ModelPrice {
  /** 每 1M token 美元，非峰时 */
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

export const PRICING: Record<string, ModelPrice> = {
  "deepseek-flash": { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  "deepseek-v4-pro": { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
};

export const DEFAULT_MODEL = "deepseek-flash";

/** 峰时判定：UTC 工作日 01:00-04:00 与 06:00-10:00 */
export function isPeakTime(now: number): boolean {
  const d = new Date(now);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (
    (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
  );
}

export function peakMultiplier(now: number): number {
  return isPeakTime(now) ? 2 : 1;
}

/**
 * 计算单次调用成本（美元）。
 * 拿不到 cache 明细时，全部输入按 cache miss 计价（保守，宁可高估）。
 */
export function estimateCostUsd(model: string, usage: Usage, now: number): number {
  const price = PRICING[model] ?? PRICING[DEFAULT_MODEL]!;
  const multiplier = peakMultiplier(now);

  const hit = Math.max(0, usage.cacheHitTokens);
  const miss = usage.cacheMissTokens > 0 ? usage.cacheMissTokens : Math.max(0, usage.promptTokens - hit);

  const inputCost = (hit * price.cacheHit + miss * price.cacheMiss) / 1_000_000;
  const outputCost = (usage.completionTokens * price.output) / 1_000_000;

  return (inputCost + outputCost) * multiplier;
}

export function usdToCny(usd: number, rate = 7.2): number {
  return usd * rate;
}

export function formatCny(cny: number): string {
  if (cny < 0.01) return `¥${cny.toFixed(4)}`;
  return `¥${cny.toFixed(2)}`;
}

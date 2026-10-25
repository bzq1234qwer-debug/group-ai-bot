/**
 * 表情包：从本地目录随机挑一张图。
 *
 * 不做表情包"理解"，也不联网下载 —— 用户自己往目录里丢图，用哪张随机。
 * 这样没有版权风险，也不用担心图片加载失败。
 */

import { readdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export function listImages(dir: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => IMAGE_EXT.has(extname(name).toLowerCase()))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export function pickRandomImage(dir: string, rng: () => number = Math.random): string | undefined {
  const images = listImages(dir);
  if (images.length === 0) return undefined;
  return images[Math.floor(rng() * images.length)];
}

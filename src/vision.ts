/**
 * 看图：把群里的图片变成能喂给模型的 data URL。
 *
 * 两个现实约束：
 * 1. QQ 的图片地址带 rkey，过一会儿就失效 —— 必须收到就取，不能延迟
 * 2. 不能把地址直接交给模型 API 让它自己下载：很多地址需要参考头或会过期，
 *    所以服务端先抓好、转成 data URL 再发
 */

import { existsSync, readFileSync, statSync } from "node:fs";

/** 单张图最大 4MB，再大就跳过（base64 之后还会膨胀 1/3） */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** 一条消息最多带几张图，控制成本 */
const MAX_IMAGES = 2;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function guessMime(pathOrUrl: string): string {
  const clean = pathOrUrl.split("?")[0]!.toLowerCase();
  const ext = clean.split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "image/jpeg";
}

/** 取不到就返回 null —— 聊天不该因为一张图挂掉 */
export async function loadImageUrl(ref: string | undefined): Promise<string | null> {
  if (!ref) return null;

  try {
    // 本地文件：NapCat 有时直接给磁盘路径
    if (!/^https?:\/\//i.test(ref)) {
      const path = ref.replace(/^file:\/\//i, "");
      if (!existsSync(path)) return null;
      if (statSync(path).size > MAX_IMAGE_BYTES) return null;
      return `data:${guessMime(path)};base64,${readFileSync(path).toString("base64")}`;
    }

    const res = await fetch(ref, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;

    const type = res.headers.get("content-type") ?? guessMime(ref);
    const mime = type.startsWith("image/") ? type.split(";")[0]! : guessMime(ref);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export interface ImageLoadResult {
  urls: string[];
  failed: number;
}

/** 一次取多张，失败的不阻塞成功的 */
export async function loadImageUrls(refs: Array<string | undefined>): Promise<ImageLoadResult> {
  const picked = refs.filter((r): r is string => Boolean(r)).slice(0, MAX_IMAGES);
  const urls: string[] = [];
  let failed = 0;

  for (const ref of picked) {
    const url = await loadImageUrl(ref);
    if (url) urls.push(url);
    else failed += 1;
  }

  return { urls, failed };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImageUrl, loadImageUrls } from "../src/vision.ts";

function pngFile(dir: string, name: string): string {
  const path = join(dir, name);
  // 够用的 PNG 头，测试只关心能不能读出来并转 base64
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return path;
}

test("本地图片转成 data URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-"));
  const url = await loadImageUrl(pngFile(dir, "a.png"));

  assert.ok(url, "应当能读出图片");
  assert.ok(url!.startsWith("data:image/png;base64,"));
});

test("取不到就返回 null，不抛错", async () => {
  assert.equal(await loadImageUrl(undefined), null);
  assert.equal(await loadImageUrl("/definitely/not/here.png"), null);
  assert.equal(await loadImageUrl("https://127.0.0.1:1/nope.png"), null);
});

test("一条消息最多带两张图，多余的不取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-"));
  const refs = [pngFile(dir, "1.png"), pngFile(dir, "2.png"), pngFile(dir, "3.png")];

  const result = await loadImageUrls(refs);
  assert.equal(result.urls.length, 2);
});

test("部分失败不影响其余图片", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-"));
  const good = pngFile(dir, "ok.png");

  const result = await loadImageUrls([good, "/missing.png"]);
  assert.equal(result.urls.length, 1);
  assert.equal(result.failed, 1);
});

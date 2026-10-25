import { test } from "node:test";
import assert from "node:assert/strict";
import { createZip, crc32 } from "../src/zip.ts";

test("CRC32 对已知输入结果正确", () => {
  // "123456789" 的 CRC32 是 0xCBF43926，这是标准测试向量
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("zip 有正确的签名和文件数", () => {
  const zip = createZip([
    { name: "a/chat.md", data: Buffer.from("你好，世界", "utf8") },
    { name: "a/_index.md", data: Buffer.from("# 索引", "utf8") },
  ]);

  // 本地文件头
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  // EOCD 在最后 22 字节
  const eocdStart = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdStart), 0x06054b50);
  assert.equal(zip.readUInt16LE(eocdStart + 8), 2, "应当记录 2 个文件");
});

test("文件名用 UTF-8，中文路径不乱码", () => {
  const zip = createZip([{ name: "群/chat.md", data: Buffer.from("x") }]);
  assert.ok(zip.includes(Buffer.from("群/chat.md", "utf8")));
});

test("空列表也能产出一个合法的空 zip", () => {
  const zip = createZip([]);
  assert.equal(zip.length, 22);
  assert.equal(zip.readUInt32LE(0), 0x06054b50);
});

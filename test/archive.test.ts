import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { archiveDay, listArchivedDays, safeFolderName } from "../src/archive.ts";

function seed(store: Store, convKey: string, entries: Array<[number, string, string, boolean]>): void {
  for (const [ts, sender, text, isSelf] of entries) {
    store.appendMessage({
      id: `${convKey}:${ts}:${Math.random()}`,
      convKey,
      senderId: sender,
      senderName: sender,
      isSelf,
      text,
      ts,
    });
  }
}

test("归档：按会话分文件夹，一天一个目录", () => {
  const root = mkdtempSync(join(tmpdir(), "archive-"));
  const store = new Store(":memory:");
  const day = new Date(2026, 9, 23, 12, 0, 0);

  seed(store, "qq:10001:group:30003", [
    [new Date(2026, 9, 23, 10, 0).getTime(), "小明", "今天开会吗", false],
    [new Date(2026, 9, 23, 10, 1).getTime(), "大肥鱼", "开，别迟到", true],
  ]);
  seed(store, "qq:10001:private:20002", [
    [new Date(2026, 9, 23, 11, 0).getTime(), "小红", "在吗", false],
  ]);

  const result = archiveDay({ store, root, day });

  assert.equal(result.conversations, 2);
  assert.equal(result.messages, 3);
  assert.ok(existsSync(join(root, "2026-10-23", "_index.md")));

  const groupDir = join(root, "2026-10-23", safeFolderName("qq:10001:group:30003"));
  assert.ok(existsSync(join(groupDir, "chat.md")), "群归档应当存在");

  const text = readFileSync(join(groupDir, "chat.md"), "utf8");
  assert.ok(text.includes("小明"), "应当包含发言人");
  assert.ok(text.includes("开，别迟到"), "应当包含内容");
  assert.ok(text.includes("AI"), "应当标出 AI 的发言");

  store.close();
});

test("归档：只收当天，不串天", () => {
  const root = mkdtempSync(join(tmpdir(), "archive-"));
  const store = new Store(":memory:");
  const day = new Date(2026, 9, 23, 12, 0, 0);

  seed(store, "qq:10001:group:1", [
    [new Date(2026, 9, 22, 23, 59).getTime(), "前一天", "不该出现", false],
    [new Date(2026, 9, 23, 0, 1).getTime(), "当天", "该出现", false],
    [new Date(2026, 9, 24, 0, 1).getTime(), "后一天", "不该出现", false],
  ]);

  const result = archiveDay({ store, root, day });
  assert.equal(result.messages, 1);

  const text = readFileSync(
    join(root, "2026-10-23", safeFolderName("qq:10001:group:1"), "chat.md"),
    "utf8",
  );
  assert.ok(text.includes("该出现"));
  assert.ok(!text.includes("不该出现"));

  store.close();
});

test("归档：没有消息的日期也会生成空索引", () => {
  const root = mkdtempSync(join(tmpdir(), "archive-"));
  const store = new Store(":memory:");
  const result = archiveDay({ store, root, day: new Date(2026, 9, 20, 12, 0, 0) });

  assert.equal(result.messages, 0);
  assert.ok(existsSync(join(root, "2026-10-20", "_index.md")));
  store.close();
});

test("归档：按保留天数清理旧目录", () => {
  const root = mkdtempSync(join(tmpdir(), "archive-"));
  const store = new Store(":memory:");

  const old = join(root, "2000-01-01");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "_index.md"), "old", "utf8");

  archiveDay({ store, root, day: new Date(2026, 9, 23, 12, 0, 0), keepDays: 7 });

  assert.ok(!existsSync(old), "超期目录应当被清掉");
  assert.ok(existsSync(join(root, "2026-10-23")), "当天的不该被清");
  store.close();
});

test("归档列表能列出已有日期", () => {
  const root = mkdtempSync(join(tmpdir(), "archive-"));
  const store = new Store(":memory:");
  archiveDay({ store, root, day: new Date(2026, 9, 22, 12, 0, 0) });
  archiveDay({ store, root, day: new Date(2026, 9, 23, 12, 0, 0) });

  const days = listArchivedDays(root);
  assert.deepEqual(days.map((d) => d.day), ["2026-10-23", "2026-10-22"]);
  store.close();
});

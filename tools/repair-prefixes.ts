/**
 * 一次性修复：把历史消息里被模型模仿出来的前缀清掉。
 *
 * 起因：早期版本把模型原始输出直接存库，而原始输出常带 "[大肥鱼 18:25]" 这种
 * 对话格式前缀。这些消息又被喂回上下文，模型就学着继续加前缀，越滚越多。
 * 现在写入已经改成存"真正发出去的干净文本"，但库里的存量还得洗一遍，
 * 否则它仍然会被自己的历史带偏。
 *
 * 用法：node tools/repair-prefixes.ts
 */

import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(HERE, "..", "data", "console.db");

const TRANSCRIPT_PREFIX = /^\s*[\[【]\s*[^\]】\n]{0,24}?\s*\d{1,2}[:：]\d{2}\s*[\]】]\s*/;
const NAME_PREFIX = /^(?:大肥鱼|本鱼|AI|助手|机器人)\s*[：:]\s*/;

function cleanup(text: string): string {
  let out = text;
  // 可能连写好几层，最多剥 5 次
  for (let i = 0; i < 5; i += 1) {
    const before = out;
    out = out.replace(TRANSCRIPT_PREFIX, "").replace(NAME_PREFIX, "");
    if (out === before) break;
  }
  return out.trim();
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

const rows = db.prepare("SELECT id, conv_key AS convKey, text FROM messages WHERE is_self = 1").all() as Array<{
  id: string;
  convKey: string;
  text: string;
}>;

const update = db.prepare("UPDATE messages SET text = ? WHERE id = ?");
let changed = 0;
for (const row of rows) {
  const cleaned = cleanup(row.text);
  if (cleaned && cleaned !== row.text) {
    update.run(cleaned, row.id);
    changed += 1;
  }
}

// 全文索引里存的是旧文本，一并重建，否则检索还会把带前缀的句子捞回来
db.exec("DELETE FROM message_fts");
const all = db.prepare(
  "SELECT conv_key AS convKey, ts, sender_name AS senderName, text FROM messages",
).all() as Array<{ convKey: string; ts: number; senderName: string; text: string }>;

const insert = db.prepare(
  "INSERT INTO message_fts (conv_key, ts, sender, body, raw) VALUES (?, ?, ?, ?, ?)",
);
for (const r of all) {
  const body = r.text.replace(/[\u4e00-\u9fff]/g, (c) => ` ${c} `).replace(/\s+/g, " ").trim();
  insert.run(r.convKey, r.ts, r.senderName, body, r.text);
}

console.log(`清洗完成：${changed} 条消息去掉前缀，全文索引重建 ${all.length} 条。`);
db.close();

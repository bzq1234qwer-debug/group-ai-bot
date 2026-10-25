/**
 * 每日归档：把当天的聊天记录按会话分文件夹写出来。
 *
 * 为什么存在：数据库里每个会话只留 200 条，超过就被物理删除。
 * 归档是唯一能把"说过的话"长期留下来的东西 —— 也是用户自己的数据备份。
 *
 * 目录结构：
 *   data/archive/2026-10-24/
 *     _index.md
 *     qq-10001-group-30003/chat.md
 *     qq-10001-private-20002/chat.md
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryRow } from "./context.ts";
import type { Store } from "./store.ts";
import { formatClock } from "./text.ts";
import { createZip } from "./zip.ts";

export interface ArchiveOptions {
  store: Store;
  /** 归档根目录，例如 data/archive */
  root: string;
  /** 要归档哪一天；默认昨天 */
  day?: Date;
  /** 保留多少天；0 或负数 = 不清理 */
  keepDays?: number;
  /** convKey → 名字（群名/对方昵称），有就用名字当标题 */
  titles?: Record<string, string>;
}

export interface ArchiveResult {
  day: string;
  dir: string;
  conversations: number;
  messages: number;
  pruned: string[];
}

/** 会话键里有冒号，不能直接当文件夹名 */
export function safeFolderName(convKey: string): string {
  return convKey.replace(/[:\\/*?"<>|]/g, "-");
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function describeConv(convKey: string, titles?: Record<string, string>): string {
  const named = titles?.[convKey];
  if (named) return named;

  const parts = convKey.split(":");
  const kind = parts[parts.length - 2] ?? "";
  const id = parts[parts.length - 1] ?? convKey;
  if (kind === "group") return `群 ${id}`;
  if (kind === "private") return `私聊 ${id}`;
  return convKey;
}

function renderChat(
  convKey: string,
  day: string,
  rows: HistoryRow[],
  titles?: Record<string, string>,
): string {
  const lines: string[] = [];
  lines.push(`# ${describeConv(convKey, titles)}`);
  lines.push("");
  lines.push(`- 会话：\`${convKey}\``);
  lines.push(`- 日期：${day}`);
  lines.push(`- 消息数：${rows.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const r of rows) {
    const who = r.isSelf ? "**AI**" : `**${r.senderName}**`;
    lines.push(`- ${formatClock(r.ts)} ${who}：${r.text.replace(/\n/g, " ")}`);
  }

  return `${lines.join("\n")}\n`;
}

export function archiveDay(opts: ArchiveOptions): ArchiveResult {
  const target = startOfDay(opts.day ?? new Date(Date.now() - 24 * 3600_000));
  const from = target.getTime();
  const to = from + 24 * 3600_000;
  const key = dayKey(target);

  const dayDir = join(opts.root, key);
  mkdirSync(dayDir, { recursive: true });

  const rows = opts.store.messagesBetween(from, to);

  const byConv = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const list = byConv.get(row.convKey);
    if (list) list.push(row);
    else byConv.set(row.convKey, [row]);
  }

  for (const [convKey, list] of byConv) {
    const dir = join(dayDir, safeFolderName(convKey));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "chat.md"), renderChat(convKey, key, list, opts.titles), "utf8");
  }

  // 当天索引
  const index: string[] = [`# ${key} 聊天归档`, "", `共 ${byConv.size} 个会话、${rows.length} 条消息。`, ""];
  for (const [convKey, list] of byConv) {
    index.push(`- [${describeConv(convKey, opts.titles)}](${safeFolderName(convKey)}/chat.md) — ${list.length} 条`);
  }
  writeFileSync(join(dayDir, "_index.md"), `${index.join("\n")}\n`, "utf8");

  // 清理超期归档：按文件夹名里的日期算，不能看 mtime
  // （刚创建的旧日期文件夹 mtime 是现在，看 mtime 永远清不掉）
  const pruned: string[] = [];
  const keepDays = opts.keepDays ?? 0;
  if (keepDays > 0) {
    const cutoff = startOfDay(new Date(Date.now() - keepDays * 24 * 3600_000)).getTime();
    for (const name of readdirSync(opts.root)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
      const [y, m, d] = name.split("-").map(Number);
      const folderDay = new Date(y!, (m ?? 1) - 1, d ?? 1).getTime();
      if (folderDay < cutoff) {
        rmSync(join(opts.root, name), { recursive: true, force: true });
        // 配套的压缩包也一起清掉，别留孤儿文件
        rmSync(join(opts.root, `${name}.zip`), { force: true });
        pruned.push(name);
      }
    }
  }

  return { day: key, dir: dayDir, conversations: byConv.size, messages: rows.length, pruned };
}

/**
 * 把某一天的归档文件夹打成一个 zip，方便备份和发给别人。
 * 返回压缩包路径；那天没有文件就返回 undefined。
 */
export function zipDay(root: string, day: string): { file: string; entries: number } | undefined {
  const dir = join(root, day);
  if (!existsSync(dir)) return undefined;

  const entries: Array<{ name: string; data: Buffer }> = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = full.slice(root.length + 1).replace(/\\/g, "/");
        entries.push({ name: rel, data: readFileSync(full) });
      }
    }
  };

  try {
    walk(dir);
  } catch {
    return undefined;
  }

  if (entries.length === 0) return undefined;

  const file = join(root, `${day}.zip`);
  writeFileSync(file, createZip(entries));
  return { file, entries: entries.length };
}

/** 已经归档了哪些天（新的在前） */
export function listArchivedDays(root: string): Array<{ day: string; sizeKb: number }> {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .reverse()
    .map((day) => {
      const full = join(root, day);
      let size = 0;
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else size += statSync(p).size;
        }
      };
      try {
        walk(full);
      } catch {
        // 目录正在写就跳过
      }
      return { day, sizeKb: Math.round(size / 1024) };
    });
}

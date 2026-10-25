/**
 * 持久化：node:sqlite（Node 24 内置，无需编译原生模块）。
 *
 * 单文件数据库，用户备份就是拷一个文件。
 */

import { DatabaseSync } from "node:sqlite";
import type { Conversation, Channel } from "./types.ts";
import { parseConvKey } from "./types.ts";
import type { HistoryRow } from "./context.ts";

export interface UsageRecord {
  bindingId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  cacheHit: number;
  costUsd: number;
  ts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  self_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  key TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT,
  member_count INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv_key TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conv_key, ts DESC);

CREATE TABLE IF NOT EXISTS sessions (
  conv_key TEXT PRIMARY KEY,
  summary TEXT,
  summary_upto INTEGER,
  turn_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id TEXT,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_ledger(ts);
`;

/**
 * 长期记忆的全文索引。
 *
 * FTS5 的默认分词器不认识中文 —— 整句会被当成一个词，搜"方案"永远搜不到。
 * 所以入库前把中文按字拆开、空格分隔（"方 案"），查询也用同样方式，
 * 再用短语查询把它们连起来匹配。
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  conv_key UNINDEXED,
  ts UNINDEXED,
  sender UNINDEXED,
  body,
  raw UNINDEXED
);
`;

/**
 * 结构化事实：谁的什么属性是什么。
 *
 * 和摘要的区别：摘要是"一段话"，模型每次得通读；
 * 事实是"一条记录"，可以直接查、可以被新的覆盖旧的。
 */
const FACTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  source_ts INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(conv_key, subject, attribute)
);
CREATE INDEX IF NOT EXISTS idx_facts_conv ON facts(conv_key, updated_at);
`;

/** 一个会话最多保留多少条事实，防止无限膨胀 */
const FACTS_PER_CONV = 80;

/** 这些词做主语没有区分度，不能进事实库 */
const PRONOUN_SUBJECTS = new Set([
  "我",
  "你",
  "他",
  "她",
  "它",
  "本人",
  "对方",
  "我们",
  "你们",
  "他们",
  "这",
  "那",
]);

/** 中文按字拆开；英文/数字保持原样。用于 FTS 入库和查询。 */
export function segmentForFts(text: string): string {
  return text
    .replace(/[\u4e00-\u9fff]/g, (c) => ` ${c} `)
    .replace(/\s+/g, " ")
    .trim();
}

/** 把一句话变成若干"可检索词"：中文取二字片段，英文取整词 */
export function extractSearchTerms(text: string, max = 8): string[] {
  const cleaned = text
    .replace(/@\S+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, " ");

  const terms: string[] = [];
  const cjkRuns = cleaned.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      terms.push(run.slice(i, i + 2));
      if (terms.length >= max) break;
    }
    if (terms.length >= max) break;
  }

  for (const word of cleaned.match(/[A-Za-z0-9]{2,}/g) ?? []) {
    terms.push(word);
    if (terms.length >= max) break;
  }

  return [...new Set(terms)];
}

export interface StoreOptions {
  /**
   * 全文索引最多保留多少行。
   * messages 表每会话封顶 200，但索引不删才"想得起来"——
   * 代价是它会无限长。所以给一个总数上限，超了丢最旧的。
   */
  ftsMaxRows?: number;
}

/** 默认最多留 10 万行索引；按每群每天几百条算，够用很久 */
const DEFAULT_FTS_MAX_ROWS = 100_000;
/** 每写入这么多条才检查一次容量，避免每条都跑一次 DELETE */
// 索引裁剪改成"超了才删、删多少算多少"，不再每 500 条全表扫一次

/**
 * 每个会话在 messages 表里保留多少条。
 *
 * 注意：这是"工作副本"的上限，不是记忆的长度 ——
 * 更早的话已经进了全文索引（能被检索到），也进了每日归档（能翻原文）。
 * 定 2000 是因为上下文最多只用最近几十条，留太多对对话没有意义，只会拖慢查询。
 */
const KEEP_PER_CONV = 2000;
/** 每写入这么多条才检查一次每会话容量 */
const CONV_PRUNE_EVERY = 200;

export class Store {
  #db: DatabaseSync;
  #ftsMaxRows: number;
  #ftsCount = 0;
  #convInserts = 0;

  constructor(path: string, options: StoreOptions = {}) {
    this.#db = new DatabaseSync(path);
    this.#ftsMaxRows = options.ftsMaxRows ?? DEFAULT_FTS_MAX_ROWS;
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
    this.#db.exec(FTS_SCHEMA);
    this.#db.exec(FACTS_SCHEMA);
    this.#backfillFts();
    this.#ftsCount = this.#countFts();
    this.#pruneFts();
  }

  /**
   * 索引超过上限就丢最旧的。
   * 关键是**只删超出的那几条**：原来是每 500 条做一次 "NOT IN (子查询)"，
   * 数据一多就变成全表扫描，写入越来越慢。
   */
  #pruneFts(): void {
    if (this.#ftsMaxRows <= 0) return;
    const excess = this.#ftsCount - this.#ftsMaxRows;
    if (excess <= 0) return;

    try {
      this.#db
        .prepare(
          `DELETE FROM message_fts WHERE rowid IN (
             SELECT rowid FROM message_fts ORDER BY rowid ASC LIMIT ?
           )`,
        )
        .run(excess);
      this.#ftsCount = this.#ftsMaxRows;
    } catch {
      // 清理失败不影响读写
    }
  }

  #countFts(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM message_fts").get() as { n: number };
    return Number(row.n);
  }

  /** 老库升级：把 messages 里已有的内容补进全文索引（只做一次） */
  #backfillFts(): void {
    const indexed = this.#db.prepare("SELECT COUNT(*) AS n FROM message_fts").get() as { n: number };
    if (Number(indexed.n) > 0) return;

    const rows = this.#db
      .prepare("SELECT conv_key AS convKey, ts, sender_name AS senderName, text FROM messages")
      .all() as Array<{ convKey: string; ts: number; senderName: string; text: string }>;

    const stmt = this.#db.prepare(
      "INSERT INTO message_fts (conv_key, ts, sender, body, raw) VALUES (?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      stmt.run(r.convKey, r.ts, r.senderName, segmentForFts(r.text), r.text);
    }
  }

  close(): void {
    this.#db.close();
  }

  upsertChannel(channel: Channel, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO channels (id, kind, label, status, self_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, self_id = excluded.self_id, updated_at = excluded.updated_at`,
      )
      .run(channel.id, channel.kind, channel.label, channel.status, channel.selfId ?? null, now);
  }

  upsertConversation(conv: Conversation, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO conversations (key, channel_id, type, external_id, title, member_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET title = excluded.title, member_count = excluded.member_count, updated_at = excluded.updated_at`,
      )
      .run(
        conv.key,
        conv.channelId,
        conv.type,
        conv.externalId,
        conv.title ?? null,
        conv.memberCount ?? null,
        now,
      );
  }

  /** 返回 false 表示这条消息已经处理过（幂等，防 NapCat 重连重放） */
  appendMessage(row: HistoryRow): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, conv_key, sender_id, sender_name, is_self, text, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.convKey, row.senderId, row.senderName, row.isSelf ? 1 : 0, row.text, row.ts);

    const inserted = Number(result.changes) > 0;
    if (!inserted) return false;

    // 同时进全文索引 —— 这样即使 200 条之后被清理，也还能被检索到
    this.#db
      .prepare("INSERT INTO message_fts (conv_key, ts, sender, body, raw) VALUES (?, ?, ?, ?, ?)")
      .run(row.convKey, row.ts, row.senderName, segmentForFts(row.text), row.text);

    // 攒够一批再检查容量，避免每条都跑一次 DELETE
    this.#ftsCount += 1;
    if (this.#ftsMaxRows > 0 && this.#ftsCount > this.#ftsMaxRows) {
      this.#pruneFts();
    }

    // 每会话的工作副本也要有上限，否则 messages 表会无限长
    this.#convInserts += 1;
    if (this.#convInserts >= CONV_PRUNE_EVERY) {
      this.#convInserts = 0;
      this.#pruneConversation(row.convKey);
    }

    return true;
  }

  /** 每个会话只留最近 KEEP_PER_CONV 条工作副本；更早的仍可被索引检索、仍有归档 */
  #pruneConversation(convKey: string): void {
    try {
      this.#db
        .prepare(
          `DELETE FROM messages WHERE conv_key = ? AND id NOT IN (
             SELECT id FROM messages WHERE conv_key = ? ORDER BY ts DESC, id DESC LIMIT ?
           )`,
        )
        .run(convKey, convKey, KEEP_PER_CONV);
    } catch {
      // 清理失败不影响读写
    }
  }

  /** 诊断用：当前全文索引有多少行 */
  countFts(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM message_fts").get() as { n: number };
    return Number(row.n);
  }

  /**
   * 从长期记忆里检索相关历史。
   * 注意：这是关键词匹配，不是语义检索 —— 用 FTS5 换来的零成本。
   */
  searchMemory(
    convKey: string,
    query: string,
    limit = 5,
  ): Array<{ sender: string; ts: number; text: string }> {
    const terms = extractSearchTerms(query);
    if (terms.length === 0) return [];

    const expression = terms.map((t) => `"${segmentForFts(t)}"`).join(" OR ");
    try {
      const rows = this.#db
        .prepare(
          `SELECT sender AS sender, ts AS ts, raw AS text
           FROM message_fts
           WHERE message_fts MATCH ? AND conv_key = ?
           ORDER BY rank LIMIT ?`,
        )
        .all(expression, convKey, limit) as Array<{ sender: string; ts: number; text: string }>;

      return rows.map((r) => ({ sender: r.sender, ts: Number(r.ts), text: r.text }));
    } catch {
      // 查询语法出错不该影响对话
      return [];
    }
  }

  /**
   * 多路召回：关键词命中是基础，再叠加"这个人说过的话"和"最近说过的话"两路加权。
   *
   * 只有一路关键词的问题：问「我上次跟你说的」时，命中的可能全是别人说的话，
   * 而真正该想起来的是同一个人说过的那句。
   */
  recallMemory(
    convKey: string,
    query: string,
    opts: { limit?: number; senderName?: string; now?: number } = {},
  ): Array<{ sender: string; ts: number; text: string; score: number }> {
    const limit = opts.limit ?? 5;
    const now = opts.now ?? Date.now();
    const candidates = this.searchMemory(convKey, query, Math.max(limit * 4, 20));

    const scored = candidates.map((hit, index) => {
      // 关键词排名：越靠前越可信
      let score = 1 / (1 + index * 0.3);

      // 同一个人说过的话，更可能是"你上次跟我说的"
      if (opts.senderName && hit.sender === opts.senderName) score += 0.45;

      // 最近说过的话权重更高，半衰期约两周
      const ageDays = Math.max(0, (now - hit.ts) / 86_400_000);
      score += 0.35 * Math.exp(-ageDays / 14);

      return { ...hit, score };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * 写入事实。同一个「主体 + 属性」用新值覆盖旧值 ——
   * 这就是"换了工作会记住新的"的实现方式，不需要手动删除。
   */
  upsertFacts(
    convKey: string,
    facts: Array<{ subject: string; attribute: string; value: string }>,
    sourceTs: number,
    now: number,
  ): number {
    if (facts.length === 0) return 0;

    const stmt = this.#db.prepare(
      `INSERT INTO facts (conv_key, subject, attribute, value, source_ts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conv_key, subject, attribute)
       DO UPDATE SET value = excluded.value, source_ts = excluded.source_ts, updated_at = excluded.updated_at`,
    );

    let changed = 0;
    for (const fact of facts) {
      const subject = fact.subject.trim().slice(0, 40);
      const attribute = fact.attribute.trim().slice(0, 40);
      const value = fact.value.trim().slice(0, 300);
      if (!subject || !attribute || !value) continue;
      // 代词做主语没有区分度，存进去只会污染事实库
      if (PRONOUN_SUBJECTS.has(subject)) continue;
      stmt.run(convKey, subject, attribute, value, sourceTs, now, now);
      changed += 1;
    }

    // 超量就丢最久没更新的，防止无限膨胀
    this.#db
      .prepare(
        `DELETE FROM facts WHERE conv_key = ? AND id NOT IN (
           SELECT id FROM facts WHERE conv_key = ? ORDER BY updated_at DESC LIMIT ?
         )`,
      )
      .run(convKey, convKey, FACTS_PER_CONV);

    return changed;
  }

  /** 取这个会话的事实，最近更新的在前 */
  listFacts(
    convKey: string,
    limit = 20,
  ): Array<{ id: number; subject: string; attribute: string; value: string; updatedAt: number }> {
    const rows = this.#db
      .prepare(
        `SELECT id, subject, attribute, value, updated_at AS updatedAt
         FROM facts WHERE conv_key = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(convKey, limit) as Array<{
      id: number;
      subject: string;
      attribute: string;
      value: string;
      updatedAt: number;
    }>;

    return rows.map((r) => ({
      id: Number(r.id),
      subject: r.subject,
      attribute: r.attribute,
      value: r.value,
      updatedAt: Number(r.updatedAt),
    }));
  }

  /** 所有会话的事实（控制台展示用） */
  listAllFacts(limit = 200): Array<{
    id: number;
    convKey: string;
    subject: string;
    attribute: string;
    value: string;
    updatedAt: number;
  }> {
    const rows = this.#db
      .prepare(
        `SELECT id, conv_key AS convKey, subject, attribute, value, updated_at AS updatedAt
         FROM facts ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      convKey: string;
      subject: string;
      attribute: string;
      value: string;
      updatedAt: number;
    }>;

    return rows.map((r) => ({
      id: Number(r.id),
      convKey: r.convKey,
      subject: r.subject,
      attribute: r.attribute,
      value: r.value,
      updatedAt: Number(r.updatedAt),
    }));
  }

  /** 删掉一条记错的事实 */
  deleteFact(id: number): boolean {
    const result = this.#db.prepare("DELETE FROM facts WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  /** 给会话起个名字：群名、对方昵称。界面上不能只显示一串 conv key */
  setConversationTitle(convKey: string, title: string, now: number): void {
    const clean = title.trim();
    if (!clean) return;

    const { channelId, type, externalId } = parseConvKey(convKey);
    this.#db
      .prepare(
        `INSERT INTO conversations (key, channel_id, type, external_id, title, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      )
      .run(convKey, channelId, type, externalId, clean, now);
  }

  getConversationTitle(convKey: string): string | undefined {
    const row = this.#db
      .prepare("SELECT title FROM conversations WHERE key = ?")
      .get(convKey) as { title: string | null } | undefined;
    return row?.title ?? undefined;
  }

  /** convKey → 名字，给界面一次性取 */
  conversationTitles(): Record<string, string> {
    const rows = this.#db
      .prepare("SELECT key, title FROM conversations WHERE title IS NOT NULL")
      .all() as Array<{ key: string; title: string }>;

    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.title;
    return map;
  }

  /** 这个会话里最近一条别人说的话是谁说的 —— 用来给老私聊补名字 */
  latestSenderName(convKey: string): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT sender_name AS name FROM messages
         WHERE conv_key = ? AND is_self = 0 AND sender_name != ''
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(convKey) as { name: string } | undefined;
    return row?.name || undefined;
  }

  /** 按消息 id 取一条 —— 被引用时用得上，省一次平台查询 */
  getMessage(id: string): HistoryRow | undefined {
    if (!id) return undefined;
    const row = this.#db
      .prepare(
        `SELECT id, conv_key AS convKey, sender_id AS senderId, sender_name AS senderName,
                is_self AS isSelf, text, ts
         FROM messages WHERE id = ?`,
      )
      .get(id) as (Omit<HistoryRow, "isSelf"> & { isSelf: number }) | undefined;

    if (!row) return undefined;
    return {
      id: row.id,
      convKey: row.convKey,
      senderId: row.senderId,
      senderName: row.senderName,
      isSelf: Number(row.isSelf) === 1,
      text: row.text,
      ts: Number(row.ts),
    };
  }

  /** 消息被撤回：改写成标记，并从全文索引里删掉，别再拿它当上下文 */
  markRecalled(id: string): boolean {
    const row = this.getMessage(id);
    if (!row) return false;
    if (row.text === "[已撤回]") return false;

    this.#db.prepare("UPDATE messages SET text = '[已撤回]' WHERE id = ?").run(id);
    this.#db.prepare("DELETE FROM message_fts WHERE conv_key = ? AND raw = ?").run(row.convKey, row.text);
    return true;
  }

  /** 这个会话最后一条消息的时间；补拉时用它当分界线 */
  lastMessageTs(convKey: string): number {
    const row = this.#db
      .prepare("SELECT MAX(ts) AS ts FROM messages WHERE conv_key = ?")
      .get(convKey) as { ts: number | null } | undefined;
    return Number(row?.ts ?? 0);
  }

  /** 取最近 limit 条，返回顺序为旧 → 新 */
  recentMessages(convKey: string, limit: number): HistoryRow[] {
    const rows = this.#db
      .prepare(
        `SELECT id, conv_key AS convKey, sender_id AS senderId, sender_name AS senderName,
                is_self AS isSelf, text, ts
         FROM messages WHERE conv_key = ? ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(convKey, limit) as Array<Omit<HistoryRow, "isSelf"> & { isSelf: number }>;

    return rows
      .map((r) => ({
        id: r.id,
        convKey: r.convKey,
        senderId: r.senderId,
        senderName: r.senderName,
        isSelf: Number(r.isSelf) === 1,
        text: r.text,
        ts: Number(r.ts),
      }))
      .reverse();
  }

  getSummary(convKey: string): string | undefined {
    const row = this.#db
      .prepare("SELECT summary FROM sessions WHERE conv_key = ?")
      .get(convKey) as { summary: string | null } | undefined;
    return row?.summary ?? undefined;
  }

  /** 摘要已经覆盖到哪个时间点；这之前的消息不用再进上下文 */
  getSummaryUpto(convKey: string): number {
    const row = this.#db
      .prepare("SELECT summary_upto FROM sessions WHERE conv_key = ?")
      .get(convKey) as { summary_upto: number | null } | undefined;
    return Number(row?.summary_upto ?? 0);
  }

  /** 某个时间点之后的消息（旧 → 新），摘要压缩用 */
  messagesSince(convKey: string, sinceTs: number, limit: number): HistoryRow[] {
    const rows = this.#db
      .prepare(
        `SELECT id, conv_key AS convKey, sender_id AS senderId, sender_name AS senderName,
                is_self AS isSelf, text, ts
         FROM messages WHERE conv_key = ? AND ts > ? ORDER BY ts ASC LIMIT ?`,
      )
      .all(convKey, sinceTs, limit) as Array<Omit<HistoryRow, "isSelf"> & { isSelf: number }>;

    return rows.map((r) => ({
      id: r.id,
      convKey: r.convKey,
      senderId: r.senderId,
      senderName: r.senderName,
      isSelf: Number(r.isSelf) === 1,
      text: r.text,
      ts: Number(r.ts),
    }));
  }

  /** 某个时间段内的全部消息（跨会话），归档用 */
  messagesBetween(fromTs: number, toTs: number): HistoryRow[] {
    const rows = this.#db
      .prepare(
        `SELECT id, conv_key AS convKey, sender_id AS senderId, sender_name AS senderName,
                is_self AS isSelf, text, ts
         FROM messages WHERE ts >= ? AND ts < ? ORDER BY ts ASC`,
      )
      .all(fromTs, toTs) as Array<Omit<HistoryRow, "isSelf"> & { isSelf: number }>;

    return rows.map((r) => ({
      id: r.id,
      convKey: r.convKey,
      senderId: r.senderId,
      senderName: r.senderName,
      isSelf: Number(r.isSelf) === 1,
      text: r.text,
      ts: Number(r.ts),
    }));
  }

  setSummary(convKey: string, summary: string, upto: number, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (conv_key, summary, summary_upto, turn_count, updated_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(conv_key) DO UPDATE SET summary = excluded.summary, summary_upto = excluded.summary_upto, updated_at = excluded.updated_at`,
      )
      .run(convKey, summary, upto, now);
  }

  clearSummary(convKey: string, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (conv_key, summary, summary_upto, turn_count, updated_at)
         VALUES (?, NULL, NULL, 0, ?)
         ON CONFLICT(conv_key) DO UPDATE SET summary = NULL, summary_upto = NULL, updated_at = excluded.updated_at`,
      )
      .run(convKey, now);
  }

  recordUsage(rec: UsageRecord): void {
    this.#db
      .prepare(
        `INSERT INTO usage_ledger (binding_id, model, tokens_in, tokens_out, reasoning_tokens, cache_hit, cost_usd, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.bindingId,
        rec.model,
        rec.tokensIn,
        rec.tokensOut,
        rec.reasoningTokens,
        rec.cacheHit,
        rec.costUsd,
        rec.ts,
      );
  }

  /** 统计某时间点之后的累计美元花费 */
  costSince(sinceTs: number): number {
    const row = this.#db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE ts >= ?")
      .get(sinceTs) as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  /** 统计某时间点之后某会话的花费（按 binding 维度需要 join，M0 先用全局） */
  costSinceForBinding(bindingId: string, sinceTs: number): number {
    const row = this.#db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_ledger WHERE binding_id = ? AND ts >= ?")
      .get(bindingId, sinceTs) as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  /** 最近有消息的会话（包括私聊）——控制台的会话列表用 */
  recentConversations(limit = 100): Array<{ convKey: string; lastTs: number; count: number }> {
    const rows = this.#db
      .prepare(
        `SELECT conv_key AS convKey, MAX(ts) AS lastTs, COUNT(*) AS n
         FROM messages GROUP BY conv_key ORDER BY lastTs DESC LIMIT ?`,
      )
      .all(limit) as Array<{ convKey: string; lastTs: number; n: number }>;

    return rows.map((r) => ({
      convKey: r.convKey,
      lastTs: Number(r.lastTs),
      count: Number(r.n),
    }));
  }

  /** 清空某个会话的全部消息（预览页的"清空记忆"用） */
  clearMessages(convKey: string): void {
    this.#db.prepare("DELETE FROM messages WHERE conv_key = ?").run(convKey);
  }

  messageCount(convKey: string): number {    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE conv_key = ?")
      .get(convKey) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }
}

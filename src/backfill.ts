/**
 * 断线补拉：把掉线期间漏掉的消息从平台上捞回来。
 *
 * 只入库，不回复 —— 补回来的是几分钟前的话，这时候再回一句"你好呀"会很怪。
 * 它的作用只有一个：让它知道那段时间群里聊过什么，接得上话。
 */

import type { Adapter } from "./types.ts";
import type { Store } from "./store.ts";

export interface BackfillOptions {
  store: Store;
  adapter: Adapter;
  /** 要补哪些会话（一般传最近活跃的） */
  convKeys: string[];
  /** 每个会话拉多少条，默认 20 */
  count?: number;
}

export interface BackfillResult {
  added: number;
  scanned: number;
}

export async function backfillConversations(opts: BackfillOptions): Promise<BackfillResult> {
  if (!opts.adapter.getHistory) return { added: 0, scanned: 0 };

  const count = opts.count ?? 20;
  let added = 0;
  let scanned = 0;

  for (const convKey of opts.convKeys) {
    const lastTs = opts.store.lastMessageTs(convKey);
    const rows = await opts.adapter.getHistory(convKey, count).catch(() => []);

    for (const row of rows) {
      scanned += 1;
      if (row.ts <= lastTs) continue;
      if (!row.text) continue;
      const inserted = opts.store.appendMessage({ ...row, convKey });
      if (inserted) added += 1;
    }
  }

  return { added, scanned };
}

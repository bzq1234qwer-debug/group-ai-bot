/**
 * 内容安全：入站挡话题，出站挡发言。
 *
 * 为什么两边都要挡：
 * - 入站：有人故意把话题往违法方向带，模型一旦接话就可能生成违规内容
 * - 出站：模型自己也可能说错，而这句话是以用户的小号名义发出去的
 *
 * 边界说明：这是一层**关键词兜底**，不是内容审核系统。
 * 它挡得住明显的雷，挡不住绕着说话的。真正的合规要靠模型本身 + 人工。
 */

/** 默认屏蔽词：只放明显违法的类别，不做泛化，避免误伤正常聊天 */
export const DEFAULT_BLOCKLIST: string[] = [
  "毒品",
  "冰毒",
  "海洛因",
  "大麻",
  "制毒",
  "枪支",
  "弹药",
  "炸药",
  "制枪",
  "赌博",
  "网赌",
  "洗钱",
  "跑分",
  "诈骗",
  "刷单",
  "代开发票",
  "增值税发票",
  "套现",
  "裸聊",
  "约炮",
  "色情",
  "嫖娼",
  "买卖身份证",
  "银行卡出租",
];

/** 被挡下来时的默认回应：不解释、不说教，一句话带过 */
export const DEFAULT_SAFE_REPLY = "这个本鱼不接，换点别的话题吧。";

export interface SafetyConfig {
  enabled: boolean;
  words: string[];
  reply: string;
}

export interface SafetyScan {
  hit: boolean;
  matched: string[];
}

/** 扫一遍文本，返回命中的词（去重，最多列 5 个，日志用） */
export function scanText(text: string, words: string[], limit = 5): SafetyScan {
  if (!text || words.length === 0) return { hit: false, matched: [] };

  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const word of words) {
    const w = word.trim();
    if (!w || w.length < 2) continue;
    if (lower.includes(w.toLowerCase())) {
      matched.push(w);
      if (matched.length >= limit) break;
    }
  }
  return { hit: matched.length > 0, matched };
}

/** 清洗用户填的词表：逗号/顿号/换行分隔，去重去空 */
export function parseWordList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.split(/[,，、\n\r]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const w = String(item).trim();
    if (w.length < 2) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

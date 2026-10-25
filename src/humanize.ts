/**
 * 拟人化：让机器人"像人"的地方，其实不在文案，而在节奏和破绽。
 *
 * 三条经验：
 * 1. 人不会秒回，也不会零间隔连发 —— 第一条要"看到+想一想"，后面每条要"打完再发"。
 * 2. 模型天生爱说"作为一个AI""希望能帮到你"，这些是最大的破绽。
 * 3. 群里没人发四段话 —— 单条超过一两句就不像人。
 */

/** 第一条回复前的延迟：按字数估，1.2~6.5 秒 */
export function firstReplyDelayMs(chars: number, rng: () => number = Math.random): number {
  const reading = Math.min(3000, chars * 35);
  const jitter = rng() * 1200;
  return Math.round(clamp(1200 + reading + jitter, 1200, 6500));
}

/** 两条消息之间的间隔：0.7~2.6 秒（打完一句再发下一句） */
export function segmentGapMs(chars: number, rng: () => number = Math.random): number {
  const typing = Math.min(1200, chars * 18);
  const jitter = rng() * 600;
  return Math.round(clamp(700 + typing + jitter, 700, 2600));
}

/**
 * 清掉模型的口头禅。
 * 只做"删"，不做"改写" —— 改写容易把语义弄坏，删掉反而更像人。
 */
const AI_TELLS: RegExp[] = [
  /作为一个?(?:AI|人工智能|人工智慧)(?:语言模型|助手|模型)?[，,、]?\s*/g,
  /作为(?:一个)?(?:AI|人工智能)(?:语言模型|助手)?[，,、]?\s*/g,
  /(?:希望|但愿)(?:这|以上)?(?:能|可以)?(?:帮|对)(?:到)?你(?:有(?:所)?帮助)?[。！!~～]?/g,
  /有什么(?:我可以|能)(?:帮|为)你(?:做)?(?:的)?[？?]?/g,
  /如果你(?:还)?有(?:其他|任何)(?:问题|疑问)[，,]?(?:随时|欢迎)[^。！？]*[。！？]?/g,
  /^(?:\s*)(?:首先|其次|总之|综上所述|总的来说)[，,、]\s*/gm,
  /(?:^|\n)\s*\d+[.、)]\s*/g, // 行首的 1. 2. 3. 编号
];

export function stripAiTells(text: string): string {
  let out = text;
  for (const pattern of AI_TELLS) {
    out = out.replace(pattern, "");
  }
  // 清完可能留下空行和多余空格
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s，,、]+/, "")
    .trim();
}

/**
 * 单条消息的硬上限。超了就在最近的标点处切断并补省略号。
 * 群里没人发 200 字，模型却很容易这么做，靠提示词约束不可靠。
 */
export function clampSegment(text: string, maxChars = 120): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;

  const window = t.slice(0, maxChars);
  const cut = Math.max(
    window.lastIndexOf("。"),
    window.lastIndexOf("！"),
    window.lastIndexOf("？"),
    window.lastIndexOf("…"),
    window.lastIndexOf("，"),
  );
  const kept = cut >= Math.floor(maxChars * 0.4) ? window.slice(0, cut + 1) : window;
  return `${kept.replace(/[，,、]$/, "")}…`;
}

/**
 * 模型会模仿上下文格式，把自己的回复也写成 "[大肥鱼 14:34] xxx"。
 * 在群里这会直接露馅，必须在发出去之前剥掉。
 *
 * 只剥开头的第一段，避免误删正文里的方括号。
 */
const TRANSCRIPT_PREFIX = /^\s*[\[【]\s*[^\]】\n]{0,24}?\s*\d{1,2}[:：]\d{2}\s*[\]】]\s*/;

export function stripTranscriptPrefix(text: string): string {
  let out = text;
  // 模型偶尔会连写两层前缀，最多剥两次
  for (let i = 0; i < 2; i += 1) {
    const next = out.replace(TRANSCRIPT_PREFIX, "");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * 心声的开关交给代码掷骰子，而不是让模型自己把握"偶尔"。
 * 模型对频率类指令极不敏感：说"偶尔"它每句都带，说"20%"它一句都不带。
 *
 * rate 默认 0 —— 产品默认不要心声，只给回复。想开的话传 0.25 左右。
 */
export function voiceHint(rng: () => number = Math.random, rate = 0): string | undefined {
  if (rate <= 0) return undefined;
  return rng() < rate ? "本轮可以在句尾带一句括号里的心声，也可以不带。" : undefined;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

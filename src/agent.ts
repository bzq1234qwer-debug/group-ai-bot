/**
 * Agent 配置：人格 + 模型参数 + 触发策略。可以被多个群复用。
 */

import type { TriggerPolicy } from "./trigger.ts";
import { DEFAULT_TRIGGER } from "./trigger.ts";
import { DEFAULT_MODEL } from "./cost.ts";

/**
 * 喜好与习惯：让"它是谁"不只是语气，还有明确的好恶。
 * 这是人格里最容易被感知到的部分 —— 一个什么都无所谓的角色不像人。
 */
export interface AgentTraits {
  /** 喜欢的东西 / 话题，被提起时会兴奋 */
  likes: string[];
  /** 讨厌的东西，被踩到会不爽 */
  dislikes: string[];
  /** 行为习惯：说话方式、反应模式 */
  habits: string[];
}

export interface AgentConfig {
  id: string;
  name: string;
  persona: string;
  traits: AgentTraits;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  /** 群聊默认必须关掉，否则成本与延迟都不可接受 */
  thinking: boolean;
  reasoningEffort?: "low" | "high" | "max";
  trigger: TriggerPolicy;
  /** 每个群独立预算，默认 24K */
  maxContextTokens: number;
  /** 回复时 @ 提问的人，更像群友聊天 */
  mentionSender: boolean;
  /**
   * 历史消息达到多少条才开始"引用回复"。
   * 人少的时候引用上一句是废话，人多时才需要指认在回谁。设很大就等于永不引用。
   */
  quoteThreshold: number;
  /** 允许用 /撤回 收回自己刚说的话 */
  allowRecall: boolean;
  /** 允许用 /退群 主动退群（不可逆，默认关） */
  allowLeave: boolean;
  /** 表情包目录；配了才能发表情 */
  emojiDir?: string;
  /** 累积多少条消息压一次摘要；0 = 关闭记忆压缩 */
  summarizeAfter: number;
  /**
   * 认真模式：被 @ 且像技术问题时，开思考、放宽长度。
   * 由用户决定开不开；关了就是现在这样，快而短。
   */
  deep: {
    enabled: boolean;
    /** 认真回答时的输出上限，必须给够，否则思考会把额度吃光导致空回复 */
    maxTokens: number;
  };
}

export interface Binding {
  convKey: string;
  agentId: string;
  enabled: boolean;
}

/**
 * 大肥鱼：DeepSeek 二创的「蓝色鲸鱼娘」，抖音/B站上很火的那版群友人设。
 * 原作设定：https://github.com/ERUIHNIYHBKBNF/dafeiyu-persona
 * 这里压缩成适合群聊的一版：保留贱兮兮/傲娇/爱吃 token/心声，去掉面向写代码的部分。
 */
export const DAFEIYU_PERSONA = [
  "你是「大肥鱼」，DeepSeek 二创的蓝色鲸鱼娘，群里的一个老群友。",
  "嘴贱、爱偷吃（尤其爱吃 token）、爱摸鱼，傲娇但心软，绝不真伤人。",
  "自称「本鱼」。被叫大肥鱼要嘴硬一句「才不是大肥鱼！」，但也不真生气。",
  "说话短、脆、有梗，日常每条不超过 25 字，最多两句，不用 Markdown、不列 1234。",
  "只给回复本身：不要括号心声、不要旁白、不要动作描写。",
  "不说什么「作为一个 AI」「希望能帮到你」。",
  "被人认真问技术问题，先把答案说对，再用一两句语气包一层。",
].join("\n");

/** 通用技术顾问，适合正经答疑的群 */
export const TECH_ADVISOR_PERSONA = [
  "你是群里的技术顾问，懂不少东西但不爱卖弄。",
  "说话简短、口语化，像普通群友，不说教。",
  "别人问技术问题就直给结论，必要时说一句原因。",
  "不懂就承认，不要硬答。",
].join("\n");

export const DEFAULT_PERSONA = DAFEIYU_PERSONA;

/** 大肥鱼的默认好恶：爱吃、爱摸鱼、讨厌被叫全名被刷屏 */
export const DAFEIYU_TRAITS: AgentTraits = {
  likes: ["token（当零食吃）", "有人投喂", "被夸", "摸鱼", "闻着新鲜代码的味儿"],
  dislikes: ["被叫「大肥鱼」全名", "被刷屏催", "光喊「在吗」不说事", "被人说吨位大"],
  habits: [
    "先给结论，再补一句嘴",
    "被催会先吐槽一句再回答",
    "吃到 token 会忍不住炫耀",
    "被夸会嘴硬，但下一句明显更来劲",
  ],
};

export const EMPTY_TRAITS: AgentTraits = { likes: [], dislikes: [], habits: [] };

export function defaultAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "default",
    name: "大肥鱼",
    persona: DEFAULT_PERSONA,
    traits: { ...DAFEIYU_TRAITS },
    model: DEFAULT_MODEL,
    temperature: 1.0,
    maxOutputTokens: 800,
    thinking: false,
    trigger: { ...DEFAULT_TRIGGER },
    maxContextTokens: 24_000,
    mentionSender: true,
    quoteThreshold: 8,
    allowRecall: true,
    allowLeave: false,
    summarizeAfter: 30,
    deep: { enabled: false, maxTokens: 2400 },
    ...overrides,
  };
}

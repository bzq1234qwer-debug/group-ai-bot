/**
 * 认真模式：判断这句话值不值得"多想一会儿"。
 *
 * 群聊里大部分是闲聊，给每条都开思考会变慢、变贵，而且回答反而啰嗦。
 * 所以只在「被 @ 的、像技术问题的」消息上开思考 + 放宽长度。
 */

/** 中文群聊里，出现这些词基本就是在问正经事 */
const TECHNICAL_HINTS =
  /怎么|如何|为什么|为啥|原理|方案|架构|报错|错误|异常|崩溃|性能|优化|实现|代码|函数|接口|数据库|部署|配置|设计|区别|对比|选型|推荐|原理|debug|bug|error|api|sql|node|python|docker|nginx|git/i;

/** 纯寒暄 / 道谢 / 表情，不该被当成技术问题 */
const SMALL_TALK = /^(在吗|在不在|你好|您好|早|晚安|谢谢|多谢|辛苦了|哈哈+|嗯+|哦+|好+|ok|收到)[。！？!?~～\s]*$/i;

export interface DeepDecision {
  deep: boolean;
  reason: string;
}

/**
 * 判定要不要进认真模式。
 * 三个条件同时满足才开：被 @、不是寒暄、像技术问题。
 */
export function shouldThinkDeeply(text: string, mentionedSelf: boolean, minLength = 12): DeepDecision {
  const t = text.trim();

  if (!mentionedSelf) return { deep: false, reason: "没被 @" };
  if (t.length < minLength) return { deep: false, reason: "太短" };
  if (SMALL_TALK.test(t)) return { deep: false, reason: "寒暄" };

  if (!TECHNICAL_HINTS.test(t)) return { deep: false, reason: "不像技术问题" };

  return { deep: true, reason: "技术问题" };
}

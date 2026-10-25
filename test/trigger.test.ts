import { test } from "node:test";
import assert from "node:assert/strict";
import type { Envelope } from "../src/types.ts";
import {
  DEFAULT_TRIGGER,
  createTriggerState,
  evaluateTrigger,
  inQuietHours,
  recordReply,
  type TriggerPolicy,
  type TriggerState,
} from "../src/trigger.ts";

function makeEnv(text: string, overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "m1",
    convKey: "qq:10001:group:30003",
    channelId: "qq:10001",
    sender: { id: "20002", name: "小明", isSelf: false, role: "member" },
    text,
    mentions: { self: true, users: [], all: false },
    media: [],
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

function policy(overrides: Partial<TriggerPolicy> = {}): TriggerPolicy {
  return { ...DEFAULT_TRIGGER, ...overrides };
}

function state(): TriggerState {
  return createTriggerState();
}

const NOW = 1_700_000_000_000;

test("mention 模式：被 @ 时回复", () => {
  const d = evaluateTrigger(makeEnv("在吗"), policy({ mode: "mention" }), state(), NOW);
  assert.equal(d.respond, true);
});

test("mention 模式：没被 @ 时沉默", () => {
  const d = evaluateTrigger(
    makeEnv("今天天气不错", { mentions: { self: false, users: [], all: false } }),
    policy({ mode: "mention" }),
    state(),
    NOW,
  );
  assert.equal(d.respond, false);
  assert.equal(d.reason, "no_trigger_match");
});

test("自己的消息永远不触发", () => {
  const d = evaluateTrigger(
    makeEnv("我是机器人", { sender: { id: "10001", name: "小D", isSelf: true } }),
    policy({ mode: "always" }),
    state(),
    NOW,
  );
  assert.equal(d.respond, false);
  assert.equal(d.reason, "self");
});

test("黑名单用户不触发", () => {
  const d = evaluateTrigger(
    makeEnv("@我 在吗"),
    policy({ mode: "always", denyUsers: ["20002"] }),
    state(),
    NOW,
  );
  assert.equal(d.respond, false);
  assert.equal(d.reason, "denied_user");
});

test("斜杠命令不触发", () => {
  const d = evaluateTrigger(makeEnv("/reset"), policy({ mode: "always" }), state(), NOW);
  assert.equal(d.respond, false);
  assert.equal(d.reason, "command");
});

test("关键词模式匹配", () => {
  const p = policy({ mode: "keyword", keywords: ["报错", "bug"] });
  assert.equal(evaluateTrigger(makeEnv("页面有个 BUG"), p, state(), NOW, () => 0).respond, true);
  assert.equal(evaluateTrigger(makeEnv("中午吃啥"), p, state(), NOW, () => 0).respond, false);
});

test("私聊：不需要 @ 也会回", () => {
  const env = makeEnv("在吗", {
    convKey: "qq:10001:private:20002",
    mentions: { self: false, users: [], all: false },
  });
  const d = evaluateTrigger(env, policy({ mode: "mention" }), state(), NOW);
  assert.equal(d.respond, true, "私聊天然就是对它说的");
});

test("私聊：插话模式下也直接回", () => {
  const env = makeEnv("随便聊聊", {
    convKey: "qq:10001:private:20002",
    mentions: { self: false, users: [], all: false },
  });
  const d = evaluateTrigger(env, policy({ mode: "interject" }), state(), NOW, () => 0.99);
  assert.equal(d.respond, true);
});

test("random 模式受随机数与概率控制", () => {
  const p = policy({ mode: "random", randomRate: 0.05 });
  assert.equal(evaluateTrigger(makeEnv("随便说说"), p, state(), NOW, () => 0.01).respond, true);
  assert.equal(evaluateTrigger(makeEnv("随便说说"), p, state(), NOW, () => 0.9).respond, false);
});

test("interject：普通陈述句不插话", () => {
  const p = policy({ mode: "interject", interject: { rate: 0.3 } });
  const d = evaluateTrigger(makeEnv("今天天气不错", { mentions: { self: false, users: [], all: false } }), p, state(), NOW, () => 0);
  assert.equal(d.respond, false);
});

test("interject：只有问号还不够，说明不是见问就抢答", () => {
  const p = policy({ mode: "interject", interject: { rate: 0.3 } });
  assert.equal(evaluateTrigger(makeEnv("有人吗？", { mentions: { self: false, users: [], all: false } }), p, state(), NOW, () => 0).respond, false);
});

test("interject：问句 + 命中话题词才开口", () => {
  const p = policy({
    mode: "interject",
    interject: { rate: 0.3, keywords: ["报错"] },
  });
  assert.equal(evaluateTrigger(makeEnv("这个报错怎么修？", { mentions: { self: false, users: [], all: false } }), p, state(), NOW, () => 0).respond, true);
});

test("interject：命中话题词也会接话", () => {
  const p = policy({
    mode: "interject",
    interject: { rate: 0.3, keywords: ["报错", "部署"] },
  });
  assert.equal(evaluateTrigger(makeEnv("昨天部署又挂了", { mentions: { self: false, users: [], all: false } }), p, state(), NOW, () => 0).respond, true);
  assert.equal(evaluateTrigger(makeEnv("中午吃面", { mentions: { self: false, users: [], all: false } }), p, state(), NOW, () => 0).respond, false);
});

test("interject：随机值很小时也压得住，不会见谁都接", () => {
  const p = policy({ mode: "interject", interject: { rate: 0.1, threshold: 1.4 } });
  assert.equal(
    evaluateTrigger(makeEnv("随便说一句", { mentions: { self: false, users: [], all: false } }), p, state(), NOW, () => 0.9).respond,
    false,
  );
});

test("冷却期：普通消息用完整冷却，@ 它只挡 3 秒", () => {
  const s = state();
  const p = policy({ mode: "always", cooldownSec: 10 });

  assert.equal(evaluateTrigger(makeEnv("第一次"), p, s, NOW).respond, true);
  recordReply(s, "qq:10001:group:30003", "20002", NOW);

  // 没人 @ 它：按完整冷却挡
  const plain = evaluateTrigger(
    makeEnv("第二次", { mentions: { self: false, users: [], all: false } }),
    p,
    s,
    NOW + 5000,
  );
  assert.equal(plain.respond, false);
  assert.equal(plain.reason, "cooldown");

  // 有人 @ 它：3 秒后就能回，否则群里两个人同时说话它会彻底哑掉
  const mention = evaluateTrigger(makeEnv("第三次"), p, s, NOW + 5000);
  assert.equal(mention.respond, true);

  const tooSoon = evaluateTrigger(makeEnv("第四次"), p, s, NOW + 11_000 - 10_000);
  assert.equal(tooSoon.respond, false);
});

test("单用户每小时配额生效", () => {
  const s = state();
  const p = policy({ mode: "always", cooldownSec: 0, perUserPerHour: 2 });

  for (let i = 0; i < 2; i += 1) {
    assert.equal(
      evaluateTrigger(makeEnv(`第${i}次`, { mentions: { self: false, users: [], all: false } }), p, s, NOW + i * 1000).respond,
      true,
    );
    recordReply(s, "qq:10001:group:30003", "20002", NOW + i * 1000);
  }

  const blocked = evaluateTrigger(makeEnv("第三次", { mentions: { self: false, users: [], all: false } }), p, s, NOW + 3000);
  assert.equal(blocked.respond, false);
  assert.equal(blocked.reason, "user_hourly_quota");

  // 一小时窗口过期后恢复
  const later = evaluateTrigger(makeEnv("很久以后", { mentions: { self: false, users: [], all: false } }), p, s, NOW + 3_600_001);
  assert.equal(later.respond, true);
});

test("免打扰时段（跨零点）", () => {
  const night = new Date(2026, 0, 15, 23, 30, 0).getTime();
  const morning = new Date(2026, 0, 16, 7, 30, 0).getTime();
  const noon = new Date(2026, 0, 16, 12, 0, 0).getTime();

  assert.equal(inQuietHours(night, [["23:00", "08:00"]]), true);
  assert.equal(inQuietHours(morning, [["23:00", "08:00"]]), true);
  assert.equal(inQuietHours(noon, [["23:00", "08:00"]]), false);

  const d = evaluateTrigger(makeEnv("在吗"), policy({ quietHours: [["23:00", "08:00"]] }), state(), night);
  assert.equal(d.reason, "quiet_hours");
});

test("私聊：不受人均小时配额限制（聊到一半突然不理人是 bug）", () => {
  const policy: TriggerPolicy = { ...DEFAULT_TRIGGER, mode: "mention", cooldownSec: 0, perUserPerHour: 2 };
  const state: TriggerState = createTriggerState();
  const now = Date.now();
  const env = makeEnv("在吗", {
    convKey: "qq:10001:private:20002",
    mentions: { self: false, users: [], all: false },
  });

  // 连发 5 条，全部都要回
  for (let i = 0; i < 5; i += 1) {
    const d = evaluateTrigger(env, policy, state, now + i * 1000);
    assert.equal(d.respond, true, `第 ${i + 1} 条不该被配额挡住`);
    recordReply(state, env.convKey, env.sender.id, now + i * 1000);
  }
});

test("群聊：非 @ 消息仍受人均配额限制", () => {
  const policy: TriggerPolicy = { ...DEFAULT_TRIGGER, mode: "always", cooldownSec: 0, perUserPerHour: 2 };
  const state: TriggerState = createTriggerState();
  const now = Date.now();
  const env = makeEnv("今天好热", {
    convKey: "qq:10001:group:30003",
    mentions: { self: false, users: [], all: false },
  });

  const first = evaluateTrigger(env, policy, state, now);
  assert.equal(first.respond, true);
  recordReply(state, env.convKey, env.sender.id, now);

  const second = evaluateTrigger(env, policy, state, now + 1000);
  assert.equal(second.respond, true);
  recordReply(state, env.convKey, env.sender.id, now + 1000);

  const third = evaluateTrigger(env, policy, state, now + 2000);
  assert.equal(third.respond, false);
  assert.equal(third.reason, "user_hourly_quota");
});
test("插话模式：被 @ 必须回，不看概率", () => {
  const policy: TriggerPolicy = { ...DEFAULT_TRIGGER, mode: "interject", cooldownSec: 0 };
  const state = createTriggerState();
  const now = Date.now();
  const env = makeEnv("随便说点什么", {
    convKey: "qq:10001:group:30003",
    mentions: { self: true, users: [], all: false },
  });

  // rng 固定返回 0.99（必不中），被 @ 仍然要回
  const alwaysMiss = () => 0.99;
  const d = evaluateTrigger(env, policy, state, now, alwaysMiss as unknown as () => number);
  assert.equal(d.respond, true, "@ 它是明确在叫它，不能被概率挡掉");
});

test("插话模式：没被 @ 的冷启动陈述句仍然按概率", () => {
  const policy: TriggerPolicy = { ...DEFAULT_TRIGGER, mode: "interject", cooldownSec: 0 };
  const state = createTriggerState();
  const env = makeEnv("今天天气不错", {
    convKey: "qq:10001:group:30003",
    mentions: { self: false, users: [], all: false },
  });
  const d = evaluateTrigger(env, policy, state, Date.now(), () => 0.99);
  assert.equal(d.respond, false);
});

test("群里被 @ 不受人均配额限制", () => {
  const policy: TriggerPolicy = { ...DEFAULT_TRIGGER, mode: "interject", cooldownSec: 0, perUserPerHour: 2 };
  const state = createTriggerState();
  const now = Date.now();
  const env = makeEnv("在吗", {
    convKey: "qq:10001:group:30003",
    mentions: { self: true, users: [], all: false },
  });

  for (let i = 0; i < 5; i += 1) {
    const d = evaluateTrigger(env, policy, state, now + i * 5000, () => 0.99);
    assert.equal(d.respond, true, `第 ${i + 1} 次 @ 应当回复`);
    recordReply(state, env.convKey, env.sender.id, now + i * 5000);
  }
});
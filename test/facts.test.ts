import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { parseSummaryOutput } from "../src/memory.ts";

test("解析：拆出摘要和事实两段", () => {
  const raw = `【摘要】
- 张三 是群主，做外贸
- 周五前交报价单

【事实】
- 张三 | 身份 | 群主，做外贸
- 本群 | 群规 | 不许发广告
`;

  const parsed = parseSummaryOutput(raw);
  assert.ok(parsed.summary.includes("张三 是群主"));
  assert.ok(!parsed.summary.includes("【事实】"));
  assert.equal(parsed.facts.length, 2);
  assert.deepEqual(parsed.facts[0], { subject: "张三", attribute: "身份", value: "群主，做外贸" });
});

test("解析：没有事实段时整段当摘要，不报错", () => {
  const parsed = parseSummaryOutput("- 张三 是群主\n- 周五交报价");
  assert.ok(parsed.summary.includes("张三"));
  assert.equal(parsed.facts.length, 0);
});

test("解析：格式坏了的行直接跳过，不污染事实库", () => {
  const raw = `【摘要】
- 正常内容

【事实】
- 张三 | 身份 | 群主
- 这行没有分隔符
- | 缺主体 | 值
- 李四 | 偏好 | 叫小李
`;
  const parsed = parseSummaryOutput(raw);
  assert.equal(parsed.facts.length, 2);
});

test("事实：同一个主体+属性，新值覆盖旧值", () => {
  const store = new Store(":memory:");

  store.upsertFacts("g1", [{ subject: "张三", attribute: "职业", value: "外贸" }], 1000, 1000);
  store.upsertFacts("g1", [{ subject: "张三", attribute: "职业", value: "做跨境电商" }], 2000, 2000);

  const facts = store.listFacts("g1");
  assert.equal(facts.length, 1, "不该出现两条矛盾的事实");
  assert.equal(facts[0]!.value, "做跨境电商");

  store.close();
});

test("事实：不同会话互不干扰", () => {
  const store = new Store(":memory:");
  store.upsertFacts("g1", [{ subject: "张三", attribute: "身份", value: "群主" }], 1000, 1000);
  store.upsertFacts("g2", [{ subject: "张三", attribute: "身份", value: "潜水员" }], 1000, 1000);

  assert.equal(store.listFacts("g1")[0]!.value, "群主");
  assert.equal(store.listFacts("g2")[0]!.value, "潜水员");
  store.close();
});

test("事实：代词做主语会被拒收", () => {
  const store = new Store(":memory:");
  const n = store.upsertFacts(
    "g1",
    [
      { subject: "我", attribute: "偏好", value: "不喜欢被叫全名" },
      { subject: "张三", attribute: "身份", value: "群主" },
    ],
    1000,
    1000,
  );

  assert.equal(n, 1, "只应存下张三那条");
  const facts = store.listFacts("g1");
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.subject, "张三");
  store.close();
});

test("事实：超过上限时丢最久没更新的", () => {
  const store = new Store(":memory:");
  for (let i = 0; i < 90; i += 1) {
    store.upsertFacts("g1", [{ subject: `人${i}`, attribute: "身份", value: "测试" }], 1000 + i, 1000 + i);
  }
  const facts = store.listFacts("g1", 200);
  assert.ok(facts.length <= 80, `上限应当是 80，实际 ${facts.length}`);
  assert.equal(facts[0]!.subject, "人89", "最新的应当还在");
  store.close();
});

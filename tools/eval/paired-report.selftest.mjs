/**
 * `paired-report.mjs` 的自测 —— 每条断言都必须**能变红**。
 *
 * 为什么自测而不是放 `src/test/`：这个模块是**开发者侧**的评测工具，
 * 不进产品包，所以不占用 `src/` 的覆盖率基线；仓库里已有同类先例
 * （`tools/audit/probe-guard.selftest.mjs`）。
 *
 * 本文件专门盯住三条纪律，因为它们是这套方法学**唯一**防"自己骗自己"的地方：
 *   纪律 1  缺数据不等于 0
 *   纪律 2  成对样本不足就拒绝给结论（头部通过率不发布）
 *   纪律 3  一次重复不足以说明稳定性
 */

import {
  planRuns,
  resolvePair,
  groupRuns,
  pairedMetric,
  passRate,
  summarize,
  render,
  verdict,
  metricValue,
  mean,
  isScored,
} from "./paired-report.mjs";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) });
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message ?? "值不相等"}：实际 ${a}，期望 ${e}`);
}

/** 造一条运行记录。 */
function run(overrides) {
  return {
    evalSet: "coding",
    caseId: "c1",
    model: "deepseek-chat",
    arm: "control",
    runNumber: 1,
    outcome: "passed",
    ...overrides,
  };
}

console.log("paired-report 自测");

// ---------------------------------------------------------------- 纪律 1
check("纪律1：没有上报的指标是 undefined，不是 0", () => {
  assertEqual(metricValue({ totalTokens: undefined }, "totalTokens"), undefined, "缺字段应为 undefined");
  assertEqual(metricValue({}, "totalTokens"), undefined, "空对象应为 undefined");
  assertEqual(metricValue({ totalTokens: 0 }, "totalTokens"), 0, "真的 0 要保留为 0");
  assertEqual(metricValue({ totalTokens: Number.NaN }, "totalTokens"), undefined, "NaN 不算数据");
});

check("纪律1：mean([]) 是 null 而不是 0", () => {
  assertEqual(mean([]), null, "空数组的平均必须是 null");
  assertEqual(mean([2, 4]), 3, "正常平均");
});

check("纪律1：passRate 在没有任何评分时是 null，不是 0", () => {
  assertEqual(passRate([]), null, "没有运行 ⇒ null");
  assertEqual(passRate([run({ outcome: "errored" })]), null, "只有出错 ⇒ null");
  assertEqual(passRate([run({ outcome: "passed" }), run({ outcome: "failed" })]), 0.5, "一半通过");
});

check("纪律1：成对均值跳过「只有一侧上报」的对，不当 0 平均", () => {
  const pairs = [
    { control: run({ totalTokens: 100 }), treatment: run({ totalTokens: 120 }) },
    // 这一对处理臂没上报 totalTokens ⇒ 必须整对跳过，而不是把处理臂当 0
    { control: run({ totalTokens: 1000 }), treatment: run({}) },
  ];
  const summary = pairedMetric(pairs, "totalTokens");
  assertEqual(summary.eligiblePairs, 1, "只有 1 对可用");
  assertEqual(summary.controlMean, 100, "对照均值只来自可用对");
  assertEqual(summary.meanDelta, 20, "差值只来自可用对（120-100）");
});

check("纪律1：一个指标全都没有数据时 meanDelta 是 null（渲染为 n/a）", () => {
  const pairs = [{ control: run({}), treatment: run({}) }];
  const summary = pairedMetric(pairs, "totalTokens");
  assertEqual(summary.eligiblePairs, 0, "可用对为 0");
  assertEqual(summary.meanDelta, null, "均值差必须是 null");
});

// ---------------------------------------------------------------- 纪律 2
check("纪律2：任务确实达成", () => {
  assert(isScored(run({ outcome: "passed" })), "passed 算有分数");
  assert(!isScored(run({ outcome: "errored" })), "errored 不算有分数");
  assert(!isScored(run({ outcome: "skipped" })), "skipped 不算有分数");
});

check("纪律2：一侧缺失 ⇒ 该对被阻塞", () => {
  const { pair, blocked } = resolvePair([run({ arm: "control" })]);
  assertEqual(pair, undefined, "不应该产出对");
  assertEqual(blocked.reasons, ["处理臂缺失"], "应说明处理臂缺失");
});

check("纪律2：一侧未评分 ⇒ 该对被阻塞并说明原因", () => {
  const { pair, blocked } = resolvePair([
    run({ arm: "control", outcome: "passed" }),
    run({ arm: "treatment", outcome: "errored" }),
  ]);
  assertEqual(pair, undefined, "不应该产出对");
  assert(blocked.reasons.some((r) => r.includes("errored")), "应说明处理臂未评分");
});

check("纪律2：一侧重复 ⇒ 该对被阻塞", () => {
  const { pair, blocked } = resolvePair([
    run({ arm: "control" }),
    run({ arm: "control" }),
    run({ arm: "treatment" }),
  ]);
  assertEqual(pair, undefined, "不应该产出对");
  assert(blocked.reasons.some((r) => r.includes("重复")), "应说明重复");
});

check("纪律2：有阻塞时头部通过率必须 withheld，且 verdict 拒绝下结论", () => {
  const runs = [
    run({ arm: "control", outcome: "passed" }),
    run({ arm: "treatment", outcome: "passed", totalTokens: 120 }),
    // c2 只有对照臂 ⇒ 这一对被阻塞
    run({ caseId: "c2", arm: "control", outcome: "passed" }),
  ];
  const report = summarize(runs, { runsPerCase: 3 });
  assertEqual(report.publishHeadline, false, "有阻塞就不能发布头部结论");
  assert(report.flags.includes("blocked-pairs"), "应带 blocked-pairs 标记");
  assert(report.flags.includes("headline-withheld"), "应带 headline-withheld 标记");
  const text = render(report);
  assert(text.includes("withheld"), "渲染必须显式写出 withheld");
  const conclusion = verdict(report);
  assertEqual(conclusion.conclusive, false, "不得下结论");
});

check("纪律2：没有阻塞且重复足够时才允许下结论（前提是 token 有数据）", () => {
  const runs = [
    run({ arm: "control", outcome: "passed", totalTokens: 100, runNumber: 1 }),
    run({ arm: "treatment", outcome: "passed", totalTokens: 120, runNumber: 1 }),
    run({ arm: "control", outcome: "passed", totalTokens: 100, runNumber: 2 }),
    run({ arm: "treatment", outcome: "failed", totalTokens: 130, runNumber: 2 }),
  ];
  const report = summarize(runs, { runsPerCase: 2 });
  assertEqual(report.publishHeadline, true, "无阻塞且 2 对 ⇒ 可以发布");
  assertEqual(report.eligiblePairs, 2, "应有 2 对");
  const tokenMetric = report.metrics.totalTokens;
  assertEqual(tokenMetric.meanDelta, 25, "token 均值差 = (120+130)/2 - 100 = 25");
  const conclusion = verdict(report);
  assertEqual(conclusion.conclusive, true, "应可下结论");
});

check("纪律2：token 计量没接通时 verdict 拒绝给结论（哪怕通过率很好）", () => {
  const runs = [
    run({ arm: "control", outcome: "failed", runNumber: 1 }),
    run({ arm: "treatment", outcome: "passed", runNumber: 1 }),
    run({ arm: "control", outcome: "failed", runNumber: 2 }),
    run({ arm: "treatment", outcome: "passed", runNumber: 2 }),
  ];
  const report = summarize(runs, { runsPerCase: 2 });
  assertEqual(report.publishHeadline, true, "成对是完整的");
  const conclusion = verdict(report);
  assertEqual(conclusion.conclusive, false, "没有 token 数据就不许下结论");
  assert(conclusion.reason.includes("计量"), "理由要指向计量链路");
});

// ---------------------------------------------------------------- 纪律 3
check("纪律3：每任务每臂重复 < 2 要标记 insufficient-repetition 且不许下结论", () => {
  const runs = [
    run({ arm: "control", outcome: "passed", totalTokens: 100 }),
    run({ arm: "treatment", outcome: "passed", totalTokens: 90 }),
  ];
  const report = summarize(runs, { runsPerCase: 1 });
  assert(report.flags.includes("insufficient-repetition"), "应标记重复不足");
  const conclusion = verdict(report);
  assertEqual(conclusion.conclusive, false, "一次重复不足以说明稳定性");
});

check("纪律3：同一臂内结果不一致要判 flaky", () => {
  const runs = [
    run({ arm: "control", outcome: "passed", runNumber: 1 }),
    run({ arm: "control", outcome: "failed", runNumber: 2 }),
  ];
  const report = summarize(runs, { runsPerCase: 2 });
  assert(report.flags.includes("flaky"), "应标记 flaky");
  assertEqual(report.flaky.length, 1, "应识别出 1 个 flaky 任务");
});

// ---------------------------------------------------------------- 计划与分组
check("计划：按运行号交替两条臂的顺序（降顺序偏）", () => {
  const planned = planRuns([{ evalSet: "coding", caseId: "c1", model: "m" }], 2);
  assertEqual(
    planned.map((p) => `${p.runNumber}:${p.arm}`),
    ["1:control", "1:treatment", "2:treatment", "2:control"],
    "奇数轮对照先、偶数轮处理先",
  );
});

check("分组：四元组不同就要分开成组", () => {
  const groups = groupRuns([
    run({ caseId: "c1", runNumber: 1 }),
    run({ caseId: "c1", runNumber: 2 }),
    run({ caseId: "c2", runNumber: 1 }),
  ]);
  assertEqual(groups.length, 3, "应有 3 组");
});

// ---------------------------------------------------------------- 符号约定
check("符号约定：正值 = 我方（treatment）比对照贵，不能被搞反", () => {
  const runs = [
    run({ arm: "control", totalTokens: 1000 }),
    run({ arm: "treatment", totalTokens: 1500 }),
  ];
  const report = summarize(runs, { runsPerCase: 3 });
  assertEqual(report.metrics.totalTokens.meanDelta, 500, "我方多花 500 应为 +500");
});

check("符号约定：我方更省时为负值", () => {
  const runs = [
    run({ arm: "control", totalTokens: 1500 }),
    run({ arm: "treatment", totalTokens: 1000 }),
  ];
  const report = summarize(runs, { runsPerCase: 3 });
  assertEqual(report.metrics.totalTokens.meanDelta, -500, "我方省 500 应为 -500");
});

// ---------------------------------------------------------------- 渲染
check("渲染：缺数据的指标写成 n/a，而不是 0", () => {
  const report = summarize(
    [run({ arm: "control" }), run({ arm: "treatment" })],
    { runsPerCase: 3 },
  );
  const text = render(report);
  assert(text.includes("n/a"), "缺数据要写 n/a");
  assert(!/Tokens\s+0\b/.test(text), "不得把缺数据渲染成 0");
});

console.log("");
if (failures.length === 0) {
  console.log(`paired-report 自测：${passed}/${passed} 通过`);
  process.exitCode = 0;
} else {
  console.log(`paired-report 自测：${passed} 通过，${failures.length} 失败`);
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
  process.exitCode = 1;
}

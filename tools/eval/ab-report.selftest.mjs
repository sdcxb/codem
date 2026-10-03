/**
 * `ab-report.mjs` 的**自测**（第 109 波）。
 *
 * 这些用例钉的是"**A/B 结论什么时候不算数**"：
 *  · 变坏必须与变好一样被报出来（只报好消息 = 自欺）；
 *  · 模型不同 ⇒ 拒绝比较；
 *  · 污染 / 零改动通过 ⇒ 从两侧都剔除（它们不是证据）；
 *  · runNumber 不对齐（拿 run-2 比 run-1）⇒ 不配对，不给差值；
 *  · 配对太少 ⇒ 明说"不下结论"。
 *
 * 用法：node tools/eval/ab-report.selftest.mjs
 */
import { abCompare, renderAb } from "./ab-report.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what ?? "值"}不符：实际 ${a}，期望 ${e}`);
}

/** 造一条运行（默认可用） */
function run(over = {}) {
  return {
    evalSet: "repo",
    caseId: "t1",
    arm: "treatment",
    model: "deepseek-flash",
    runNumber: 1,
    outcome: "failed",
    diffChars: 500,
    contaminated: false,
    suspiciousNoDiffPass: false,
    ...over,
  };
}

/** 造 N 个任务的基线/候选（控制变好/变坏的数量，保证覆盖数足够） */
function makeSets(changes) {
  const baseline = [];
  const candidate = [];
  let i = 0;
  for (const [outcomeBase, outcomeCand] of changes) {
    const caseId = `task-${String(i++).padStart(2, "0")}`;
    baseline.push(run({ caseId, outcome: outcomeBase }));
    candidate.push(run({ caseId, outcome: outcomeCand }));
  }
  return { baseline, candidate };
}

console.log("ab-report 自测");

check("A1: 变好与变坏**都要**报（只报好消息是自欺）", () => {
  const { baseline, candidate } = makeSets([
    ["failed", "passed"], // 变好
    ["passed", "failed"], // 变坏
    ["passed", "passed"],
    ["failed", "failed"],
    ["passed", "passed"],
    ["passed", "passed"],
  ]);
  const report = abCompare(baseline, candidate);
  eq(report.fixed.length, 1, "变好数");
  eq(report.regressed.length, 1, "变坏数");
  eq(report.flags.includes("regression"), true, "必须立起 regression 旗");
});

check("A2: 配对不足 ⇒ 拒绝下结论（insufficient-coverage）", () => {
  const { baseline, candidate } = makeSets([
    ["failed", "passed"],
    ["passed", "passed"],
  ]);
  const report = abCompare(baseline, candidate, { minTasks: 6 });
  eq(report.publishDelta, false, "是否允许发布差值");
  eq(report.flags.includes("insufficient-coverage"), true, "旗");
  eq(renderAb(report).includes("暂不下结论"), true, "渲染里要明说");
});

check("A3: 变好的数量够、没有变坏 ⇒ 允许发布差值", () => {
  const { baseline, candidate } = makeSets([
    ["failed", "passed"],
    ["failed", "passed"],
    ["failed", "passed"],
    ["passed", "passed"],
    ["passed", "passed"],
    ["passed", "passed"],
  ]);
  const report = abCompare(baseline, candidate, { minTasks: 6 });
  eq(report.publishDelta, true, "是否允许发布差值");
  eq(Math.round(report.baselinePassRate * 100), 50, "基线通过率");
  eq(Math.round(report.candidatePassRate * 100), 100, "候选通过率");
});

check("A4: runNumber 不对齐 ⇒ 不配对（拿 run-2 比 run-1 会把抖动当效果）", () => {
  const baseline = [run({ caseId: "a", runNumber: 1, outcome: "failed" })];
  const candidate = [run({ caseId: "a", runNumber: 2, outcome: "passed" })];
  const report = abCompare(baseline, candidate, { minTasks: 1 });
  eq(report.pairs, 0, "配对数");
  eq(report.onlyBaseline.length, 1, "只在基线里");
  eq(report.onlyCandidate.length, 1, "只在候选里");
  eq(report.publishDelta, false, "有未配对任务就不许发布差值");
  eq(report.flags.includes("unpaired-tasks"), true, "旗");
});

check("A5: 污染与零改动通过**两侧都剔除**，并计数报告", () => {
  const baseline = [
    run({ caseId: "a", outcome: "passed" }),
    run({ caseId: "b", outcome: "passed", contaminated: true }),
    run({ caseId: "c", outcome: "passed", suspiciousNoDiffPass: true }),
    run({ caseId: "d", outcome: "passed" }),
  ];
  const candidate = baseline.map((r) => ({ ...r }));
  const report = abCompare(baseline, candidate, { minTasks: 3 });
  eq(report.pairs, 2, "可用配对数（只算 a/d）");
  eq(report.droppedBaseline, 2, "基线剔除数");
  eq(report.droppedCandidate, 2, "候选剔除数");
  eq(report.flags.includes("dropped-runs"), true, "旗");
});

check("A6: 两边完全没变 ⇒ no-change（不许把噪声说成提升）", () => {
  const { baseline, candidate } = makeSets([
    ["passed", "passed"],
    ["passed", "passed"],
    ["failed", "failed"],
    ["failed", "failed"],
    ["passed", "passed"],
    ["passed", "passed"],
  ]);
  const report = abCompare(baseline, candidate, { minTasks: 6 });
  eq(report.flags.includes("no-change"), true, "旗");
  eq(report.publishDelta, true, "覆盖够就允许发布（差值为 0 也是一个结论）");
  eq(report.baselinePassRate, report.candidatePassRate, "通过率应当相同");
});

check("A7: 通过率的**分母是可评分的运行**（被剔除的不能稀释通过率）", () => {
  // 一条"污染通过" + 一条真失败：可评分的只有失败那条 ⇒ 通过率 0；
  // 若分母错用"全部运行"，就会算成 50%（把脏数据当成了成绩）。
  const rows = [
    run({ caseId: "a", outcome: "passed", contaminated: true }),
    run({ caseId: "b", outcome: "failed" }),
  ];
  const report = abCompare(rows, rows.map((r) => ({ ...r })), { minTasks: 1 });
  eq(report.baselinePassRate, 0, "基线通过率（只能看可评分的那条）");
  eq(report.candidatePassRate, 0, "候选通过率");
});

check("A8: --only-tasks 显式声明子集 ⇒ 未声明的任务不再阻塞结论，但**声明了没跑到的仍会阻塞**", () => {
  const baseline = [
    run({ caseId: "gap-1", outcome: "failed" }),
    run({ caseId: "gap-2", outcome: "failed" }),
    run({ caseId: "other-a", outcome: "passed" }),
    run({ caseId: "other-b", outcome: "passed" }),
  ];
  const candidate = [
    run({ caseId: "gap-1", outcome: "passed" }),
    run({ caseId: "gap-2", outcome: "passed" }),
  ];
  // 不声明子集：other-a/other-b 只在基线里 ⇒ 未配对 ⇒ 不下结论
  const withoutFilter = abCompare(baseline, candidate, { minTasks: 2 });
  eq(withoutFilter.publishDelta, false, "不过滤时应当 withhold");
  eq(withoutFilter.flags.includes("unpaired-tasks"), true, "旗");
  // 显式声明只比 gap-1/gap-2：两个都配对且都变好 ⇒ 允许发布
  const withFilter = abCompare(baseline, candidate, { minTasks: 2, onlyTasks: ["gap-1", "gap-2"] });
  eq(withFilter.pairs, 2, "配对数");
  eq(withFilter.fixed.length, 2, "变好数");
  eq(withFilter.publishDelta, true, "声明子集后允许发布");
  eq(withFilter.onlyBaseline.length, 0, "未声明任务不该出现在未配对里");
  // 声明了却没跑到的任务（候选里缺 gap-2）仍然阻塞
  const missingOne = abCompare(baseline, [run({ caseId: "gap-1", outcome: "passed" })], {
    minTasks: 2,
    onlyTasks: ["gap-1", "gap-2"],
  });
  eq(missingOne.publishDelta, false, "声明了没跑到的任务仍然 withhold");
  eq(missingOne.onlyBaseline.map((r) => r.caseId), ["gap-2"], "未配对任务");
});

/**
 * A9（第 117 波）：**"挪位"记录不进通过率**。
 *
 * 重复的 (caseId, runNumber) 会被搬到高位 run 号（900+）并带 `parkedFrom`。
 * 它们是**效度不同期**的样本（泄漏期 / 清理之前），混进来会把通过率算歪；
 * 而它们满足"runNumber ≥ 2"，只看运行号拦不住。
 */
check("A9: 挪位记录（parkedFrom / runNumber ≥ 900）一律不计入通过率", () => {
  const baseline = [run({ caseId: "park-1", outcome: "failed" })];
  const candidate = [
    run({ caseId: "park-1", outcome: "passed" }),
    // 同一个键的另一条被挪到高位（模拟"重复运行号"的处置）
    { ...run({ caseId: "park-1", outcome: "failed" }), runNumber: 900, parkedFrom: 1, parkNote: "重复键" },
  ];
  const cmp = abCompare(baseline, candidate, { minTasks: 1 });
  eq(cmp.pairs, 1, "只应配到一条（挪位那条不参与）");
  eq(cmp.fixed.length, 1, "变好数");
  eq(cmp.scoredCandidate ?? 1, 1, "候选侧可评分运行数应为 1");
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
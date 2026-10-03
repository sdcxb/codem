/**
 * `normalize-codem-records.mjs` 的**自测**（第 106 波）。
 *
 * 这些用例钉的是"**记录口径**"本身：token 桶怎么映射、缺数据怎么处理、运行号能不能猜、
 * 污染怎么带过去。它们是这份比较的地基 —— 地基错了，后面所有数字都错。
 *
 * 用法：node tools/eval/normalize-codem-records.selftest.mjs
 */
import { normalizeCodemRecord, normalizeCodemRecords, checkSameModel } from "./normalize-codem-records.mjs";

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

function assertEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what ?? "值"}不符：实际 ${a}，期望 ${e}`);
}

function assertThrows(fn, pattern, what) {
  try {
    fn();
  } catch (error) {
    if (pattern && !pattern.test(error.message)) {
      throw new Error(`${what ?? "错误"}信息不符：${error.message}`);
    }
    return;
  }
  throw new Error(`${what ?? "调用"}应当抛错，但没有`);
}

/** 一条"完整"的 Codem 记录（用例在此基础上改） */
function codemRecord(over = {}) {
  return {
    evalSet: "repo",
    agent: "codem-app",
    arm: "treatment",
    runNumber: 1,
    model: "deepseek-flash",
    caseId: "repo-01-edit-ambiguity",
    outcome: "passed",
    usage: {
      totalTokens: 4147865,
      promptTokens: 4075579,
      cacheHitTokens: 3868800,
      uncachedInputTokens: 206779,
      completionTokens: 72286,
    },
    toolCalls: 80,
    totalMs: 447672,
    contaminated: false,
    ...over,
  };
}

console.log("normalize-codem-records 自测");

check("N1: token 桶按**同口径**映射（总/未缓存输入/缓存读/输出）", () => {
  const r = normalizeCodemRecord(codemRecord());
  assertEqual(r.arm, "treatment", "臂名");
  assertEqual(r.totalTokens, 4147865, "总 token");
  // 关键：输入要取「未缓存输入」，不能取 promptTokens（后者含缓存读，与对照臂口径不同）
  assertEqual(r.inputTokens, 206779, "输入 token（未缓存）");
  assertEqual(r.cacheReadTokens, 3868800, "缓存读");
  assertEqual(r.outputTokens, 72286, "输出 token");
});

check("N2: 缺数据**不等于 0**（没有 usage 时各桶是 undefined）", () => {
  const r = normalizeCodemRecord(codemRecord({ usage: null }));
  assertEqual(r.totalTokens, undefined, "总 token");
  assertEqual(r.inputTokens, undefined, "输入 token");
  assertEqual(r.outputTokens, undefined, "输出 token");
  // 而且不能是 0（0 会被当成"省了钱"参与平均）
  if (r.totalTokens === 0) throw new Error("缺失被写成了 0 —— 违反纪律 1");
});

check("N3: 对照臂没有的指标（cacheWriteTokens）**不给值**", () => {
  const r = normalizeCodemRecord(codemRecord());
  assertEqual("cacheWriteTokens" in r, false, "是否伪造了 cacheWrite 桶");
});

check("N4: 运行号**不许猜** —— 记录缺 runNumber 必须抛错并说清原因", () => {
  const bad = codemRecord();
  delete bad.runNumber;
  assertThrows(() => normalizeCodemRecord(bad), /运行号必须由驱动显式写入/, "缺 runNumber");
});

check("N5: 缺 model 也拒绝（无法证明同模型）", () => {
  const bad = codemRecord();
  delete bad.model;
  assertThrows(() => normalizeCodemRecord(bad), /缺少字段：model/, "缺 model");
});

check("N6: 污染标记**原样带过去**", () => {
  const r = normalizeCodemRecord(codemRecord({ contaminated: true }));
  assertEqual(r.contaminated, true, "污染标记");
});

check("N7: loopStops 既支持数组也支持数字（驱动改过形状）", () => {
  assertEqual(normalizeCodemRecord(codemRecord({ loopStops: [1, 2] })).loopStops, 2, "数组");
  assertEqual(normalizeCodemRecord(codemRecord({ loopStops: 3 })).loopStops, 3, "数字");
});

check("N8: 同模型检查 —— 相同放行、不同拒绝、缺一侧拒绝", () => {
  const control = [{ model: "deepseek-flash" }];
  const treatment = [{ model: "deepseek-flash" }];
  assertEqual(checkSameModel(control, treatment).ok, true, "同模型");
  assertEqual(checkSameModel(control, [{ model: "gpt-4" }]).ok, false, "不同模型");
  assertEqual(checkSameModel(control, [{ model: undefined }]).ok, false, "缺模型名");
  assertEqual(checkSameModel(control, [{ model: "a" }, { model: "b" }]).ok, false, "一侧多模型");
});

check("N9: 批量规范化保持顺序（报告要靠它对齐运行号）", () => {
  const rows = normalizeCodemRecords([
    codemRecord({ caseId: "a", runNumber: 1 }),
    codemRecord({ caseId: "b", runNumber: 2 }),
  ]);
  assertEqual(rows.map((r) => `${r.caseId}#${r.runNumber}`), ["a#1", "b#2"], "顺序");
});

check("N10: 「通过了但零改动」被标出来（老记录没有该字段时当场算）", () => {
  // 老记录（没有 suspiciousNoDiffPass 字段）：通过 + diff=0 ⇒ 必须标出来
  assertEqual(normalizeCodemRecord(codemRecord({ diffChars: 0 })).suspiciousNoDiffPass, true, "零改动通过");
  // 正常通过（有真实改动）⇒ 不标
  assertEqual(normalizeCodemRecord(codemRecord({ diffChars: 3000 })).suspiciousNoDiffPass, false, "有改动通过");
  // 失败 + 零改动 ⇒ 不是这种问题（没通过就不算"零改动通过"）
  assertEqual(
    normalizeCodemRecord(codemRecord({ outcome: "failed", diffChars: 0 })).suspiciousNoDiffPass,
    false,
    "失败+零改动",
  );
  // 记录里显式带了就以它为准（新驱动会写这个字段）
  assertEqual(
    normalizeCodemRecord(codemRecord({ diffChars: 0, suspiciousNoDiffPass: false })).suspiciousNoDiffPass,
    false,
    "显式字段优先",
  );
  // 没有 diffChars（缺数据）⇒ 不能凭空判成可疑（纪律 1：缺数据不是 0）
  const noDiff = codemRecord();
  delete noDiff.diffChars;
  assertEqual(normalizeCodemRecord(noDiff).suspiciousNoDiffPass, false, "缺 diffChars");
});

console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);

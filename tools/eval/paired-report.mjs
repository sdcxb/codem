/**
 * 成对评测（paired evaluation）的**方法学核心** —— 把
 * 「同样用 DS 模型，水平和 token 消耗都不差于 dsh」变成可判真假的一句话。
 *
 * 移植自 Pi Agent Harness 1.0 的 `packages/evals/src/{plan.ts,report.ts}` 的**方法学**，
 * 不是移植它的用例（它只做"文档 lift"对照，没有代码质量 benchmark）。
 * 来源证据（`.preview-shot/_pi-repo`，HEAD 9b3c19d）：
 *   - `packages/evals/src/report.ts:22`   inputTokens 等四个 token 桶
 *   - `packages/evals/src/report.ts:37,40` eligiblePairs / meanDelta（成对结构）
 *   - `packages/evals/src/report.ts:249`  resolvePair(group) -> { pair?, blocked? }
 *   - `packages/evals/src/report.ts:379`  publishHeadline = blockedPairCount === 0 && pairs.length > 0
 *   - `packages/evals/src/report.ts:445`  「Pass rate withheld because pairs are blocked」
 *   - `packages/evals/src/report.ts:52-56`（plan.ts）按运行号交替顺序，降低顺序偏
 *
 * 三条纪律（本文件存在的理由，比任何数字都重要）：
 *   1. **缺数据不等于 0** —— 某一侧没上报的指标，该指标在该对上"不可用"，绝不当成 0 参与平均。
 *   2. **成对样本不足就拒绝给结论** —— 只要有一对被阻塞，头部通过率**不发布**。
 *   3. **一次重复不足以说明稳定性** —— 每任务每臂重复次数 < 2 时明确标注。
 *
 * 本文件是纯函数 + 一个自测入口，没有任何 I/O，所以它可以被单独变异验证。
 */

/** 两条臂：对照（DSH）与处理（Codem）。 */
export const ARMS = ["control", "treatment"];

/** 一次运行的结果。**语义上必须区分**「没有数据」与「数据是 0」。 */
export const OUTCOMES = [
  "passed", // 任务达成
  "failed", // 跑了但没达成
  "errored", // 运行本身出错（崩溃 / 接口报错）
  "skipped", // 明确跳过（例如需要 API key 而没给）
  "pending", // 计划了但没跑
  "unscored", // 跑了但无法评分
];

/** 判定一次运行是否"有分数"。只有 passed / failed 算有分数。 */
export function isScored(run) {
  return run.outcome === "passed" || run.outcome === "failed";
}

/** 可成对比较的指标。单位用于渲染，不影响计算。 */
export const METRICS = [
  { key: "totalTokens", label: "Tokens", unit: "", scale: 1 },
  { key: "inputTokens", label: "Input", unit: "", scale: 1 },
  { key: "outputTokens", label: "Output", unit: "", scale: 1 },
  { key: "cacheReadTokens", label: "CacheRead", unit: "", scale: 1 },
  { key: "cacheWriteTokens", label: "CacheWrite", unit: "", scale: 1 },
  { key: "toolCalls", label: "Tools", unit: "", scale: 1 },
  { key: "totalMs", label: "Latency", unit: "ms", scale: 1 },
  { key: "estimatedCostUsd", label: "Est.Cost", unit: "$", scale: 1 },
];

/**
 * 计划运行顺序：**按运行号交替**两条臂的顺序。
 * 目的是降低"总是同一个先跑"带来的顺序偏（缓存预热、机器负载）。
 * 奇数轮 control 先，偶数轮 treatment 先。
 */
export function planRuns(cases, runsPerCase) {
  const planned = [];
  for (const testCase of cases) {
    for (let runNumber = 1; runNumber <= runsPerCase; runNumber++) {
      const order = runNumber % 2 === 1 ? ["control", "treatment"] : ["treatment", "control"];
      for (const arm of order) {
        planned.push({
          evalSet: testCase.evalSet,
          caseId: testCase.caseId,
          model: testCase.model,
          arm,
          runNumber,
        });
      }
    }
  }
  return planned;
}

/** 取某个指标的数值。**没有上报就返回 undefined，绝不返回 0。** */
export function metricValue(run, key) {
  const value = run?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 平均；空数组返回 null（**不是 0**）。 */
export function mean(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * 把一组（同一 evalSet/caseId/model/runNumber 的）运行解成一对。
 * 规则与 Pi 一致：**两侧各恰好一条、且都有分数**，才算一对；否则阻塞并说明原因。
 */
export function resolvePair(group) {
  if (!group || group.length === 0) {
    return { blocked: { reasons: ["没有运行记录"], group: [] } };
  }
  const key = group[0];
  const label = `${key.evalSet}/${key.caseId}/${key.model}/run-${key.runNumber}`;

  const control = group.filter((run) => run.arm === "control");
  const treatment = group.filter((run) => run.arm === "treatment");

  const reasons = [];
  if (control.length === 0) reasons.push("对照臂缺失");
  if (treatment.length === 0) reasons.push("处理臂缺失");
  if (control.length > 1) reasons.push(`对照臂重复 ${control.length} 次`);
  if (treatment.length > 1) reasons.push(`处理臂重复 ${treatment.length} 次`);

  // 单侧多条时无法判断"哪一条代表这一对"，直接阻塞（不当成可平均的样本）。
  if (reasons.length === 0) {
    const controlRun = control[0];
    const treatmentRun = treatment[0];
    if (!isScored(controlRun)) reasons.push(`对照臂未评分（${controlRun.outcome}）`);
    if (!isScored(treatmentRun)) reasons.push(`处理臂未评分（${treatmentRun.outcome}）`);
    if (reasons.length === 0) {
      return { pair: { label, control: controlRun, treatment: treatmentRun } };
    }
  }
  return { blocked: { label, reasons, group } };
}

/** 按 (evalSet, caseId, model, runNumber) 分组。 */
export function groupRuns(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.evalSet}\u0000${run.caseId}\u0000${run.model}\u0000${run.runNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups.values()];
}

/** 成对均值：只在**两侧都上报了**该指标的对上计算；否则该指标返回 null。 */
export function pairedMetric(pairs, key) {
  const controlValues = [];
  const treatmentValues = [];
  for (const pair of pairs) {
    const controlValue = metricValue(pair.control, key);
    const treatmentValue = metricValue(pair.treatment, key);
    if (controlValue === undefined || treatmentValue === undefined) continue;
    controlValues.push(controlValue);
    treatmentValues.push(treatmentValue);
  }
  const controlMean = mean(controlValues);
  const treatmentMean = mean(treatmentValues);
  let meanDelta = null;
  if (controlMean !== null && treatmentMean !== null) {
    // 约定：**正值 = 处理臂（我方）比对照臂（DSH）花得多**。
    meanDelta = treatmentMean - controlMean;
  }
  return {
    key,
    eligiblePairs: controlValues.length,
    controlMean,
    treatmentMean,
    meanDelta,
  };
}

/** 通过率。分母是**有分数的**运行数；一个都没有时返回 null，不返回 0。 */
export function passRate(runs) {
  const scored = runs.filter(isScored);
  if (scored.length === 0) return null;
  const passed = scored.filter((run) => run.outcome === "passed").length;
  return passed / scored.length;
}

/**
 * 不稳定性检测：**同一臂内**同一任务不同运行号的结果不一致 ⇒ 该任务 flaky。
 * 一次重复（每个运行号只有一条）无法检测，由 insufficientRepetition 单独标注。
 */
export function findFlakyCases(runs) {
  const byArmCase = new Map();
  for (const run of runs) {
    if (!isScored(run)) continue;
    const key = `${run.arm}\u0000${run.evalSet}\u0000${run.caseId}\u0000${run.model}`;
    if (!byArmCase.has(key)) byArmCase.set(key, []);
    byArmCase.get(key).push(run.outcome);
  }
  const flaky = [];
  for (const [key, outcomes] of byArmCase) {
    if (outcomes.length < 2) continue;
    const first = outcomes[0];
    if (outcomes.some((outcome) => outcome !== first)) {
      const [arm, evalSet, caseId, model] = key.split("\u0000");
      flaky.push({ arm, evalSet, caseId, model });
    }
  }
  return flaky;
}

/**
 * 汇总一份报告。
 *
 * @param runs 所有运行记录
 * @param options.runsPerCase 每任务每臂计划重复次数（用于"一次重复不足以说明稳定性"）
 */
export function summarize(runs, options = {}) {
  const groups = groupRuns(runs);
  const pairs = [];
  const blockedPairs = [];
  for (const group of groups) {
    const { pair, blocked } = resolvePair(group);
    if (pair) pairs.push(pair);
    if (blocked) {
      const sample = blocked.group[0];
      blockedPairs.push({
        label: sample
          ? `${sample.evalSet}/${sample.caseId}/${sample.model}/run-${sample.runNumber}`
          : (blocked.label ?? "unknown"),
        reasons: blocked.reasons,
      });
    }
  }

  const controlRuns = runs.filter((run) => run.arm === "control");
  const treatmentRuns = runs.filter((run) => run.arm === "treatment");
  const controlPassRate = passRate(controlRuns);
  const treatmentPassRate = passRate(treatmentRuns);
  let lift = null;
  if (controlPassRate !== null && treatmentPassRate !== null) {
    lift = treatmentPassRate - controlPassRate;
  }

  const totalPairs = groups.length;
  // 纪律 2：只要有一对被阻塞，就不发布头部结论。
  const publishHeadline = blockedPairs.length === 0 && pairs.length > 0;

  const metrics = {};
  for (const metric of METRICS) metrics[metric.key] = pairedMetric(pairs, metric.key);

  const flags = [];
  if (lift !== null && lift <= 0) flags.push("no-lift");
  if (lift !== null && lift < 0) flags.push("negative-delta");
  if (controlPassRate === 1) flags.push("control-saturated");
  if (treatmentPassRate === 1) flags.push("treatment-saturated");
  if (blockedPairs.length > 0) flags.push("blocked-pairs");
  const flaky = findFlakyCases(runs);
  if (flaky.length > 0) flags.push("flaky");
  const runsPerCase = options.runsPerCase;
  if (typeof runsPerCase === "number" && runsPerCase < 2) flags.push("insufficient-repetition");
  if (!publishHeadline) flags.push("headline-withheld");

  return {
    totalRuns: runs.length,
    totalPairs,
    eligiblePairs: pairs.length,
    blockedPairs,
    controlPassRate,
    treatmentPassRate,
    lift,
    publishHeadline,
    metrics,
    flags,
    flaky,
  };
}

/** 带符号渲染一个数，便于人读。 */
export function signed(value, digits) {
  if (value === null || value === undefined) return "n/a";
  const rounded = Number(value.toFixed(digits));
  if (rounded > 0) return `+${rounded}`;
  return `${rounded}`;
}

/** 渲染成纯文本。**头部结论被withheld 时必须显式说出来**，不能留白让人误读。 */
export function render(report) {
  const lines = [];
  lines.push(`runs ${report.totalRuns}  pairs ${report.eligiblePairs}/${report.totalPairs} eligible`);
  if (report.publishHeadline) {
    const pct = (value) => `${(value * 100).toFixed(1)}%`;
    lines.push(`Pass rate  control ${pct(report.controlPassRate)}  treatment ${pct(report.treatmentPassRate)}  lift ${signed(report.lift * 100, 1)}pp`);
  } else {
    lines.push("Pass rate  withheld because pairs are blocked");
  }
  for (const metric of METRICS) {
    const summary = report.metrics[metric.key];
    if (!summary || summary.meanDelta === null) {
      // 纪律 1：没有数据就说没有数据，不写 0。
      lines.push(`    ${metric.label.padStart(10)}  n/a (no pair reported this metric)`);
      continue;
    }
    lines.push(
      `    ${metric.label.padStart(10)}  ${signed(summary.meanDelta, 2)}${metric.unit} ` +
        `(treatment ${summary.treatmentMean.toFixed(2)}${metric.unit}, control ${summary.controlMean.toFixed(2)}${metric.unit}, ${summary.eligiblePairs} pairs)`,
    );
  }
  if (report.blockedPairs.length > 0) {
    lines.push("Blocked pairs:");
    for (const blocked of report.blockedPairs) {
      lines.push(`    ${blocked.label}: ${blocked.reasons.join("; ")}`);
    }
  }
  if (report.flaky.length > 0) {
    lines.push(`Flaky cases: ${report.flaky.length}`);
  }
  if (report.flags.length > 0) lines.push(`Flags: ${report.flags.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * 判定"能不能下结论"。这是本模块对外最重要的一个函数 ——
 * 因为它把「不许过度声称」写成了代码，而不是写成一句口号。
 */
export function verdict(report) {
  if (!report.publishHeadline) {
    return {
      conclusive: false,
      reason: "有成对样本被阻塞 —— 缺数据不等于 0，先补齐再谈结论",
    };
  }
  if (report.flags.includes("insufficient-repetition")) {
    return {
      conclusive: false,
      reason: "每任务每臂重复次数 < 2 —— 一次重复不足以说明稳定性",
    };
  }
  const tokenMetric = report.metrics.totalTokens;
  if (!tokenMetric || tokenMetric.meanDelta === null) {
    return {
      conclusive: false,
      reason: "没有任何一对上报了 token 总量 —— 计量链路没接通，先修计量",
    };
  }
  return {
    conclusive: true,
    reason: `成对样本 ${report.eligiblePairs} 对；token 均值差 ${signed(tokenMetric.meanDelta, 2)}（正值 = 我方更贵）`,
  };
}

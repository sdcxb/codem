/**
 * **A/B 报告：同一个臂、同一批任务、两个构建**（第 109 波）。
 *
 * ## 为什么需要它（与 `repo-paired-report.mjs` 的分工）
 *
 * · `repo-paired-report.mjs`：**Codem vs DSH**（处理臂 vs 对照臂）—— 回答"我们和它谁强"；
 * · 本文件：**新构建 vs 旧构建**（同一条臂、同模型、同任务）—— 回答"我这次改动有没有用"。
 *
 * 第二个问题在"测量 → 改产品 → 再测量"的闭环里是**每一轮都要问**的，
 * 而它有两个容易自欺的地方，本文件专门钉住：
 *
 *  1. **只挑改好的任务看** —— 所以报告必须同时给出 fixed（变好）与 regressed（变坏）两个方向，
 *     并且**分母是"两边都可评分的任务"**，不是"我关心的那几个"；
 *  2. **把噪声当提升** —— 所以：模型必须相同；runNumber 必须对齐（否则是拿 run-2 比 run-1，
 *     差异里混着"同任务重复本来就有的抖动"）；被污染/零改动通过的运行一律剔除；
 *     任务数不足时**明说不下结论**（`insufficient-coverage`）。
 *
 * 用法：
 *   node tools/eval/ab-report.mjs --baseline <旧构建记录> --candidate <新构建记录> [--min-tasks 6]
 */
import { readRecords, normalizeCodemRecords, checkSameModel } from "./normalize-codem-records.mjs";

/**
 * 逐任务比较两条记录集合（同臂、不同构建）。
 *
 * @param baseline 旧构建的运行（已规范化）
 * @param candidate 新构建的运行（已规范化）
 * @param options.minTasks 低于这个可评分数就拒绝下结论（默认 6）
 * @param options.onlyTasks **显式声明**只在哪些任务上比较（默认全部）
 */
export function abCompare(baseline, candidate, options = {}) {
  const minTasks = typeof options.minTasks === "number" ? options.minTasks : 6;
  /**
   * **只在声明的任务子集上比较**（第 109 波）。
   *
   * 为什么需要它：A/B 复测通常只跑"出问题的那几个任务 + 少量回归对照"（时间与成本决定的），
   * 而基线记录里往往有更多任务。不过滤的话 `onlyBaseline` 会塞满未配对任务 ⇒ 永远"不下结论"；
   * 而粗暴地忽略它们又等于**偷偷缩小分母**。
   * 所以做成**显式声明**：任务清单写在命令行里、也原样印在报告里，谁都能看出
   * "这次只在这几个任务上比"。声明之后，`onlyBaseline/onlyCandidate` 仍然照常拦截
   * （声明了却没跑到的任务依然会让结论 withhold）。
   */
  const onlyTasks =
    Array.isArray(options.onlyTasks) && options.onlyTasks.length > 0 ? new Set(options.onlyTasks) : null;
  const restrict = (rows) => (onlyTasks ? rows.filter((r) => onlyTasks.has(r.caseId)) : rows);
  baseline = restrict(baseline);
  candidate = restrict(candidate);

  /** 只留"能当证据"的运行：有评分、未污染、不是零改动通过 */
  const usable = (rows) =>
    rows.filter(
      (r) =>
        (r.outcome === "passed" || r.outcome === "failed") && !r.contaminated && !r.suspiciousNoDiffPass,
    );
  const dropped = (rows) => rows.length - usable(rows).length;

  /** 按 (caseId, runNumber) 配对：跨构建比较必须是**同一个运行号** */
  const key = (r) => `${r.caseId}\u0000${r.runNumber}`;
  const baseMap = new Map(usable(baseline).map((r) => [key(r), r]));
  const candMap = new Map(usable(candidate).map((r) => [key(r), r]));

  const fixed = [];
  const regressed = [];
  const bothPassed = [];
  const bothFailed = [];
  const onlyBaseline = [];
  const onlyCandidate = [];

  for (const [k, base] of baseMap) {
    const cand = candMap.get(k);
    if (!cand) {
      onlyBaseline.push(base);
      continue;
    }
    if (base.outcome === "failed" && cand.outcome === "passed") fixed.push({ base, cand });
    else if (base.outcome === "passed" && cand.outcome === "failed") regressed.push({ base, cand });
    else if (base.outcome === "passed") bothPassed.push({ base, cand });
    else bothFailed.push({ base, cand });
  }
  for (const [k, cand] of candMap) if (!baseMap.has(k)) onlyCandidate.push(cand);

  const pairs = fixed.length + regressed.length + bothPassed.length + bothFailed.length;
  const flags = [];
  if (pairs < minTasks) flags.push("insufficient-coverage");
  if (regressed.length > 0) flags.push("regression");
  if (fixed.length === 0 && regressed.length === 0) flags.push("no-change");
  if (dropped(baseline) > 0 || dropped(candidate) > 0) flags.push("dropped-runs");
  if (onlyBaseline.length > 0 || onlyCandidate.length > 0) flags.push("unpaired-tasks");

  const passRate = (rows) => {
    const scored = usable(rows);
    if (scored.length === 0) return null;
    return scored.filter((r) => r.outcome === "passed").length / scored.length;
  };

  return {
    pairs,
    fixed,
    regressed,
    bothPassed,
    bothFailed,
    onlyBaseline,
    onlyCandidate,
    baselinePassRate: passRate(baseline),
    candidatePassRate: passRate(candidate),
    droppedBaseline: dropped(baseline),
    droppedCandidate: dropped(candidate),
    flags,
    /** 只有配对数够、且没有未配对的缺口时，才允许把差值当成"这次改动带来的" */
    publishDelta: pairs >= minTasks && onlyBaseline.length === 0 && onlyCandidate.length === 0,
  };
}

/** 渲染成人读的文本 */
export function renderAb(report, labels = { baseline: "旧构建", candidate: "新构建" }) {
  const lines = [];
  const pct = (v) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  lines.push(
    `配对 ${report.pairs} 个任务：${labels.baseline} 通过率 ${pct(report.baselinePassRate)} → ` +
      `${labels.candidate} ${pct(report.candidatePassRate)}`,
  );
  lines.push(`  ✅ 变好 ${report.fixed.length}：${report.fixed.map((p) => p.cand.caseId).join(", ") || "（无）"}`);
  lines.push(`  ❌ 变坏 ${report.regressed.length}：${report.regressed.map((p) => p.cand.caseId).join(", ") || "（无）"}`);
  lines.push(
    `  ➖ 两边都过 ${report.bothPassed.length} / 两边都没过 ${report.bothFailed.length}` +
      (report.bothFailed.length ? `（${report.bothFailed.map((p) => p.cand.caseId).join(", ")}）` : ""),
  );
  if (report.onlyBaseline.length || report.onlyCandidate.length) {
    lines.push(
      `  ⚠️ 未配对：只有基线 ${report.onlyBaseline.length}（${report.onlyBaseline.map((r) => r.caseId).join(", ") || "-"}）、` +
        `只有候选 ${report.onlyCandidate.length}（${report.onlyCandidate.map((r) => r.caseId).join(", ") || "-"}）`,
    );
  }
  if (report.droppedBaseline || report.droppedCandidate) {
    lines.push(
      `  🧹 剔除（污染 / 零改动通过 / 未评分）：基线 ${report.droppedBaseline} 条、候选 ${report.droppedCandidate} 条`,
    );
  }
  lines.push(`Flags: ${report.flags.join(", ") || "（无）"}`);
  lines.push(
    report.publishDelta
      ? `结论：这 ${report.pairs} 个任务上的差值可以作为本次改动的证据（没有未配对任务）。`
      : `结论：**暂不下结论** —— 配对不足以支撑"改动有效"（见 flags）。`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--baseline") args.baseline = argv[++i];
    else if (argv[i] === "--candidate") args.candidate = argv[++i];
    else if (argv[i] === "--min-tasks") args.minTasks = Number(argv[++i]);
    else if (argv[i] === "--only-tasks") args.onlyTasks = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  if (args.help || !args.baseline || !args.candidate) {
    console.log(
      "用法：node tools/eval/ab-report.mjs --baseline <旧构建记录> --candidate <新构建记录> [--min-tasks N] [--only-tasks a,b,c]",
    );
    process.exit(args.help ? 0 : 2);
  }

  const baselineRaw = readRecords(args.baseline);
  const candidateRaw = readRecords(args.candidate);
  // 两条记录都按 Codem 臂口径规范化（A/B 是同一条臂的两个构建）
  const versionOf = (rows) => [...new Set(rows.map((r) => r.appVersion).filter(Boolean))].join("/") || "?";
  console.log(`基线：${args.baseline}（${baselineRaw.length} 条，版本 ${versionOf(baselineRaw)}）`);
  console.log(`候选：${args.candidate}（${candidateRaw.length} 条，版本 ${versionOf(candidateRaw)}）`);

  const modelCheck = checkSameModel(baselineRaw, candidateRaw);
  if (!modelCheck.ok) {
    console.log(`\n❌ 拒绝比较：${modelCheck.reason}`);
    console.log("   （同模型是前提：不同模型的差别不能当成这次改动的效果）");
    process.exit(1);
  }

  if (args.onlyTasks) console.log(`只比较这些任务（显式声明）：${args.onlyTasks.join(", ")}`);
  const report = abCompare(normalizeCodemRecords(baselineRaw), normalizeCodemRecords(candidateRaw), {
    minTasks: args.minTasks,
    onlyTasks: args.onlyTasks,
  });
  console.log("");
  console.log(renderAb(report, { baseline: `旧构建 ${versionOf(baselineRaw)}`, candidate: `新构建 ${versionOf(candidateRaw)}` }));
  process.exit(report.publishDelta ? 0 : 1);
}

/** 直接执行时跑 CLI；被 import 时只导出函数（判据要 import 它） */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/eval/ab-report.mjs")) {
  main();
}

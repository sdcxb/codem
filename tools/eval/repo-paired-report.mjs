/**
 * **Codem vs DSH 成对报告**（第 106 波）：读两个臂的记录，出结论。
 *
 * 用法：
 *   node tools/eval/repo-paired-report.mjs --control .preview-shot/eval-records-repo-control.jsonl \
 *     --treatment .preview-shot/eval-records-codem-repo-v2.jsonl [--runs 1] [--json]
 *
 * ## 这个脚本刻意不自己算分
 *
 * 通过率、成对均值、阻塞判定、flaky 检测全在 `paired-report.mjs`（纯函数 + 自测 + 变异自证）。
 * 本脚本只做两件事：**取数**（含 Codem 侧的字段规范化）与**渲染**。
 * 这样"结论怎么来的"永远只有一处实现，改动也只能改一处。
 *
 * ## 地基不成立就拒绝出结论
 *
 * · 两臂**模型不同** ⇒ 直接拒（同模型是这份比较的前提）；
 * · 有一臂**缺任务** ⇒ 该任务的对会阻塞，报告自己会 withheld（不发布头部结论）；
 * · 有**污染**运行 ⇒ 保留在记录里，但报告里点명（宁可作废也不用脏数据）。
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize, render } from "./paired-report.mjs";
import { readRecords, normalizeCodemRecords, checkSameModel } from "./normalize-codem-records.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { runs: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--control") out.control = next();
    else if (arg === "--treatment") out.treatment = next();
    else if (arg === "--runs") out.runs = Number(next());
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`不认识的参数：${arg}`);
  }
  return out;
}

const USAGE = `用法：
  node tools/eval/repo-paired-report.mjs --control <对照臂 JSONL> --treatment <Codem 臂 JSONL> [--runs N] [--json]

说明：
  · 对照臂记录由 tools/eval/drivers/dsh-driver.mjs 写出（已含 arm/model/runNumber）；
  · Codem 臂记录由 .preview-shot/_codem-repo-eval.mjs 写出（第 106 波起含 arm/runNumber/model），
    本脚本会把它规范化成成对比较口径（token 桶的映射见 normalize-codem-records.mjs 的文件头）。`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.control || !args.treatment) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }

  const controlRaw = readRecords(args.control);
  const treatmentRaw = normalizeCodemRecords(readRecords(args.treatment));

  const modelCheck = checkSameModel(controlRaw, treatmentRaw);
  console.log(`对照臂：${args.control}（${controlRaw.length} 条，模型 ${modelCheck.controlModels.join("/") || "?"}）`);
  console.log(`处理臂：${args.treatment}（${treatmentRaw.length} 条，模型 ${modelCheck.treatmentModels.join("/") || "?"}）`);
  if (!modelCheck.ok) {
    console.log(`\n❌ 拒绝出结论：${modelCheck.reason}`);
    console.log("   （同模型是这份比较的前提；不同模型下的分数差不能归因到产品）");
    process.exit(1);
  }

  const contaminated = [...controlRaw, ...treatmentRaw].filter((r) => r.contaminated);
  if (contaminated.length > 0) {
    console.log(`\n⚠️ 有 ${contaminated.length} 条**污染**记录（读过工作区外的答案仓库）—— 它们仍会进报告，`);
    console.log("   但报告会按纪律处理（脏数据不作依据）。受影响的用例：");
    for (const r of contaminated) console.log(`   · ${r.arm}/${r.caseId}/run-${r.runNumber}`);
  }

  /**
   * "通过了但工作区没有改动" —— **尺子完整性问题**，必须先说。
   * 这类"通过"要么说明工作区带着上一次的修复（假绿），要么说明驱动的改动口径漏了已提交的改动；
   * 无论哪种，把它当成绩都会让通过率虚高（老口径里混进了 3 次）。
   *
   * 处置：**把它从可评分集合里剔除**（它不是证据）。剔除之后该任务的处理臂就缺一条，
   * `paired-report.mjs` 会把这一对判成阻塞 ⇒ 头部结论 withheld —— 这正是我们要的：
   * "尺子有问题时不给结论"，而不是"照样出一个更好看的数"。
   */
  const suspicious = treatmentRaw.filter((r) => r.suspiciousNoDiffPass);
  const treatmentScored = treatmentRaw.filter((r) => !r.suspiciousNoDiffPass);
  if (suspicious.length > 0) {
    console.log(`\n❌ 有 ${suspicious.length} 条"**通过了但工作区零改动**"的记录 —— 这不是成绩，是尺子问题：`);
    for (const r of suspicious) console.log(`   · ${r.caseId}/run-${r.runNumber}`);
    console.log("   处置：**已从可评分集合里剔除**（重跑该任务才算数）。因此这些任务的对会缺一侧 ⇒ 头部结论 withheld。");
  }

  const runs = [...controlRaw, ...treatmentScored];
  const report = summarize(runs, { runsPerCase: args.runs });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("");
    console.log(render(report));
  }
  // 头部结论没发布（有阻塞对 / 没有对）时，用退出码 1 表示"这次不能下结论"
  process.exit(report.publishHeadline ? 0 : 1);
}

main();

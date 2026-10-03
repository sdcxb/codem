/**
 * 出「真实仓库档（Codem 应用实测）」的汇总报告。
 *
 * 与 `tools/eval/paired-report.mjs` 的分工：那个是**臂对照**（命令行 agent，成对比较）；
 * 这个只汇总 **Codem 应用自己跑出来的记录**（`.preview-shot/eval-records-codem-repo.jsonl`）。
 *
 * ## 为什么要单独一个（而不是肉眼看 jsonl）
 *
 * 这一档的结论**必须带口径**：同一个任务可能跑过多次，其中有些是"尺子坏掉"的次数
 * （污染 / 工作目录指错 / 自我还原）。把那些混进通过率里，数字就是假的。
 * 所以这里**默认只统计 `contaminated === false` 且 `outcome !== "errored"` 的记录**，
 * 并把被排除的显式列出来 —— 「哪些不算数」本身是结论的一部分。
 *
 * 用法：
 *   node tools/eval/codem-records-report.mjs [记录文件]
 *   node tools/eval/codem-records-report.mjs --all      # 连不算数的也列出来
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RECORDS = join(HERE, "..", "..", ".preview-shot", "eval-records-codem-repo.jsonl");

const argv = process.argv.slice(2);
const showAll = argv.includes("--all");
const file = resolve(argv.find((a) => !a.startsWith("--")) ?? DEFAULT_RECORDS);

if (!existsSync(file)) {
  console.log(`没有记录文件：${file}`);
  process.exit(1);
}

const records = readFileSync(file, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

/**
 * 「通过但没有改动」**不可能是真通过**：工作区是一份只有 bug 状态提交的新仓库，
 * 判据在 bug 状态下必须是红的（`npm run eval:repo-bug-tests` 强制）。
 * 所以 `passed && diffChars === 0` 只有一种解释：**这个任务的 bug 根本没造出来**
 * （退化的任务，谁都能过）—— 实测抓到过一次（repo-08 的 `buggyCommit` 写成了引入修复的那个提交）。
 *
 * 这里把它自动标出来并从通过率里剔除：**判据要能自己识破假绿**，不能靠人记得排除。
 */
const isVacuousPass = (r) => r.outcome === "passed" && (r.diffChars ?? 0) === 0;

/** 算数的那部分：没污染、没跑挂、也不是"通过但零改动"。其余的要显式排除并说明原因。 */
const trusted = records.filter((r) => r.contaminated === false && r.outcome !== "errored" && !isVacuousPass(r));
const excluded = records.filter((r) => !(r.contaminated === false && r.outcome !== "errored" && !isVacuousPass(r)));

const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "n/a");
const min = (ms) => (typeof ms === "number" ? (ms / 60000).toFixed(1) : "n/a");

console.log(`记录：${file}（共 ${records.length} 条；算数 ${trusted.length} 条，排除 ${excluded.length} 条）\n`);

console.log("任务                                结果      迭代  调用      token      耗时     判据  改动");
for (const r of trusted) {
  console.log(
    `  ${String(r.caseId).padEnd(34)} ${String(r.outcome).padEnd(8)} ${String(r.maxIteration ?? "?").padStart(4)} ` +
      `${String(r.toolCalls ?? "?").padStart(5)} ${fmt(r.usage?.totalTokens).padStart(10)} ${String(min(r.totalMs)).padStart(7)}min ` +
      `${String(r.gradeExit ?? "?").padStart(4)} ${String(r.diffChars ?? "?").padStart(6)}`,
  );
}

const passed = trusted.filter((r) => r.outcome === "passed").length;
const tokens = trusted.reduce((a, r) => a + (r.usage?.totalTokens ?? 0), 0);
const ms = trusted.reduce((a, r) => a + (r.totalMs ?? 0), 0);
const guardStops = trusted.reduce((a, r) => a + (r.loopStops?.length ?? 0), 0);
const cached = trusted.reduce((a, r) => a + (r.usage?.cacheHitTokens ?? 0), 0);
const blocked = trusted.reduce((a, r) => a + (r.blockedOutsideAttempts ?? 0), 0);

console.log(
  `\n算数的那部分：通过 ${passed} / ${trusted.length}` +
    `（${trusted.length > 0 ? Math.round((passed / trusted.length) * 100) : 0}%）` +
    `，合计 ${fmt(tokens)} token（缓存命中 ${fmt(cached)}）、${min(ms)} 分钟`,
);
console.log(`停滞守卫在真机上停下的次数：${guardStops}（0 = 没有误杀；能不能拦由 src/test/stall-guard-loop-behavior.test.ts 那几条变异判据保证）`);
console.log(`被沙箱拦下的「碰工作区之外」尝试：${blocked} 次`);

if (excluded.length > 0) {
  console.log(`\n**不算数**的 ${excluded.length} 条（口径见交接单 §11/§12）：`);
  for (const r of excluded) {
    const why = [];
    if (isVacuousPass(r)) why.push("**通过但零改动** ⇒ 任务退化（bug 没造出来），不算真通过");
    if (r.contaminated) why.push(`污染 ${r.outsideWorkspaceCalls?.length ?? "?"} 次（碰了主仓库）`);
    if (r.contaminated === undefined) why.push("没有污染检测字段（早于该口径）");
    if (r.outcome === "errored") why.push(`跑挂：${r.error ?? "?"}`);
    console.log(`  ${String(r.caseId).padEnd(34)} ${String(r.outcome).padEnd(8)} ${why.join("；")}`);
  }
  if (!showAll) console.log("（加 --all 会连同它们的明细一起列出）");
}

if (showAll) {
  console.log("\n全部记录明细：");
  for (const r of records) {
    console.log(
      `  ${String(r.caseId).padEnd(34)} ${String(r.outcome).padEnd(8)} iter=${r.maxIteration ?? "?"} ` +
        `tok=${fmt(r.usage?.totalTokens)} loop_stops=${r.loopStops?.length ?? "?"} contaminated=${r.contaminated} sess=${r.session ?? "-"}`,
    );
  }
}

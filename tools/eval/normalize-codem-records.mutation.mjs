/**
 * `normalize-codem-records.mjs` 的**变异自证**（第 106 波）。
 *
 * 自测全绿**不算证据**：要证明它是"活的尺子"，必须把每一处关键判断逐个改坏，
 * 看自测是否**真的**变红。改坏哪个用例、为什么这条变异必须被咬住，写在每条 `why` 里。
 *
 * 用法：node tools/eval/normalize-codem-records.mutation.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "normalize-codem-records.mjs");
const selftest = join(here, "normalize-codem-records.selftest.mjs");
const original = readFileSync(target, "utf8");

/** 每条变异：一段原文 → 坏版本；并说明为什么**必须**被咬住 */
const mutations = [
  {
    id: "M1",
    discipline: "口径一致（输入 token 要取未缓存输入）",
    from: "    inputTokens: num(usage.uncachedInputTokens),",
    to: "    inputTokens: num(usage.promptTokens),",
    why: "promptTokens 里**含缓存读**，与对照臂的 inputTokens 口径不同 —— 混用会让两侧的输入量不可比。",
  },
  {
    id: "M2",
    discipline: "纪律 1（缺数据不等于 0）",
    from: "  const num = (value) => (typeof value === \"number\" && Number.isFinite(value) ? value : undefined);",
    to: "  const num = (value) => (typeof value === \"number\" && Number.isFinite(value) ? value : 0);",
    why: "把「没上报」当 0：缺 token 数据会看起来像「用了 0」—— 尺子最容易骗人的地方。",
  },
  {
    id: "M3",
    discipline: "纪律 2（运行号不许猜）",
    from: "  const missing = REQUIRED_FIELDS.filter((field) => record?.[field] === undefined || record?.[field] === null);",
    to: "  const missing = REQUIRED_FIELDS.filter((field) => field !== \"runNumber\" && (record?.[field] === undefined || record?.[field] === null));",
    why: "放行缺失的 runNumber，就只能按出现顺序猜 —— 猜错会把两次真实重复误判成一对矛盾数据，进而阻塞整份报告。",
  },
  {
    id: "M4",
    discipline: "污染必须原样带过去",
    from: "    contaminated: Boolean(record.contaminated),",
    to: "    contaminated: false,",
    why: "把污染标记抹平，脏数据（读过答案仓库的运行）就会混进结论。",
  },
  {
    id: "M5",
    discipline: "地基（同模型才可比）",
    from: "  if (controlModels[0] !== treatmentModels[0]) {",
    to: "  if (false) {",
    why: "不再检查模型是否相同：不同模型下的分数差会被误归因到产品。",
  },
];

console.log("normalize-codem-records 变异自证");

function runSelftest() {
  try {
    execFileSync(process.execPath, [selftest], { stdio: "pipe", encoding: "utf8" });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

// 先确认基线是绿的（否则"变红"没有意义）
const baseline = runSelftest();
if (!baseline.ok) {
  console.log("  基线就是红的 —— 先修自测，变异自证没有意义");
  writeFileSync(target, original);
  process.exit(1);
}
console.log("  基线：绿");

let survived = 0;
try {
  for (const mutation of mutations) {
    if (!original.includes(mutation.from)) {
      console.log(`  ✗ ${mutation.id} 变异锚点没命中（判据可能已被改动）—— 这条变异没有意义`);
      survived++;
      continue;
    }
    writeFileSync(target, original.replace(mutation.from, mutation.to));
    const result = runSelftest();
    if (result.ok) {
      console.log(`  ✗ ${mutation.id} 仍然全绿 —— 这条变异**没被咬住**（${mutation.discipline}）`);
      console.log(`      ${mutation.why}`);
      survived++;
    } else {
      console.log(`  ✓ ${mutation.id} 被咬住（${mutation.discipline}）`);
    }
  }
} finally {
  writeFileSync(target, original);
}

console.log(survived === 0 ? "\n全部变异都被咬住 ✅" : `\n有 ${survived} 条变异存活 ❌`);
process.exit(survived === 0 ? 0 : 1);

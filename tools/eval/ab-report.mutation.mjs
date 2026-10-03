/**
 * `ab-report.mjs` 的**变异自证**（第 109 波）。
 *
 * 自测全绿不算证据：必须把每一处"防自欺"的判断逐个改坏，看自测是否**真的**变红。
 *
 * 用法：node tools/eval/ab-report.mutation.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "ab-report.mjs");
const selftest = join(here, "ab-report.selftest.mjs");
const original = readFileSync(target, "utf8");

const mutations = [
  {
    id: "M1",
    discipline: "变坏必须与变好一样被报出来",
    from: "    else if (base.outcome === \"passed\" && cand.outcome === \"failed\") regressed.push({ base, cand });",
    to: "    else if (false) regressed.push({ base, cand });",
    why: "把「变坏」这一支删掉：报告就只会说好话，读者看不到回归 —— 这是 A/B 里最常见的自欺。",
  },
  {
    id: "M2",
    discipline: "配对不足必须拒绝下结论",
    from: "  if (pairs < minTasks) flags.push(\"insufficient-coverage\");",
    to: "  if (false) flags.push(\"insufficient-coverage\");",
    why: "去掉覆盖不足的旗，2 个任务的差值也会被当成「改动有效」。",
  },
  {
    id: "M3",
    discipline: "runNumber 必须对齐",
    from: "  const key = (r) => `${r.caseId}\\u0000${r.runNumber}`;",
    to: "  const key = (r) => `${r.caseId}`;",
    why: "key 里去掉运行号：拿 run-2 比 run-1 会被当成同一对，差异里混进同任务重复的抖动。",
  },
  {
    id: "M4",
    discipline: "污染 / 零改动通过一律剔除（且「挪位」记录不进报告）",
    /**
     * 第 117 波：锚点跟着实现更新。
     *
     * 这条变异原先只从 `usable()` 里删掉"污染 / 零改动通过"两个条件；
     * 我给同一个过滤函数加上了"排除 parkedFrom / runNumber ≥ 900 的挪位记录"之后，
     * 原文不再匹配 ⇒ 变异**空转**（脚本会如实报"锚点没命中"，这正是在提醒我更新它）。
     */
    from: '        (r.outcome === "passed" || r.outcome === "failed") &&\n        !r.contaminated &&\n        !r.suspiciousNoDiffPass &&',
    to: '        (r.outcome === "passed" || r.outcome === "failed") &&',
    why: "不再剔除脏数据：污染运行与「零改动通过」都会被算进通过率（挪位记录同样失去保护）。",
  },
  {
    id: "M5",
    discipline: "通过率的分母是「可评分的运行」",
    from: "    const scored = usable(rows);\n    if (scored.length === 0) return null;\n    return scored.filter((r) => r.outcome === \"passed\").length / scored.length;",
    to: "    const scored = rows;\n    if (scored.length === 0) return null;\n    return scored.filter((r) => r.outcome === \"passed\").length / scored.length;",
    why: "分母改成「全部运行」：未评分/被剔除的运行会把通过率稀释成看起来更低的数（或反之）。",
  },
];

console.log("ab-report 变异自证");

function runSelftest() {
  try {
    execFileSync(process.execPath, [selftest], { stdio: "pipe", encoding: "utf8" });
    return { ok: true };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

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
      console.log(`  ✗ ${mutation.id} 变异锚点没命中（判据或实现已改）—— 这条变异没有意义`);
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

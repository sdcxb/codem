/**
 * 变异自证：把 `paired-report.mjs` 的**关键那一行**逐条改坏，
 * 确认自测**变红**，再还原。
 *
 * 这不是可选的仪式 —— 项目规矩是「没变红的判据视为没有覆盖」。
 * 每条变异都写明：改哪一行、期望哪条断言变红、实际结果。
 *
 * 用法：node tools/eval/paired-report.mutation.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "paired-report.mjs");
const selftest = join(here, "paired-report.selftest.mjs");
const original = readFileSync(target, "utf8");

/** 每条变异：找一段原文、换成坏版本、并说明为什么这条变异**必须**咬住。 */
const mutations = [
  {
    id: "M1",
    discipline: "纪律 1（缺数据不等于 0）",
    from: "  return typeof value === \"number\" && Number.isFinite(value) ? value : undefined;",
    to: "  return typeof value === \"number\" && Number.isFinite(value) ? value : 0;",
    why: "把「没上报」当成 0 —— 这正是尺子最容易骗人的地方（缺数据被当成「用了 0 个 token」，于是我方看起来更省）。",
  },
  {
    id: "M2",
    discipline: "纪律 1（空平均不等于 0）",
    from: "  if (values.length === 0) return null;",
    to: "  if (values.length === 0) return 0;",
    why: "空集合的平均写 0，会让「一对都没有」看起来像「差值是 0 = 一样好」。",
  },
  {
    id: "M3",
    discipline: "纪律 2（成对样本不足就拒绝给结论）",
    from: "  const publishHeadline = blockedPairs.length === 0 && pairs.length > 0;",
    to: "  const publishHeadline = pairs.length > 0;",
    why: "去掉阻塞检查 —— 只要有一对能用就发布头部通过率，这是最典型的过度声称。",
  },
  {
    id: "M4",
    discipline: "纪律 3（一次重复不足以说明稳定性）",
    from: "  if (typeof runsPerCase === \"number\" && runsPerCase < 2) flags.push(\"insufficient-repetition\");",
    to: "  if (false) flags.push(\"insufficient-repetition\");",
    why: "去掉重复次数检查，让「跑一次就下结论」畅通无阻。",
  },
  {
    id: "M5",
    discipline: "符号约定（正值 = 我方更贵）",
    from: "    meanDelta = treatmentMean - controlMean;",
    to: "    meanDelta = controlMean - treatmentMean;",
    why: "把差值方向搞反，会让「我方更贵」被读成「我方更省」—— 结论完全颠倒。",
  },
];

console.log("paired-report 变异自证");

function runSelftest() {
  try {
    execFileSync(process.execPath, [selftest], { stdio: "pipe", encoding: "utf8" });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

// 先确认基线是绿的（否则下面的"变红"没有意义）。
const baseline = runSelftest();
if (!baseline.ok) {
  console.log("  基线就是红的 —— 先修自测，变异自证没有意义");
  writeFileSync(target, original);
  process.exitCode = 1;
  process.exit();
}
console.log("  基线：绿");

let caught = 0;
const missed = [];

for (const mutation of mutations) {
  if (!original.includes(mutation.from)) {
    missed.push({ ...mutation, reason: "变异没应用成功（找不到原文）" });
    console.log(`  ${mutation.id} ✗ ${mutation.discipline} —— 变异没应用成功（找不到原文），这条不算咬住`);
    continue;
  }
  writeFileSync(target, original.replace(mutation.from, mutation.to));
  const result = runSelftest();
  writeFileSync(target, original);
  if (result.ok) {
    missed.push({ ...mutation, reason: "变异后仍然全绿" });
    console.log(`  ${mutation.id} ✗ ${mutation.discipline} —— 改坏了却照样全绿 ⇒ 自测没有覆盖它`);
  } else {
    caught++;
    const firstFail = result.output
      .split("\n")
      .find((line) => line.trim().startsWith("FAIL"));
    console.log(`  ${mutation.id} ✓ ${mutation.discipline} —— 变红：${(firstFail ?? "").trim()}`);
  }
}

// 还原后必须回到绿。
const restored = runSelftest();
if (!restored.ok) {
  console.log("  还原失败：文件没有回到绿色状态");
  writeFileSync(target, original);
  process.exitCode = 1;
  process.exit();
}
console.log(`  还原：绿`);

console.log("");
if (missed.length === 0) {
  console.log(`变异自证：${caught}/${mutations.length} 全部咬住`);
  process.exitCode = 0;
} else {
  console.log(`变异自证：${caught}/${mutations.length} 咬住，${missed.length} 没咬住`);
  for (const item of missed) console.log(`  - ${item.id} ${item.discipline}: ${item.reason}`);
  process.exitCode = 1;
}

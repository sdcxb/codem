/**
 * 评测链路的**变异自证** —— 证明 `pipeline.selftest.mjs` 真的会红。
 *
 * 这不是仪式：一个"评测器"的自测如果不会红，那它就不是判据，只是装饰。
 * 逐条改坏关键那一行，确认自测**变红**，再还原。
 *
 * 用法：node tools/eval/pipeline.mutation.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(HERE, "tasks.mjs");
const RUN_ARM = join(HERE, "run-arm.mjs");
const SELFTEST = join(HERE, "pipeline.selftest.mjs");

const originals = new Map([
  [TASKS, readFileSync(TASKS, "utf8")],
  [RUN_ARM, readFileSync(RUN_ARM, "utf8")],
]);

/**
 * 每条变异：改哪个文件、把什么换成什么、为什么这条变异**必须**咬住。
 */
const mutations = [
  {
    id: "M1",
    file: TASKS,
    label: "判据不再区分对错（把 read-01 的判据换成恒成功）",
    from: 'grade: "node verify-answer.mjs",',
    to: 'grade: "node --version",',
    why:
      "把判据换成一条永远成功的命令之后，「什么都不做的臂必须全红」就不再成立。" +
      "这正是最危险的一类假绿：任务集看起来在测东西，其实什么都没测。",
  },
  {
    id: "M2",
    file: TASKS,
    label: "覆盖口径不成立（把唯一一个「读代码」任务改成别的类别）",
    from: 'category: "读代码",',
    to: 'category: "改小 bug",',
    why: "六个覆盖口径少一个，任务集就不再覆盖它承诺的范围 —— 覆盖声明必须是判据而不是口号。",
  },
  {
    id: "M3",
    file: RUN_ARM,
    label: "把「没上报用量」填成 0",
    from: "  if (!existsSync(file)) return undefined; // 关键：不填 0",
    to: "  if (!existsSync(file)) return { totalTokens: 0 };",
    why:
      "「缺数据」被当成 0 之后，没上报用量的那一侧会看起来像「只用了 0 个 token」——" +
      "这把尺子存在的全部意义就是防这一件事。",
  },
  {
    id: "M4",
    file: RUN_ARM,
    label: "把「没跑起来」当成「跑了没做对」",
    from: '      outcome = "errored";\n      failureReason = "agent 命令超时";',
    to: '      outcome = "failed";\n      failureReason = "agent 命令超时";',
    why: "errored 被并进 failed 会污染通过率（超时的任务会被算成「模型做错了」）。",
  },
];

function restoreAll() {
  for (const [file, text] of originals) writeFileSync(file, text);
}

function runSelftest() {
  try {
    execFileSync(process.execPath, [SELFTEST], { stdio: "pipe", encoding: "utf8" });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

console.log("评测链路 变异自证");

const baseline = runSelftest();
if (!baseline.ok) {
  console.log("  基线就是红的 —— 先修自测，变异自证没有意义");
  restoreAll();
  process.exitCode = 1;
  process.exit();
}
console.log("  基线：绿");

let caught = 0;
const missed = [];

for (const mutation of mutations) {
  const original = originals.get(mutation.file);
  if (!original.includes(mutation.from)) {
    missed.push({ ...mutation, reason: "变异没应用成功（找不到原文）" });
    console.log(`  ${mutation.id} ✗ ${mutation.label} —— 变异没应用成功，这条不算咬住`);
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
  const result = runSelftest();
  restoreAll();
  if (result.ok) {
    missed.push({ ...mutation, reason: "变异后仍然全绿" });
    console.log(`  ${mutation.id} ✗ ${mutation.label} —— 改坏了却照样全绿 ⇒ 自测没有覆盖它`);
  } else {
    caught++;
    const firstFail = result.output
      .split("\n")
      // ⚠️ 必须用 startsWith("FAIL")，不能用 includes("FAIL")：
      // 通过行的文案里就有「必须 FAILED」这种字样，includes 会匹配到**通过**的那一行，
      // 于是变异记录指向一条绿线 —— 一份会误导人的记录比没有记录更糟。
      .find((line) => line.trim().startsWith("FAIL"));
    const detail = firstFail
      ? firstFail.trim()
      : result.output.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
    console.log(`  ${mutation.id} ✓ ${mutation.label} —— 变红：${detail.trim()}`);
  }
}

const restored = runSelftest();
if (!restored.ok) {
  console.log("  还原失败：文件没有回到绿色状态");
  restoreAll();
  process.exitCode = 1;
  process.exit();
}
console.log("  还原：绿");

console.log("");
if (missed.length === 0) {
  console.log(`变异自证：${caught}/${mutations.length} 全部咬住`);
  process.exitCode = 0;
} else {
  console.log(`变异自证：${caught}/${mutations.length} 咬住，${missed.length} 没咬住`);
  for (const item of missed) console.log(`  - ${item.id} ${item.label}: ${item.reason}`);
  process.exitCode = 1;
}

/**
 * 评测链路自测 —— 证明这把尺子**真的会区分对错**，而不是一个恒绿的装饰。
 *
 * ## 为什么要专门证明这件事
 *
 * 本仓库的核心规矩：**没变红的判据视为没有覆盖**。这条规矩对"评测器"本身同样适用 ——
 * 一个判据如果对「什么都不做」和「做对了」给出同一个结果，那它的所有数字都是假的。
 * 所以这里跑两个桩臂，**必须一个全红、一个全绿**：
 *
 *   control   = `stubs/noop-agent.mjs`       什么都不做 ⇒ 每个任务都必须 FAILED
 *   treatment = `stubs/reference-solver.mjs` 抄参考解   ⇒ 每个任务都必须 PASSED
 *
 * ## 这两条臂的数字**不是**"我方水平"
 *
 * 桩臂不需要理解任务，它们只验证**链路**：环境变量有没有传进去、工作区对不对、
 * 判据亮不亮、用量文件回得来吗、记录合不合法、成对报告算不算得对。
 * 真正跑 DSH 与 Codem 要各自接一个 driver（见 docs/MEASUREMENT-PLAN-DSH-VS-CODEM.md）。
 *
 * ## 顺带钉住的四条纪律
 *
 * 1. **判据会区分对错**（上面那对全红/全绿）。
 * 2. **"没上报用量" ≠ "用量是 0"**：不写 `.arm-usage.json` 时记录里**根本没有** token 字段，
 *    成对指标报 `eligiblePairs = 0 / meanDelta = null`，渲染写 `n/a`，`verdict` **拒绝下结论**。
 * 3. **"没跑起来" ≠ "跑了没做对"**：agent 命令被杀 ⇒ `errored`，通过率算 `null` 而不是 0。
 * 4. **记录是逐行 JSON**，`--report` 能直接读。
 *
 * 用法：node tools/eval/pipeline.selftest.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TASKS, CATEGORIES, validateTaskSet } from "./tasks.mjs";
import { summarize, verdict, render } from "./paired-report.mjs";
import { runOneTask } from "./run-arm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOOP = join(HERE, "stubs", "noop-agent.mjs");
const REFERENCE = join(HERE, "stubs", "reference-solver.mjs");
const MODEL = "stub-model";

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) });
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * 尽力清理工作区。
 *
 * ⚠️ 这里**故意容忍 EPERM**，而且这不是偷懒 —— 它本身就是一条观察：
 * Windows 上 `shell: true` 时，子进程是 **shell**；超时把 shell 杀掉之后，
 * 被 shell 启起来的真正子进程**可能还活着**，继续占着工作目录，
 * 于是 `rmSync` 报 `EPERM`。这与产品里 D4 那条「超时只放弃等待、不杀进程树」是**同一个形状**
 * （见 docs/DSH-ALIGNMENT-FIX-PLAN.md 的 D4）。
 * 对自测来说，留一个临时目录不影响结论，**但不能让清理的失败伪装成被测逻辑的失败** ——
 * 交接单 §11.5 记过这个坑（"清理代码把自己的失败伪装成了被测代码的失败"）。
 */
function cleanup(ws) {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch (error) {
    console.log(`       （工作区暂时删不掉，已忽略：${error?.code ?? error?.message ?? error}）`);
  }
}

/** 跑一条臂：**真实走 `--agent-cmd` 那条路**（不是直接把文件抄进去），逐任务过判据。 */
function runArm(arm, agentCmd, { runNumber = 1, emitUsage = true, tasks = TASKS } = {}) {
  const records = [];
  const outcomes = new Map();
  const previous = process.env.EVAL_EMIT_USAGE;
  process.env.EVAL_EMIT_USAGE = emitUsage ? "1" : "0";
  try {
    for (const task of tasks) {
      const ws = mkdtempSync(join(tmpdir(), `codem-eval-selftest-${arm}-`));
      try {
        for (const [rel, content] of Object.entries(task.files)) {
          const target = join(ws, rel);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content, "utf8");
        }
        const { record } = runOneTask({ ws, task, arm, model: MODEL, runNumber }, { agentCmd, evalSet: "selftest" });
        records.push(record);
        outcomes.set(task.id, record.outcome);
      } finally {
        if (existsSync(ws)) cleanup(ws);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.EVAL_EMIT_USAGE;
    else process.env.EVAL_EMIT_USAGE = previous;
  }
  return { records, outcomes };
}

const NOOP_CMD = `"${process.execPath}" "${NOOP}"`;
const REFERENCE_CMD = `"${process.execPath}" "${REFERENCE}"`;

console.log("评测链路自测");

// ---------------------------------------------------------------- 任务集自身
check("任务集：字段齐全、id 不重复、六个覆盖口径都有任务", () => {
  const problems = validateTaskSet();
  assert(problems.length === 0, `任务集有问题：\n       ${problems.join("\n       ")}`);
  assert(TASKS.length >= 10, `任务数 ${TASKS.length} 太少（用户口径 10–20）`);
  const covered = new Set(TASKS.map((t) => t.category));
  for (const c of CATEGORIES) assert(covered.has(c), `类别「${c}」没有任务`);
});

check("任务集：每个任务都带参考解（否则没法证明判据会区分对错）", () => {
  const missing = TASKS.filter((t) => !t.reference || Object.keys(t.reference).length === 0).map((t) => t.id);
  assert(missing.length === 0, `没有参考解：${missing.join(", ")}`);
});

console.log("");
console.log("跑桩臂（真实走 --agent-cmd 那条路）…");
const control = runArm("control", NOOP_CMD, { emitUsage: true });
const treatment = runArm("treatment", REFERENCE_CMD, { emitUsage: true });
console.log(`  control   失败 ${[...control.outcomes.values()].filter((o) => o === "failed").length}/${TASKS.length}`);
console.log(`  treatment 通过 ${[...treatment.outcomes.values()].filter((o) => o === "passed").length}/${TASKS.length}`);
console.log("");

// ---------------------------------------------------------------- 纪律 1
check("纪律1（判据会区分对错）：什么都不做的臂，每个任务都必须 FAILED", () => {
  const notFailed = [...control.outcomes.entries()].filter(([, o]) => o !== "failed");
  assert(
    notFailed.length === 0,
    `这些任务在「什么都不做」的臂上没有失败 ⇒ 判据是假的：\n       ${notFailed
      .map(([id, o]) => `${id}=${o}`)
      .join("\n       ")}`,
  );
});

check("纪律1（判据会区分对错）：抄参考解的臂，每个任务都必须 PASSED", () => {
  const notPassed = [...treatment.outcomes.entries()].filter(([, o]) => o !== "passed");
  assert(
    notPassed.length === 0,
    `这些任务在「正确解」的臂上没有通过 ⇒ 判据写错了：\n       ${notPassed
      .map(([id, o]) => `${id}=${o}`)
      .join("\n       ")}`,
  );
});

// ---------------------------------------------------------------- 成对报告
check("成对报告：通过率 0 → 1，lift = 1.0，成对完整时允许发布头部结论", () => {
  const report = summarize([...control.records, ...treatment.records], { runsPerCase: 2 });
  assert(report.controlPassRate === 0, `control 通过率应为 0，实际 ${report.controlPassRate}`);
  assert(report.treatmentPassRate === 1, `treatment 通过率应为 1，实际 ${report.treatmentPassRate}`);
  assert(report.lift === 1, `lift 应为 1，实际 ${report.lift}`);
  assert(report.publishHeadline === true, `成对完整时应允许发布，flags=${report.flags.join(",")}`);
  assert(report.eligiblePairs === TASKS.length, `应有 ${TASKS.length} 对，实际 ${report.eligiblePairs}`);
});

check("成对报告：两侧都上报用量时 token 指标可用，方向正确", () => {
  // noop 桩 1050 token、reference 桩 4200 token ⇒ treatment 更贵 ⇒ 差值应为正。
  const report = summarize([...control.records, ...treatment.records], { runsPerCase: 2 });
  const metric = report.metrics.totalTokens;
  assert(metric.eligiblePairs === TASKS.length, `token 可用对应为 ${TASKS.length}，实际 ${metric.eligiblePairs}`);
  assert(metric.meanDelta !== null, "token 均值差不应为 null");
  assert(metric.meanDelta > 0, `reference 桩用了更多 token，差值应为正，实际 ${metric.meanDelta}`);
});

// ---------------------------------------------------------------- 纪律 2
check("纪律2（没上报用量 ≠ 0）：不写用量文件时记录里**根本没有** token 字段", () => {
  const noUsage = runArm("treatment", REFERENCE_CMD, { emitUsage: false, tasks: TASKS.slice(0, 3) });
  for (const record of noUsage.records) {
    assert(!("totalTokens" in record), `${record.caseId} 出现了 totalTokens=${record.totalTokens} —— 没上报就该没有这个键`);
    assert(!("inputTokens" in record), `${record.caseId} 出现了 inputTokens`);
  }
});

check("纪律2：计量没接通时，即使水平 lift = 1.0，verdict 也必须**拒绝**下结论", () => {
  const treatmentNoUsage = runArm("treatment", REFERENCE_CMD, { emitUsage: false });
  const controlNoUsage = runArm("control", NOOP_CMD, { emitUsage: false });
  const report = summarize([...controlNoUsage.records, ...treatmentNoUsage.records], { runsPerCase: 2 });
  assert(report.lift === 1, `水平上确实是 1.0 的提升，实际 ${report.lift}`);
  const conclusion = verdict(report);
  assert(conclusion.conclusive === false, "没有任何 token 数据却给出了结论 —— 这正是「拿假数对比实测」的入口");
  assert(/计量/.test(conclusion.reason), `拒绝的理由应指向计量链路，实际「${conclusion.reason}」`);
});

check("纪律2：一侧缺用量的对，该指标报 eligiblePairs=0 / meanDelta=null，渲染写 n/a", () => {
  const treatmentNoUsage = runArm("treatment", REFERENCE_CMD, { emitUsage: false, tasks: TASKS.slice(0, 3) });
  const report = summarize([...control.records.slice(0, 3), ...treatmentNoUsage.records], { runsPerCase: 2 });
  const metric = report.metrics.totalTokens;
  assert(metric.eligiblePairs === 0, `应为 0 对可用，实际 ${metric.eligiblePairs}`);
  assert(metric.meanDelta === null, `meanDelta 应为 null（不是 0），实际 ${metric.meanDelta}`);
  assert(render(report).includes("n/a"), "渲染里应写 n/a，而不是把缺数据写成 0");
});

// ---------------------------------------------------------------- 纪律 3
check("纪律3（没跑起来 ≠ 跑错了）：agent 命令跑超时 ⇒ errored，通过率算 null 而不是 0", () => {
  const ws = mkdtempSync(join(tmpdir(), "codem-eval-selftest-errored-"));
  try {
    const task = TASKS[0];
    for (const [rel, content] of Object.entries(task.files)) {
      const target = join(ws, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    // 睡 5 秒但只给 700ms 的预算 ⇒ 必然超时被杀。
    // ⚠️ 第一版用 `process.kill(process.pid,'SIGTERM')` 造这一条，实测**不成立**：
    // `shell: true` 时直接子进程是 shell，它被杀掉后自己返回一个非零退出码，
    // `spawnSync.status` 不是 null，于是走到了"判据失败"而不是"没跑起来"。
    // 所以这里改成**真的超时** —— 这才是要验的那条路径。
    const { record } = runOneTask(
      { ws, task, arm: "control", model: MODEL, runNumber: 1 },
      {
        agentCmd: `"${process.execPath}" -e "setTimeout(()=>{},5000)"`,
        evalSet: "selftest",
        agentTimeoutMs: 700,
      },
    );
    assert(record.outcome === "errored", `应记 errored，实际 ${record.outcome}（${record.failureReason ?? "-"}）`);
    const report = summarize([record], { runsPerCase: 2 });
    assert(report.controlPassRate === null, `只有 errored 时通过率应为 null（不是 0），实际 ${report.controlPassRate}`);
  } finally {
    if (existsSync(ws)) cleanup(ws);
  }
});

// ---------------------------------------------------------------- 记录形态
check("纪律4：记录是逐行 JSON，且带上 --report 需要的全部字段", () => {
  const lines = [...control.records, ...treatment.records].map((r) => JSON.stringify(r));
  assert(lines.length > 0, "没有记录");
  for (const line of lines) {
    const parsed = JSON.parse(line);
    for (const field of ["evalSet", "caseId", "model", "arm", "runNumber", "outcome"]) {
      assert(parsed[field] !== undefined, `记录缺字段 ${field}：${line}`);
    }
  }
});

console.log("");
if (failures.length === 0) {
  console.log(`评测链路自测：${passed}/${passed} 通过`);
  process.exitCode = 0;
} else {
  console.log(`评测链路自测：${passed} 通过，${failures.length} 失败`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exitCode = 1;
}

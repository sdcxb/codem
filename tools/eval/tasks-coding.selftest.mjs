/**
 * 第二档（编码档）任务集的**自证** —— 与第一档同一套纪律：
 * 一个判据如果对「什么都不做」和「做对了」给出同样结果，它的所有数字都是假的。
 *
 *   control   = stubs/noop-agent.mjs        ⇒ 每个任务都必须 FAILED
 *   treatment = stubs/reference-solver.mjs  ⇒ 每个任务都必须 PASSED
 *
 * ⚠️ 与第一档不同：这一档**刻意**不求覆盖六个口径，它求的是"能区分编码水平"。
 * 所以这里额外断言一件事：**参考解不是"抄一遍就过"** —— 每个任务的初始文件必须真的失败
 * （由 noop 臂逐条钉住），否则这个任务在测空气（第一档第一版就栽在这上面）。
 *
 * 用法：node tools/eval/tasks-coding.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TASKS, validateTaskSet } from "./tasks-coding.mjs";
import { summarize } from "./paired-report.mjs";
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
function cleanup(ws) {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch (error) {
    console.log(`       （工作区暂时删不掉，已忽略：${error?.code ?? error}）`);
  }
}

function runArm(arm, agentCmd, tasks = TASKS) {
  const outcomes = new Map();
  for (const task of tasks) {
    const ws = mkdtempSync(join(tmpdir(), `codem-eval-coding-${arm}-`));
    try {
      for (const [rel, content] of Object.entries(task.files)) {
        const target = join(ws, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
      }
      const { record } = runOneTask({ ws, task, arm, model: MODEL, runNumber: 1 }, { agentCmd, evalSet: "coding-tier2" });
      outcomes.set(task.id, record.outcome);
    } finally {
      if (existsSync(ws)) cleanup(ws);
    }
  }
  return outcomes;
}

const NOOP_CMD = `"${process.execPath}" "${NOOP}"`;
const REFERENCE_CMD = `"${process.execPath}" "${REFERENCE}"`;

console.log("编码档任务集 自证");
console.log(`任务数：${TASKS.length}`);

check("任务集：字段齐全、id 不重复、至少覆盖 4 个口径、每个都有参考解", () => {
  const problems = validateTaskSet();
  assert(problems.length === 0, `任务集有问题：\n       ${problems.join("\n       ")}`);
});

console.log("");
console.log("跑桩臂…");
const noop = runArm("control", NOOP_CMD);
const ref = runArm("treatment", REFERENCE_CMD);
console.log(`  noop      失败 ${[...noop.values()].filter((o) => o === "failed").length}/${TASKS.length}`);
console.log(`  reference 通过 ${[...ref.values()].filter((o) => o === "passed").length}/${TASKS.length}`);
console.log("");

check("判据会区分对错：什么都不做的臂，每个任务都必须 FAILED（否则这个任务在测空气）", () => {
  const bad = [...noop.entries()].filter(([, o]) => o !== "failed");
  assert(
    bad.length === 0,
    `这些任务"什么都不做"也能过 ⇒ 判据是假的：\n       ${bad.map(([id, o]) => `${id}=${o}`).join("\n       ")}`,
  );
});

check("判据会区分对错：抄参考解的臂，每个任务都必须 PASSED（否则判据写错了）", () => {
  const bad = [...ref.entries()].filter(([, o]) => o !== "passed");
  assert(
    bad.length === 0,
    `这些任务在正确解上没过 ⇒ 判据写错了：\n       ${bad.map(([id, o]) => `${id}=${o}`).join("\n       ")}`,
  );
});

check("每个任务都至少动过一个文件才算有区分度（参考解非空）", () => {
  const empty = TASKS.filter((t) => Object.keys(t.reference ?? {}).length === 0).map((t) => t.id);
  assert(empty.length === 0, `参考解为空：${empty.join(", ")}`);
});

check("提示里不许泄露参考解（不许出现改完之后的代码片段）", () => {
  // 粗判：prompt 里不该出现 reference 里的多行代码块特征（比如 structuredClone / mapLimit 的实现片段）
  const suspicious = [];
  for (const task of TASKS) {
    for (const [, code] of Object.entries(task.reference ?? {})) {
      const lines = String(code).split("\n").map((l) => l.trim()).filter((l) => l.length > 30 && !l.startsWith("*") && !l.startsWith("//"));
      for (const line of lines.slice(0, 2)) {
        if (task.prompt.includes(line)) suspicious.push(`${task.id}: 「${line.slice(0, 50)}…」`);
      }
    }
  }
  assert(suspicious.length === 0, `提示里疑似泄露了解法：\n       ${suspicious.join("\n       ")}`);
});

console.log("");
if (failures.length === 0) {
  console.log(`编码档任务集 自证：${passed}/${passed} 通过`);
  process.exitCode = 0;
} else {
  console.log(`编码档任务集 自证：${passed} 通过，${failures.length} 失败`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
void summarize;

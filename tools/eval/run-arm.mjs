/**
 * 跑一条臂（arm）在冻结任务集上的表现，产出 `paired-report.mjs` 能直接吃的记录。
 *
 * ## 用法
 *
 *   node tools/eval/run-arm.mjs --arm control  --agent-cmd "<命令>" --model <名字>
 *   node tools/eval/run-arm.mjs --arm treatment --agent-cmd "<命令>" --model <名字>
 *   node tools/eval/run-arm.mjs --report                 # 读记录并出成对报告
 *
 * ## agent 命令的契约（这是整条链路的关键接口）
 *
 * 命令在**工作区目录**里执行，并拿到这些环境变量：
 *
 *   EVAL_TASK_ID       任务 id
 *   EVAL_TASK_PROMPT   给 agent 的原话（同一份也写进了 <ws>/TASK.md）
 *   EVAL_WORKSPACE     工作区绝对路径（也就是 cwd）
 *   EVAL_MODEL         模型名（两侧必须相同，否则对比没有意义）
 *   EVAL_RUN_NUMBER    第几次重复
 *
 * 命令**可选**地在工作区里写一份 `<ws>/.arm-usage.json`，把这次跑的真实用量交回来：
 *
 *   { "inputTokens": 123, "outputTokens": 45,
 *     "cacheReadTokens": 0, "cacheWriteTokens": 0, "totalTokens": 168,
 *     "toolCalls": 7, "estimatedCostUsd": 0.0012 }
 *
 * ## 为什么"没写 usage"必须与"写了 0"分开
 *
 * 这是这把尺子的**第一纪律**（见 `paired-report.mjs`）：某一侧没上报的指标，
 * 在该对上就是**不可用**，绝不当 0 参与平均 —— 否则"我们用了 0 个 token"会看起来像真的。
 * 所以这里**不填默认值**：文件不存在就整个 `usage` 字段留空（`undefined`）。
 *
 * ## 判据（grade）怎么算
 *
 * 每个任务自带 `grade` 命令，在**工作区里**跑，**退出码 0 = 通过**。
 * 命令本身超时或 agent 命令崩溃 ⇒ 记 `errored`（不是 failed）——
 * 「没跑起来」和「跑了但没做对」是两件事，混起来会污染通过率。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TASKS, validateTaskSet } from "./tasks.mjs";
import { summarize, render, verdict } from "./paired-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "records.jsonl");
const AGENT_TIMEOUT_MS = 20 * 60 * 1000;
const GRADE_TIMEOUT_MS = 5 * 60 * 1000;

function parseArgs(argv) {
  const out = { arms: [], tasks: [], runNumbers: [1], report: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--arm") out.arms.push(next());
    else if (arg === "--agent-cmd") out.agentCmd = next();
    else if (arg === "--model") out.model = next();
    else if (arg === "--eval-set") out.evalSet = next();
    else if (arg === "--task") out.tasks.push(next());
    else if (arg === "--run") out.runNumbers = [Number(next())];
    else if (arg === "--runs") {
      const n = Number(next());
      out.runNumbers = Array.from({ length: n }, (_, i) => i + 1);
    } else if (arg === "--out") out.out = next();
    else if (arg === "--report") out.report = true;
    else if (arg === "--keep") out.keep = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`不认识的参数：${arg}`);
  }
  return out;
}

const USAGE = `用法：
  node tools/eval/run-arm.mjs --arm <名字> --agent-cmd "<命令>" --model <名字> [--task <id>]... [--runs N] [--out 文件]
  node tools/eval/run-arm.mjs --report [--out 文件]

  --arm         这条臂的名字。惯例：control = DSH，treatment = Codem。
  --agent-cmd   在任务工作区里执行的命令（见文件头的环境变量契约）。
  --model       模型名。**两侧必须写同一个**，否则对比不成立。
  --runs N      每个任务重复 N 次（< 2 时报告会标注"一次重复不足以说明稳定性"）。
  --out         记录文件（JSONL），默认 tools/eval/records.jsonl。
  --report      不跑任务，只读记录出成对报告。
  --keep        保留工作区目录（排查用）。
`;

function selectedTasks(args) {
  if (args.tasks.length === 0) return TASKS;
  const wanted = new Set(args.tasks);
  const picked = TASKS.filter((t) => wanted.has(t.id));
  const missing = [...wanted].filter((id) => !TASKS.some((t) => t.id === id));
  if (missing.length > 0) throw new Error(`任务集里没有这些 id：${missing.join(", ")}`);
  return picked;
}

function prepareWorkspace(task, arm, model, runNumber) {
  const ws = mkdtempSync(join(tmpdir(), `codem-eval-${arm}-${task.id}-`));
  for (const [rel, content] of Object.entries(task.files)) {
    const target = join(ws, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  writeFileSync(join(ws, "TASK.md"), `${task.prompt}\n`, "utf8");
  return { ws, task, arm, model, runNumber };
}

/** 把参考解写进工作区（只用于自测里证明判据会区分对错）。 */
export function applyReference(task, ws) {
  for (const [rel, content] of Object.entries(task.reference)) {
    const target = join(ws, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

function readUsage(ws) {
  const file = join(ws, ".arm-usage.json");
  if (!existsSync(file)) return undefined; // 关键：不填 0
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined; // 坏文件同样算"没有上报"，不算 0
  }
}

export function runOneTask(entry, options = {}) {
  const { ws, task, arm, model, runNumber } = entry;
  const evalSet = options.evalSet ?? "coding";
  // 超时可注入：自测要能在毫秒级验证"跑超时 ⇒ errored"这条路径，而不是等 20 分钟。
  const agentTimeoutMs = options.agentTimeoutMs ?? AGENT_TIMEOUT_MS;
  const gradeTimeoutMs = options.gradeTimeoutMs ?? GRADE_TIMEOUT_MS;
  const started = Date.now();
  let outcome = "failed";
  let failureReason = null;
  let agentStatus = null;

  if (options.applyReference) {
    // 自测路径：不跑 agent，直接放参考解，用来验证判据会亮绿。
    applyReference(task, ws);
  } else {
    const result = spawnSync(options.agentCmd, {
      cwd: ws,
      shell: true,
      encoding: "utf8",
      timeout: agentTimeoutMs,
      env: {
        ...process.env,
        EVAL_TASK_ID: task.id,
        EVAL_TASK_PROMPT: task.prompt,
        EVAL_WORKSPACE: ws,
        EVAL_MODEL: model,
        EVAL_RUN_NUMBER: String(runNumber),
        EVAL_ARM: arm,
      },
    });
    if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
      outcome = "errored";
      failureReason = "agent 命令超时";
    } else if (result.status === null) {
      outcome = "errored";
      failureReason = `agent 命令没有正常退出（signal=${result.signal ?? "?"}）`;
    }
    agentStatus = result.status;
  }

  // 判据：退出码 0 = 通过。只在 agent 真的跑起来之后才判。
  if (outcome !== "errored") {
    const grade = spawnSync(task.grade, {
      cwd: ws,
      shell: true,
      encoding: "utf8",
      timeout: gradeTimeoutMs,
    });
    if (grade.error?.code === "ETIMEDOUT" || grade.signal === "SIGTERM") {
      outcome = "errored";
      failureReason = "判据命令超时";
    } else if (grade.status === 0) {
      outcome = "passed";
    } else {
      outcome = "failed";
      failureReason = `判据退出码 ${grade.status}`;
    }
  }

  const usage = readUsage(ws);
  return {
    record: {
      evalSet,
      caseId: task.id,
      model,
      arm,
      runNumber,
      outcome,
      ...(usage ?? {}),
      totalMs: Date.now() - started,
      ...(failureReason ? { failureReason } : {}),
      ...(agentStatus !== null ? { agentExitStatus: agentStatus } : {}),
    },
    failureReason,
  };
}

function appendRecord(out, record) {
  mkdirSync(dirname(out), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  writeFileSync(out, existsSync(out) ? readFileSync(out, "utf8") + line : line, "utf8");
}

function readRecords(out) {
  if (!existsSync(out)) return [];
  return readFileSync(out, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const out = resolve(args.out ?? DEFAULT_OUT);

  if (args.report) {
    const records = readRecords(out);
    if (records.length === 0) {
      console.log(`没有记录可读：${out}`);
      return 1;
    }
    const report = summarize(records, { runsPerCase: args.runNumbers.length });
    process.stdout.write(render(report));
    const conclusion = verdict(report);
    console.log("");
    console.log(conclusion.conclusive ? `可以下结论：${conclusion.reason}` : `还不能下结论：${conclusion.reason}`);
    return 0;
  }

  if (args.arms.length !== 1) throw new Error("必须正好指定一条 --arm");
  if (!args.agentCmd) throw new Error("缺少 --agent-cmd");
  if (!args.model) throw new Error("缺少 --model（两侧必须写同一个模型名，否则对比不成立）");

  const problems = validateTaskSet();
  if (problems.length > 0) throw new Error(`任务集自身有问题：\n  - ${problems.join("\n  - ")}`);

  const arm = args.arms[0];
  const tasks = selectedTasks(args);
  console.log(`臂=${arm} 模型=${args.model} 任务=${tasks.length} 重复=${args.runNumbers.length}`);
  console.log(`记录写入：${out}`);

  let passed = 0;
  let failed = 0;
  let errored = 0;
  for (const task of tasks) {
    for (const runNumber of args.runNumbers) {
      const entry = prepareWorkspace(task, arm, args.model, runNumber);
      const { record, failureReason } = runOneTask(entry, {
        agentCmd: args.agentCmd,
        evalSet: args.evalSet,
      });
      appendRecord(out, record);
      const mark = record.outcome === "passed" ? "✅" : record.outcome === "errored" ? "⚠️" : "❌";
      console.log(`  ${mark} ${task.id} run-${runNumber} ${record.outcome}${failureReason ? ` (${failureReason})` : ""}`);
      if (record.outcome === "passed") passed++;
      else if (record.outcome === "errored") errored++;
      else failed++;
      if (!args.keep) {
        // 尽力清理：超时把 shell 杀掉之后，真正的子进程可能还活着并占着目录（Windows 上是 EPERM）。
        // 留个临时目录不影响结论，但**不能让清理的失败伪装成被测逻辑的失败**（交接单 §11.5 记过这个坑）。
        try {
          rmSync(entry.ws, { recursive: true, force: true });
        } catch (cleanupError) {
          console.log(`     （工作区暂时删不掉，已忽略：${cleanupError?.code ?? cleanupError?.message ?? cleanupError}）`);
        }
      } else {
        console.log(`     工作区保留：${entry.ws}`);
      }
    }
  }
  console.log(`小计：通过 ${passed} / 失败 ${failed} / 出错 ${errored}（出错不计入通过率）`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`run-arm 失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

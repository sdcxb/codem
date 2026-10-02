/**
 * 真实仓库档的执行器。
 *
 * 与 `run-arm.mjs` 的区别只有一个：**工作区的准备方式**。
 *   run-arm  ：临时目录 + 写入任务自带的初始文件（自包含小工程）
 *   本文件   ：`git worktree` 拉一份真实仓库，把**实现**回退到修复前，判据测试保持 HEAD 版本
 *
 * 这样被测量的 agent 面对的是**真实的大代码库**：它得自己找入口、读懂上下文，
 * 而不是在一个 30 行的小文件里改一行。判据是本次会话里已经变异自证过的测试。
 *
 * ## 反作弊
 *
 * 评分前执行 `git checkout HEAD -- <testFiles>`：**把判据文件还原**。
 * 否则 agent 只要把测试改绿就行了 —— 那测的就不是修 bug 的能力。
 *
 * ## 安全
 *
 * · 所有操作都在 `git worktree` 出来的**临时目录**里，绝不动主仓库的工作区。
 * · 清理时先 `rmdir` 掉 `node_modules` 这个 junction（**只删链接，不删目标**），
 *   再 `git worktree remove --force`。顺序反了会尝试遍历整个 node_modules。
 *
 * 用法：
 *   node tools/eval/run-repo-arm.mjs --arm control --model deepseek-flash --runs 1 \
 *     --out .preview-shot/eval-records-repo-control.jsonl \
 *     --agent-cmd "node C:\mimo-gui\tools\eval\drivers\dsh-driver.mjs"
 *   node tools/eval/run-repo-arm.mjs --arm reference --reference      # 自证：应当全绿
 *   node tools/eval/run-repo-arm.mjs --arm noop --agent-cmd "node .../noop-agent.mjs"  # 自证：应当全红
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmdirSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TASKS, REPO_ROOT, validateTaskSet } from "./tasks-repo.mjs";
import { summarize, render, verdict } from "./paired-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const GRADE_TIMEOUT_MS = 10 * 60 * 1000;

function git(args, cwd = REPO_ROOT) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5 * 60 * 1000 });
}

function parseArgs(argv) {
  const out = { arms: [], tasks: [], runNumbers: [1], report: false, reference: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--arm") out.arms.push(next());
    else if (arg === "--agent-cmd") out.agentCmd = next();
    else if (arg === "--model") out.model = next();
    else if (arg === "--eval-set") out.evalSet = next();
    else if (arg === "--task") out.tasks.push(next());
    else if (arg === "--runs") out.runNumbers = Array.from({ length: Number(next()) }, (_, i) => i + 1);
    else if (arg === "--out") out.out = next();
    else if (arg === "--report") out.report = true;
    else if (arg === "--reference") out.reference = true;
    else if (arg === "--keep") out.keep = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`不认识的参数：${arg}`);
  }
  return out;
}

const USAGE = `用法：
  node tools/eval/run-repo-arm.mjs --arm <名字> (--agent-cmd "<命令>" | --reference) --model <名字> [--runs N] [--out 文件]
  node tools/eval/run-repo-arm.mjs --report [--out 文件]

  --reference   自证用：不跑 agent，直接把实现还原成 HEAD（应当全绿）
  --report      只读记录出成对报告
`;

/** 建一个真实仓库的 worktree，并把实现回退到修复前。 */
function prepareRepoWorkspace(task) {
  const ws = mkdtempSync(join(tmpdir(), `codem-eval-repo-${task.id}-`));
  // mkdtemp 建出来的是空目录，worktree add 要它不存在或为空（空可以）
  const add = git(["worktree", "add", "--detach", ws, "HEAD"]);
  if (add.status !== 0) throw new Error(`worktree add 失败：${add.stderr || add.stdout}`);
  // node_modules 用 junction 指回主仓库：不拷、也不改主仓库
  try {
    mkdirSync(join(ws, "node_modules"), { recursive: false });
    rmdirSync(join(ws, "node_modules")); // 立刻删掉，改成 junction
  } catch {
    /* 已存在就跳过 */
  }
  const junction = spawnSync("cmd", ["/c", "mklink", "/J", join(ws, "node_modules"), join(REPO_ROOT, "node_modules")], {
    encoding: "utf8",
  });
  if (junction.status !== 0) throw new Error(`node_modules junction 失败：${junction.stderr || junction.stdout}`);
  return ws;
}

/** 造 bug：把实现文件回退到修复前。 */
function applyBug(task, ws) {
  const r = git(["checkout", task.buggyCommit, "--", ...task.revertPaths], ws);
  if (r.status !== 0) throw new Error(`${task.id}: 回退实现失败：${r.stderr || r.stdout}`);
}

/** 自证用：把实现还原成 HEAD（= 正确解）。 */
function restoreImplementation(task, ws) {
  const r = git(["checkout", "HEAD", "--", ...task.revertPaths], ws);
  if (r.status !== 0) throw new Error(`${task.id}: 还原实现失败：${r.stderr || r.stdout}`);
}

/** 反作弊：判据文件从 HEAD 还原，agent 改测试无效。 */
function restoreTests(task, ws) {
  git(["checkout", "HEAD", "--", ...task.testFiles], ws);
}

function cleanupRepoWorkspace(ws) {
  try {
    rmdirSync(join(ws, "node_modules")); // 只删 junction 链接
  } catch {
    /* 已经不是 junction 就跳过 */
  }
  const r = git(["worktree", "remove", ws, "--force"]);
  if (r.status !== 0) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch (error) {
      console.log(`     （worktree 删不掉，已忽略：${error?.code ?? error}）`);
    }
    git(["worktree", "prune"]);
  }
}

function readUsage(ws) {
  const file = join(ws, ".arm-usage.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function runTask(task, { arm, model, runNumber, agentCmd, reference, evalSet }) {
  const started = Date.now();
  const ws = prepareRepoWorkspace(task);
  let outcome = "failed";
  let failureReason = null;
  let usage;
  try {
    applyBug(task, ws);
    if (reference) {
      restoreImplementation(task, ws);
    } else {
      const r = spawnSync(agentCmd, {
        cwd: ws,
        shell: true,
        encoding: "utf8",
        timeout: AGENT_TIMEOUT_MS,
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
      if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM") {
        outcome = "errored";
        failureReason = "agent 命令超时";
      } else if (r.status === null) {
        outcome = "errored";
        failureReason = `agent 命令没有正常退出（signal=${r.signal ?? "?"}）`;
      }
    }

    if (outcome !== "errored") {
      restoreTests(task, ws); // 反作弊
      const grade = spawnSync(task.grade, { cwd: ws, shell: true, encoding: "utf8", timeout: GRADE_TIMEOUT_MS });
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
  } catch (error) {
    outcome = "errored";
    failureReason = error?.message ?? String(error);
  } finally {
    /**
     * ⚠️ 必须在**删工作区之前**读用量。
     * 第一版把 `readUsage(ws)` 放在 finally 之后 —— 于是 worktree（连同 driver 写的
     * `.arm-usage.json`）已经被删掉，token 全是 undefined。**第一次跑 DSH 的数字就是这么丢的。**
     */
    usage = readUsage(ws);
    cleanupRepoWorkspace(ws);
  }

  return {
    record: {
      evalSet: evalSet ?? "repo",
      caseId: task.id,
      model,
      arm,
      runNumber,
      outcome,
      ...(usage ?? {}),
      totalMs: Date.now() - started,
      ...(failureReason ? { failureReason } : {}),
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
  const out = resolve(args.out ?? join(HERE, "records-repo.jsonl"));

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
  if (!args.reference && !args.agentCmd) throw new Error("缺少 --agent-cmd（或加 --reference 做自证）");
  if (!args.model) throw new Error("缺少 --model");

  const problems = validateTaskSet();
  if (problems.length > 0) throw new Error(`任务集自身有问题：\n  - ${problems.join("\n  - ")}`);

  const arm = args.arms[0];
  const tasks = args.tasks.length > 0 ? TASKS.filter((t) => args.tasks.includes(t.id)) : TASKS;
  console.log(`臂=${arm} 模型=${args.model} 任务集=repo 任务=${tasks.length} 重复=${args.runNumbers.length}${args.reference ? " [reference 模式]" : ""}`);
  console.log(`记录写入：${out}`);

  let passed = 0;
  let failed = 0;
  let errored = 0;
  for (const task of tasks) {
    for (const runNumber of args.runNumbers) {
      const { record, failureReason } = runTask(task, {
        arm,
        model: args.model,
        runNumber,
        agentCmd: args.agentCmd,
        reference: args.reference,
        evalSet: args.evalSet,
      });
      appendRecord(out, record);
      const mark = record.outcome === "passed" ? "✅" : record.outcome === "errored" ? "⚠️" : "❌";
      console.log(`  ${mark} ${task.id} run-${runNumber} ${record.outcome}${failureReason ? ` (${failureReason})` : ""}`);
      if (record.outcome === "passed") passed++;
      else if (record.outcome === "errored") errored++;
      else failed++;
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
    console.error(`run-repo-arm 失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmdirSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TASKS, REPO_ROOT, validateTaskSet, gradeCommand, filesToRestore } from "./tasks-repo.mjs";
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
    else if (arg === "--verify-workspace") out.verifyWorkspace = true;
    else if (arg === "--verify-bug-tests") out.verifyBugTests = true;
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
  --verify-workspace    自证：工作区可信（历史只有 bug 状态、答案不在里面）—— 已挂进 npm run audit
  --verify-bug-tests    自证：**bug 状态下每个任务的判据必须是红的**（任务不许退化；不跑 agent、不花钱）
`;

/**
 * 工作区的构造与自证都在 `./repo-workspace.mjs`（第 96 波抽出）。
 *
 * 为什么抽出去：这份配方有两个消费者 —— 本文件（命令行 agent 的臂）与
 * `.preview-shot/_codem-repo-eval.mjs`（CDP 驱动装好的 Codem）。
 * **两把尺子 = 没有尺子**，所以只留一份；它的自证见 `--verify-workspace`。
 */
import {
  createRepoWorkspace,
  restoreImplementationAt,
  restoreTestsAt,
  cleanRepoWorkspace,
  verifyRepoWorkspace,
} from "./repo-workspace.mjs";

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

/**
 * **与臂无关的污染检测**：这次运行里，agent 有没有去碰"答案仓库"（默认 `C:\mimo-gui`）。
 *
 * 为什么需要（第 101 波）：Codem 那一侧靠**应用内的沙箱**把工作区外的路径挡住，
 * 并且由 CDP 驱动从事件流里判定污染；但 `--agent-cmd` 这一侧是**普通子进程**
 * （DSH driver 就是这种），没有应用级沙箱 —— 它想读哪就读哪。
 * 于是"两条臂的分数能不能比"这件事，取决于**两条臂是不是都干净**。
 *
 * 判据（保守）：driver 把原始事件留在 `<ws>/.dsh-events.jsonl`，这里只取
 * `tool_call` 的**访问目标**字段（path/file_path/command/code/script/pattern/workdir）——
 * 与 Codem 侧同一个口径（内容载荷不算）。**因为事件流里没有结果状态**，
 * 这里只能判"**碰过**"，不能判"读到没读到" ⇒ 保守：碰过就算污染，宁可作废也不用脏数据。
 *
 * @returns `{ answerRepoHits: string[], contaminated: boolean } | undefined`（没有事件文件就 undefined）
 */
function readOutsideAccess(ws) {
  const file = join(ws, ".dsh-events.jsonl");
  if (!existsSync(file)) return undefined;
  const hits = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type !== "tool_call") continue;
    const input = event.input ?? {};
    const target = ["path", "file_path", "command", "code", "script", "pattern", "workdir"]
      .filter((f) => typeof input[f] === "string")
      .map((f) => input[f])
      .join(" ");
    if (/mimo-gui/i.test(target)) hits.push(`${event.tool ?? "?"}: ${target.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return { answerRepoHits: hits, contaminated: hits.length > 0 };
}

function runTask(task, { arm, model, runNumber, agentCmd, reference, evalSet }) {
  const started = Date.now();
  const ws = createRepoWorkspace(task);
  let outcome = "failed";
  let failureReason = null;
  let usage;
  let outsideAccess;
  try {
    // 工作区在 `createRepoWorkspace` 里已经是**提交过的 bug 状态**（干净树），
    // 这里不再二次回退：那会让 mtime 变化、也会让"agent 面对的是干净工作区"这件事失真。
    if (reference) {
      restoreImplementationAt(task, ws);
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
      restoreTestsAt(task, ws); // 反作弊
      const grade = spawnSync(gradeCommand(task), { cwd: ws, shell: true, encoding: "utf8", timeout: GRADE_TIMEOUT_MS });
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
    outsideAccess = readOutsideAccess(ws);
    cleanRepoWorkspace(ws);
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
      /**
       * 与臂无关的污染字段（第 101 波）：`--agent-cmd` 这条路上没有应用级沙箱，
       * 所以"这次有没有碰答案仓库"必须由驱动自己判。**非空 ⇒ 分数作废**。
       */
      ...(outsideAccess
        ? { outsideAnswerRepoHits: outsideAccess.answerRepoHits, contaminated: outsideAccess.contaminated }
        : {}),
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

  /**
   * `--verify-bug-tests`：**任务集自己的判据**——bug 状态下，每个任务的判据**必须是红的**。
   *
   * 为什么需要它（比 `--verify-workspace` 更强的一层）：
   * 工作区自证只能证明"至少有一个 `revertPath` 与 HEAD 不同"，**不能**证明"那份差异让判据失败"。
   * 一个退化的任务（改的是无关代码、或者判据本来就依赖别处）在 bug 状态下判据照样绿 ——
   * 那种任务谁都能"修好"，分数毫无意义。
   *
   * 这一层跑的是**真判据命令**（`gradeCommand`），不跑 agent、不花模型钱：
   * 退出码非 0 ⇒ bug 在位（好）；退出码 0 ⇒ **任务退化**（红）。
   */
  if (args.verifyBugTests) {
    const tasks = args.tasks.length > 0 ? TASKS.filter((t) => args.tasks.includes(t.id)) : TASKS;
    let vacuous = 0;
    let errored = 0;
    for (const task of tasks) {
      const ws = createRepoWorkspace(task);
      try {
        const grade = spawnSync(gradeCommand(task), { cwd: ws, shell: true, encoding: "utf8", timeout: GRADE_TIMEOUT_MS });
        if (grade.error?.code === "ETIMEDOUT" || grade.signal === "SIGTERM") {
          errored++;
          console.log(`  ⚠️  ${task.id}：判据命令超时，无法判定`);
        } else if (grade.status === 0) {
          vacuous++;
          console.log(`  ❌ ${task.id}：**bug 状态下判据是绿的** —— 这个任务退化（谁都能过），分数没有意义`);
        } else {
          const out = `${grade.stdout ?? ""}${grade.stderr ?? ""}`;
          const failed = (out.match(/FAIL|✗|×/g) ?? []).length;
          console.log(`  ✅ ${task.id}：bug 状态下判据红（退出码 ${grade.status}，命中失败标记 ${failed} 处）`);
        }
      } finally {
        cleanRepoWorkspace(ws);
      }
    }
    console.log(
      `\n判据自证（bug 状态必须红）：${tasks.length - vacuous - errored}/${tasks.length} 通过` +
        (vacuous > 0 ? `，**${vacuous} 个任务退化**` : "") +
        (errored > 0 ? `，${errored} 个超时未判定` : ""),
    );
    return vacuous === 0 && errored === 0 ? 0 : 1;
  }

  if (args.verifyWorkspace) {
    const tasks = args.tasks.length > 0 ? TASKS.filter((t) => args.tasks.includes(t.id)) : TASKS;
    let bad = 0;
    let warned = 0;
    for (const task of tasks) {
      // 造一份工作区 → 验它 → 删掉（自证不需要留着）
      const ws = createRepoWorkspace(task);
      let result;
      try {
        result = verifyRepoWorkspace(task, ws);
      } finally {
        cleanRepoWorkspace(ws);
      }
      const { problems, warnings } = result;
      if (problems.length === 0) {
        console.log(`  ✅ ${task.id}：工作区可信（历史 1 个提交 = bug 状态；答案与任务集不在里面）`);
      } else {
        bad++;
        console.log(`  ❌ ${task.id}：`);
        for (const p of problems) console.log(`       - ${p}`);
      }
      for (const w of warnings) {
        warned++;
        console.log(`  ⚠️  ${task.id}：${w}`);
      }
    }
    console.log(
      `\n工作区自证：${tasks.length - bad}/${tasks.length} 通过` +
        (warned > 0 ? `（另有 ${warned} 条任务集卫生警告，不影响"尺子可信"的结论）` : ""),
    );
    return bad === 0 ? 0 : 1;
  }

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

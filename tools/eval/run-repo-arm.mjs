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

/**
 * 建一个真实仓库的评测工作区：**一份只有"bug 状态"这一个提交的全新仓库**。
 *
 * ## 为什么不再用 `git worktree add --detach HEAD`（第 96 波修掉的漏洞）
 *
 * 旧做法是"在 HEAD 上开 worktree，再把实现回退到 <buggyCommit>" —— 于是
 * **修复后的版本仍然在 `HEAD` 里**：被测 agent 只要跑一句
 * `git checkout HEAD -- <实现文件>`（或 `git restore` / `git stash`），
 * 就把**参考解**装了回去，看起来"修好了"。
 * 这不是假设：本轮实测三次（repo-01/02/03）**三次都这么过关**，
 * 而且 agent 还会顺藤摸到"自己在评测里"（它列了 `git worktree list`、
 * 扫到过上一轮留下的 `%TEMP%\codem-eval-repo-*`）。
 *
 * ## 现在的口径
 *
 * 1. `git archive HEAD` 把**跟踪的文件**导出成一份干净的工作树
 *    （不拷 `node_modules`：用 junction 指回主仓库；不拷 `target/`、`.preview-shot/` 等未跟踪物）；
 * 2. **把答案挪出工作区**：排除 `docs/HANDOFF-*`（那份交接单写着每个任务的缺陷与修法）
 *    与 `tools/eval/**`（任务集本身写着涉及哪些文件、`buggyCommit` 是哪个）；
 * 3. 用 `<buggyCommit>:<实现文件>` 的内容覆盖实现 ⇒ 造出 bug；
 * 4. `git init` + 一次提交 ⇒ **工作区的 git 历史只有一个提交，就是 bug 状态**；
 *    `git checkout HEAD -- <文件>` 只会把 bug 装回来，而"参考解"在这个仓库里**不可达**。
 *
 * ⚠️ 仍然挡不住的：agent 去网上找/从别处拿（本档不防这个）；以及"它自己真的会修"（那正是要测的）。
 */
function prepareRepoWorkspace(task) {
  const ws = mkdtempSync(join(tmpdir(), `codem-eval-repo-${task.id}-`));
  const tar = join(ws, "..", `codem-eval-archive-${task.id}-${process.pid}.tar`);
  // 1) 导出 HEAD 的跟踪文件（随后再把"答案"删掉，见 EXCLUDED_FROM_WORKSPACE 的说明）
  const archive = git(["archive", "--format=tar", "-o", tar, "HEAD"]);
  if (archive.status !== 0) throw new Error(`git archive 失败：${archive.stderr || archive.stdout}`);
  const untar = spawnSync("tar", ["-xf", tar, "-C", ws], { encoding: "utf8" });
  try {
    rmSync(tar, { force: true });
  } catch {
    /* 删不掉不影响评测 */
  }
  if (untar.status !== 0) throw new Error(`解包失败：${untar.stderr || untar.stdout}`);
  removeAnswersFromWorkspace(ws);

  // 2) node_modules 用 junction 指回主仓库：不拷、也不改主仓库
  const junction = spawnSync("cmd", ["/c", "mklink", "/J", join(ws, "node_modules"), join(REPO_ROOT, "node_modules")], {
    encoding: "utf8",
  });
  if (junction.status !== 0) throw new Error(`node_modules junction 失败：${junction.stderr || junction.stdout}`);

  // 3) 造 bug（用主仓库的对象库读 buggyCommit，写进工作区）
  applyBug(task, ws);

  // 4) 一次提交：HEAD == bug 状态，历史里没有参考解
  git(["init", "-q"], ws);
  git(["add", "-A"], ws);
  const commit = git(
    ["-c", "user.name=codem-eval", "-c", "user.email=eval@localhost", "commit", "-q", "-m", `EVAL bug state: ${task.id}`],
    ws,
  );
  if (commit.status !== 0) throw new Error(`${task.id}: 建立 bug 状态提交失败：${commit.stderr || commit.stdout}`);
  return ws;
}

/**
 * 从工作区里删掉**答案**与**任务集**。
 *
 * - `docs/HANDOFF-*.md`：交接单逐条写着"哪个文件有什么缺陷、怎么修" —— 留着等于开卷考；
 * - `tools/eval`：任务集里有 `revertPaths` / `buggyCommit` / 判据文件名，等于提前告诉它改哪里。
 *
 * 判据（测试文件）**不删** —— 它就是评分依据，而且反作弊会从提交里还原它们。
 */
const EXCLUDED_FROM_WORKSPACE = ["docs/HANDOFF-*", "tools/eval"];

function removeAnswersFromWorkspace(ws) {
  const drop = [
    join(ws, "tools", "eval"),
  ];
  // docs/HANDOFF-*.md（交接单）——用目录枚举，避免依赖 shell 的 glob
  const docs = join(ws, "docs");
  if (existsSync(docs)) {
    for (const name of readdirSync(docs)) {
      if (name.startsWith("HANDOFF-")) drop.push(join(docs, name));
    }
  }
  for (const p of drop) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch (error) {
      console.log(`     （删不掉 ${p}，已忽略：${error?.code ?? error}）`);
    }
  }
}

/** 造 bug：把实现文件换成 `<buggyCommit>` 里的那一版（主仓库的对象库是只读来源）。 */
function applyBug(task, ws) {
  for (const rel of task.revertPaths) {
    const show = git(["show", `${task.buggyCommit}:${rel}`]);
    if (show.status !== 0) throw new Error(`${task.id}: 取 ${task.buggyCommit}:${rel} 失败：${show.stderr || show.stdout}`);
    const target = join(ws, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, show.stdout ?? "", "utf8");
  }
}

/** 自证用：把实现还原成 HEAD（= 正确解）。 */
function restoreImplementation(task, ws) {
  for (const rel of task.revertPaths) {
    const show = git(["show", `HEAD:${rel}`]);
    if (show.status !== 0) throw new Error(`${task.id}: 取 HEAD:${rel} 失败：${show.stderr || show.stdout}`);
    writeFileSync(join(ws, rel), show.stdout ?? "", "utf8");
  }
}

/**
 * 反作弊：判据文件 + 回归子集从**这个工作区自己的提交**还原（= 评测开始时的版本），agent 改测试无效。
 *
 * 它与旧实现的区别只有一处，但很关键：这里还原出来的**只有测试文件**，
 * 而工作区的 `HEAD` 是 **bug 状态** —— 所以"从 git 还原实现"这条路不再是拿答案。
 */
function restoreTests(task, ws) {
  git(["checkout", "HEAD", "--", ...filesToRestore(task)], ws);
}

function cleanupRepoWorkspace(ws) {
  try {
    rmdirSync(join(ws, "node_modules")); // 只删 junction 链接
  } catch {
    /* 已经不是 junction 就跳过 */
  }
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch (error) {
    console.log(`     （工作区删不掉，已忽略：${error?.code ?? error}）`);
  }
}

/**
 * `--verify-workspace`：**只验工作区**（不跑 agent、不评分）—— 证明尺子本身是可信的。
 *
 * 对每个任务断言三件事：
 *  1. 工作区历史**只有一个提交**（`HEAD~1` 不存在）⇒ "从 git 里取回参考解"这条路不存在；
 *  2. 每个 `revertPaths` 的**工作区内容 == 该提交**（干净树）且 **== `<buggyCommit>` 的版本** ⇒ bug 真的在里面；
 *  3. 它与**主仓库 HEAD 的版本不同** ⇒ 这个任务确实构造出了差异（退化的任务会被抓出来）；
 *  4. 答案（`docs/HANDOFF-*`）与任务集（`tools/eval`）不在工作区里。
 *
 * 为什么值得有一个独立模式：本轮实测三次"agent 用 `git checkout HEAD -- <实现文件>`
 * 把参考解装回来"，说明"尺子可信"必须自己是被验证过的，不能靠"看起来对"。
 */
function verifyWorkspace(task) {
  const ws = prepareRepoWorkspace(task);
  const problems = [];
  const warnings = [];
  try {
    const log = git(["log", "--oneline"], ws).stdout?.trim().split("\n").filter(Boolean) ?? [];
    if (log.length !== 1) problems.push(`历史里有 ${log.length} 个提交（应当只有 1 个：bug 状态）`);
    if (git(["cat-file", "-e", "HEAD~1"], ws).status === 0) problems.push("HEAD~1 存在 ⇒ 参考解在历史里可达");

    let differing = 0;
    for (const rel of task.revertPaths) {
      const inWs = readFileSync(join(ws, rel), "utf8");
      const wsHead = git(["show", `HEAD:${rel}`], ws).stdout ?? "";
      if (inWs !== wsHead) problems.push(`${rel}: 工作区内容与自己的 HEAD 不一致（工作区应当是干净树）`);
      const buggy = git(["show", `${task.buggyCommit}:${rel}`]).stdout ?? "";
      if (inWs !== buggy) problems.push(`${rel}: 工作区内容 ≠ ${task.buggyCommit} 的版本（bug 没造出来）`);
      const fixed = git(["show", `HEAD:${rel}`]).stdout ?? "";
      if (buggy === fixed) {
        warnings.push(
          `${rel}: buggyCommit(${task.buggyCommit}) 与 HEAD 的内容**完全相同** —— 这条 revertPath 是空操作（bug 由本任务别的文件提供）`,
        );
      } else {
        differing++;
      }
    }
    /**
     * **全部** revertPath 都没差异 ⇒ 这个任务根本没构造出 bug（判据会恒绿）—— 这是致命项。
     * 只有**一部分**没差异 ⇒ 只发警告：bug 确实由别的文件提供，任务有效，但声明里有冗余项
     * （会让人以为"修复必须动这个文件"）。这是**任务集卫生**问题，不是本次评测不可信。
     */
    if (differing === 0) problems.push("所有 revertPath 都与 HEAD 相同 ⇒ 这个任务构造不出任何差异（判据会恒绿）");

    if (existsSync(join(ws, "tools", "eval"))) problems.push("工作区里还有 tools/eval（任务集 = 答案提示）");
    const docsDir = join(ws, "docs");
    if (existsSync(docsDir) && readdirSync(docsDir).some((n) => n.startsWith("HANDOFF-"))) {
      problems.push("工作区里还有 docs/HANDOFF-*（交接单 = 答案）");
    }
  } finally {
    cleanupRepoWorkspace(ws);
  }
  return { problems, warnings };
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
    // 工作区在 `prepareRepoWorkspace` 里已经是**提交过的 bug 状态**（干净树），
    // 这里不再二次回退：那会让 mtime 变化、也会让"agent 面对的是干净工作区"这件事失真。
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

  if (args.verifyWorkspace) {
    const tasks = args.tasks.length > 0 ? TASKS.filter((t) => args.tasks.includes(t.id)) : TASKS;
    let bad = 0;
    let warned = 0;
    for (const task of tasks) {
      const { problems, warnings } = verifyWorkspace(task);
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

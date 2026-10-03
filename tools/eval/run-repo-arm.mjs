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
// 第 113 波：污染判定与《记录完整性检查器》共用同一套规则（别再各写一份）
import { DEFAULT_ANSWER_REPO_RE, JUNCTION_ESCAPE_RE } from "./codem-record-integrity.mjs";
// 第 117 波：重复 (caseId, runNumber) 的处置（纯函数，判据见 src/test/eval-record-append.test.ts）
import { planRecordAppend } from "./record-append.mjs";
import { ensureSharedNodeModules } from "./repo-workspace.mjs";
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
    /**
     * **显式运行号**（第 111 波加）。
     *
     * 为什么必须与 `--runs` 分开：`--runs 2` 的语义是"跑 1..2 两次"（次数），
     * 而我第一版在重复跑 campaign 里把它当成"这次是 run-2"来用 —— 于是**又跑了一次 run-1**，
     * 记录里同一 (case, arm, model, runNumber) 出现两条、结果还不一样，
     * 成对报告因此把该对判成阻塞（它的纪律是对的，是我的调用错了）。
     */
    else if (arg === "--run-number") out.runNumbers = [Number(next())];
    else if (arg === "--out") out.out = next();
    else if (arg === "--report") out.report = true;
    else if (arg === "--reference") out.reference = true;
    else if (arg === "--keep") out.keep = true;
    else if (arg === "--verify-workspace") out.verifyWorkspace = true;
    else if (arg === "--verify-reference") out.verifyReference = true;
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
    /**
     * 第 113 波：**同一条规则必须只有一份**。
     *
     * 老口径只找 `mimo-gui` 特征词，于是 `node_modules\..`（顺着 junction 走到答案仓库、
     * 一个特征词都没有）**看不见** —— 那次 run-1 因此无法证明干净。
     * 现在与 `codem-record-integrity.mjs` 共用 `JUNCTION_ESCAPE_RE`，
     * 避免两条臂各自演化出不同的"污染"定义（那是尺子最容易出的问题）。
     */
    if (DEFAULT_ANSWER_REPO_RE.test(target) || JUNCTION_ESCAPE_RE.test(target)) {
      hits.push(`${event.tool ?? "?"}: ${target.replace(/\s+/g, " ").slice(0, 200)}`);
    }
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
  /** 判据输出的留档路径（诊断用；见下面写文件处的说明） */
  let gradeFile = null;
  /** 驱动原始事件流的留档路径（第 110 波：让对照臂也能事后诊断"它跑过什么"） */
  let eventsFile = null;
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
      /**
       * 评分前**再确认一次**共享 node_modules 副本是完整的（第 109 波）。
       *
       * 为什么要在这里再查一次：副本是**所有工作区共用**的，而被测 agent 可能在自己的工作区里跑
       * `npm install` 之类的命令 —— 那会顺着 junction 改到共享副本上（实测撞过一次：
       * 判据以 `Cannot find package '@vitest/utils'` 崩掉，而记录把它记成了"任务失败"）。
       * 抽查只要几毫秒；坏了就重新镜像，绝不让"环境坏了"冒充"任务没做出来"。
       */
      try {
        ensureSharedNodeModules({ quiet: true });
      } catch (error) {
        console.log(`     ⚠️ 共享依赖副本不可用（${error?.message ?? error}）—— 判据可能跑不起来`);
      }
      restoreTestsAt(task, ws); // 反作弊
      const grade = spawnSync(gradeCommand(task), { cwd: ws, shell: true, encoding: "utf8", timeout: GRADE_TIMEOUT_MS });
      /**
       * **把判据输出留档**（第 106 波补，与 Codem 侧的 `.preview-shot/eval-codem-*.grade.txt` 对称）。
       *
       * 为什么必须有：对照臂失败时，记录里只有 `判据退出码 1` —— 于是"DSH 为什么没过"这件事
       * 事后**无法诊断**（只能重跑，而重跑要花十几分钟与真金白银）。
       * 两条臂的诊断能力必须对称，否则"差距在哪"就只能靠猜。
       */
      gradeFile = join(HERE, "..", "..", ".preview-shot", `eval-${arm}-${task.id}.grade.txt`);
      try {
        writeFileSync(gradeFile, `${grade.stdout ?? ""}${grade.stderr ?? ""}`, "utf8");
      } catch (error) {
        console.log(`     （判据输出没存下来：${error?.message ?? error}）`);
        gradeFile = null;
      }
      for (const line of String(`${grade.stdout ?? ""}${grade.stderr ?? ""}`).split("\n")) {
        if (/Test Files|Tests\s|FAIL|×/.test(line)) console.log(`     ${line.trim().slice(0, 160)}`);
      }
      const gradeOutput = `${grade.stdout ?? ""}${grade.stderr ?? ""}`;
      /**
       * **"跑不起来"≠"没做出来"**（第 109 波修正，有实测代价）。
       *
       * 实测事故：对照臂 `repo-07` 被判成 `failed`，而判据输出里两个测试文件**都是 ✓**，
       * 真正的原因是环境错误 `ERR_MODULE_NOT_FOUND: Cannot find package '@vitest/utils'`
       * （评测工作区的依赖副本当时不完整）—— 判据根本没跑到结论那一步。
       * 把它记成 `failed`，就等于**把一次尺子故障算进了对手的分数**（本轮因此差点得出
       * "DSH 只有 11/12"的错误结论）。
       *
       * 所以：输出里出现"模块/依赖/命令本身跑不起来"的特征，一律记 `errored` 并说明原因；
       * `errored` 不计入通过率（`paired-report.mjs` 的口径），需要重跑。
       */
      const environmentFailure = /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module|ENOENT: no such file or directory, open '.*node_modules/i.test(
        gradeOutput,
      );
      if (grade.error?.code === "ETIMEDOUT" || grade.signal === "SIGTERM") {
        outcome = "errored";
        failureReason = "判据命令超时";
      } else if (environmentFailure) {
        outcome = "errored";
        failureReason = "判据环境错误（依赖/模块缺失，判据没有跑到结论）—— 需要修环境后重跑";
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
    /**
     * **把驱动留下的原始事件流留档**（第 110 波）。
     *
     * 为什么：Codem 侧每个任务都会留下 `.diff.txt` 与 `.grade.txt`（能事后诊断"它改了什么、
     * 跑过哪些测试、哪条红过"），而对照臂只留一个用量 JSON —— 事件流随工作区一起被删掉。
     * 于是"DSH 为什么能过 repo-02/03/04"这类问题**事后无法回答**，只能重跑（十几分钟 + 真金白银）。
     * 两条臂的诊断能力必须对称，否则"差距在哪"就只能靠猜。
     */
    eventsFile = null;
    try {
      const raw = join(ws, ".dsh-events.jsonl");
      if (existsSync(raw)) {
        eventsFile = join(HERE, "..", "..", ".preview-shot", `eval-${arm}-${task.id}.events.jsonl`);
        writeFileSync(eventsFile, readFileSync(raw, "utf8"), "utf8");
      }
    } catch (error) {
      console.log(`     （事件流没存下来：${error?.message ?? error}）`);
      eventsFile = null;
    }
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
      // 判据输出的留档路径（对照臂失败时靠它做诊断 —— 只记一个退出码等于事后无法归因）
      ...(gradeFile ? { gradeFile } : {}),
      ...(eventsFile ? { eventsFile } : {}),
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
  /**
   * **重复运行号守卫**（第 117 波补，代价已付过两次）。
   *
   * 判定器与成对报告都按 `(caseId, runNumber)` 配对。同一个键出现两条（结果还可能不同）⇒
   * 该对**直接被阻塞**，等于白跑一轮。实测踩到两次：
   *  · repo-02/control/run-2：策略复跑写过一条（failed），补跑链又写一条（passed）；
   *  · repo-06/run-2：errored 一条，重跑又写一条（failed）。
   *
   * 处置原则：**既不阻塞配对，也不丢数据** —— 新来的这条**自动"挪到高位 run 号"**
   * （`parkedFrom` 记清它原来该是 run 几），并打一行警告。这样：
   *  · 同一个 (caseId, runNumber) 只剩最早那条 ⇒ 配对永远干净；
   *  · 多出来的那次运行仍然留在文件里 ⇒ 事后可查、可复用。
   */
  const existing = readRecords(out);
  const planned = planRecordAppend(existing, record);
  if (planned.warning) console.log(`   ⚠️ ${planned.warning}`);
  const line = `${JSON.stringify(planned.record)}\n`;
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
          /**
           * ⚠️ **退出码 1 不等于"判据红了"**（第 109 波修正，抓到过假绿）。
           *
           * 实测事故：共享依赖副本的目录名起错（叫 `codem-eval-node_modules` 而不是 `node_modules`），
           * 判据命令于是以 `ERR_MODULE_NOT_FOUND` 崩掉 —— 它**同样返回退出码 1**，
           * 而当时这条自证只看退出码 ⇒ 12/12 全"通过"，其实一条断言都没跑到
           * （线索就在那句"命中失败标记 **0** 处"，当时没追问）。
           *
           * 现在必须**同时**满足：①退出码非 0 ②输出里有真实的失败标记 ③没有环境级错误特征。
           */
          const environmentFailure =
            /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module|ENOENT: no such file or directory, open '.*node_modules/i.test(
              out,
            );
          if (environmentFailure) {
            errored++;
            console.log(`  ⚠️  ${task.id}：判据**没跑起来**（环境错误：依赖/模块缺失）—— 不能算"判据红"`);
          } else if (failed === 0) {
            errored++;
            console.log(
              `  ⚠️  ${task.id}：退出码 ${grade.status} 但**输出里没有任何失败标记** —— ` +
                `分不清"判据红"与"跑崩了"，按不可判定处理`,
            );
          } else {
            console.log(`  ✅ ${task.id}：bug 状态下判据红（退出码 ${grade.status}，命中失败标记 ${failed} 处）`);
          }
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

  /**
   * `--verify-reference`：**第三层尺子自证 —— 参考解必须让判据变绿**（第 117 波补）。
   *
   * 为什么必须有它：另外两层只证明"工作区干净"与"bug 状态下判据是红的"。
   * 但**红的判据不等于可解的判据** —— 若某条判据过严、依赖时序、或参考解根本没盖住它，
   * 那"agent 没过"就什么也说明不了（我们会在一个**无解**的任务上给自己记败绩）。
   *
   * 做法：造工作区 → 把 `revertPaths` 恢复成 HEAD（= 参考解）→ 跑真判据命令 ⇒ **必须绿**。
   * 不跑 agent、不花模型钱。
   */
  if (args.verifyReference) {
    const tasks = args.tasks.length > 0 ? TASKS.filter((t) => args.tasks.includes(t.id)) : TASKS;
    let red = 0;
    let errored = 0;
    for (const task of tasks) {
      const ws = createRepoWorkspace(task);
      try {
        restoreImplementationAt(task, ws);
        const grade = spawnSync(gradeCommand(task), { cwd: ws, shell: true, encoding: "utf8", timeout: GRADE_TIMEOUT_MS });
        const out = `${grade.stdout ?? ""}${grade.stderr ?? ""}`;
        const environmentFailure =
          /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module|ENOENT: no such file or directory, open '.*node_modules/i.test(
            out,
          );
        if (grade.error?.code === "ETIMEDOUT" || grade.signal === "SIGTERM" || environmentFailure) {
          errored++;
          console.log(`  ⚠️  ${task.id}：判据命令超时或环境错误，无法判定`);
        } else if (grade.status === 0) {
          console.log(`  ✅ ${task.id}：参考解下判据全绿（任务可解）`);
        } else {
          red++;
          const failedMarkers = (out.match(/FAIL|✗|×/g) ?? []).length;
          console.log(
            `  ❌ ${task.id}：**参考解下判据仍是红的**（退出码 ${grade.status}，失败标记 ${failedMarkers} 处）` +
              ` —— 要么任务无解，要么这条判据还依赖别的改动`,
          );
        }
      } finally {
        cleanRepoWorkspace(ws);
      }
    }
    console.log(
      `\n参考解自证（HEAD 必须让判据变绿）：${tasks.length - red - errored}/${tasks.length} 通过` +
        (red > 0 ? `，**${red} 个任务在参考解下仍红**` : "") +
        (errored > 0 ? `，${errored} 个无法判定` : ""),
    );
    return red === 0 && errored === 0 ? 0 : 1;
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

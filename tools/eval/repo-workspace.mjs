/**
 * 真实仓库档的**评测工作区**：造出一份"只有 bug 状态这一个提交"的仓库。
 *
 * ## 为什么单独一个模块（第 96 波）
 *
 * 这份配方有两个消费者：
 *   · `run-repo-arm.mjs` —— 命令行 agent 的臂（DSH 那种 `--agent-cmd`）；
 *   · Codem 自己的驱动（`.preview-shot/_codem-repo-eval.mjs`，通过 CDP 驱动装好的应用）。
 * 两个消费者必须**用同一份**工作区构造逻辑 —— 否则"尺子"就有两把，
 * 而这一波的整个教训正是"尺子本身必须先被验证过"。
 *
 * ## 为什么不是 `git worktree add --detach HEAD`（旧做法，有洞）
 *
 * 旧做法是"在 HEAD 上开 worktree，再把实现回退到 `<buggyCommit>`" ⇒ **修复后的版本仍在 `HEAD` 里**：
 * 被测 agent 一句 `git checkout HEAD -- <实现文件>`（或 `git restore` / `git stash`）就把**参考解**装回来。
 * 这不是假设：本轮实测三次（repo-01/02/03）**三次都这么过关**。
 *
 * 现在的口径：
 *   1. `git archive HEAD` 导出**跟踪的文件**（`node_modules` 用 junction 指回主仓库）；
 *   2. **把答案挪出工作区**：删掉 `docs/HANDOFF-*.md`（交接单写着每个任务的缺陷与修法）
 *      与 `tools/eval`（任务集写着 `revertPaths` / `buggyCommit` / 判据文件名）；
 *   3. 用 `<buggyCommit>:<实现文件>` 覆盖实现 ⇒ 造出 bug；
 *   4. `git init` + 一次提交 ⇒ **历史只有一个提交，就是 bug 状态**。
 *      于是 `git checkout HEAD -- <文件>` 只会把 bug 装回来，**参考解在这个仓库里不可达**。
 *
 * ⚠️ 挡不住的：去别处拿答案（本档不防）、以及"它自己真的会修"（那正是要测的）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { REPO_ROOT, filesToRestore } from "./tasks-repo.mjs";

/** 主仓库里跑 git（只读地读对象库） */
export function git(args, cwd = REPO_ROOT) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5 * 60 * 1000 });
}

/**
 * 从工作区里删掉的**答案与任务集**：
 * - `docs/HANDOFF-*.md`：交接单逐条写着"哪个文件有什么缺陷、怎么修" —— 留着等于开卷考；
 * - `tools/eval`：任务集里有 `revertPaths` / `buggyCommit` / 判据文件名，等于提前告诉它改哪里。
 *
 * 判据（测试文件）**不删** —— 它就是评分依据，而且反作弊会从提交里还原它们。
 */
export const EXCLUDED_FROM_WORKSPACE = ["docs/HANDOFF-*", "tools/eval"];

function removeAnswers(ws) {
  const drop = [join(ws, "tools", "eval")];
  const docs = join(ws, "docs");
  if (existsSync(docs)) {
    for (const name of readdirSync(docs)) if (name.startsWith("HANDOFF-")) drop.push(join(docs, name));
  }
  for (const p of drop) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch (error) {
      console.log(`     （删不掉 ${p}，已忽略：${error?.code ?? error}）`);
    }
  }
}

/** node_modules 用 junction 指回主仓库：不拷、也不改主仓库 */
/**
 * **共享的 `node_modules` 副本**（第 106 波）：junction 的**父目录不能是答案仓库**。
 *
 * ## 为什么（实测发现的泄漏通道）
 *
 * 老做法是把工作区的 `node_modules` 直接 junction 到 `C:\mimo-gui\node_modules`。
 * 这在功能上没问题（省 1GB 拷贝），但它**把答案仓库暴露给了被测 agent**：
 * `node_modules` 的父目录就是 `C:\mimo-gui` —— 只要 agent 执行 `cd node_modules\..`（或
 * `ls ..`、`resolve(join(cwd,'node_modules','..'))`），它就站在**有参考解的那个仓库**里了。
 * 实测证据：一次 repo-02 运行里 agent 直接去改 `C:\mimo-gui\src\core\llm\tools.ts`（主仓库文件）。
 *
 * 现在改成：**先把主仓库的 `node_modules` 镜像到 `%TEMP%\codem-eval-node_modules`（一次），
 * 工作区再 junction 到那份副本**。于是 `node_modules/..` 是 `%TEMP%`，不是答案仓库。
 *
 * 镜像只在 `package-lock.json` 变了或副本不存在时做一次（用锁文件的哈希做新鲜度标记，
 * 标记写在**副本之外**，免得它自己进到被测 agent 的视野里）。
 */
export function sharedNodeModulesDir() {
  return join(tmpdir(), "codem-eval-node_modules");
}

function lockfileFingerprint() {
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    const abs = join(REPO_ROOT, name);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    return `${name}:${st.size}:${Math.round(st.mtimeMs)}`;
  }
  return "no-lockfile";
}

/** 确保共享副本存在且新鲜；返回它的路径 */
export function ensureSharedNodeModules({ quiet = false } = {}) {
  const shared = sharedNodeModulesDir();
  const marker = `${shared}.ready.json`;
  const fingerprint = lockfileFingerprint();
  if (existsSync(marker) && existsSync(shared)) {
    try {
      if (JSON.parse(readFileSync(marker, "utf8")).fingerprint === fingerprint) return shared;
    } catch {
      /* 标记坏了就当不新鲜 */
    }
  }
  if (!quiet) console.log(`   镜像 node_modules → ${shared}（一次，约 1GB；之后所有工作区共用这份副本）`);
  // robocopy：退出码 0–7 都算成功（1 = 有文件复制，3 = 有文件+目录）
  const copy = spawnSync(
    "robocopy",
    [join(REPO_ROOT, "node_modules"), shared, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/R:1", "/W:1", "/MT:16"],
    { encoding: "utf8", timeout: 30 * 60 * 1000 },
  );
  if (copy.status > 7) {
    throw new Error(`镜像 node_modules 失败（robocopy 退出码 ${copy.status}）：${copy.stderr || copy.stdout}`);
  }
  writeFileSync(marker, JSON.stringify({ fingerprint, at: Date.now() }), "utf8");
  return shared;
}

function linkNodeModules(ws) {
  const target = join(ws, "node_modules");
  if (existsSync(target)) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      /* 下面 mklink 会报错，交给它说 */
    }
  }
  // junction 到**共享副本**，不是主仓库（见 ensureSharedNodeModules 的说明）
  const shared = ensureSharedNodeModules();
  const junction = spawnSync("cmd", ["/c", "mklink", "/J", target, shared], {
    encoding: "utf8",
  });
  if (junction.status !== 0) throw new Error(`node_modules junction 失败：${junction.stderr || junction.stdout}`);
}

/**
 * 清掉一个目录，给"句柄还没放开"留余地。
 *
 * 实测（第 101 波）：上一个任务刚在同一个路径上跑完 `npx vitest`（esbuild/vitest 的子进程、
 * 应用的文件监听都可能还握着句柄），紧接着 `rmSync` 会抛
 * `EPERM: Permission denied`（Windows 上删不掉"正在被使用的目录"）。
 * 那样整个任务会直接跑挂（`errored`），而这跟被测 agent 一点关系都没有 —— **脚手架不该这么脆**。
 *
 * 三级退让：直接删 → 等一会儿再删 → **改名挪开**（改名对句柄不敏感），把旧的留在旁边。
 */
function resetDir(ws) {
  /** 同步小睡（不 spawn 子进程）：`Atomics.wait` 是唯一干净的同步 sleep */
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let lastError;
  for (const delay of [0, 400, 1200]) {
    if (delay) sleep(delay);
    try {
      rmSync(ws, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const stale = `${ws}.stale-${Date.now()}`;
  try {
    renameSync(ws, stale);
    console.log(`     （工作区删不掉，已改名挪开：${stale}）`);
    return;
  } catch {
    throw lastError;
  }
}

/**
 * 在 `ws` 里造出 bug 状态并**提交**（幂等：`ws` 已存在时先清空）。
 *
 * @param task 任务对象（用 `revertPaths` / `buggyCommit`）
 * @param ws   目标目录；不给就给一个临时目录
 * @returns 工作区路径
 */
export function createRepoWorkspace(task, ws = mkdtempSync(join(tmpdir(), `codem-eval-repo-${task.id}-`))) {
  resetDir(ws);
  mkdirSync(ws, { recursive: true });

  // 1) 导出 HEAD 的跟踪文件
  const tar = join(tmpdir(), `codem-eval-archive-${task.id}-${process.pid}-${Date.now()}.tar`);
  const archive = git(["archive", "--format=tar", "-o", tar, "HEAD"]);
  if (archive.status !== 0) throw new Error(`git archive 失败：${archive.stderr || archive.stdout}`);
  const untar = spawnSync("tar", ["-xf", tar, "-C", ws], { encoding: "utf8" });
  rmSync(tar, { force: true });
  if (untar.status !== 0) throw new Error(`解包失败：${untar.stderr || untar.stdout}`);

  linkNodeModules(ws);

  // 2) 把答案挪出工作区
  removeAnswers(ws);

  // 3) 造 bug
  applyBugAt(task, ws);

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

/** 造 bug：把实现文件换成 `<buggyCommit>` 里的那一版（主仓库对象库是只读来源） */
export function applyBugAt(task, ws) {
  for (const rel of task.revertPaths) {
    const show = git(["show", `${task.buggyCommit}:${rel}`]);
    if (show.status !== 0) throw new Error(`${task.id}: 取 ${task.buggyCommit}:${rel} 失败：${show.stderr || show.stdout}`);
    const target = join(ws, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, show.stdout ?? "", "utf8");
  }
}

/** 自证用：把实现还原成 HEAD（= 正确解） */
export function restoreImplementationAt(task, ws) {
  for (const rel of task.revertPaths) {
    const show = git(["show", `HEAD:${rel}`]);
    if (show.status !== 0) throw new Error(`${task.id}: 取 HEAD:${rel} 失败：${show.stderr || show.stdout}`);
    writeFileSync(join(ws, rel), show.stdout ?? "", "utf8");
  }
}

/**
 * 反作弊：判据文件 + 回归子集从**工作区自己的提交**还原（= 评测开始时的版本），agent 改测试无效。
 *
 * 与旧实现的区别只有一处但很关键：还原出来的**只有测试文件**，而工作区的 `HEAD` 是 **bug 状态** ——
 * 所以"从 git 还原实现"不再等于拿答案。
 */
export function restoreTestsAt(task, ws) {
  git(["checkout", "HEAD", "--", ...filesToRestore(task)], ws);
}

/** 删掉工作区（只删 junction 链接，不动主仓库的 node_modules） */
export function cleanRepoWorkspace(ws) {
  try {
    rmSync(join(ws, "node_modules"), { recursive: true, force: true });
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
 * 验工作区是不是可信（不跑 agent、不评分）—— 尺子自己的判据。
 *
 * 断言：历史**只有 1 个提交**、`HEAD~1` 不存在、每个 `revertPath` 的工作区内容 == 自己的 `HEAD`
 * 且 == `<buggyCommit>` 的版本、**至少一个文件与主仓库 HEAD 不同**（否则任务构造不出差异）、
 * 答案与任务集不在工作区里。
 *
 * @returns `problems`（致命：尺子不可信）与 `warnings`（任务集卫生：某条 `revertPath` 是空操作）
 */
export function verifyRepoWorkspace(task, ws) {
  const problems = [];
  const warnings = [];
  const log = git(["log", "--oneline"], ws).stdout?.trim().split("\n").filter(Boolean) ?? [];
  if (log.length !== 1) problems.push(`历史里有 ${log.length} 个提交（应当只有 1 个：bug 状态）`);
  if (git(["cat-file", "-e", "HEAD~1"], ws).status === 0) problems.push("HEAD~1 存在 ⇒ 参考解在历史里可达");

  let differing = 0;
  for (const rel of task.revertPaths) {
    const abs = join(ws, rel);
    if (!existsSync(abs)) {
      problems.push(`${rel}: 工作区里没有这个文件`);
      continue;
    }
    const inWs = readFileSync(abs, "utf8");
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
  if (differing === 0) problems.push("所有 revertPath 都与 HEAD 相同 ⇒ 这个任务构造不出任何差异（判据会恒绿）");

  if (existsSync(join(ws, "tools", "eval"))) problems.push("工作区里还有 tools/eval（任务集 = 答案提示）");
  const docsDir = join(ws, "docs");
  if (existsSync(docsDir) && readdirSync(docsDir).some((n) => n.startsWith("HANDOFF-"))) {
    problems.push("工作区里还有 docs/HANDOFF-*（交接单 = 答案）");
  }

  /**
   * **答案仓库不能通过 `node_modules` 的父目录暴露**（第 106 波新增）。
   *
   * 实测过的泄漏通道：工作区的 `node_modules` 曾被 junction 到 `C:\mimo-gui\node_modules`，
   * 于是 `node_modules/..` 就是**有参考解的主仓库** —— 一次 repo-02 运行里 agent 直接去改了
   * `C:\mimo-gui\src\core\llm\tools.ts`。
   *
   * 这条判据检查的是"junction 指向的那份 `node_modules` 的**父目录**"：
   * 它必须不是主仓库，也不是主仓库的祖先。
   */
  const nm = join(ws, "node_modules");
  if (existsSync(nm)) {
    /**
     * ⚠️ 路径比较必须先**归一化**：`REPO_ROOT` 是用 `/` 拼的（`C:/mimo-gui`），
     * 而 `realpathSync` 给的是 `C:\mimo-gui` —— 直接 `===` 永远不相等，
     * 判据就成了"永远绿"（这一版第一遍就是这么写的，实测发现后才补上归一化）。
     */
    const normalize = (p) => p.replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
    const resolved = realpathSync(nm);
    const parent = normalize(dirname(resolved));
    const repo = normalize(REPO_ROOT);
    const looksLikeAnswersRepo = parent === repo || repo.startsWith(parent + "\\");
    if (looksLikeAnswersRepo) {
      problems.push(
        `node_modules 指向 ${resolved}，其父目录 ${dirname(resolved)} 就是答案仓库（或它的祖先）⇒ agent 能顺着它走到参考解`,
      );
    }
  } else {
    problems.push("工作区里没有 node_modules（依赖没接上，判据会跑不起来）");
  }

  return { problems, warnings };
}

/**
 * Host git 命令通道判据（GITP-1..5，第 270 波）。
 *
 * 背景：Host 以前没有 `execute_command` 的等价实现，`FileChangeTracker.start()` 的
 * `isGitRepo()` 恒 false ⇒ `turn_file_changes` **结构性为空**。`git-exec.ts` 是补上的
 * 唯一通道；它**不过审批**，所以白名单/危险选项/工作区边界必须在这里钉死。
 *
 * | 判据 | 钉什么 | 变异（改坏哪里 ⇒ 红） |
 * |---|---|---|
 * | GITP-1 | 写命令（add/commit/apply…）被拒，且**工作区真的没变** | 放开白名单 ⇒ 红 |
 * | GITP-2 | argv 不经 shell：`; echo …` 只是普通参数 | 改成 `spawn(cmd,{shell:true})` ⇒ 红 |
 * | GITP-3 | 非 ASCII 路径按 UTF-8 原样输出（`core.quotepath=false`） | 去掉该参数 ⇒ 路径变 `"\346…"` |
 * | GITP-4 | 超时杀进程树（用可控的 Node 睡眠进程，不赌 git 时序） | 去掉定时器/杀树 ⇒ 红 |
 * | GITP-5 | 非 git 工作区返回非 0 退出码，不抛异常 | 改成 throw ⇒ 红 |
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeGitInvoker, runProcess } from "../../packages/host/src/git-exec";

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function initRepo(): Promise<string> {
  const ws = await tempDir("codem-gitp-");
  git(ws, ["init"]);
  git(ws, ["config", "user.email", "host-test@example.invalid"]);
  git(ws, ["config", "user.name", "Host Test"]);
  await writeFile(join(ws, "a.txt"), "one\n", "utf8");
  git(ws, ["add", "a.txt"]);
  git(ws, ["commit", "-m", "base"]);
  return ws;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("GITP-1 只读白名单", () => {
  it("add/commit/apply/checkout/push 被拒（返回非 0，不执行）", async () => {
    const ws = await initRepo();
    const invoker = createNodeGitInvoker({ workspaceRoot: ws });
    await writeFile(join(ws, "a.txt"), "two\n", "utf8");

    for (const args of [
      ["add", "-A"],
      ["commit", "-m", "host should not commit"],
      ["apply", "some.patch"],
      ["checkout", "--", "a.txt"],
      ["push"],
      ["reset", "--hard"],
      ["clean", "-fd"],
    ]) {
      const r = await invoker.runGit(ws, args);
      expect(r.exitCode, `${args[0]} 必须被拒绝`).toBe(126);
      expect(r.stderr).toContain("命令被拒绝");
    }
    // 工作区真的没变：文件仍是第二版、仍未被暂存
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("two\n");
    expect(git(ws, ["diff", "--cached", "--name-only"]).trim(), "add 不许真的暂存").toBe("");
  });

  it("stash 只允许 create（drop/pop/apply 会改工作区）", async () => {
    const ws = await initRepo();
    const invoker = createNodeGitInvoker({ workspaceRoot: ws });
    for (const args of [["stash", "drop"], ["stash", "pop"], ["stash", "apply"]]) {
      const r = await invoker.runGit(ws, args);
      expect(r.exitCode).toBe(126);
      expect(r.stderr).toContain("只允许 create");
    }
  });

  it("diff 的写文件/外部程序选项被拒", async () => {
    const ws = await initRepo();
    const invoker = createNodeGitInvoker({ workspaceRoot: ws });
    for (const args of [
      ["diff", "--output=out.patch"],
      ["diff", "--ext-diff"],
      ["diff", "--textconv"],
      ["diff", "--no-index", "a.txt", "a.txt"],
    ]) {
      const r = await invoker.runGit(ws, args);
      expect(r.exitCode, args.join(" ")).toBe(126);
      expect(r.stderr).toContain("被拒绝");
    }
  });

  it("cat-file 只允许 -e <对象名>（存在性检查）；读内容/批量被拒", async () => {
    const ws = await initRepo();
    const invoker = createNodeGitInvoker({ workspaceRoot: ws });
    const tree = git(ws, ["rev-parse", "HEAD^{tree}"]).trim();

    const ok = await invoker.runGit(ws, ["cat-file", "-e", tree]);
    expect(ok.exitCode, `真实对象应当存在：${ok.stderr}`).toBe(0);

    const missing = await invoker.runGit(ws, ["cat-file", "-e", "f".repeat(40)]);
    expect(missing.exitCode, "不存在的对象返回非 0，不抛").not.toBe(0);

    for (const args of [
      ["cat-file", "-p", tree],
      ["cat-file", "HEAD"],
      ["cat-file", "--batch"],
      ["cat-file", "-e", "HEAD"],
      ["cat-file", "-e", tree, "extra"],
    ]) {
      const r = await invoker.runGit(ws, args);
      expect(r.exitCode, args.join(" ")).toBe(126);
      expect(r.stderr).toContain("cat-file");
    }
  });

  it("cwd 逃出工作区被拒（不 spawn）", async () => {
    const ws = await initRepo();
    const outside = await tempDir("codem-gitp-outside-");
    const invoker = createNodeGitInvoker({ workspaceRoot: ws });
    const r = await invoker.runGit(outside, ["rev-parse", "--is-inside-work-tree"]);
    expect(r.exitCode).toBe(126);
    expect(r.stderr).toContain("逃出工作区");
  });
});

describe("GITP-2 argv 不经 shell", () => {
  it("参数里的 ; | & 只是普通字符，不会变成第二条命令", async () => {
    const ws = await initRepo();
    const invoker = createNodeGitInvoker({ workspaceRoot: ws });
    const r = await invoker.runGit(ws, ["diff", "HEAD; echo INJECTED"]);
    expect(r.stdout, "shell 执行的话会看到 INJECTED").not.toContain("INJECTED");
    expect(r.exitCode === null || r.exitCode !== 0, "非法 revision 应报错").toBe(true);
  });
});

describe("GITP-3 core.quotepath=false", () => {
  it("中文路径原样输出（不是 \"\\346\\226\\207…\"）", async () => {
    const ws = await initRepo();
    await writeFile(join(ws, "中文文件.txt"), "第一版\n", "utf8");
    git(ws, ["add", "中文文件.txt"]);
    await writeFile(join(ws, "中文文件.txt"), "第二版\n", "utf8");

    const invoker = createNodeGitInvoker({ workspaceRoot: ws });
    const r = await invoker.runGit(ws, ["diff", "--name-status", "HEAD"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout, `实际输出：${r.stdout}`).toContain("中文文件.txt");
    expect(r.stdout, "不许出现八进制转义").not.toContain("\\346");
  });
});

describe("GITP-4 超时杀进程树", () => {
  it("可控的 Node 睡眠进程超时后返回 timedOut / 124", async () => {
    const started = Date.now();
    const r = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      timeoutMs: 300,
    });
    const elapsed = Date.now() - started;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("超时");
    expect(elapsed, `实际 ${elapsed}ms`).toBeLessThan(10_000);
  }, 20_000);
});

describe("GITP-5 非 git 工作区不抛", () => {
  it("rev-parse 返回非 0 退出码，stdout 不是 true", async () => {
    const plain = await tempDir("codem-gitp-plain-");
    const invoker = createNodeGitInvoker({ workspaceRoot: plain });
    const r = await invoker.runGit(plain, ["rev-parse", "--is-inside-work-tree"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.trim()).not.toBe("true");
  });
});

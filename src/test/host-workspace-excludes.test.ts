/**
 * `.git/info/exclude` 自动维护判据（WEX-1..7）。
 *
 * 这一组钉五件事：
 * 1. 非 git 工作区 ⇒ 明确降级（返回 reason），**不创建** `.git`；
 * 2. 幂等：连续调用只有一个标记块，且**块外用户内容原样保留**；
 * 3. 子目录工作区也生效（排除模式不带前导 `/`，任意层级命中）；
 * 4. 真实 worktree 写到 common 的 `info/exclude`（不是工作区里瞎建目录）；
 * 5. 恶意 `.git` 文件指向工作区外 ⇒ 拒绝写入并给出原因；
 * 6. 无法读取/写入 ⇒ 不抛出、不阻断，返回失败原因。
 */
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  WORKSPACE_ARTIFACT_EXCLUDE_PATTERNS,
  ensureWorkspaceArtifactExcludes,
  mergeExcludeBlock,
} from "../../packages/host/src/workspace-artifacts";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout;
}

async function initRepo(): Promise<string> {
  const dir = await tempDir("codem-wex-");
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "host-test@example.invalid"]);
  await git(dir, ["config", "user.name", "Host Test"]);
  await writeFile(join(dir, "a.txt"), "a\n", "utf8");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "base"]);
  return dir;
}

async function excludePathOf(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "--git-path", "info/exclude"])).trim();
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("WEX-1 非 git 工作区：明确降级、不创建 .git", () => {
  it("返回 not-a-git-repo，且目录里没有出现 .git", async () => {
    const root = await tempDir("codem-wex-nogit-");
    const result = await ensureWorkspaceArtifactExcludes(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["not-a-git-repo", "no-git"]).toContain(result.reason);
      expect(result.message.length).toBeGreaterThan(0);
    }
    await expect(lstat(join(root, ".git"))).rejects.toThrow();
  });
});

describe("WEX-2 幂等 + 保留用户内容", () => {
  it("连续两次只有一个标记块；用户已有的行一字不少", async () => {
    const root = await initRepo();
    const rel = await excludePathOf(root);
    const abs = join(root, rel);
    const userLines = ["# 我的本地忽略规则", "scratch/", "*.local.json"] as string[];
    await writeFile(abs, `${userLines.join("\n")}\n`, "utf8");

    const first = await ensureWorkspaceArtifactExcludes(root);
    expect(first).toMatchObject({ ok: true, changed: true });
    const afterFirst = await readFile(abs, "utf8");
    const second = await ensureWorkspaceArtifactExcludes(root);
    expect(second).toMatchObject({ ok: true, changed: false });
    const afterSecond = await readFile(abs, "utf8");

    expect(afterSecond, "第二次必须逐字不变（幂等）").toBe(afterFirst);
    for (const line of userLines) {
      expect(afterSecond.split(/\r?\n/)).toContain(line);
    }
    expect(afterSecond.split(/\r?\n/).filter((l) => l.includes(">>> codem workspace artifacts"))).toHaveLength(1);
    for (const pattern of WORKSPACE_ARTIFACT_EXCLUDE_PATTERNS) {
      expect(afterSecond.split(/\r?\n/), pattern).toContain(pattern);
    }
  });

  it("mergeExcludeBlock 只替换标记块（重复调用不累积），保留 CRLF", () => {
    const existing = "keep-me.txt\r\n# >>> codem workspace artifacts (managed by Codem) >>>\r\nOLD\r\n# <<< codem workspace artifacts (managed by Codem) <<<\r\n";
    const merged = mergeExcludeBlock(existing);
    expect(merged).toContain("keep-me.txt\r\n");
    expect(merged).not.toContain("OLD");
    expect(merged.match(/>>> codem workspace artifacts/g)).toHaveLength(1);
    expect(mergeExcludeBlock(merged)).toBe(merged);
  });

  it("孤立的开始标记（用户手改/旧残留）不许吞掉其后的用户内容", () => {
    const existing = "user.txt\n# >>> codem workspace artifacts (managed by Codem) >>>\nkeep-after.txt\n";
    const first = mergeExcludeBlock(existing);
    expect(first).toContain("keep-after.txt");
    expect(first.match(/>>> codem workspace artifacts/g)).toHaveLength(1);
    // 第二次合并是关键：旧实现会从孤立标记吞到新块末尾，把 keep-after.txt 丢掉
    const second = mergeExcludeBlock(first);
    expect(second).toContain("user.txt");
    expect(second).toContain("keep-after.txt");
    expect(second.match(/>>> codem workspace artifacts/g)).toHaveLength(1);
  });
});

describe("WEX-3 子目录工作区（仓库的某个子目录）", () => {
  it("把子目录当工作区：仍写到所属仓库的 exclude，且排除块无前导 /（任意层级命中）", async () => {
    const root = await initRepo();
    const sub = join(root, "packages", "app");
    await mkdir(sub, { recursive: true });
    const result = await ensureWorkspaceArtifactExcludes(sub);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      const text = await readFile(result.path, "utf8");
      expect(text).toContain(".codem-attachments/");
      expect(text).not.toContain("/.codem-attachments/");
    }
  });
});

describe("WEX-4 worktree：写到 common 的 info/exclude", () => {
  it("worktree 路径下调用成功，写入的是主仓库的 .git/info/exclude", async () => {
    const main = await initRepo();
    const wt = join(await tempDir("codem-wex-wt-"), "wt");
    await git(main, ["worktree", "add", "-b", "wtb", wt]);
    const result = await ensureWorkspaceArtifactExcludes(wt);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      const mainExclude = join(main, ".git", "info", "exclude");
      const text = await readFile(mainExclude, "utf8");
      expect(text).toContain(".codem-attachments/");
      expect(result.path.toLowerCase()).toContain(".git");
    }
  });
});

describe("WEX-5 恶意 .git 重定向：拒绝写入", () => {
  it("`.git` 文件指向另一个仓库的 .git ⇒ unsafe-git-dir，且对方 exclude 不被改动", async () => {
    const victim = await initRepo();
    const victimExclude = join(victim, ".git", "info", "exclude");
    const before = await readFile(victimExclude, "utf8");

    const evil = await tempDir("codem-wex-evil-");
    await writeFile(join(evil, ".git"), `gitdir: ${join(victim, ".git")}\n`, "utf8");

    const result = await ensureWorkspaceArtifactExcludes(evil);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe-git-dir");
    expect(await readFile(victimExclude, "utf8"), "受害者仓库一字未改").toBe(before);
  });
});

describe("WEX-6 读/写失败：不抛、不阻断，返回原因", () => {
  it("exclude 位置被目录占住（不可读）⇒ read-failed/write-failed，不抛出", async () => {
    const root = await initRepo();
    const rel = await excludePathOf(root);
    const abs = join(root, rel);
    await rm(abs, { force: true });
    await mkdir(abs, { recursive: true });

    const result = await ensureWorkspaceArtifactExcludes(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["read-failed", "write-failed", "unsafe-exclude-path"]).toContain(result.reason);
  });

  it("info 目录不存在 ⇒ 不自动创建目录，明确降级", async () => {
    const root = await initRepo();
    await rm(join(root, ".git", "info"), { recursive: true, force: true });
    const result = await ensureWorkspaceArtifactExcludes(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe-exclude-path");
    await expect(lstat(join(root, ".git", "info"))).rejects.toThrow();
  });
});

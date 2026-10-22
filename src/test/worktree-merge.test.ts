/**
 * WT-MERGE-1..4：worktree → 主工作区的合并入口。
 *
 * 真机缺口（2026-10-22）：worktree 是 detached HEAD，Codem 没有合并入口，
 * 改动只能手工 cherry-pick。这里用真实 git 仓库验证：
 * - 干净主工作区 + 有改动 → 提交并 merge --no-ff；
 * - 主工作区脏 → 拒绝（不 stash、不提交 worktree）；
 * - 同线冲突 → 回滚主工作区（不留冲突态）并抛冲突文件；
 * - 无改动 → 拒绝。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("../core/file-api", () => ({
  executeCommand: mockExec,
  exists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: vi.fn(),
  grepSearch: vi.fn(),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { mergeWorktreeToProject } from "../core/environment/worktree-manager";

const BASH = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const git = (cwd: string, cmd: string) =>
  execSync(`git ${cmd}`, { cwd, encoding: "utf8", shell: BASH, stdio: ["ignore", "pipe", "pipe"] });

let root = "";
let repo = "";
let wt = "";
const baseFile = "shared.txt";

beforeEach(() => {
  mockExec.mockImplementation(async (command: string, cwd: string) => {
    try {
      const stdout = execSync(command, { cwd, encoding: "utf8", shell: BASH, stdio: ["ignore", "pipe", "pipe"] });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (e: any) {
      return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message ?? e), exitCode: e.status ?? 1 };
    }
  });

  root = fs.mkdtempSync(path.join(os.tmpdir(), "codem-wt-merge-"));
  repo = path.join(root, "repo");
  wt = path.join(root, "wt");
  fs.mkdirSync(repo);
  git(repo, "init -q");
  git(repo, "config user.email test@example.com");
  git(repo, "config user.name test");
  fs.writeFileSync(path.join(repo, baseFile), "base\n");
  git(repo, "add -A");
  git(repo, "commit -qm base");
  git(repo, "worktree add -q -b feat ../wt");
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("worktree 合并回主工作区", () => {
  it("WT-MERGE-1：干净主工作区 + worktree 改动 → 提交并 merge，主工作区拿到改动", async () => {
    fs.writeFileSync(path.join(wt, baseFile), "base\nworktree-change\n");
    const res = await mergeWorktreeToProject(repo, wt, "merge worktree");
    expect(res.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(res.mergedSha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(fs.readFileSync(path.join(repo, baseFile), "utf8")).toContain("worktree-change");
    expect(git(repo, "log --oneline --merges -1").trim().length).toBeGreaterThan(0);
    expect(git(wt, "status --porcelain").trim()).toBe("");
  });

  it("WT-MERGE-2：主工作区有未提交改动 → 拒绝，且不提交 worktree", async () => {
    fs.writeFileSync(path.join(wt, baseFile), "base\nworktree-change\n");
    fs.writeFileSync(path.join(repo, "other.txt"), "dirty\n");
    await expect(mergeWorktreeToProject(repo, wt)).rejects.toThrow(/主工作区有未提交改动/);
    expect(git(wt, "status --porcelain").trim()).not.toBe("");
  });

  it("WT-MERGE-3：同线冲突 → 回滚主工作区，抛冲突文件，不留 MERGE_HEAD", async () => {
    fs.writeFileSync(path.join(wt, baseFile), "worktree\n");
    fs.writeFileSync(path.join(repo, baseFile), "main\n");
    git(repo, "add -A");
    git(repo, "commit -qm main-change");
    await expect(mergeWorktreeToProject(repo, wt)).rejects.toThrow(/合并冲突/);
    expect(git(repo, "status --porcelain").trim()).toBe("");
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, baseFile), "utf8").trim()).toBe("main");
  });

  it("WT-MERGE-5：冲突 + onConflict=worktree → 保留工作树版本，主工作区干净", async () => {
    fs.writeFileSync(path.join(wt, baseFile), "worktree");
    fs.writeFileSync(path.join(repo, baseFile), "main");
    git(repo, "add -A");
    git(repo, "commit -qm main-change");
    const res = await mergeWorktreeToProject(repo, wt, { onConflict: "worktree" });
    expect(res.conflictsResolved).toBe("worktree");
    expect(fs.readFileSync(path.join(repo, baseFile), "utf8").trim()).toBe("worktree");
    expect(git(repo, "status --porcelain").trim()).toBe("");
  });

  it("WT-MERGE-6：冲突 + onConflict=main → 保留主工作区版本，主工作区干净", async () => {
    fs.writeFileSync(path.join(wt, baseFile), "worktree");
    fs.writeFileSync(path.join(repo, baseFile), "main");
    git(repo, "add -A");
    git(repo, "commit -qm main-change");
    const res = await mergeWorktreeToProject(repo, wt, { onConflict: "main" });
    expect(res.conflictsResolved).toBe("main");
    expect(fs.readFileSync(path.join(repo, baseFile), "utf8").trim()).toBe("main");
    expect(git(repo, "status --porcelain").trim()).toBe("");
  });

  it("WT-MERGE-7：首轮冲突回滚后，worktree 已提交但仍可重试选边", async () => {
    fs.writeFileSync(path.join(wt, baseFile), "worktree");
    fs.writeFileSync(path.join(repo, baseFile), "main");
    git(repo, "add -A");
    git(repo, "commit -qm main-change");
    await expect(mergeWorktreeToProject(repo, wt)).rejects.toThrow(/合并冲突/);
    const res = await mergeWorktreeToProject(repo, wt, { onConflict: "worktree" });
    expect(res.conflictsResolved).toBe("worktree");
    expect(fs.readFileSync(path.join(repo, baseFile), "utf8").trim()).toBe("worktree");
  });

  it("WT-MERGE-4：worktree 没有改动 → 拒绝", async () => {
    await expect(mergeWorktreeToProject(repo, wt)).rejects.toThrow(/没有可合并的改动/);
  });
});

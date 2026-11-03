/**
 * 桌面网关变更面的**真实数据链路**判据（GWC-I1..GWC-I3）。
 *
 * 前面的 `gateway-changes.test.ts` 用假存储/假 git 钉语义；这里把真实件装起来：
 * `FileChangeStorage` 的查询原语（经假存储端口，但走真实的 `queryChangesPage` /
 * `getByIdAsync`）+ **真实 git 仓库** + Host 的真实 `createNodeGitInvoker`（含
 * `cat-file -e` 白名单）+ 共享的 `createChangesService`。
 *
 * 它回答的是"桌面那份记录 + 桌面 git 对象能不能真的产出 patch"，不是形状断言。
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createChangesService } from "../../packages/host/src/changes";
import { setCommandInvoker, runGitCommand } from "../core/command-api";
import { FileChangeTracker } from "../core/environment/file-change-tracker";
import {
  FileChangeStorage,
  queryChangesPage,
} from "../core/storage/file-change-storage";
import { setStoragePort } from "../core/storage/port";
import { createNodeGitInvoker } from "../../packages/host/src/git-exec";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const dirs: string[] = [];
let port: FakeStoragePort | null = null;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  setStoragePort(null);
  setCommandInvoker(null);
  port = null;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("GWC-I1 桌面 turn_file_changes + 真实 git 对象 → 真实 patch", () => {
  it("list 走 queryChangesPage；diff 走 cat-file -e + tree-to-tree diff", async () => {
    const repo = await tempDir("codem-gwc-");
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "gwc@example.invalid"]);
    git(repo, ["config", "user.name", "GWC Test"]);
    await writeFile(join(repo, "src.txt"), "one\n", "utf8");
    git(repo, ["add", "src.txt"]);
    git(repo, ["commit", "-m", "base"]);

    const beforeTree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
    await writeFile(join(repo, "src.txt"), "one\ntwo\n", "utf8");
    const afterCommit = git(repo, ["stash", "create"]).trim();
    expect(afterCommit, "stash create 必须产出提交对象").not.toBe("");
    const afterTree = git(repo, ["rev-parse", `${afterCommit}^{tree}`]).trim();

    port = createFakeStoragePort({
      seed: {
        turn_file_changes: [
          {
            id: "tfc-real-1",
            session_id: "sess-real",
            message_id: "assistant-real",
            turn_index: 1,
            before_tree: beforeTree,
            after_tree: afterTree,
            changed_files: JSON.stringify([{ path: "src.txt", status: "M", additions: 1, deletions: 0 }]),
            patch_sha256: "unused",
            current_brief: "Turn 1: 1 file(s) changed",
            status: "completed",
            created_at: 1_700_000_000_000,
          },
        ],
      },
    });
    setStoragePort(port);
    // 与 Host 一样走真实命令通道：这一步同时验证 `cat-file -e` 真被白名单放行。
    setCommandInvoker(createNodeGitInvoker({ workspaceRoot: repo }));

    const svc = createChangesService({
      sessionExists: async (id) => id === "sess-real",
      queryPage: (sid, offset, limit) => queryChangesPage(sid, offset, limit),
      getById: (id) => FileChangeStorage.getByIdAsync(id),
      workspaceFor: async () => repo,
      isGitWorkspace: (workspace) => FileChangeTracker.isGitWorkspace(workspace),
      runGit: (workspace, args) => runGitCommand(workspace, args),
      isSensitivePath: () => false,
    });

    const listed = await svc.list("sess-real");
    expect(listed.supported).toBe(true);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].changeId).toBe("tfc-real-1");
    expect(listed.items[0].files[0].path).toBe("src.txt");
    expect(JSON.stringify(listed)).not.toContain("before_tree");

    const got = await svc.diff("sess-real", "tfc-real-1", "src.txt");
    expect(got.supported, got.reason).toBe(true);
    expect(got.status).toBe("M");
    expect(got.patch).toContain("+two");
    expect(got.patch).toContain("--- a/src.txt");
  });
});

describe("GWC-I2 对象在别的仓库 ⇒ supported=false（不是 INTERNAL）", () => {
  it("同一记录换一个空仓库 ⇒ cat-file 失败，明确说跨工作区", async () => {
    const repo = await tempDir("codem-gwc-a-");
    const other = await tempDir("codem-gwc-b-");
    for (const dir of [repo, other]) {
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "gwc@example.invalid"]);
      git(dir, ["config", "user.name", "GWC Test"]);
      await writeFile(join(dir, "x.txt"), "x\n", "utf8");
      git(dir, ["add", "x.txt"]);
      git(dir, ["commit", "-m", "base"]);
    }
    const beforeTree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
    await writeFile(join(repo, "x.txt"), "x\ny\n", "utf8");
    const afterTree = git(repo, ["rev-parse", `${git(repo, ["stash", "create"]).trim()}^{tree}`]).trim();

    port = createFakeStoragePort({
      seed: {
        turn_file_changes: [
          {
            id: "tfc-foreign",
            session_id: "sess-real",
            message_id: "assistant-real",
            turn_index: 1,
            before_tree: beforeTree,
            after_tree: afterTree,
            changed_files: JSON.stringify([{ path: "x.txt", status: "M" }]),
            patch_sha256: null,
            current_brief: null,
            status: "completed",
            created_at: 1_700_000_000_000,
          },
        ],
      },
    });
    setStoragePort(port);
    setCommandInvoker(createNodeGitInvoker({ workspaceRoot: other }));

    const svc = createChangesService({
      sessionExists: async () => true,
      queryPage: (sid, offset, limit) => queryChangesPage(sid, offset, limit),
      getById: (id) => FileChangeStorage.getByIdAsync(id),
      workspaceFor: async () => other,
      isGitWorkspace: (workspace) => FileChangeTracker.isGitWorkspace(workspace),
      runGit: (workspace, args) => runGitCommand(workspace, args),
    });

    const got = await svc.diff("sess-real", "tfc-foreign", "x.txt");
    expect(got.supported).toBe(false);
    expect(got.patch).toBe("");
    expect(got.reason).toContain("另一个工作区");
  });
});

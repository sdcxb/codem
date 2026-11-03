/**
 * Host 真的能**记录**文件变更（CHG-H1..5，第 270 波）。
 *
 * 这一组与 `host-git-exec.test.ts` 分工：
 * - GITP 钉"命令通道本身"（白名单 / argv / 超时 / 编码）；
 * - CHG-H 钉"同一份 `FileChangeTracker` 在 Host 的存储 + Host 的 git 通道上真的写出行"。
 *
 * 为什么不用 mock 掉 git：这个缺陷的形态就是"Host 没有 git 通道"，
 * mock 掉 git 等于把要证明的东西假设成真的。这里用**真临时仓库 + 真 git + 假存储端口**
 * （假端口只替 SQLite，不替 git 行为）。
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setCommandInvoker } from "../core/command-api";
import { createNodeGitInvoker } from "../../packages/host/src/git-exec";
import { ensureWorkspaceArtifactExcludes } from "../../packages/host/src/workspace-artifacts";
import {
  FileChangeStorage,
  __resetFileChangeWindow,
  queryChangesPage,
} from "../core/storage/file-change-storage";
import {
  FileChangeTracker,
  __resetFileChangeSnapshotCache,
} from "../core/environment/file-change-tracker";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

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
  const ws = await tempDir("codem-chg-");
  git(ws, ["init"]);
  git(ws, ["config", "user.email", "host-test@example.invalid"]);
  git(ws, ["config", "user.name", "Host Test"]);
  await writeFile(join(ws, "src.txt"), "one\n", "utf8");
  git(ws, ["add", "src.txt"]);
  git(ws, ["commit", "-m", "base"]);
  return ws;
}

/** 写穿是异步 IPC；等到行真的可读（有界，避免用固定 sleep 赌时序） */
async function waitForRows(sessionId: string, expected = 1) {
  for (let i = 0; i < 100; i++) {
    const page = await queryChangesPage(sessionId, 0, 10);
    if (page.items.length >= expected) return page;
    await new Promise((r) => setTimeout(r, 5));
  }
  return await queryChangesPage(sessionId, 0, 10);
}

afterEach(async () => {
  setCommandInvoker(null);
  setStoragePort(null);
  __resetFileChangeSnapshotCache();
  __resetFileChangeWindow();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("CHG-H1 有改动的迭代 ⇒ Host 表里多一行", () => {
  it("修改已跟踪文件 + 新建文件：记录含两条路径、message_id 是助手行 id", async () => {
    const ws = await initRepo();
    setStoragePort(createFakeStoragePort() as never);
    setCommandInvoker(createNodeGitInvoker({ workspaceRoot: ws }));

    const tracker = new FileChangeTracker(ws, "host-session-1", "host-assistant-1", 3);
    expect(await tracker.start(), "Host 的 git 通道必须能认出这是 git 仓库").toBe(true);
    await writeFile(join(ws, "src.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(ws, "new.txt"), "brand new\n", "utf8");
    tracker.noteMutation();

    const result = await tracker.finalize();
    expect(result, "有改动 ⇒ 必须产出记录").not.toBeNull();
    expect(result!.artifactId).toMatch(/^tfc-/);

    const page = await waitForRows("host-session-1");
    expect(page.items).toHaveLength(1);
    const row = page.items[0];
    expect(row.message_id, "记录的 message_id 必须是落库方给的助手行 id").toBe("host-assistant-1");
    expect(row.turn_index).toBe(3);
    expect(row.before_tree).toBeTruthy();
    expect(row.after_tree).toBeTruthy();

    const files = JSON.parse(row.changed_files ?? "[]") as Array<{
      path: string;
      status: string;
      additions?: number;
      deletions?: number;
    }>;
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("src.txt")?.status, "修改过的已跟踪文件").toBe("M");
    expect(byPath.get("src.txt")?.additions, "numstat 必须真的折进记录").toBeGreaterThan(0);
    expect(byPath.get("new.txt")?.status, "未跟踪的新文件补成 A").toBe("A");
    /** 一屏投影不含 patch 正文（写的时候有，读回来没有） */
    expect((row as { patch?: string }).patch).toBeUndefined();
  });

  it("列表能按 message_id / changed_files 解析出协议视图（端点只读投影）", async () => {
    const ws = await initRepo();
    setStoragePort(createFakeStoragePort() as never);
    setCommandInvoker(createNodeGitInvoker({ workspaceRoot: ws }));
    const tracker = new FileChangeTracker(ws, "host-session-2", "host-assistant-2", 1);
    await tracker.start();
    await writeFile(join(ws, "src.txt"), "changed\n", "utf8");
    tracker.noteMutation();
    await tracker.finalize();
    await waitForRows("host-session-2");

    const views = FileChangeStorage.parseChangedFiles((await queryChangesPage("host-session-2", 0, 5)).items[0]);
    expect(views.map((f) => f.path)).toContain("src.txt");
  });
});

describe("CHG-H2 纯读迭代 ⇒ 一行都没有（skip 生效）", () => {
  it("没有 noteMutation() 时 finalize 返回 null，表里零行", async () => {
    const ws = await initRepo();
    setStoragePort(createFakeStoragePort() as never);
    setCommandInvoker(createNodeGitInvoker({ workspaceRoot: ws }));

    const tracker = new FileChangeTracker(ws, "host-session-readonly", "host-assistant-3", 1);
    expect(await tracker.start()).toBe(true);
    expect(await tracker.finalize()).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect((await queryChangesPage("host-session-readonly", 0, 10)).items, "纯读迭代不许写行").toEqual([]);
  });
});

describe("CHG-H5 非 git 工作区 ⇒ 不写行、不抛、不弹失败", () => {
  it("start() 返回 false，finalize() 返回 null", async () => {
    const plain = await tempDir("codem-chg-plain-");
    setStoragePort(createFakeStoragePort() as never);
    setCommandInvoker(createNodeGitInvoker({ workspaceRoot: plain }));

    const tracker = new FileChangeTracker(plain, "host-session-plain", "host-assistant-4", 1);
    await expect(tracker.start()).resolves.toBe(false);
    tracker.noteMutation();
    await expect(tracker.finalize()).resolves.toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect((await queryChangesPage("host-session-plain", 0, 10)).items).toEqual([]);
  });
});

describe("CHG-H6 Host 内部产物不污染变更记录（共享工作区）", () => {
  it("ensureWorkspaceArtifactExcludes 之后，附件/快照目录不出现在 changed_files", async () => {
    const ws = await initRepo();
    setStoragePort(createFakeStoragePort() as never);
    setCommandInvoker(createNodeGitInvoker({ workspaceRoot: ws }));
    await ensureWorkspaceArtifactExcludes(ws);

    await mkdir(join(ws, ".codem-attachments"), { recursive: true });
    await mkdir(join(ws, ".codem-snapshots"), { recursive: true });
    await writeFile(join(ws, ".codem-attachments", "att-1__a.txt"), "x", "utf8");
    await writeFile(join(ws, ".codem-snapshots", "snap-1.json"), "{}", "utf8");

    const tracker = new FileChangeTracker(ws, "host-session-artifacts", "host-assistant-6", 1);
    expect(await tracker.start()).toBe(true);
    // 本轮真正的改动在 start() 之后发生（与真实回合一致）
    await writeFile(join(ws, "real.txt"), "y", "utf8");
    tracker.noteMutation();
    await tracker.finalize();
    await waitForRows("host-session-artifacts");

    const views = FileChangeStorage.parseChangedFiles(
      (await queryChangesPage("host-session-artifacts", 0, 5)).items[0],
    );
    const paths = views.map((f) => f.path);
    expect(paths, "真正的改动仍要记录").toContain("real.txt");
    expect(paths.some((p) => p.startsWith(".codem-attachments/")), "附件副本不是用户改动").toBe(false);
    expect(paths.some((p) => p.startsWith(".codem-snapshots/")), "快照不是用户改动").toBe(false);
  });

  it("反向对照：不维护 exclude 时，未跟踪的内部产物会被记成新增（说明判据有效）", async () => {
    const ws = await initRepo();
    setStoragePort(createFakeStoragePort() as never);
    setCommandInvoker(createNodeGitInvoker({ workspaceRoot: ws }));

    await mkdir(join(ws, ".codem-attachments"), { recursive: true });

    const tracker = new FileChangeTracker(ws, "host-session-artifacts-raw", "host-assistant-7", 1);
    expect(await tracker.start()).toBe(true);
    // 本轮新建的附件副本 + 真正的用户文件都在 start() 之后出现
    await writeFile(join(ws, ".codem-attachments", "att-1__a.txt"), "x", "utf8");
    await writeFile(join(ws, "real.txt"), "y", "utf8");
    tracker.noteMutation();
    await tracker.finalize();
    await waitForRows("host-session-artifacts-raw");

    const views = FileChangeStorage.parseChangedFiles(
      (await queryChangesPage("host-session-artifacts-raw", 0, 5)).items[0],
    );
    expect(
      views.map((f) => f.path).some((p) => p.startsWith(".codem-attachments/")),
      "没有 exclude 时确实会污染 —— 这条反向对照证明上一条不是假绿",
    ).toBe(true);
  });
});

/**
 * Host 内部产物隔离：附件副本清理 + 开关策略（ATTS-1..4）。
 *
 * 钉四件事：
 * 1. 只删 App 自己命名的过期副本（`att-*__*`），用户自己放进该目录的文件一个不动；
 * 2. 目录空了才删；非空保留；
 * 3. 共享工作区才启用（Android 本机 DC-14 依赖 `.codem-attachments` 仍然存在）；
 * 4. 共享工作区关快照、非共享保持开启（与 `snapshotsEnabledForWorkspace` 同一事实）。
 */
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ATTACHMENT_SCRATCH_TTL_MS,
  pruneWorkspaceAttachments,
  shouldManageWorkspaceArtifacts,
  snapshotsEnabledForWorkspace,
} from "../../packages/host/src/workspace-artifacts";

const dirs: string[] = [];

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codem-atts-"));
  dirs.push(dir);
  return dir;
}

/** 把 mtime 拨回两天前（模拟"过期"） */
async function ageFile(file: string): Promise<void> {
  const old = new Date(Date.now() - ATTACHMENT_SCRATCH_TTL_MS * 2);
  await utimes(file, old, old);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ATTS-1 只删过期的 App 附件副本", () => {
  it("旧 att-*__* 删除；新 att-*__* 保留；用户文件保留", async () => {
    const root = await tempWorkspace();
    const dir = join(root, ".codem-attachments");
    await mkdir(dir, { recursive: true });
    const oldAtt = join(dir, "att-old__a.txt");
    const newAtt = join(dir, "att-new__b.txt");
    const userFile = join(dir, "notes.txt");
    await writeFile(oldAtt, "old", "utf8");
    await writeFile(newAtt, "new", "utf8");
    await writeFile(userFile, "mine", "utf8");
    await ageFile(oldAtt);
    await ageFile(userFile);

    const result = await pruneWorkspaceAttachments(root);
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.errors).toEqual([]);
    const left = (await readdir(dir)).sort();
    expect(left).toContain("att-new__b.txt");
    expect(left).toContain("notes.txt");
    expect(left).not.toContain("att-old__a.txt");
  });

  it("符号链接不跟随、不删除", async () => {
    const root = await tempWorkspace();
    const dir = join(root, ".codem-attachments");
    await mkdir(dir, { recursive: true });
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    const link = join(dir, "att-link__x.txt");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, link).catch(() => undefined);
    await ageFile(outside);

    const result = await pruneWorkspaceAttachments(root);
    expect(result.removed).toBe(0);
    await expect(stat(outside)).resolves.toBeTruthy();
  });
});

describe("ATTS-2 目录空了才删", () => {
  it("只剩 App 副本 ⇒ 清空后目录被移除", async () => {
    const root = await tempWorkspace();
    const dir = join(root, ".codem-attachments");
    await mkdir(dir, { recursive: true });
    const att = join(dir, "att-old__a.txt");
    await writeFile(att, "old", "utf8");
    await ageFile(att);

    await pruneWorkspaceAttachments(root);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("还有用户文件 ⇒ 目录保留", async () => {
    const root = await tempWorkspace();
    const dir = join(root, ".codem-attachments");
    await mkdir(dir, { recursive: true });
    const att = join(dir, "att-old__a.txt");
    const userFile = join(dir, "my-notes.md");
    await writeFile(att, "old", "utf8");
    await writeFile(userFile, "mine", "utf8");
    await ageFile(att);
    await ageFile(userFile);

    await pruneWorkspaceAttachments(root);
    const left = await readdir(dir);
    expect(left).toEqual(["my-notes.md"]);
  });

  it("没有该目录 ⇒ 零结果、不创建目录", async () => {
    const root = await tempWorkspace();
    const result = await pruneWorkspaceAttachments(root);
    expect(result).toEqual({ removed: 0, kept: 0, errors: [] });
    await expect(stat(join(root, ".codem-attachments"))).rejects.toThrow();
  });
});

describe("ATTS-3 门控：只有共享桌面工作区才维护内部产物", () => {
  it("shouldManageWorkspaceArtifacts 与 snapshotsEnabledForWorkspace 是同一事实的两面", () => {
    expect(shouldManageWorkspaceArtifacts(true)).toBe(true);
    expect(shouldManageWorkspaceArtifacts(false)).toBe(false);
    expect(snapshotsEnabledForWorkspace(true), "共享工作区：Host 不写快照").toBe(false);
    expect(snapshotsEnabledForWorkspace(false), "Android 本机/开发机手跑：保持原行为").toBe(true);
  });
});

/**
 * Host 共用工作区判据（HWS-1/2）。
 *
 * 这两条守的是 `packages/host` 的共享库行为（Android 本机 Host 仍在用）：
 * 1. **Host 真的用传进来的目录**：`listWorkspaceDir` / `readWorkspaceFile` 对临时项目返回
 *    该项目的文件（不是 Host 的默认空目录）；
 * 2. **换工作区不换数据根**：同一 `dataHome` + 不同 `workspaceRoot` ⇒ 同一个库文件 / 配对文件
 *    （会话、设备都在这下面，所以重启后还在）。
 *
 * 桌面 Host sidecar 已随 ADR-0005 M4 退役：原先的 HWS-3/4（桌面把当前项目交给
 * `host_start`、App 项目切换接线）与 `host_cmd.rs` 的 HC-1..8 不再存在。
 * Android 本机 Host 的启动参数由 `android-shell` 的 `HostSupervisor` 负责。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HostError } from "../../packages/host/src/errors";
import { pairingFile, resolveHostConfig } from "../../packages/host/src/config";
import { listWorkspaceDir, readWorkspaceFile } from "../../packages/host/src/workspace";

const dirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "codem-hws-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# desktop project\n", "utf8");
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(dir, ".env"), "SECRET=not-for-phone\n", "utf8");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("HWS-1 Host 使用传入的工作区（不是默认空目录）", () => {
  it("workspace.list 列出项目的真实文件（目录在前）", async () => {
    const project = tempProject();
    const listing = await listWorkspaceDir(project, ".");
    expect(listing.entries.map((e) => `${e.type}:${e.name}`)).toEqual(
      expect.arrayContaining(["dir:src", "file:README.md", "file:.env"]),
    );
    expect(listing.entries[0].type).toBe("dir");
  });

  it("workspace.read 读到项目的文件；路径逃逸仍被拒绝", async () => {
    const project = tempProject();
    const file = await readWorkspaceFile(project, "src/a.ts");
    expect(file.encoding).toBe("utf8");
    expect(file.text).toContain("export const a = 1");

    await expect(readWorkspaceFile(project, "../outside.txt")).rejects.toBeInstanceOf(HostError);
    await expect(listWorkspaceDir(project, "C:\\Windows")).rejects.toBeInstanceOf(HostError);
  });
});

describe("HWS-2 换工作区重启保留数据根/会话", () => {
  it("同一 dataHome + 不同 workspaceRoot ⇒ 同一个库文件与配对文件", () => {
    const projectA = tempProject();
    const projectB = tempProject();
    const dataHome = tempProject();
    const base = { dataHome, dbBin: process.execPath, port: 0 };
    const a = resolveHostConfig({ overrides: { ...base, workspaceRoot: projectA, workspaceSharedWithDesktop: true } });
    const b = resolveHostConfig({ overrides: { ...base, workspaceRoot: projectB, workspaceSharedWithDesktop: true } });

    expect(a.workspaceRoot).not.toBe(b.workspaceRoot);
    expect(a.dbPath, "库文件跟着 dataHome 走，不跟 workspace 走").toBe(b.dbPath);
    expect(pairingFile(a.dataHome), "配对设备也在 dataHome 下").toBe(pairingFile(b.dataHome));
    expect(a.workspaceSharedWithDesktop).toBe(true);
    expect(b.workspaceSharedWithDesktop).toBe(true);
  });

  it("没有 --workspace-shared 时来源位为 false（Android 本机 Host 不能声称与桌面同一份）", () => {
    const config = resolveHostConfig({
      overrides: { dataHome: tempProject(), dbBin: process.execPath, workspaceRoot: tempProject(), port: 0 },
    });
    expect(config.workspaceSharedWithDesktop).toBe(false);
  });
});

/**
 * 卸载技能的安全契约（用户反馈：技能管理里「删除技能」卡死）
 *
 * 背景与两条必须守住的约束：
 * 1. **删除技能目录不能再走"可能弹系统对话框"的路径。** 旧实现把目录交给
 *    PowerShell + `Microsoft.VisualBasic.FileIO.FileSystem::DeleteDirectory(..., 'OnlyErrorDialogs', 'SendToRecycleBin')`：
 *    一旦该 API 弹出错误/进度对话框（例如文件被占用、目录太大放不进回收站），它就一直等人点，
 *    Tauri 命令永不返回，前端 `await` 永不结束 —— 界面上就是「删除技能」卡死。
 *    现在技能目录走 `delete_directory_permanent`（Rust `remove_dir_all`，无 shell、无对话框）。
 * 2. **删除失败不能谎报成功。** 旧实现 `catch { console.warn }` 后照旧 `return { success: true }`：
 *    界面上技能消失了，磁盘上的文件夹还在，下次启动又被扫回来（"删了又回来"）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteDirectoryPermanent: vi.fn(),
  deleteFile: vi.fn(),
  deletePath: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  getAppDataDir: vi.fn(),
  diagTrail: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  deleteDirectoryPermanent: mocks.deleteDirectoryPermanent,
  deleteFile: mocks.deleteFile,
  deletePath: mocks.deletePath,
  listDirectory: mocks.listDirectory,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  getAppDataDir: mocks.getAppDataDir,
}));

vi.mock("../core/skill/skill-delete-diag", () => ({
  diagTrail: mocks.diagTrail,
}));

import { uninstallSkill } from "../core/skill/installer";
import { getSkillRegistry, type SkillDefinition } from "../core/skill/skill";

function userSkill(name: string, filePath: string): SkillDefinition {
  return {
    name,
    description: "test skill",
    prompt: "body",
    filePath,
    source: "user",
    enabled: true,
    contextMode: "inline",
  } as SkillDefinition;
}

describe("卸载技能 — 永久删除 + 失败不谎报", () => {
  beforeEach(() => {
    mocks.deleteDirectoryPermanent.mockReset().mockResolvedValue(undefined);
    mocks.deleteFile.mockReset().mockResolvedValue(undefined);
    mocks.deletePath.mockReset().mockResolvedValue(undefined);
    mocks.getAppDataDir.mockReset().mockResolvedValue("/appdata/");
    mocks.diagTrail.mockReset();
    // 让 installer 的 getSkillsDir() 走 Tauri 分支（取 appData 下的技能根目录），
    // 这样"越界目标护栏"的判断与真实运行环境一致。
    (window as unknown as Record<string, unknown>).__TAURI__ = {
      core: { invoke: vi.fn().mockResolvedValue(undefined) },
    };
    const registry = getSkillRegistry();
    for (const name of ["uninst-ok", "uninst-fail", "uninst-file", "uninst-builtin", "uninst-timeout", "uninst-root"]) {
      registry.remove(name);
    }
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI__;
  });

  it("UNINST-1: 用户技能走永久删除，且**不**经过回收站命令（卡死的旧路径）", async () => {
    const registry = getSkillRegistry();
    registry.register(userSkill("uninst-ok", "C:\\appdata\\.codem\\skills\\uninst-ok"));

    const result = await uninstallSkill("uninst-ok");

    expect(result.success).toBe(true);
    expect(mocks.deleteDirectoryPermanent).toHaveBeenCalledTimes(1);
    expect(mocks.deleteDirectoryPermanent.mock.calls[0][0]).toBe(
      "C:\\appdata\\.codem\\skills\\uninst-ok",
    );
    // 关键断言：不再有任何调用会走到 delete_directory（回收站）/ deletePath
    expect(mocks.deletePath).not.toHaveBeenCalled();
    expect(registry.get("uninst-ok")).toBeUndefined();
  });

  it("UNINST-2: 目录删不掉时返回失败，并把技能留在注册表里（不许谎报成功）", async () => {
    const registry = getSkillRegistry();
    registry.register(userSkill("uninst-fail", "C:\\appdata\\.codem\\skills\\uninst-fail"));
    mocks.deleteDirectoryPermanent.mockRejectedValue(new Error("拒绝访问"));
    mocks.deleteFile.mockRejectedValue(new Error("不是文件"));

    const result = await uninstallSkill("uninst-fail");

    expect(result.success).toBe(false);
    expect(result.error).toContain("删除失败");
    expect(result.error).toContain("仍保留");
    // 技能仍在：否则界面显示已删除、重启后又被扫描回来
    expect(registry.get("uninst-fail")).toBeDefined();
  });

  it("UNINST-3: provider 技能指向单个文件时，目录删除失败后回退单文件删除", async () => {
    const registry = getSkillRegistry();
    registry.register(userSkill("uninst-file", "C:\\appdata\\.codem\\skills\\provider.js"));
    mocks.deleteDirectoryPermanent.mockRejectedValue(new Error("不是目录"));

    const result = await uninstallSkill("uninst-file");

    expect(result.success).toBe(true);
    expect(mocks.deleteFile).toHaveBeenCalledWith("C:\\appdata\\.codem\\skills\\provider.js");
    expect(registry.get("uninst-file")).toBeUndefined();
  });

  it("UNINST-4: 内置技能与不存在的技能都不落盘删除", async () => {
    const registry = getSkillRegistry();
    registry.register({ ...userSkill("uninst-builtin", "C:\\bundled\\uninst-builtin"), source: "builtin" });

    const builtin = await uninstallSkill("uninst-builtin");
    expect(builtin.success).toBe(false);
    expect(builtin.error).toContain("内置技能不可删除");
    expect(registry.get("uninst-builtin")).toBeDefined();

    const missing = await uninstallSkill("definitely-not-installed");
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("不存在");

    expect(mocks.deleteDirectoryPermanent).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("UNINST-5: 永久删除超时 → 有界失败（不再无限等），技能保留且不重试", async () => {
    vi.useFakeTimers();
    try {
      const registry = getSkillRegistry();
      registry.register(userSkill("uninst-timeout", "C:\\appdata\\.codem\\skills\\uninst-timeout"));
      // 原生调用永不返回（旧路径卡死的形态）
      mocks.deleteDirectoryPermanent.mockImplementation(() => new Promise(() => {}));

      const pending = uninstallSkill("uninst-timeout");
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.error).toContain("没有返回");
      expect(registry.get("uninst-timeout")).toBeDefined();
      // 超时后不再退避重试单文件删除（否则又要等一个超时）
      expect(mocks.deleteFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("UNINST-6: 诊断轨迹先于原生删除落盘（用户报的场景里控制台什么都没有，只能靠落盘）", async () => {
    const registry = getSkillRegistry();
    registry.register(userSkill("uninst-ok", "C:\\appdata\\.codem\\skills\\uninst-ok"));
    mocks.diagTrail.mockClear();

    const order: string[] = [];
    mocks.diagTrail.mockImplementation((event: string) => order.push(`diag:${event}`));
    mocks.deleteDirectoryPermanent.mockImplementation(async () => {
      order.push("native:delete_directory_permanent");
    });

    const result = await uninstallSkill("uninst-ok");

    expect(result.success).toBe(true);
    expect(order[0]).toBe("diag:uninstallSkill entered");
    expect(order).toContain("diag:uninstallSkill deleting");
    expect(order.indexOf("diag:uninstallSkill deleting")).toBeLessThan(
      order.indexOf("native:delete_directory_permanent"),
    );
    expect(order).toContain("diag:uninstallSkill directory removed");
    // 轨迹里必须带路径，否则事后无法判断删的到底是哪个目录
    const deletingCall = mocks.diagTrail.mock.calls.find((c) => c[0] === "uninstallSkill deleting");
    expect(deletingCall?.[1]?.path).toBe("C:\\appdata\\.codem\\skills\\uninst-ok");
  });

  it("UNINST-7: 目标是技能根目录（记录被写坏）时直接拒绝，不落盘删除", async () => {
    const registry = getSkillRegistry();
    registry.register(userSkill("uninst-root", "/appdata/.codem/skills"));

    const result = await uninstallSkill("uninst-root");

    expect(result.success).toBe(false);
    expect(result.error).toContain("拒绝删除");
    expect(mocks.deleteDirectoryPermanent).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    registry.remove("uninst-root");
  });
});

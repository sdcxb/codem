/**
 * 测试：Git Worktree 环境 — WTR-001 ~ WTR-035
 *
 * 覆盖范围：
 *   6.1 Worktree 创建与生命周期
 *   6.2 Worktree 配额与清理
 *   6.3 Worktree 与执行模式集成
 *
 * 关键 Mock：executeCommand (所有 git 命令通过 PowerShell 执行)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock file-api — use vi.hoisted to ensure mock vars are available when factory runs
const { mockExecuteCommand, mockExists } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  mockExists: vi.fn(),
}));
vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  exists: mockExists,
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: vi.fn(),
  grepSearch: vi.fn(),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import {
  isGitRepo,
  getCurrentBranch,
  listBranches,
  hasUncommittedChanges,
  getWorktreeRoot,
  createWorktree,
  removeWorktree,
  scanWorktrees,
  enforceMaxWorktrees,
  getWorktreeCount,
  getWorktreeSettings,
  setWorktreeSettings,
  getProjectExecutionMode,
  setProjectExecutionMode,
} from "../core/environment/worktree-manager";
import { getSettingJSON, setSettingJSON, removeSetting } from "../core/storage/settings";
import { initDatabase, resetDatabase } from "../core/storage/database";

describe("Git Worktree — 路径处理工具", () => {
  // WTR-009
  it("WTR-009: psQuote 转义单引号逻辑存在于源码中", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/environment/worktree-manager.ts"), "utf-8");
    expect(src).toContain("function psQuote");
    expect(src).toContain("''");
  });

  // WTR-010
  it("WTR-010: normalizePath 规范化路径分隔符逻辑存在于源码中", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/environment/worktree-manager.ts"), "utf-8");
    expect(src).toContain("function normalizePath");
  });

  // WTR-008
  it("WTR-008: getWorktreeRoot 返回正确路径", () => {
    const root = getWorktreeRoot("D:/projects/myapp");
    expect(root).toContain(".codem-worktrees");
    expect(root).toContain("myapp");
  });
});

describe("Git Worktree — Git 命令封装", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { resetDatabase(); } catch { initDatabase(); }
    localStorage.clear();
  });

  // WTR-011
  it("WTR-011: isGitRepo — git 仓库返回 true", async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: "true\n", stderr: "", exitCode: 0 });
    const result = await isGitRepo("D:/test");
    expect(result).toBe(true);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      expect.stringContaining("git -C"),
      "D:/test"
    );
    expect(mockExecuteCommand.mock.calls[0][0]).toContain("rev-parse --is-inside-work-tree");
  });

  it("WTR-011b: isGitRepo — 非 git 仓库返回 false", async () => {
    mockExecuteCommand.mockRejectedValue(new Error("not a git repo"));
    const result = await isGitRepo("D:/notgit");
    expect(result).toBe(false);
  });

  // WTR-012
  it("WTR-012: getCurrentBranch — 返回当前分支名", async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: "main\n", stderr: "", exitCode: 0 });
    const branch = await getCurrentBranch("D:/test");
    expect(branch).toBe("main");
  });

  it("WTR-012b: getCurrentBranch — detached HEAD 返回短哈希", async () => {
    mockExecuteCommand
      .mockResolvedValueOnce({ stdout: "\n", stderr: "", exitCode: 0 }) // branch --show-current empty
      .mockResolvedValueOnce({ stdout: "abc1234\n", stderr: "", exitCode: 0 }); // rev-parse --short HEAD
    const branch = await getCurrentBranch("D:/test");
    expect(branch).toBe("(abc1234)");
  });

  it("WTR-012c: getCurrentBranch — 失败返回 unknown", async () => {
    mockExecuteCommand.mockRejectedValue(new Error("fail"));
    const branch = await getCurrentBranch("D:/fail");
    expect(branch).toBe("unknown");
  });

  // WTR-020
  it("WTR-020: listBranches — 返回分支名数组", async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: "main\nfeature-x\ndev\n", stderr: "", exitCode: 0 });
    const branches = await listBranches("D:/test");
    expect(branches).toHaveLength(3);
    expect(branches).toContain("main");
    expect(branches).toContain("feature-x");
    expect(branches).toContain("dev");
  });

  it("WTR-020b: listBranches — 空输出返回空数组", async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const branches = await listBranches("D:/test");
    expect(branches).toHaveLength(0);
  });

  // WTR-019
  it("WTR-019: hasUncommittedChanges — 有修改返回 true", async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: " M file.txt\n?? new.txt\n", stderr: "", exitCode: 0 });
    const result = await hasUncommittedChanges("D:/test");
    expect(result).toBe(true);
  });

  it("WTR-019b: hasUncommittedChanges — 无修改返回 false", async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await hasUncommittedChanges("D:/test");
    expect(result).toBe(false);
  });
});

describe("Git Worktree — 创建与移除", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { resetDatabase(); } catch { initDatabase(); }
    localStorage.clear();
  });

  // WTR-001
  it("WTR-001: createWorktree 基本流程", async () => {
    mockExists.mockResolvedValue(false); // worktree doesn't exist yet
    mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const path = await createWorktree("D:/project", "session-123");
    expect(path).toContain(".codem-worktrees");
    expect(path).toContain("session-123");
    expect(mockExecuteCommand).toHaveBeenCalled();
    // Verify git worktree add command was called
    const cmd = mockExecuteCommand.mock.calls[0][0];
    expect(cmd).toContain("worktree add");
    expect(cmd).toContain("--detach");
  });

  // WTR-002
  it("WTR-002: createWorktree 指定分支", async () => {
    mockExists.mockResolvedValue(false);
    mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await createWorktree("D:/project", "session-123", "feature-x");
    const cmd = mockExecuteCommand.mock.calls[0][0];
    expect(cmd).toContain("feature-x");
    expect(cmd).toContain("worktree add");
  });

  // WTR-003
  it("WTR-003: worktree 已存在且是 git 仓库——复用", async () => {
    mockExists.mockResolvedValue(true);
    mockExecuteCommand
      .mockResolvedValueOnce({ stdout: "true\n", stderr: "", exitCode: 0 }) // isGitRepo
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }); // checkout if branch

    const path = await createWorktree("D:/project", "session-123", "main");
    expect(path).toContain("session-123");
  });

  // WTR-004
  it("WTR-004: worktree 已存在但非 git——抛出错误", async () => {
    mockExists.mockResolvedValue(true);
    mockExecuteCommand.mockResolvedValue({ stdout: "false\n", stderr: "", exitCode: 0 }); // not a git repo

    await expect(createWorktree("D:/project", "session-123")).rejects.toThrow(
      "Target exists and is not a git worktree"
    );
  });

  // WTR-005
  it("WTR-005: removeWorktree — git worktree remove 成功", async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await removeWorktree("D:/project", "D:/project/.codem-worktrees/session-1");
    expect(mockExecuteCommand).toHaveBeenCalled();
    const cmd = mockExecuteCommand.mock.calls[0][0];
    expect(cmd).toContain("worktree remove");
    expect(cmd).toContain("--force");
  });

  it("WTR-005b: removeWorktree — git remove 失败时用 PowerShell 清理", async () => {
    mockExecuteCommand
      .mockRejectedValueOnce(new Error("git remove failed")) // git worktree remove fails
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }); // PowerShell Remove-Item
    await removeWorktree("D:/project", "D:/project/.codem-worktrees/session-1");
    // Should have called executeCommand at least twice
    expect(mockExecuteCommand.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Git Worktree — 扫描与配额", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { resetDatabase(); } catch { initDatabase(); }
    localStorage.clear();
  });

  // WTR-007
  it("WTR-007: scanWorktrees 返回 WorktreeInfo 数组", async () => {
    mockExists.mockResolvedValue(true);
    // Get-ChildItem returns dirs
    mockExecuteCommand
      .mockResolvedValueOnce({ stdout: "D:/wt/sess-1\nD:/wt/sess-2\n", stderr: "", exitCode: 0 }) // Get-ChildItem
      .mockResolvedValueOnce({ stdout: "true\n", stderr: "", exitCode: 0 }) // isGitRepo sess-1
      .mockResolvedValueOnce({ stdout: "main\n", stderr: "", exitCode: 0 }) // branch sess-1
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // hasUncommitted sess-1
      .mockResolvedValueOnce({ stdout: "2024-01-01T00:00:00.000Z", stderr: "", exitCode: 0 }) // creationTime sess-1
      .mockResolvedValueOnce({ stdout: "true\n", stderr: "", exitCode: 0 }) // isGitRepo sess-2
      .mockResolvedValueOnce({ stdout: "dev\n", stderr: "", exitCode: 0 }) // branch sess-2
      .mockResolvedValueOnce({ stdout: " M file\n", stderr: "", exitCode: 0 }) // hasUncommitted sess-2
      .mockResolvedValueOnce({ stdout: "2024-01-02T00:00:00.000Z", stderr: "", exitCode: 0 }); // creationTime sess-2

    const worktrees = await scanWorktrees("D:/wt");
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].sessionId).toBe("sess-1");
    expect(worktrees[1].sessionId).toBe("sess-2");
  });

  it("WTR-007b: scanWorktrees — root 不存在返回空数组", async () => {
    mockExists.mockResolvedValue(false);
    const worktrees = await scanWorktrees("D:/nonexistent");
    expect(worktrees).toHaveLength(0);
  });

  // WTR-015
  it("WTR-015: getWorktreeSettings 返回默认值", () => {
    removeSetting("codem-worktree-settings");
    const settings = getWorktreeSettings();
    expect(settings.maxWorktrees).toBe(30);
    expect(settings.autoCleanOldest).toBe(true);
    expect(settings.warnOnDirty).toBe(true);
  });

  it("WTR-015b: setWorktreeSettings 合并用户设置", () => {
    setWorktreeSettings({ maxWorktrees: 20 });
    const settings = getWorktreeSettings();
    expect(settings.maxWorktrees).toBe(20);
    expect(settings.autoCleanOldest).toBe(true); // still default
  });

  // WTR-017
  it("WTR-017: autoCleanOldest=false 时不清理", async () => {
    setWorktreeSettings({ autoCleanOldest: false });
    mockExists.mockResolvedValue(true);
    mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const cleaned = await enforceMaxWorktrees("D:/wt");
    expect(cleaned).toBe(0);
  });
});

describe("Git Worktree — 执行模式", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { resetDatabase(); } catch { initDatabase(); }
    localStorage.clear();
  });

  // WTR-021
  it("WTR-021: getProjectExecutionMode 默认返回 current_workspace", () => {
    const mode = getProjectExecutionMode("D:/project");
    expect(mode).toBe("current_workspace");
  });

  // WTR-022
  it("WTR-022: setProjectExecutionMode 设置 git_worktree", () => {
    setProjectExecutionMode("D:/project", "git_worktree");
    expect(getProjectExecutionMode("D:/project")).toBe("git_worktree");
  });

  it("WTR-022b: 不同项目不同执行模式", () => {
    setProjectExecutionMode("D:/projectA", "git_worktree");
    setProjectExecutionMode("D:/projectB", "current_workspace");
    expect(getProjectExecutionMode("D:/projectA")).toBe("git_worktree");
    expect(getProjectExecutionMode("D:/projectB")).toBe("current_workspace");
  });

  it("WTR-022c: setProjectExecutionMode 覆盖已有模式", () => {
    setProjectExecutionMode("D:/project", "git_worktree");
    setProjectExecutionMode("D:/project", "current_workspace");
    expect(getProjectExecutionMode("D:/project")).toBe("current_workspace");
  });
});

describe("Git Worktree — 与对话/工具集成", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { resetDatabase(); } catch { initDatabase(); }
    localStorage.clear();
  });

  it("WTR-026: worktree 路径作为 cwd 的逻辑存在于 App.tsx", () => {
    const fs = require("fs");
    const path = require("path");
    const appSrc = fs.readFileSync(path.join(__dirname, "../App.tsx"), "utf-8");
    // Verify worktree path is used as cwd
    expect(appSrc).toContain("session.worktreePath");
    expect(appSrc).toContain("cwd = session.worktreePath");
    expect(appSrc).toContain("executionMode");
    expect(appSrc).toContain("git_worktree");
  });

  it("WTR-025: worktree 创建失败回退逻辑存在于 App.tsx", () => {
    const fs = require("fs");
    const path = require("path");
    const appSrc = fs.readFileSync(path.join(__dirname, "../App.tsx"), "utf-8");
    expect(appSrc).toContain("Failed to create worktree");
    expect(appSrc).toContain("falling back to project dir");
  });

  it("WTR-029: fork 会话创建 worktree 逻辑存在于 store.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const storeSrc = fs.readFileSync(path.join(__dirname, "../core/store.ts"), "utf-8");
    expect(storeSrc).toContain("forkSession");
    expect(storeSrc).toContain("createWorktreeSync");
    expect(storeSrc).toContain("executionMode");
  });

  it("WTR-030: 删除会话清理 worktree 逻辑存在于 store.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const storeSrc = fs.readFileSync(path.join(__dirname, "../core/store.ts"), "utf-8");
    expect(storeSrc).toContain("removeWorktreeSync");
    expect(storeSrc).toContain("deleteSession");
  });

  it("WTR-034: GitConfig 注入 system prompt 逻辑存在于 prompt.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const promptSrc = fs.readFileSync(path.join(__dirname, "../core/prompt/prompt.ts"), "utf-8");
    expect(promptSrc).toContain("gitConfig");
    expect(promptSrc).toContain("GitConfig");
  });

  it("WTR-035: 跨会话委派在 worktree 下的隔离逻辑存在于 executor.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const executorSrc = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(executorSrc).toContain("cwd");
    expect(executorSrc).toContain("sessionId");
  });
});

describe("Git Worktree — Session 类型字段", () => {
  it("WTR-023: Session 类型包含 worktreePath/executionMode/worktreeBranch 字段", () => {
    const fs = require("fs");
    const path = require("path");
    const typesSrc = fs.readFileSync(path.join(__dirname, "../core/types.ts"), "utf-8");
    expect(typesSrc).toContain("worktreePath");
    expect(typesSrc).toContain("executionMode");
    expect(typesSrc).toContain("worktreeBranch");
    expect(typesSrc).toContain("git_worktree");
    expect(typesSrc).toContain("current_workspace");
  });
});

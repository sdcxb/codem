/**
 * Git Worktree Manager — Cross-Platform (Windows/PowerShell Compatible)
 *
 * 对标 wecode-ref 的 worktree 管理体系：
 * - createWorktree: `git worktree add --detach <path> [branch]`
 * - removeWorktree: `git worktree remove --force` + PowerShell Remove-Item
 * - scanWorktrees: PowerShell Get-ChildItem -Directory
 * - hasUncommittedChanges: `git status --porcelain`
 * - enforceMaxWorktrees: LRU 清理最旧 worktree（默认上限 15）
 *
 * ★ Windows 编码兼容方案：
 * - 所有命令通过 executeCommand → Rust 后端统一用 PowerShell 执行
 * - Rust 后端已设置 chcp 65001 + UTF-8 encoding（lib.rs execute_command）
 * - 路径参数用单引号包裹（PowerShell 单引号不解析变量/转义）
 *   → 防止路径中的空格、中文、特殊字符导致命令注入
 * - 单引号内的单引号用 '' 转义（PowerShell 标准）
 * - 不使用双引号（PowerShell 双引号会解析 $variables）
 * - 不使用 CMD 语法（if exist, del 等）— 只有 PowerShell
 * - 不使用 Unix 命令（find, stat, rm, test）— 全部 PowerShell 等价
 *
 * 路径规则：{projectPath}/.codem-worktrees/{sessionId}/
 */

import { executeCommand, exists } from "../file-api";
import { getSettingJSON, setSettingJSON } from "../storage/settings";

// Platform detection for cross-platform path handling
const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Win");

// ========== Cross-Platform Helpers ==========

/**
 * Escape a path for safe use in PowerShell single-quoted strings.
 * PowerShell escapes single quotes by doubling them: 'C:\it''s here'
 * Single quotes in PowerShell = literal string, no variable interpolation.
 */
function psQuote(p: string): string {
  return p.replace(/'/g, "''");
}

/**
 * Normalize path separators to forward slashes for consistent JS-side parsing.
 * PowerShell and git both accept mixed separators, so this is for our convenience.
 */
function normalizePath(p: string): string {
  return p.replace(/\\+/g, "/").replace(/\/+$/g, "");
}

// ========== Types ==========

export type ExecutionMode = "current_workspace" | "git_worktree";

export interface WorktreeInfo {
  sessionId: string;
  path: string;
  branch: string;
  createdAt: number;
  hasUncommitted: boolean;
}

export interface WorktreeSettings {
  maxWorktrees: number;
  autoCleanOldest: boolean;
  warnOnDirty: boolean;
}

const DEFAULT_SETTINGS: WorktreeSettings = {
  maxWorktrees: 15,
  autoCleanOldest: true,
  warnOnDirty: true,
};

const WORKTREE_DIR_NAME = ".codem-worktrees";
const SETTINGS_KEY = "codem-worktree-settings";

// ========== Settings ==========

export function getWorktreeSettings(): WorktreeSettings {
  try {
    const stored = getSettingJSON<Partial<WorktreeSettings>>(SETTINGS_KEY, {});
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function setWorktreeSettings(settings: Partial<WorktreeSettings>): void {
  const current = getWorktreeSettings();
  const updated = { ...current, ...settings };
  setSettingJSON(SETTINGS_KEY, updated);
  window.dispatchEvent(new CustomEvent("codem-worktree-settings-changed"));
}

// ========== Core Git Operations ==========
// All git commands use: git -C 'path' <subcommand>
// Single-quoted paths prevent injection and handle spaces/CJK characters.

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const result = await executeCommand(
      `git -C '${psQuote(path)}' rev-parse --is-inside-work-tree`,
      path
    );
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function getCurrentBranch(path: string): Promise<string> {
  try {
    const result = await executeCommand(
      `git -C '${psQuote(path)}' branch --show-current`,
      path
    );
    const branch = result.stdout.trim();
    if (branch) return branch;
    // Detached HEAD — show short commit
    const revResult = await executeCommand(
      `git -C '${psQuote(path)}' rev-parse --short HEAD`,
      path
    );
    return `(${revResult.stdout.trim()})`;
  } catch {
    return "unknown";
  }
}

export async function listBranches(path: string): Promise<string[]> {
  try {
    const result = await executeCommand(
      `git -C '${psQuote(path)}' branch --format=%(refname:short)`,
      path
    );
    return result.stdout
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
  } catch {
    return [];
  }
}

export async function hasUncommittedChanges(path: string): Promise<boolean> {
  try {
    const result = await executeCommand(
      `git -C '${psQuote(path)}' status --porcelain`,
      path
    );
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ========== Worktree Lifecycle ==========

export function getWorktreeRoot(projectPath: string): string {
  // Always normalize to forward slashes first for consistent JS-side processing
  const normalized = normalizePath(projectPath);
  if (isWindows) {
    // Convert to Windows native backslash for git/PowerShell compatibility
    return `${normalized.replace(/\//g, "\\")}\\${WORKTREE_DIR_NAME}`;
  }
  return `${normalized}/${WORKTREE_DIR_NAME}`;
}

export async function createWorktree(
  projectPath: string,
  sessionId: string,
  branch?: string
): Promise<string> {
  const worktreeRoot = getWorktreeRoot(projectPath);
  const sep = isWindows ? "\\" : "/";
  const worktreePath = `${worktreeRoot}${sep}${sessionId}`;

  // Check if already exists (uses Tauri path_exists — no shell command needed)
  if (await exists(worktreePath)) {
    const isWorktree = await isGitRepo(worktreePath);
    if (isWorktree) {
      if (branch) {
        await executeCommand(
          `git -C '${psQuote(worktreePath)}' checkout --force --detach '${psQuote(branch)}'`,
          worktreePath
        );
      }
      return worktreePath;
    }
    throw new Error(`Target exists and is not a git worktree: ${worktreePath}`);
  }

  // git worktree add --detach <path> [branch]
  const safeProject = psQuote(projectPath);
  const safeWorktree = psQuote(worktreePath);
  const cmd = branch
    ? `git -C '${safeProject}' worktree add --detach '${safeWorktree}' '${psQuote(branch)}'`
    : `git -C '${safeProject}' worktree add --detach '${safeWorktree}'`;

  const result = await executeCommand(cmd, projectPath);
  if (result.exitCode && result.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr}`);
  }

  // Enforce max worktree limit after creating
  await enforceMaxWorktrees(worktreeRoot);

  return worktreePath;
}

export async function removeWorktree(
  sourcePath: string,
  worktreePath: string
): Promise<void> {
  const safeSource = psQuote(sourcePath);
  const safeWorktree = psQuote(worktreePath);

  // Try git worktree remove first
  try {
    await executeCommand(
      `git -C '${safeSource}' worktree remove --force '${safeWorktree}'`,
      sourcePath
    );
  } catch {
    // If git worktree remove fails, fall through to directory cleanup
  }

  // Best-effort directory cleanup using PowerShell Remove-Item
  // -LiteralPath: treats the path literally (no wildcard expansion)
  // -ErrorAction SilentlyContinue: don't throw if already gone
  try {
    await executeCommand(
      `Remove-Item -LiteralPath '${safeWorktree}' -Recurse -Force -ErrorAction SilentlyContinue`
    );
  } catch {
    // Ignore — directory may already be gone
  }
}

export async function scanWorktrees(
  worktreeRoot: string
): Promise<WorktreeInfo[]> {
  const rootExists = await exists(worktreeRoot);
  if (!rootExists) return [];

  try {
    // PowerShell: Get-ChildItem -Directory returns only directories
    // -LiteralPath: handles paths with spaces, CJK, special chars
    const safeRoot = psQuote(worktreeRoot);
    const result = await executeCommand(
      `Get-ChildItem -LiteralPath '${safeRoot}' -Directory | Select-Object -ExpandProperty FullName`,
      worktreeRoot
    );
    const dirs = result.stdout
      .split("\n")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    const infos: WorktreeInfo[] = [];
    for (const dir of dirs) {
      const normalizedDir = normalizePath(dir);
      const sessionId = normalizedDir.split("/").pop() || "";
      if (!await isGitRepo(dir)) continue;

      const branch = await getCurrentBranch(dir);
      const dirty = await hasUncommittedChanges(dir);

      // Get creation time via PowerShell: (Get-Item).CreationTime
      let createdAt = Date.now();
      try {
        const statResult = await executeCommand(
          `(Get-Item -LiteralPath '${psQuote(dir)}').CreationTime.ToString('o')`,
          dir
        );
        const dateStr = statResult.stdout.trim();
        if (dateStr) {
          const ts = Date.parse(dateStr);
          if (!isNaN(ts)) {
            createdAt = ts;
          }
        }
      } catch {
        // Fallback to now
      }

      infos.push({
        sessionId,
        path: dir,
        branch,
        createdAt,
        hasUncommitted: dirty,
      });
    }

    // Sort by creation time (oldest first)
    return infos.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function enforceMaxWorktrees(
  worktreeRoot: string,
  activeSessionIds: Set<string> = new Set()
): Promise<number> {
  const settings = getWorktreeSettings();
  if (!settings.autoCleanOldest) return 0;

  const worktrees = await scanWorktrees(worktreeRoot);
  if (worktrees.length <= settings.maxWorktrees) return 0;

  let cleaned = 0;
  for (const wt of worktrees) {
    if (worktrees.length - cleaned <= settings.maxWorktrees) break;
    if (activeSessionIds.has(wt.sessionId)) continue;
    if (settings.warnOnDirty && wt.hasUncommitted) continue;

    try {
      // Find the source repo (parent of worktreeRoot)
      const sourcePath = normalizePath(worktreeRoot).replace(/\/[^/]+$/, "");
      await removeWorktree(sourcePath, wt.path);
      cleaned++;
    } catch {
      // Continue even if one fails
    }
  }

  return cleaned;
}

export async function getWorktreeCount(projectPath: string): Promise<number> {
  const worktreeRoot = getWorktreeRoot(projectPath);
  const worktrees = await scanWorktrees(worktreeRoot);
  return worktrees.length;
}

// ========== Execution Mode Preferences ==========

export function getProjectExecutionMode(projectPath: string): ExecutionMode {
  try {
    const prefs = getSettingJSON<Record<string, ExecutionMode>>(
      "codem-project-execution-modes",
      {}
    );
    return prefs[projectPath] || "current_workspace";
  } catch {
    return "current_workspace";
  }
}

export function setProjectExecutionMode(
  projectPath: string,
  mode: ExecutionMode
): void {
  try {
    const prefs = getSettingJSON<Record<string, ExecutionMode>>(
      "codem-project-execution-modes",
      {}
    );
    prefs[projectPath] = mode;
    setSettingJSON("codem-project-execution-modes", prefs);
    window.dispatchEvent(
      new CustomEvent("codem-execution-mode-changed", {
        detail: { projectPath, mode },
      })
    );
  } catch (e) {
    console.error("[WorktreeManager] Failed to set execution mode:", e);
  }
}

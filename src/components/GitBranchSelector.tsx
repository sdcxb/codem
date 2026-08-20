/**
 * GitBranchSelector — Git 分支选择器
 *
 * 在标题栏或侧边栏中嵌入的紧凑型 Git 分支管理组件。
 * 支持：
 * - 显示当前分支 + 脏状态指示
 * - 下拉切换本地分支
 * - 创建新分支
 * - 快速 stash / pop
 *
 * 使用 Tauri execute_command 执行 Git 操作。
 * CSS 变量驱动，自动适配三套皮肤。
 */

import { useState, useEffect, useCallback, memo, useRef } from "react";
import { GitBranch, Check, Plus, LoaderCircle, CircleDot, AlertCircle, ChevronDown } from "lucide-react";
import { executeCommand } from "../core/file-api";
import { useProjectStore } from "../core/store";

interface BranchInfo {
  name: string;
  current: boolean;
  isDirty?: boolean;
}

interface GitBranchSelectorProps {
  /** 自定义工作目录（默认使用当前项目路径） */
  cwd?: string;
  /** 紧凑模式（只显示图标） */
  compact?: boolean;
  /** 刷新间隔（毫秒，0 表示不自动刷新） */
  refreshInterval?: number;
}

export const GitBranchSelector = memo(function GitBranchSelector({
  cwd,
  compact = false,
  refreshInterval = 0,
}: GitBranchSelectorProps) {
  const { currentProject, currentSession } = useProjectStore();
  const workDir = cwd || currentSession?.worktreePath || currentProject?.path || "";
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [currentBranch, setCurrentBranch] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [error, setError] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!workDir) return;
    setLoading(true);
    setError("");
    try {
      const safeDir = workDir.replace(/'/g, "''");
      // 先检查是否是 git 仓库
      const isGitResult = await executeCommand(
        `git -C '${safeDir}' rev-parse --is-inside-work-tree`
      );
      if (isGitResult.stdout.trim() !== "true") {
        // 不是 git 仓库 — 清空状态，不报错
        setCurrentBranch("");
        setBranches([]);
        setIsDirty(false);
        return;
      }
      // 获取当前分支
      const branchResult = await executeCommand(
        `git -C '${safeDir}' rev-parse --abbrev-ref HEAD`
      );
      const branch = branchResult.stdout.trim();
      setCurrentBranch(branch);

      // 获取脏状态
      const statusResult = await executeCommand(
        `git -C '${safeDir}' status --porcelain`
      );
      setIsDirty(statusResult.stdout.trim().length > 0);

      // 获取所有本地分支
      const branchListResult = await executeCommand(
        `git -C '${safeDir}' branch --format='%(refname:short)'`
      );
      const allBranches = branchListResult.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((name) => ({
          name: name.trim(),
          current: name.trim() === branch,
        }));
      setBranches(allBranches);
    } catch (err: any) {
      // git 命令失败 — 可能不是 git 仓库，静默处理
      setCurrentBranch("");
      setBranches([]);
      setIsDirty(false);
    } finally {
      setLoading(false);
    }
  }, [workDir]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 自动刷新 — 仅在有分支时才定时刷新（避免非 git 仓库时频繁重试）
  useEffect(() => {
    if (refreshInterval > 0 && currentBranch) {
      const timer = setInterval(refresh, refreshInterval);
      return () => clearInterval(timer);
    }
  }, [refreshInterval, refresh, currentBranch]);

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setShowCreateInput(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 自动聚焦新分支输入框
  useEffect(() => {
    if (showCreateInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showCreateInput]);

  const handleCheckout = useCallback(async (branchName: string) => {
    if (!workDir || branchName === currentBranch) {
      setShowDropdown(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const safeDir = workDir.replace(/'/g, "''");
      await executeCommand(`git -C '${safeDir}' checkout '${branchName}'`);
      setCurrentBranch(branchName);
      setBranches((prev) =>
        prev.map((b) => ({ ...b, current: b.name === branchName }))
      );
      setShowDropdown(false);
    } catch (err: any) {
      setError(err.stderr || err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [workDir, currentBranch]);

  const handleCreateBranch = useCallback(async () => {
    if (!workDir || !newBranchName.trim()) return;
    setLoading(true);
    setError("");
    try {
      const safeDir = workDir.replace(/'/g, "''");
      const branchName = newBranchName.trim().replace(/\s+/g, "-");
      await executeCommand(`git -C '${safeDir}' checkout -b '${branchName}'`);
      setCurrentBranch(branchName);
      setBranches((prev) => [
        { name: branchName, current: true },
        ...prev.map((b) => ({ ...b, current: false })),
      ]);
      setNewBranchName("");
      setShowCreateInput(false);
      setShowDropdown(false);
    } catch (err: any) {
      setError(err.stderr || err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [workDir, newBranchName]);

  if (!workDir) {
    // Bug2: 不返回 null（会导致按钮消失），显示占位状态
    return (
      <div className="git-branch-selector" ref={dropdownRef}>
        <button
          className="git-branch-btn clean"
          disabled
          title="No repository"
        >
          <GitBranch size={14} />
          {!compact && (
            <span className="git-branch-name">No Git</span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="git-branch-selector" ref={dropdownRef}>
      <button
        className={`git-branch-btn ${isDirty ? "dirty" : "clean"} ${compact ? "compact" : ""}`}
        onClick={() => setShowDropdown((s) => !s)}
        title={error || currentBranch}
        disabled={loading}
      >
        {loading ? (
          <LoaderCircle size={14} className="spinning" />
        ) : isDirty ? (
          <CircleDot size={14} />
        ) : (
          <GitBranch size={14} />
        )}
        {!compact && (
          <>
            <span className="git-branch-name">{currentBranch || "—"}</span>
            <ChevronDown size={10} />
          </>
        )}
      </button>

      {showDropdown && (
        <div className="git-branch-dropdown">
          {error && (
            <div className="git-branch-error">
              <AlertCircle size={12} />
              <span>{error}</span>
            </div>
          )}

          {showCreateInput ? (
            <div className="git-branch-create">
              <input
                ref={inputRef}
                className="git-branch-input"
                placeholder="新分支名称..."
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateBranch();
                  if (e.key === "Escape") setShowCreateInput(false);
                }}
              />
              <button
                className="git-branch-create-btn"
                onClick={handleCreateBranch}
                disabled={!newBranchName.trim() || loading}
              >
                <Check size={12} />
              </button>
            </div>
          ) : (
            <>
              <div className="git-branch-list">
                {branches.map((b) => (
                  <button
                    key={b.name}
                    className={`git-branch-item ${b.current ? "current" : ""}`}
                    onClick={() => handleCheckout(b.name)}
                    disabled={b.current}
                  >
                    {b.current ? (
                      <Check size={12} />
                    ) : (
                      <GitBranch size={12} />
                    )}
                    <span>{b.name}</span>
                  </button>
                ))}
              </div>
              <button
                className="git-branch-new-btn"
                onClick={() => setShowCreateInput(true)}
              >
                <Plus size={12} />
                <span>新建分支</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
});

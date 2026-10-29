/**
 * Git Info Panel — Environment monitoring
 *
 * Shows:
 * - Branch selector (current branch + switch + create, merged from TitleBar)
 * - Dirty status
 * - Diff shortstat (insertions/deletions)
 * - Recent commits (last 5)
 * - Commit + push quick actions
 *
 * Designed to be embedded in RightSidebar or a bottom panel.
 */

import { useState, useEffect, useCallback } from "react";
import { executeCommand } from "../core/file-api";
import { mergeWorktreeToProject, removeWorktree, conflictAbsolutePath } from "../core/environment";
import { openFileDirectly } from "../utils/file-link";
import { confirmDialog } from "../core/ui/native-dialog";
import { useProjectStore } from "../core/store";
import { useLang } from "../core/i18n/lang";
import { onAutoCommitted } from "../core/environment/git-commit-service";
import { GitBranchSelector } from "./GitBranchSelector";

interface GitStatus {
  branch: string;
  isDirty: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  insertions: number;
  deletions: number;
}

interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export function GitInfoPanel() {
  const lang = useLang();
  const zh = lang === "zh";
  const { currentProject, currentSession } = useProjectStore();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);
  const [fileChoices, setFileChoices] = useState<Record<string, "worktree" | "main">>({});

  // Monitor the worktree path if session is in worktree mode, otherwise project path
  const projectPath = currentSession?.worktreePath || currentProject?.path;

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setStatus(null);
      setCommits([]);
      return;
    }

    setLoading(true);
    const safePath = projectPath.replace(/'/g, "''");

    try {
      // Get branch
      const branchResult = await executeCommand(
        `git -C '${safePath}' branch --show-current`,
        projectPath
      );
      const branch = branchResult.stdout.trim() || "(detached)";

      // Get porcelain status
      const statusResult = await executeCommand(
        `git -C '${safePath}' status --porcelain`,
        projectPath
      );
      const lines = statusResult.stdout.trim().split("\n").filter(l => l.trim());

      let staged = 0, unstaged = 0, untracked = 0;
      for (const line of lines) {
        const x = line[0];
        const y = line[1];
        if (x === "?") untracked++;
        else {
          if (x !== " " && x !== "?") staged++;
          if (y !== " " && y !== "?") unstaged++;
        }
      }

      // Get diff shortstat
      const diffResult = await executeCommand(
        `git -C '${safePath}' diff --shortstat`,
        projectPath
      );
      const diffText = diffResult.stdout.trim();
      let insertions = 0, deletions = 0;
      const insMatch = diffText.match(/(\d+) insertion/);
      const delMatch = diffText.match(/(\d+) deletion/);
      if (insMatch) insertions = parseInt(insMatch[1]);
      if (delMatch) deletions = parseInt(delMatch[1]);

      setStatus({
        branch,
        isDirty: lines.length > 0,
        stagedCount: staged,
        unstagedCount: unstaged,
        untrackedCount: untracked,
        insertions,
        deletions,
      });

      // Get recent commits
      const logResult = await executeCommand(
        `git -C '${safePath}' log --oneline -5 --format="%h|%s|%an|%cr"`,
        projectPath
      );
      const commitLines = logResult.stdout.trim().split("\n").filter(l => l.trim());
      setCommits(commitLines.map(line => {
        const [hash, message, author, date] = line.split("|");
        return { hash: hash || "", message: message || "", author: author || "", date: date || "" };
      }));
    } catch (e) {
      console.error("[GitInfoPanel] refresh failed:", e);
      setStatus(null);
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  // GitBranchSelector 切换/新建分支成功后联动刷新本面板（分支/统计/提交历史）
  const handleBranchChange = useCallback(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000); // Auto-refresh every 10s
    // P1-5: Refresh when auto-commit happens
    const unsubscribe = onAutoCommitted(() => refresh());
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, [refresh]);

  const handleCommit = async () => {
    if (!projectPath || !commitMsg.trim()) return;
    const safePath = projectPath.replace(/'/g, "''");
    const safeMsg = commitMsg.replace(/'/g, "''");
    try {
      await executeCommand(`git -C '${safePath}' add -A`, projectPath);
      const result = await executeCommand(
        `git -C '${safePath}' commit -m '${safeMsg}'`,
        projectPath
      );
      if (result.exitCode && result.exitCode !== 0) {
        setActionResult(`❌ ${result.stderr}`);
      } else {
        setActionResult(`✅ ${zh ? "提交成功" : "Committed"}`);
        setCommitMsg("");
        refresh();
      }
    } catch (e: any) {
      setActionResult(`❌ ${e?.message || e}`);
    }
    setTimeout(() => setActionResult(null), 5000);
  };

  const handlePush = async () => {
    if (!projectPath) return;
    const safePath = projectPath.replace(/'/g, "''");
    try {
      const result = await executeCommand(
        `git -C '${safePath}' push`,
        projectPath
      );
      if (result.exitCode && result.exitCode !== 0) {
        setActionResult(`❌ ${result.stderr}`);
      } else {
        setActionResult(`✅ ${zh ? "推送成功" : "Pushed"}`);
        refresh();
      }
    } catch (e: any) {
      setActionResult(`❌ ${e?.message || e}`);
    }
    setTimeout(() => setActionResult(null), 5000);
  };

  const handlePull = async () => {
    if (!projectPath) return;
    const safePath = projectPath.replace(/'/g, "''");
    try {
      const result = await executeCommand(
        `git -C '${safePath}' pull`,
        projectPath
      );
      if (result.exitCode && result.exitCode !== 0) {
        setActionResult(`❌ ${result.stderr}`);
      } else {
        setActionResult(`✅ ${zh ? "拉取成功" : "Pulled"}`);
        refresh();
      }
    } catch (e: any) {
      setActionResult(`❌ ${e?.message || e}`);
    }
    setTimeout(() => setActionResult(null), 5000);
  };

  /**
   * 把当前会话的 worktree 改动合并回**主项目**（不是 worktree）。
   * 2026-10-22 真机缺口：worktree 只能进不能出；这里补最小入口。
   * 冲突/主工作区不干净时由 mergeWorktreeToProject 回滚并抛错，不在主工作区留冲突态。
   */
  const handleMergeWorktree = async (
    onConflict?: "worktree" | "main",
    resolutions?: Record<string, "worktree" | "main">
  ) => {
    const worktreePath = currentSession?.worktreePath;
    const mainPath = currentProject?.path;
    if (!worktreePath || !mainPath) return;
    if (!onConflict && !resolutions) {
      const ok = await confirmDialog(
        zh
          ? "把工作树改动提交并合并到主工作区，然后删除工作树并切回本地？主工作区必须干净；冲突会先回滚，再由你选择保留哪一边。"
          : "Commit the worktree changes, merge them into the main workspace, then remove the worktree and switch back to local? The main workspace must be clean; conflicts are rolled back first, then you choose a side."
      );
      if (!ok) return;
    }
    setActionResult(null);
    setConflictFiles([]);
    setFileChoices({});
    try {
      const res = await mergeWorktreeToProject(mainPath, worktreePath, {
        onConflict: onConflict ?? "abort",
        resolutions,
      });
      try {
        await removeWorktree(mainPath, worktreePath);
      } catch (cleanupErr) {
        console.warn("[GitInfoPanel] worktree 清理失败（已合并，目录可能残留）:", cleanupErr);
      }
      if (currentSession) {
        useProjectStore.getState().updateSession(currentSession.id, {
          executionMode: "current_workspace",
          worktreePath: undefined,
        });
      }
      setActionResult(`✅ ${zh ? "已合并并清理工作树" : "Merged and removed worktree"}: ${res.mergedSha.slice(0, 7)}`);
      refresh();
    } catch (e: any) {
      setActionResult(`❌ ${e?.message || e}`);
      if (Array.isArray(e?.conflictFiles) && e.conflictFiles.length > 0) setConflictFiles(e.conflictFiles);
    }
    setTimeout(() => setActionResult(null), 10000);
  };

  if (!projectPath) {
    return (
      <div style={{ padding: 12, fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>
        {zh ? "请先选择项目" : "Select a project"}
      </div>
    );
  }

  if (!status && loading) {
    return (
      <div style={{ padding: 12, fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>
        ⏳ {zh ? "加载中..." : "Loading..."}
      </div>
    );
  }

  return (
    <div style={{ fontSize: 'var(--fs-sm)', display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 分支选择器（显示/切换/新建）—— 由标题栏 GitBranchSelector 合并而来，承担当前分支展示 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <GitBranchSelector refreshInterval={5000} onBranchChange={handleBranchChange} />
        {status && (status.isDirty ? (
          <span style={{ fontSize: 'var(--fs-xs)', color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 15%, transparent)", padding: "1px 6px", borderRadius: "var(--radius)" }}>
            ⚠️ {zh ? "未提交" : "dirty"}
          </span>
        ) : (
          <span style={{ fontSize: 'var(--fs-xs)', color: "var(--success)" }}>✓ {zh ? "干净" : "clean"}</span>
        ))}
      </div>

      {/* Stats */}
      {status && status.isDirty && (
        <div style={{ display: "flex", gap: 8, fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
          <span>📝 {status.stagedCount} {zh ? "已暂存" : "staged"}</span>
          <span>✏️ {status.unstagedCount} {zh ? "已修改" : "modified"}</span>
          <span>❓ {status.untrackedCount} {zh ? "未跟踪" : "untracked"}</span>
          {(status.insertions > 0 || status.deletions > 0) && (
            <span>+{status.insertions}/-{status.deletions}</span>
          )}
        </div>
      )}

      {/* Commit input */}
      <div style={{ display: "flex", gap: 4 }}>
        <input
          type="text"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder={zh ? "提交信息..." : "Commit message..."}
          style={{
            flex: 1, padding: "4px 8px", fontSize: 'var(--fs-sm)',
            borderRadius: "var(--radius-xs)", border: "1px solid var(--border-primary)",
            background: "var(--bg-tertiary)", color: "var(--text-primary)",
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && commitMsg.trim()) handleCommit(); }}
        />
        <button
          onClick={handleCommit}
          disabled={!commitMsg.trim()}
          style={{
            padding: "4px 10px", fontSize: 'var(--fs-sm)', borderRadius: "var(--radius-xs)",
            border: "1px solid var(--border-primary)",
            background: "var(--bg-secondary)", color: "var(--text-primary)",
            cursor: commitMsg.trim() ? "pointer" : "not-allowed",
            opacity: commitMsg.trim() ? 1 : 0.5,
          }}
        >
          {zh ? "提交" : "Commit"}
        </button>
        <button
          onClick={handlePush}
          title={zh ? "推送" : "Push"}
          style={{
            padding: "4px 10px", fontSize: 'var(--fs-sm)', borderRadius: "var(--radius-xs)",
            border: "1px solid var(--border-primary)",
            background: "var(--bg-secondary)", color: "var(--text-primary)",
            cursor: "pointer",
          }}
        >
          ⬆
        </button>
        <button
          onClick={handlePull}
          title={zh ? "拉取" : "Pull"}
          style={{
            padding: "4px 10px", fontSize: 'var(--fs-sm)', borderRadius: "var(--radius-xs)",
            border: "1px solid var(--border-primary)",
            background: "var(--bg-secondary)", color: "var(--text-primary)",
            cursor: "pointer",
          }}
        >
          ⬇
        </button>
      </div>

      {currentSession?.worktreePath && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-xs)', color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            🌒 {currentSession.worktreePath}
          </div>
          <button
            onClick={() => handleMergeWorktree()}
            disabled={loading}
            title={zh ? "提交工作树改动并合并回主工作区" : "Commit worktree changes and merge into the main workspace"}
            style={{
              flexShrink: 0, padding: "3px 8px", fontSize: 'var(--fs-xs)', borderRadius: "var(--radius-xs)",
              border: "1px solid var(--border-primary)", background: "var(--bg-secondary)",
              color: "var(--text-primary)", cursor: loading ? "default" : "pointer",
            }}
          >
            {zh ? "合并回主工作区" : "Merge to main"}
          </button>
        </div>
      )}

      {actionResult && (
        <div style={{ fontSize: 'var(--fs-xs)', color: actionResult.startsWith("✅") ? "var(--success)" : "var(--error)" }}>
          {actionResult}
        </div>
      )}

      {conflictFiles.length > 0 && (
        <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 4 }}>
          <div>{zh ? "冲突文件：逐文件选择保留哪一边，或整体选一边；工作树会清理" : "Conflicted files: pick a side per file, or use one side for all; worktree will be removed"}</div>
          <div className="wt-conflict-list">
            {conflictFiles.map((rel) => (
              <div key={rel} className="wt-conflict-file">
                <span className="wt-conflict-path">{rel}</span>
                <div className="wt-conflict-actions">
                  <button
                    className="wt-conflict-open"
                    aria-pressed={fileChoices[rel] === "main"}
                    onClick={() => setFileChoices((prev) => ({ ...prev, [rel]: "main" }))}
                  >
                    {zh ? "主工作区" : "Main"}
                  </button>
                  <button
                    className="wt-conflict-open"
                    aria-pressed={fileChoices[rel] === "worktree"}
                    onClick={() => setFileChoices((prev) => ({ ...prev, [rel]: "worktree" }))}
                  >
                    {zh ? "工作树" : "Worktree"}
                  </button>
                  <button
                    className="wt-conflict-open"
                    onClick={() => {
                      const main = currentProject?.path;
                      if (!main) return;
                      void openFileDirectly(conflictAbsolutePath(main, rel));
                    }}
                  >
                    {zh ? "打开" : "Open"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="wt-conflict-tools">
            <button
              disabled={conflictFiles.some((f) => !fileChoices[f])}
              className="wt-conflict-open"
              onClick={() => handleMergeWorktree(undefined, fileChoices)}
            >
              {zh ? `按选择合并（${conflictFiles.filter((f) => fileChoices[f]).length}/${conflictFiles.length}）` : `Merge selected (${conflictFiles.filter((f) => fileChoices[f]).length}/${conflictFiles.length})`}
            </button>
          </div>
          <div className="wt-conflict-tools">
            <button
              className="wt-conflict-open"
              onClick={() => handleMergeWorktree("worktree")}
            >
              {zh ? "全部以工作树为准" : "Use worktree for all"}
            </button>
            <button
              className="wt-conflict-open"
              onClick={() => handleMergeWorktree("main")}
            >
              {zh ? "全部以主工作区为准" : "Use main for all"}
            </button>
          </div>
        </div>
      )}

      {/* Recent commits (collapsible) */}
      {commits.length > 0 && (
        <div>
          <div
            onClick={() => setIsExpanded(!isExpanded)}
            style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", cursor: "pointer", userSelect: "none" }}
          >
            {isExpanded ? "▼" : "▶"} {zh ? "最近提交" : "Recent commits"} ({commits.length})
          </div>
          {isExpanded && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
              {commits.map((c, i) => (
                <div key={i} style={{ fontSize: 'var(--fs-xs)', padding: "4px 6px", borderRadius: "var(--radius-xs)", background: "var(--bg-tertiary)" }}>
                  <span style={{ fontFamily: "monospace", color: "var(--accent)", fontWeight: 600 }}>{c.hash}</span>
                  <span style={{ marginLeft: 6 }}>{c.message}</span>
                  <span style={{ marginLeft: 6, color: "var(--text-muted)" }}>{c.date}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Refresh button */}
      <button
        onClick={refresh}
        disabled={loading}
        style={{
          fontSize: 'var(--fs-xs)', padding: "2px 8px", borderRadius: "var(--radius-xs)",
          border: "1px solid var(--border-primary)",
          background: "none", color: "var(--text-muted)",
          cursor: loading ? "wait" : "pointer",
          alignSelf: "flex-start",
        }}
      >
        {loading ? "⏳" : "🔄"} {zh ? "刷新" : "Refresh"}
      </button>
    </div>
  );
}

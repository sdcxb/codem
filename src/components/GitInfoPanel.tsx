/**
 * Git Info Panel — Environment monitoring (对标 wecode 环境信息面板)
 *
 * Shows:
 * - Current branch + dirty status
 * - Diff shortstat (insertions/deletions)
 * - Recent commits (last 5)
 * - Commit + push quick actions
 *
 * Designed to be embedded in RightSidebar or a bottom panel.
 */

import { useState, useEffect, useCallback } from "react";
import { executeCommand } from "../core/file-api";
import { useProjectStore } from "../core/store";
import { useLang } from "../core/i18n/lang";

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

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000); // Auto-refresh every 10s
    return () => clearInterval(interval);
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

  if (!projectPath) {
    return (
      <div style={{ padding: 12, fontSize: 11, color: "var(--text-muted)" }}>
        {zh ? "请先选择项目" : "Select a project"}
      </div>
    );
  }

  if (!status && loading) {
    return (
      <div style={{ padding: 12, fontSize: 11, color: "var(--text-muted)" }}>
        ⏳ {zh ? "加载中..." : "Loading..."}
      </div>
    );
  }

  return (
    <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Branch + dirty status */}
      {status && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, color: "var(--accent)" }}>🌿 {status.branch}</span>
          {status.isDirty && (
            <span style={{ fontSize: 10, color: "#e67e22", background: "rgba(230,126,34,0.15)", padding: "1px 6px", borderRadius: 8 }}>
              ⚠️ {zh ? "未提交" : "dirty"}
            </span>
          )}
          {!status.isDirty && (
            <span style={{ fontSize: 10, color: "#22c55e" }}>✓ {zh ? "干净" : "clean"}</span>
          )}
        </div>
      )}

      {/* Stats */}
      {status && status.isDirty && (
        <div style={{ display: "flex", gap: 8, fontSize: 10, color: "var(--text-muted)" }}>
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
            flex: 1, padding: "4px 8px", fontSize: 11,
            borderRadius: 4, border: "1px solid var(--border-primary)",
            background: "var(--bg-tertiary)", color: "var(--text-primary)",
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && commitMsg.trim()) handleCommit(); }}
        />
        <button
          onClick={handleCommit}
          disabled={!commitMsg.trim()}
          style={{
            padding: "4px 10px", fontSize: 11, borderRadius: 4,
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
            padding: "4px 10px", fontSize: 11, borderRadius: 4,
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
            padding: "4px 10px", fontSize: 11, borderRadius: 4,
            border: "1px solid var(--border-primary)",
            background: "var(--bg-secondary)", color: "var(--text-primary)",
            cursor: "pointer",
          }}
        >
          ⬇
        </button>
      </div>

      {currentSession?.worktreePath && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          🌒 {currentSession.worktreePath}
        </div>
      )}

      {actionResult && (
        <div style={{ fontSize: 10, color: actionResult.startsWith("✅") ? "#22c55e" : "#e74c3c" }}>
          {actionResult}
        </div>
      )}

      {/* Recent commits (collapsible) */}
      {commits.length > 0 && (
        <div>
          <div
            onClick={() => setIsExpanded(!isExpanded)}
            style={{ fontSize: 10, color: "var(--text-muted)", cursor: "pointer", userSelect: "none" }}
          >
            {isExpanded ? "▼" : "▶"} {zh ? "最近提交" : "Recent commits"} ({commits.length})
          </div>
          {isExpanded && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
              {commits.map((c, i) => (
                <div key={i} style={{ fontSize: 10, padding: "4px 6px", borderRadius: 4, background: "var(--bg-tertiary)" }}>
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
          fontSize: 10, padding: "2px 8px", borderRadius: 4,
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

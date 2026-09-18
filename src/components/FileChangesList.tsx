/**
 * FileChangesList — Per-turn file change history panel
 *
 * Reads from turn_file_changes table (via FileChangeStorage).
 * Clicking a file opens DiffViewer with before/after content.
 * Includes Topic-style grouping by turn + revert button.
 *
 * P1-4: Thin wrapper that reuses existing DiffViewer component.
 */

import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, RotateCcw, FileText, GitBranch } from "lucide-react";
import { FileChangeStorage, type TurnFileChangeRecord, type ChangedFile } from "../core/storage/file-change-storage";
import { FileChangeTracker } from "../core/environment/file-change-tracker";
import { onFileChangesTracked } from "../core/environment/file-change-tracker";
import { DiffViewer } from "./DiffViewer";

interface FileChangesListProps {
  sessionId: string;
  workspace: string;
}

export function FileChangesList({ sessionId, workspace }: FileChangesListProps) {
  const [records, setRecords] = useState<TurnFileChangeRecord[]>([]);
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<{ path: string; before: string; after: string } | null>(null);

  const loadRecords = useCallback(() => {
    const list = FileChangeStorage.listBySession(sessionId);
    setRecords(list);
  }, [sessionId]);

  useEffect(() => {
    loadRecords();
    const unsub = onFileChangesTracked(() => loadRecords());
    return unsub;
  }, [loadRecords]);

  /**
   * ## ⚠️ 第 47 轮补（UI/UX 审计 P0）：单轮变更回滚也要先确认
   *
   * `FileChangeTracker.revert` 做的是"反向打补丁 + `Remove-Item -Force` 删掉本轮新建的文件"
   * —— 同样是**动用户工作区文件**，而这里原来是单击即执行、没有确认也没有撤销。
   * 与 `SnapshotPanel` 那条入口一起补齐（仓库里更轻的操作都有确认，只有这两处没有）。
   *
   * 确认框里把**文件清单**说清：用户是在知道"要动哪几个文件"的前提下点的。
   */
  const handleRevert = async (record: TurnFileChangeRecord) => {
    // `changed_files` 是 JSON 文本列（`[{path, status, …}]`）—— 解析失败就退回只报条数的文案
    let files: Array<{ path: string; status: string }> = [];
    try {
      const parsed = record.changed_files ? JSON.parse(record.changed_files) : [];
      if (Array.isArray(parsed)) files = parsed;
    } catch (e) {
      console.warn("[FileChangesList] changed_files 解析失败（回滚确认框只报条数）:", e);
    }
    const fileList =
      files
        .slice(0, 8)
        .map((f) => `  · ${f.status} ${f.path.split(/[\\/]/).pop()}`)
        .join("\n") + (files.length > 8 ? `\n  · …还有 ${files.length - 8} 个` : "");
    const msg =
      `回滚这一轮的改动会改写你的工作区文件：\n\n` +
      (files.length > 0
        ? `将反向应用 ${files.length} 个文件的改动` +
          (files.some((f) => f.status === "A") ? `（其中新增的文件会被删除）` : "") +
          `：\n${fileList}\n\n`
        : `将反向应用这一轮记录的全部改动。\n\n`) +
      `这一步没有自动快照，确定继续吗？`;
    if (!window.confirm(msg)) return;

    const ok = await FileChangeTracker.revert(record.id, workspace);
    if (ok) {
      loadRecords();
    }
  };

  const handleViewDiff = async (record: TurnFileChangeRecord, file: ChangedFile) => {
    try {
      const { invoke } = (window as any).__TAURI__.core;
      let before = "";
      let after = "";

      // Get before content via git show beforeTree:path
      if (record.before_tree && file.status !== "A") {
        const beforeResult = await invoke("execute_command", {
          command: "git -C \"" + workspace + "\" show " + record.before_tree + ":\"" + file.path + "\"",
          cwd: workspace,
        });
        before = beforeResult.stdout || "";
      }
      // Get after content via git show afterTree:path
      if (record.after_tree && file.status !== "D") {
        const afterResult = await invoke("execute_command", {
          command: "git -C \"" + workspace + "\" show " + record.after_tree + ":\"" + file.path + "\"",
          cwd: workspace,
        });
        after = afterResult.stdout || "";
      }

      setDiffFile({ path: file.path, before, after });
    } catch (e: any) {
      console.error("[FileChangesList] Failed to load diff:", e);
    }
  };

  if (records.length === 0) {
    return (
      <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: 'var(--fs-sm)', textAlign: "center" }}>
        <GitBranch size={20} style={{ opacity: 0.3, marginBottom: 8 }} />
        <div>暂无文件变更记录</div>
        <div style={{ marginTop: 4, opacity: 0.6 }}>Agent 执行修改后会自动记录</div>
      </div>
    );
  }

  return (
    <div className="file-changes-list">
      {records.map((record) => {
        const files = FileChangeStorage.parseChangedFiles(record);
        const isExpanded = expandedTurn === record.id;
        const isReverted = record.status === "reverted";

        return (
          <div key={record.id} className={"turn-change-group" + (isReverted ? " reverted" : "")}>
            <div
              className="turn-change-header"
              onClick={() => setExpandedTurn(isExpanded ? null : record.id)}
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="turn-label">
                Turn {record.turn_index}
                {isReverted && <span className="reverted-tag">已回滚</span>}
              </span>
              <span className="turn-file-count">{files.length} 文件</span>
            </div>
            {isExpanded && (
              <div className="turn-change-files">
                {record.current_brief && (
                  <div className="turn-brief">{record.current_brief}</div>
                )}
                {files.map((file, i) => (
                  <div key={i} className="change-file-row" onClick={() => handleViewDiff(record, file)}>
                    <FileText size={12} className="change-file-icon" />
                    <span className="change-file-path" title={file.path}>
                      {file.path.split(/[/\\]/).pop()}
                    </span>
                    <span
                      className={"change-file-status git-status-" + (
                        file.status.toLowerCase() === "m" ? "modified"
                        : file.status.toLowerCase() === "a" ? "added"
                        : file.status.toLowerCase() === "d" ? "deleted"
                        : "untracked"
                      )}
                    >
                      {file.status}
                    </span>
                  </div>
                ))}
                <button
                  className="revert-btn"
                  onClick={(e) => { e.stopPropagation(); handleRevert(record); }}
                  disabled={isReverted}
                  title="回滚此轮变更"
                >
                  <RotateCcw size={12} /> 回滚
                </button>
              </div>
            )}
          </div>
        );
      })}

      {diffFile && (
        <div className="diff-viewer-overlay" onClick={() => setDiffFile(null)}>
          <div className="diff-viewer-modal" onClick={(e) => e.stopPropagation()}>
            <DiffViewer
              filePath={diffFile.path}
              before={diffFile.before}
              after={diffFile.after}
              onClose={() => setDiffFile(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

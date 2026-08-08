/**
 * InlineDiffReview — 内嵌式文件变更审批面板
 *
 * 替代弹窗式 DiffViewer，在对话流内嵌展示文件变更审批。
 * 支持单文件 diff 审查、批量审批/拒绝、"本会话自动批准"快捷操作。
 *
 * 对标：frakio-work 的 DecisionTray + wecode 的 FinalPromptMessage 内嵌审批模式。
 */

import { useState, useMemo, memo, useCallback } from "react";
import {
  FileText,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  Edit3,
  GitBranch,
} from "lucide-react";

// Re-use the diff algorithm from DiffViewer
export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  oldLineNum: number | null;
  newLineNum: number | null;
  content: string;
}

/** Simple LCS-based line diff algorithm */
function computeDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  if (m > 5000 || n > 5000) {
    const result: DiffLine[] = [];
    for (let i = 0; i < m; i++) {
      result.push({ type: "removed", oldLineNum: i + 1, newLineNum: null, content: oldLines[i] });
    }
    for (let j = 0; j < n; j++) {
      result.push({ type: "added", oldLineNum: null, newLineNum: j + 1, content: newLines[j] });
    }
    return result;
  }

  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "unchanged", oldLineNum: i, newLineNum: j, content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "added", oldLineNum: null, newLineNum: j, content: newLines[j - 1] });
      j--;
    } else if (i > 0) {
      result.unshift({ type: "removed", oldLineNum: i, newLineNum: null, content: oldLines[i - 1] });
      i--;
    }
  }
  return result;
}

export interface InlineDiffReviewProps {
  filePath: string;
  before: string;
  after: string;
  /** File sequence info, e.g. "2 / 5" */
  sequenceInfo?: string;
  onAccept: () => void;
  onReject: () => void;
  onCustom?: (instruction: string) => void;
  onAcceptAll?: () => void;
}

export const InlineDiffReview = memo(function InlineDiffReview({
  filePath,
  before,
  after,
  sequenceInfo,
  onAccept,
  onReject,
  onCustom,
  onAcceptAll,
}: InlineDiffReviewProps) {
  const [viewMode, setViewMode] = useState<"unified" | "preview">("unified");
  const [collapsed, setCollapsed] = useState(false);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customInstruction, setCustomInstruction] = useState("");

  const diffLines = useMemo(() => computeDiff(before, after), [before, after]);
  const addedCount = diffLines.filter((l) => l.type === "added").length;
  const removedCount = diffLines.filter((l) => l.type === "removed").length;
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const isNewFile = !before || before.length === 0;

  const handleAccept = useCallback(() => {
    onAccept();
  }, [onAccept]);

  const handleReject = useCallback(() => {
    onReject();
  }, [onReject]);

  const handleCustomSubmit = useCallback(() => {
    if (customInstruction.trim()) {
      onCustom?.(customInstruction.trim());
      setShowCustomInput(false);
      setCustomInstruction("");
    }
  }, [customInstruction, onCustom]);

  return (
    <div className="inline-diff-review">
      {/* Header bar */}
      <div className="inline-diff-header" onClick={() => setCollapsed((c) => !c)}>
        <button
          className="inline-diff-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((c) => !c);
          }}
          aria-label={collapsed ? "展开" : "折叠"}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <FileText size={15} className="inline-diff-file-icon" />
        <div className="inline-diff-title-area">
          <div className="inline-diff-filename-row">
            <strong className="inline-diff-filename">{fileName}</strong>
            {sequenceInfo && (
              <span className="inline-diff-sequence-badge">{sequenceInfo}</span>
            )}
            {isNewFile && <span className="inline-diff-new-badge">新文件</span>}
          </div>
          <span className="inline-diff-filepath" title={filePath}>
            {filePath}
          </span>
        </div>
        <div className="inline-diff-stats">
          <span className="inline-diff-stat-added">+{addedCount}</span>
          <span className="inline-diff-stat-removed">-{removedCount}</span>
        </div>
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="inline-diff-body">
          {/* View mode toggle */}
          <div className="inline-diff-toolbar">
            <div className="inline-diff-mode-toggle">
              <button
                className={`inline-diff-mode-btn ${viewMode === "unified" ? "active" : ""}`}
                onClick={() => setViewMode("unified")}
              >
                Unified
              </button>
              <button
                className={`inline-diff-mode-btn ${viewMode === "preview" ? "active" : ""}`}
                onClick={() => setViewMode("preview")}
              >
                Preview
              </button>
            </div>
          </div>

          {/* Diff content */}
          <div className="inline-diff-content">
            {viewMode === "unified" ? (
              <UnifiedDiff lines={diffLines} />
            ) : (
              <PreviewDiff before={before} after={after} isNewFile={isNewFile} />
            )}
          </div>

          {/* Custom instruction input */}
          {showCustomInput && (
            <div className="inline-diff-custom-panel">
              <textarea
                className="inline-diff-custom-textarea"
                value={customInstruction}
                onChange={(e) => setCustomInstruction(e.target.value)}
                placeholder="例如：不要覆盖，把新内容追加到文件末尾"
                rows={2}
                autoFocus
              />
              <div className="inline-diff-custom-actions">
                <button
                  className="inline-diff-custom-submit"
                  onClick={handleCustomSubmit}
                  disabled={!customInstruction.trim()}
                >
                  提交指令
                </button>
                <button
                  className="inline-diff-custom-cancel"
                  onClick={() => {
                    setShowCustomInput(false);
                    setCustomInstruction("");
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* Action bar */}
          <div className="inline-diff-actions">
            <button className="inline-diff-btn accept" onClick={handleAccept}>
              <Check size={14} />
              <span>批准</span>
            </button>
            <button className="inline-diff-btn reject" onClick={handleReject}>
              <X size={14} />
              <span>拒绝</span>
            </button>
            {onAcceptAll && (
              <button className="inline-diff-btn accept-all" onClick={onAcceptAll}>
                <ShieldCheck size={14} />
                <span>全部批准</span>
              </button>
            )}
            {onCustom && !showCustomInput && (
              <button
                className="inline-diff-btn custom"
                onClick={() => setShowCustomInput(true)}
              >
                <Edit3 size={14} />
                <span>自定义</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// ========== Unified Diff View ==========

function UnifiedDiff({ lines }: { lines: DiffLine[] }) {
  // Limit to first 200 lines for performance
  const displayLines = lines.length > 200 ? [...lines.slice(0, 200)] : lines;
  const truncated = lines.length > 200;

  return (
    <div className="inline-diff-unified">
      <table className="inline-diff-table">
        <tbody>
          {displayLines.map((line, idx) => (
            <tr key={idx} className={`inline-diff-line inline-diff-${line.type}`}>
              <td className="inline-diff-line-num inline-diff-old-num">
                {line.oldLineNum ?? ""}
              </td>
              <td className="inline-diff-line-num inline-diff-new-num">
                {line.newLineNum ?? ""}
              </td>
              <td className="inline-diff-line-marker">
                {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
              </td>
              <td className="inline-diff-line-content">
                <pre>{line.content || " "}</pre>
              </td>
            </tr>
          ))}
          {truncated && (
            <tr className="inline-diff-truncated">
              <td colSpan={4}>... 还有 {lines.length - 200} 行未显示</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ========== Preview Diff View ==========

function PreviewDiff({
  before,
  after,
  isNewFile,
}: {
  before: string;
  after: string;
  isNewFile: boolean;
}) {
  return (
    <div className="inline-diff-preview">
      {!isNewFile && (
        <div className="inline-diff-preview-section">
          <div className="inline-diff-preview-label">
            <span className="inline-diff-preview-badge old">原始内容</span>
            <span className="inline-diff-preview-meta">{before.length} bytes</span>
          </div>
          <pre className="inline-diff-preview-content old">{before || "(empty)"}</pre>
        </div>
      )}
      {isNewFile && (
        <div className="inline-diff-preview-section">
          <span className="inline-diff-preview-badge new">✨ 新文件</span>
        </div>
      )}
      {!isNewFile && <div className="inline-diff-preview-arrow">↓</div>}
      <div className="inline-diff-preview-section">
        <div className="inline-diff-preview-label">
          <span className="inline-diff-preview-badge new">写入内容</span>
          <span className="inline-diff-preview-meta">{after.length} bytes</span>
        </div>
        <pre className="inline-diff-preview-content new">{after || "(empty)"}</pre>
      </div>
    </div>
  );
}

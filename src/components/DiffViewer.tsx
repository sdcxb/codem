import { useState, useMemo } from "react";

// ========== S4: Diff Review UI ==========

interface DiffViewerProps {
  filePath: string;
  before: string;
  after: string;
  onAccept?: () => void;
  onReject?: () => void;
  onCustom?: (instruction: string) => void;
  onClose?: () => void;
}

interface DiffLine {
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

  // Build LCS table (optimized: only keep 2 rows for space)
  // But for diff we need the full table to backtrack, so use full matrix
  // For very large files, fall back to simple comparison
  if (m > 5000 || n > 5000) {
    // Fallback: show all as removed + all as added
    const result: DiffLine[] = [];
    for (let i = 0; i < m; i++) {
      result.push({ type: "removed", oldLineNum: i + 1, newLineNum: null, content: oldLines[i] });
    }
    for (let j = 0; j < n; j++) {
      result.push({ type: "added", oldLineNum: null, newLineNum: j + 1, content: newLines[j] });
    }
    return result;
  }

  // LCS DP table
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

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({
        type: "unchanged",
        oldLineNum: i,
        newLineNum: j,
        content: oldLines[i - 1],
      });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({
        type: "added",
        oldLineNum: null,
        newLineNum: j,
        content: newLines[j - 1],
      });
      j--;
    } else if (i > 0) {
      result.unshift({
        type: "removed",
        oldLineNum: i,
        newLineNum: null,
        content: oldLines[i - 1],
      });
      i--;
    }
  }

  return result;
}

export function DiffViewer({ filePath, before, after, onAccept, onReject, onCustom, onClose }: DiffViewerProps) {
  const [viewMode, setViewMode] = useState<"preview" | "unified" | "split">("preview");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customInstruction, setCustomInstruction] = useState("");

  const diffLines = useMemo(() => computeDiff(before, after), [before, after]);

  const addedCount = diffLines.filter(l => l.type === "added").length;
  const removedCount = diffLines.filter(l => l.type === "removed").length;
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const isNewFile = !before || before.length === 0;

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-header">
        <div className="diff-viewer-title">
          <span className="diff-viewer-icon">📄</span>
          <span className="diff-viewer-filename" title={filePath}>{fileName}</span>
          <span className="diff-viewer-stats">
            <span className="diff-stat-added">+{addedCount}</span>
            <span className="diff-stat-removed">-{removedCount}</span>
          </span>
        </div>
        <div className="diff-viewer-actions">
          <div className="diff-view-mode-toggle">
            <button
              className={`diff-mode-btn ${viewMode === "preview" ? "active" : ""}`}
              onClick={() => setViewMode("preview")}
              title="Show raw before/after content"
            >
              Preview
            </button>
            <button
              className={`diff-mode-btn ${viewMode === "unified" ? "active" : ""}`}
              onClick={() => setViewMode("unified")}
            >
              Unified
            </button>
            <button
              className={`diff-mode-btn ${viewMode === "split" ? "active" : ""}`}
              onClick={() => setViewMode("split")}
            >
              Split
            </button>
          </div>
          {onAccept && (
            <button className="diff-accept-btn" onClick={onAccept} title="Keep new content">
              ✅ Accept
            </button>
          )}
          {onReject && (
            <button className="diff-reject-btn" onClick={onReject} title="Restore old content">
              ↩️ Reject
            </button>
          )}
          {onCustom && !showCustomInput && (
            <button className="diff-custom-btn" onClick={() => setShowCustomInput(true)} title="Provide custom instruction">
              ✏️ 其他
            </button>
          )}
          {onClose && (
            <button className="diff-close-btn" onClick={onClose}>✕</button>
          )}
        </div>
      </div>

      <div className="diff-viewer-path">{filePath}</div>

      {showCustomInput && (
        <div className="diff-custom-panel">
          <div className="diff-custom-label">请输入你的指令（例如：追加到文件末尾、合并内容、只保留新内容的部分…）</div>
          <div className="diff-custom-input-row">
            <textarea
              className="diff-custom-textarea"
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              placeholder="例如：不要覆盖，把新内容追加到文件末尾"
              rows={2}
              autoFocus
            />
          </div>
          <div className="diff-custom-actions">
            <button
              className="diff-custom-submit-btn"
              onClick={() => {
                if (customInstruction.trim()) {
                  onCustom?.(customInstruction.trim());
                }
              }}
              disabled={!customInstruction.trim()}
            >
              ✅ 提交指令
            </button>
            <button
              className="diff-custom-cancel-btn"
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

      <div className="diff-viewer-body">
        {viewMode === "preview" ? (
          <PreviewDiffView before={before} after={after} isNewFile={isNewFile} />
        ) : viewMode === "unified" ? (
          <UnifiedDiffView lines={diffLines} />
        ) : (
          <SplitDiffView lines={diffLines} />
        )}
      </div>
    </div>
  );
}

/** Preview view: shows raw before/after content side by side, clearly labeled */
function PreviewDiffView({ before, after, isNewFile }: { before: string; after: string; isNewFile: boolean }) {
  return (
    <div className="diff-preview">
      {!isNewFile && (
        <div className="diff-preview-section diff-preview-old">
          <div className="diff-preview-label">
            <span className="diff-preview-badge diff-preview-badge-old">原始内容</span>
            <span className="diff-preview-meta">{before.length} bytes</span>
          </div>
          <pre className="diff-preview-content diff-preview-content-old">{before || "(empty)"}</pre>
        </div>
      )}
      {isNewFile && (
        <div className="diff-preview-section diff-preview-new-file">
          <span className="diff-preview-badge diff-preview-badge-new">✨ 新文件</span>
        </div>
      )}
      <div className="diff-preview-arrow">↓</div>
      <div className="diff-preview-section diff-preview-new">
        <div className="diff-preview-label">
          <span className="diff-preview-badge diff-preview-badge-new">写入内容</span>
          <span className="diff-preview-meta">{after.length} bytes</span>
        </div>
        <pre className="diff-preview-content diff-preview-content-new">{after || "(empty)"}</pre>
      </div>
    </div>
  );
}

function UnifiedDiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <table className="diff-table diff-unified">
      <tbody>
        {lines.map((line, idx) => (
          <tr key={idx} className={`diff-line diff-${line.type}`}>
            <td className="diff-line-num diff-old-num">{line.oldLineNum ?? ""}</td>
            <td className="diff-line-num diff-new-num">{line.newLineNum ?? ""}</td>
            <td className="diff-line-marker">
              {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
            </td>
            <td className="diff-line-content">
              <pre>{line.content || " "}</pre>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SplitDiffView({ lines }: { lines: DiffLine[] }) {
  // Group lines into old/new pairs for split view
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "unchanged") {
      rows.push({ left: line, right: line });
      i++;
    } else if (line.type === "removed") {
      // Check if next line is an addition (paired change)
      const next = lines[i + 1];
      if (next && next.type === "added") {
        rows.push({ left: line, right: next });
        i += 2;
      } else {
        rows.push({ left: line, right: null });
        i++;
      }
    } else if (line.type === "added") {
      rows.push({ left: null, right: line });
      i++;
    } else {
      i++;
    }
  }

  return (
    <table className="diff-table diff-split">
      <thead>
        <tr>
          <th colSpan={2} className="diff-split-header-old">Original</th>
          <th colSpan={2} className="diff-split-header-new">Modified</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => (
          <tr key={idx}>
            <td className="diff-line-num">{row.left?.oldLineNum ?? ""}</td>
            <td className={`diff-line-content diff-${row.left?.type || "empty"}`}>
              <pre>{row.left?.content || " "}</pre>
            </td>
            <td className="diff-line-num">{row.right?.newLineNum ?? ""}</td>
            <td className={`diff-line-content diff-${row.right?.type || "empty"}`}>
              <pre>{row.right?.content || " "}</pre>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

import { useState, useMemo } from "react";
import { ActionIcons } from "../core/icons/icon-map";

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

/** unified / split 视图最多渲染的 diff 行数（超出只渲染前 N 行并明确告知） */
export const DIFF_RENDER_ROW_CAP = 400;

/**
 * DP 单元格上限（`中间段长度之积`）。超过就退化成「全删 + 全增」。
 *
 * 4M 格 ≈ 32 MB（数字数组按 8 字节算）且是毫秒级；超过这个量级用户也不会逐行看，
 * 退化 + 说明比"卡住 3 秒再给一张没人看得完的表"更诚实。
 */
const DIFF_MAX_CELLS = 4_000_000;

/**
 * 逐行 LCS diff。
 *
 * ## 第 233 轮审计：三项有界化（语义不变）
 *
 * 1. **先剥公共前后缀**：两端的相同行必然是 `unchanged`，DP 只需跑中间那段。
 *    一次只改 3 行的大文件从此几乎零成本（原来要跑整张 m×n 表）。
 * 2. **结果 push + reverse**：原来逐行 `unshift` 是 O(L²)（1 万行要搬 5000 万次元素）。
 * 3. **按"中间段格数"而不是"总行数"设上限**：原来 `m > 5000` 就退化成全删全增，
 *    而"5000 行里改 1 行"本可以精确 diff。
 *
 * 导出是为了让判据直接测算法（组件判据只能看到渲染结果）。
 */
export function computeDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");

  // ===== 1) 剥公共前缀 / 后缀 =====
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < maxPrefix - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);
  const m = midOld.length;
  const n = midNew.length;

  const head: DiffLine[] = [];
  for (let k = 0; k < prefix; k++) {
    head.push({ type: "unchanged", oldLineNum: k + 1, newLineNum: k + 1, content: oldLines[k] });
  }
  const tail: DiffLine[] = [];
  for (let k = 0; k < suffix; k++) {
    const oldNo = oldLines.length - suffix + k + 1;
    const newNo = newLines.length - suffix + k + 1;
    tail.push({
      type: "unchanged",
      oldLineNum: oldNo,
      newLineNum: newNo,
      content: oldLines[oldLines.length - suffix + k],
    });
  }

  // ===== 2) 中间段：超过格数上限就退化成「全删 + 全增」 =====
  if (m === 0 && n === 0) return [...head, ...tail];
  if (m * n > DIFF_MAX_CELLS) {
    const result: DiffLine[] = [...head];
    for (let i = 0; i < m; i++) {
      result.push({ type: "removed", oldLineNum: prefix + i + 1, newLineNum: null, content: midOld[i] });
    }
    for (let j = 0; j < n; j++) {
      result.push({ type: "added", oldLineNum: null, newLineNum: prefix + j + 1, content: midNew[j] });
    }
    return [...result, ...tail];
  }

  // ===== 3) LCS DP（只跑中间段）=====
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = midOld[i - 1] === midNew[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // 回溯（push 完再 reverse —— 原来是逐行 unshift，O(L²)）
  const mid: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && midOld[i - 1] === midNew[j - 1]) {
      mid.push({ type: "unchanged", oldLineNum: prefix + i, newLineNum: prefix + j, content: midOld[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      mid.push({ type: "added", oldLineNum: null, newLineNum: prefix + j, content: midNew[j - 1] });
      j--;
    } else {
      mid.push({ type: "removed", oldLineNum: prefix + i, newLineNum: null, content: midOld[i - 1] });
      i--;
    }
  }
  mid.reverse();

  return [...head, ...mid, ...tail];
}

export function DiffViewer({ filePath, before, after, onAccept, onReject, onCustom, onClose }: DiffViewerProps) {
  const CloseIcon = ActionIcons.close;
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
            <button aria-label="关闭" title="关闭" className="diff-close-btn" onClick={onClose}><CloseIcon size={16} /></button>
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
  /**
   * 第 233 轮审计：渲染量有上限（原来把全部 diff 行塞进 DOM；
   * >5000 行时还会退化成"全删+全增"= 2L 行）。被截断必须**说出来**，不许静默少显示。
   */
  const truncated = lines.length > DIFF_RENDER_ROW_CAP;
  const visible = truncated ? lines.slice(0, DIFF_RENDER_ROW_CAP) : lines;
  return (
    <table className="diff-table diff-unified">
      <tbody>
        {visible.map((line, idx) => (
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
      {truncated && (
        <tfoot>
          <tr>
            <td colSpan={4} className="diff-truncated-note">
              内容过长：仅显示前 {DIFF_RENDER_ROW_CAP} 行（共 {lines.length} 行 diff 行）
            </td>
          </tr>
        </tfoot>
      )}
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

  /**
   * 第 233 轮审计：与 unified 同一口径的**渲染上限**（配对后的行数同样可能上万）。
   */
  const truncated = rows.length > DIFF_RENDER_ROW_CAP;
  const visibleRows = truncated ? rows.slice(0, DIFF_RENDER_ROW_CAP) : rows;

  return (
    <table className="diff-table diff-split">
      <thead>
        <tr>
          <th colSpan={2} className="diff-split-header-old">Original</th>
          <th colSpan={2} className="diff-split-header-new">Modified</th>
        </tr>
      </thead>
      <tbody>
        {visibleRows.map((row, idx) => (
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
      {truncated && (
        <tfoot>
          <tr>
            <td colSpan={4} className="diff-truncated-note">
              内容过长：仅显示前 {DIFF_RENDER_ROW_CAP} 行（共 {rows.length} 行对比行）
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}

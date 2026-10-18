/**
 * Diff 卡片：**统一 / 分屏**两种视图（2026-10-18，对标 open-claude-ui 的 StreamingDiffViewer）。
 *
 * 为什么单独成文件：这两种视图的"行配对 + 行号"是纯函数（`core/ui/diff-view.ts`），
 * 组件只负责画。抽出来之后判据可以直接 `render(<DiffBlockCard …/>)` 并点按钮切模式，
 * 而不是把断言塞进巨大的 ToolCallCard。
 *
 * 判据 `DIFFVIEW-1..5`。
 */
import { useState } from "react";
import { FileEdit } from "lucide-react";
import { getLang } from "../core/i18n/lang";
import {
  parseDiffLines,
  toSplitRows,
  toUnifiedRows,
  type DiffViewMode,
} from "../core/ui/diff-view";

export interface DiffHunk {
  path: string;
  oldText: string | null;
  newText: string;
}

export function DiffBlockCard({ hunks }: { hunks: DiffHunk[] }) {
  const [mode, setMode] = useState<DiffViewMode>("unified");
  const zh = getLang() === "zh";
  return (
    <div className="tool-card tool-card--scroll diff-block">
      <div className="diff-view-mode-bar" role="group" aria-label="diff view mode">
        <button
          type="button"
          className={`diff-view-mode-btn ${mode === "unified" ? "is-active" : ""}`}
          aria-pressed={mode === "unified"}
          onClick={() => setMode("unified")}
        >
          {zh ? "统一" : "Unified"}
        </button>
        <button
          type="button"
          className={`diff-view-mode-btn ${mode === "split" ? "is-active" : ""}`}
          aria-pressed={mode === "split"}
          onClick={() => setMode("split")}
        >
          {zh ? "分屏" : "Split"}
        </button>
      </div>
      {hunks.map((hunk, idx) => {
        const parsed = parseDiffLines(hunk.newText || "");
        return (
          <div key={idx} className="tool-card-row">
            <div className="tool-card-head">
              <FileEdit className="icon-xs" /> {hunk.path}
            </div>
            {mode === "unified" ? (
              <pre className="tool-card-pre tool-card-pre--tight tool-card-pre--plain diff-unified">
                {toUnifiedRows(parsed).map((row, i) => (
                  <div key={i} className={`diff-line diff-line--${row.kind}`}>
                    <span className="diff-lnum diff-lnum--old">{row.oldNum ?? ""}</span>
                    <span className="diff-lnum diff-lnum--new">{row.newNum ?? ""}</span>
                    <span className="diff-line-text">{row.text || " "}</span>
                  </div>
                ))}
              </pre>
            ) : (
              <div className="diff-split-grid">
                {toSplitRows(parsed).map((row, i) => (
                  <div key={i} className={`diff-split-row diff-split-row--${row.kind}`}>
                    <span className="diff-lnum diff-lnum--old">{row.left?.num ?? ""}</span>
                    <span className={`diff-cell diff-cell--${row.left?.kind ?? "empty"}`}>
                      {row.left ? row.left.text || " " : ""}
                    </span>
                    <span className="diff-lnum diff-lnum--new">{row.right?.num ?? ""}</span>
                    <span className={`diff-cell diff-cell--${row.right?.kind ?? "empty"}`}>
                      {row.right ? row.right.text || " " : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

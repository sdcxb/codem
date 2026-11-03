/**
 * 差异视图 `DiffView` —— 桌面 `DiffViewer` 与本包宿主的**唯一**实现。
 *
 * 归属线：
 * - 这里只有"差异长什么样"：标题/统计/模式切换/自定义指令/预览/统一/分屏/渲染上限；
 * - 文案**全部由宿主注入**（`strings` 必填、没有默认值）—— 共享层不猜语言，
 *   也不允许出现"有注入 / 没注入"两条渲染路径（同 `chat-platform.tsx` 的纪律）；
 * - 图标用 lucide（与本包其它组件一致），不依赖桌面图标层（`ActionIcons`），
 *   桌面 `ActionIcons.close` 本来就是 lucide 的 `X`，换成直连不丢任何能力。
 *
 * 数据形状：`before` / `after` 两段文本 —— 桌面写确认、快照对比、回合变更都用这个形状。
 * 手机壳的 `workspace.diff` 只给统一 patch 文本（见 `docs/architecture/UI-UNIFY-PLAN.md`
 * Phase 5 的边界），**不要**在这里加"第二种输入"：那会变成两份 diff 渲染。
 */
import * as React from "react";
import { useMemo, useState } from "react";
import { X } from "lucide-react";

import { computeDiff, DIFF_RENDER_ROW_CAP, type DiffLine } from "./lcs-diff";

/** 差异视图的全部文案（必填：共享层没有默认语言） */
export interface DiffStrings {
  /** 模式按钮 */
  preview: string;
  previewTitle: string;
  unified: string;
  split: string;
  /** 三个动作按钮（不传对应回调时按钮不出现） */
  accept: string;
  acceptTitle: string;
  reject: string;
  rejectTitle: string;
  custom: string;
  customTitle: string;
  /** 自定义指令面板 */
  customLabel: string;
  customPlaceholder: string;
  customSubmit: string;
  customCancel: string;
  /** 预览视图 */
  originalLabel: string;
  modifiedLabel: string;
  newFileLabel: string;
  emptyContent: string;
  /** split 视图的表头（列标题） */
  splitOriginal: string;
  splitModified: string;
  bytes: (count: number) => string;
  /** 渲染上限的说明（unified / split 两种口径） */
  truncatedUnified: (shown: number, total: number) => string;
  truncatedSplit: (shown: number, total: number) => string;
  /** 关闭按钮的 aria-label / title */
  close: string;
}

export interface DiffViewProps {
  filePath: string;
  before: string;
  after: string;
  strings: DiffStrings;
  onAccept?: () => void;
  onReject?: () => void;
  onCustom?: (instruction: string) => void;
  onClose?: () => void;
}

export function DiffView(props: DiffViewProps): React.ReactElement {
  const { strings } = props;
  const [viewMode, setViewMode] = useState<"preview" | "unified" | "split">("preview");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customInstruction, setCustomInstruction] = useState("");

  const diffLines = useMemo(() => computeDiff(props.before, props.after), [props.before, props.after]);

  const addedCount = diffLines.filter((l) => l.type === "added").length;
  const removedCount = diffLines.filter((l) => l.type === "removed").length;
  const fileName = props.filePath.split(/[\\/]/).pop() || props.filePath;
  const isNewFile = !props.before || props.before.length === 0;

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-header">
        <div className="diff-viewer-title">
          <span className="diff-viewer-icon">📄</span>
          <span className="diff-viewer-filename" title={props.filePath}>{fileName}</span>
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
              title={strings.previewTitle}
            >
              {strings.preview}
            </button>
            <button
              className={`diff-mode-btn ${viewMode === "unified" ? "active" : ""}`}
              onClick={() => setViewMode("unified")}
            >
              {strings.unified}
            </button>
            <button
              className={`diff-mode-btn ${viewMode === "split" ? "active" : ""}`}
              onClick={() => setViewMode("split")}
            >
              {strings.split}
            </button>
          </div>
          {props.onAccept ? (
            <button className="diff-accept-btn" onClick={props.onAccept} title={strings.acceptTitle}>
              {strings.accept}
            </button>
          ) : null}
          {props.onReject ? (
            <button className="diff-reject-btn" onClick={props.onReject} title={strings.rejectTitle}>
              {strings.reject}
            </button>
          ) : null}
          {props.onCustom && !showCustomInput ? (
            <button className="diff-custom-btn" onClick={() => setShowCustomInput(true)} title={strings.customTitle}>
              {strings.custom}
            </button>
          ) : null}
          {props.onClose ? (
            <button
              aria-label={strings.close}
              title={strings.close}
              className="diff-close-btn"
              onClick={props.onClose}
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="diff-viewer-path">{props.filePath}</div>

      {showCustomInput ? (
        <div className="diff-custom-panel">
          <div className="diff-custom-label">{strings.customLabel}</div>
          <div className="diff-custom-input-row">
            <textarea
              className="diff-custom-textarea"
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              placeholder={strings.customPlaceholder}
              rows={2}
              autoFocus
            />
          </div>
          <div className="diff-custom-actions">
            <button
              className="diff-custom-submit-btn"
              onClick={() => {
                if (customInstruction.trim()) {
                  props.onCustom?.(customInstruction.trim());
                }
              }}
              disabled={!customInstruction.trim()}
            >
              {strings.customSubmit}
            </button>
            <button
              className="diff-custom-cancel-btn"
              onClick={() => {
                setShowCustomInput(false);
                setCustomInstruction("");
              }}
            >
              {strings.customCancel}
            </button>
          </div>
        </div>
      ) : null}

      <div className="diff-viewer-body">
        {viewMode === "preview" ? (
          <PreviewDiffView
            before={props.before}
            after={props.after}
            isNewFile={isNewFile}
            strings={strings}
          />
        ) : viewMode === "unified" ? (
          <UnifiedDiffView lines={diffLines} strings={strings} />
        ) : (
          <SplitDiffView lines={diffLines} strings={strings} />
        )}
      </div>
    </div>
  );
}

/** Preview view: 原始/写入内容并排对照（新文件只显示一行标记） */
function PreviewDiffView(props: {
  before: string;
  after: string;
  isNewFile: boolean;
  strings: DiffStrings;
}): React.ReactElement {
  const { strings } = props;
  return (
    <div className="diff-preview">
      {!props.isNewFile ? (
        <div className="diff-preview-section diff-preview-old">
          <div className="diff-preview-label">
            <span className="diff-preview-badge diff-preview-badge-old">{strings.originalLabel}</span>
            <span className="diff-preview-meta">{strings.bytes(props.before.length)}</span>
          </div>
          <pre className="diff-preview-content diff-preview-content-old">{props.before || strings.emptyContent}</pre>
        </div>
      ) : null}
      {props.isNewFile ? (
        <div className="diff-preview-section diff-preview-new-file">
          <span className="diff-preview-badge diff-preview-badge-new">{strings.newFileLabel}</span>
        </div>
      ) : null}
      <div className="diff-preview-arrow">↓</div>
      <div className="diff-preview-section diff-preview-new">
        <div className="diff-preview-label">
          <span className="diff-preview-badge diff-preview-badge-new">{strings.modifiedLabel}</span>
          <span className="diff-preview-meta">{strings.bytes(props.after.length)}</span>
        </div>
        <pre className="diff-preview-content diff-preview-content-new">{props.after || strings.emptyContent}</pre>
      </div>
    </div>
  );
}

function UnifiedDiffView(props: { lines: DiffLine[]; strings: DiffStrings }): React.ReactElement {
  /**
   * 第 233 轮审计：渲染量有上限（原来把全部 diff 行塞进 DOM；
   * >5000 行时还会退化成"全删+全增"= 2L 行）。被截断必须**说出来**，不许静默少显示。
   */
  const truncated = props.lines.length > DIFF_RENDER_ROW_CAP;
  const visible = truncated ? props.lines.slice(0, DIFF_RENDER_ROW_CAP) : props.lines;
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
      {truncated ? (
        <tfoot>
          <tr>
            <td colSpan={4} className="diff-truncated-note">
              {props.strings.truncatedUnified(DIFF_RENDER_ROW_CAP, props.lines.length)}
            </td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

function SplitDiffView(props: { lines: DiffLine[]; strings: DiffStrings }): React.ReactElement {
  // Group lines into old/new pairs for split view
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let i = 0;
  while (i < props.lines.length) {
    const line = props.lines[i];
    if (line.type === "unchanged") {
      rows.push({ left: line, right: line });
      i++;
    } else if (line.type === "removed") {
      // Check if next line is an addition (paired change)
      const next = props.lines[i + 1];
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
          <th colSpan={2} className="diff-split-header-old">{props.strings.splitOriginal}</th>
          <th colSpan={2} className="diff-split-header-new">{props.strings.splitModified}</th>
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
      {truncated ? (
        <tfoot>
          <tr>
            <td colSpan={4} className="diff-truncated-note">
              {props.strings.truncatedSplit(DIFF_RENDER_ROW_CAP, rows.length)}
            </td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

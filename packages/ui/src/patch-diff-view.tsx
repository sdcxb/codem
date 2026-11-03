/**
 * Patch 差异视图 —— 桌面工具卡 `DiffBlockCard` 与手机（文件预览 / 差异页签 / 变更浮层）
 * 的**唯一**实现。
 *
 * ## 与 `diff-view.tsx`（before/after `DiffView`）的分工
 *
 * `DiffView` 的输入是 before/after 两段文本，算法是 LCS；这里的输入是**统一 patch 文本**
 * （`git diff` / `workspace.diff` / `session.change.diff`），行号由 `@@` 头给出。
 * 两者是不同输入，不合并成"第二种输入"。
 *
 * ## 纪律
 *
 * - 文案全部由宿主注入（`strings` 必填）—— 共享层不猜语言；
 * - 空态不由本组件决定（"没有改动 / 不是 git 仓库 / 出错"是三种事实，宿主分别展示）；
 * - 渲染量有上限：复用 `DIFF_RENDER_ROW_CAP`，被截断必须说出来。
 *
 * 判据 `DIFFVIEW-5..8`、`FD-WIRE-6..9`。
 */
import * as React from "react";
import { useMemo, useState } from "react";

import { DIFF_RENDER_ROW_CAP } from "./lcs-diff";
import {
  parsePatchLines,
  toSplitRows,
  toUnifiedRows,
  type DiffViewMode,
} from "./patch-diff";

/** 共享 patch 视图的全部文案（必填：共享层没有默认语言） */
export interface PatchDiffStrings {
  unified: string;
  split: string;
  /** 模式按钮组的 aria-label（桌面沿用 "diff view mode"，保持 DOM 不变） */
  modeBarLabel: string;
  /** 渲染上限说明（`shown` 是实际渲染行数，`total` 是截断前总行数） */
  truncated: (shown: number, total: number) => string;
}

export interface PatchDiffModeBarProps {
  mode: DiffViewMode;
  onModeChange: (mode: DiffViewMode) => void;
  strings: PatchDiffStrings;
}

/**
 * 统一 / 分屏切换条。
 *
 * 桌面一张卡片可能有多个 hunk，但**只有一个模式条**（卡片级状态）—— 所以它和 body
 * 拆成两个零件，由宿主决定持有状态的位置；手机用组合好的 `PatchDiffView`。
 */
export function PatchDiffModeBar(props: PatchDiffModeBarProps): React.ReactElement {
  const { mode, onModeChange, strings } = props;
  return (
    <div className="diff-view-mode-bar" role="group" aria-label={strings.modeBarLabel}>
      <button
        type="button"
        className={`diff-view-mode-btn ${mode === "unified" ? "is-active" : ""}`}
        aria-pressed={mode === "unified"}
        onClick={() => onModeChange("unified")}
      >
        {strings.unified}
      </button>
      <button
        type="button"
        className={`diff-view-mode-btn ${mode === "split" ? "is-active" : ""}`}
        aria-pressed={mode === "split"}
        onClick={() => onModeChange("split")}
      >
        {strings.split}
      </button>
    </div>
  );
}

export interface PatchDiffBodyProps {
  patch: string;
  mode: DiffViewMode;
  strings: PatchDiffStrings;
}

/** patch 的行视图（不含模式条，也不含文件头 —— 文件头属于宿主卡片）。 */
export function PatchDiffBody(props: PatchDiffBodyProps): React.ReactElement {
  const parsed = useMemo(() => parsePatchLines(props.patch), [props.patch]);
  const unifiedRows = useMemo(
    () => (props.mode === "unified" ? toUnifiedRows(parsed) : null),
    [parsed, props.mode],
  );
  const splitRows = useMemo(
    () => (props.mode === "split" ? toSplitRows(parsed) : null),
    [parsed, props.mode],
  );

  const total = unifiedRows ? unifiedRows.length : (splitRows?.length ?? 0);
  const truncated = total > DIFF_RENDER_ROW_CAP;
  const note = truncated ? (
    <div className="diff-truncated-note">{props.strings.truncated(DIFF_RENDER_ROW_CAP, total)}</div>
  ) : null;

  if (props.mode === "unified") {
    const rows = truncated ? unifiedRows!.slice(0, DIFF_RENDER_ROW_CAP) : unifiedRows!;
    return (
      <>
        <pre className="tool-card-pre tool-card-pre--tight tool-card-pre--plain diff-unified">
          {rows.map((row, i) => (
            <div key={i} className={`diff-line diff-line--${row.kind}`}>
              <span className="diff-lnum diff-lnum--old">{row.oldNum ?? ""}</span>
              <span className="diff-lnum diff-lnum--new">{row.newNum ?? ""}</span>
              <span className="diff-line-text">{row.text || " "}</span>
            </div>
          ))}
        </pre>
        {note}
      </>
    );
  }

  const rows = truncated ? splitRows!.slice(0, DIFF_RENDER_ROW_CAP) : splitRows!;
  return (
    <>
      <div className="diff-split-grid">
        {rows.map((row, i) => (
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
      {note}
    </>
  );
}

export interface PatchDiffViewProps {
  patch: string;
  strings: PatchDiffStrings;
}

/** 组合视图（模式条 + body）：手机两处 patch 面用它，桌面卡片自己持有模式状态。 */
export function PatchDiffView(props: PatchDiffViewProps): React.ReactElement {
  const [mode, setMode] = useState<DiffViewMode>("unified");
  return (
    <div className="patch-diff">
      <PatchDiffModeBar mode={mode} onModeChange={setMode} strings={props.strings} />
      <PatchDiffBody patch={props.patch} mode={mode} strings={props.strings} />
    </div>
  );
}

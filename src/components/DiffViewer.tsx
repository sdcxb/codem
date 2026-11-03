/**
 * 桌面差异视图 —— **平台适配器**。
 *
 * 骨架（`DiffView`）与算法（`computeDiff` / `DIFF_RENDER_ROW_CAP`）只有一份，在
 * `packages/ui/src/{diff-view,lcs-diff}.tsx`（与手机壳同一个包）。这里只做两件事：
 *
 * 1. 注入桌面文案（共享层没有默认语言：`strings` 必填）；
 * 2. 把已有的 `computeDiff` / `DIFF_RENDER_ROW_CAP` **原样 re-export** ——
 *    三个既有调用点（写确认 / 回滚 / 快照）与 `diff-viewer-large` 判据的 import 路径不变。
 *
 * 关闭图标：共享层直用 lucide 的 `X`，与桌面 `ActionIcons.close` 是同一个图标（不丢能力）。
 */
import * as React from "react";

import { DiffView, type DiffStrings } from "../../packages/ui/src/diff-view";

export { computeDiff, DIFF_RENDER_ROW_CAP } from "../../packages/ui/src/lcs-diff";

interface DiffViewerProps {
  filePath: string;
  before: string;
  after: string;
  onAccept?: () => void;
  onReject?: () => void;
  onCustom?: (instruction: string) => void;
  onClose?: () => void;
}

/** 桌面文案（与迁移前逐字一致；接线判据用同一对象比对共享层渲染结果） */
export const DESKTOP_DIFF_STRINGS: DiffStrings = {
  preview: "Preview",
  previewTitle: "Show raw before/after content",
  unified: "Unified",
  split: "Split",
  accept: "✅ Accept",
  acceptTitle: "Keep new content",
  reject: "↩️ Reject",
  rejectTitle: "Restore old content",
  custom: "✏️ 其他",
  customTitle: "Provide custom instruction",
  customLabel: "请输入你的指令（例如：追加到文件末尾、合并内容、只保留新内容的部分…）",
  customPlaceholder: "例如：不要覆盖，把新内容追加到文件末尾",
  customSubmit: "✅ 提交指令",
  customCancel: "取消",
  originalLabel: "原始内容",
  modifiedLabel: "写入内容",
  newFileLabel: "✨ 新文件",
  emptyContent: "(empty)",
  splitOriginal: "Original",
  splitModified: "Modified",
  bytes: (count) => `${count} bytes`,
  truncatedUnified: (shown, total) => `内容过长：仅显示前 ${shown} 行（共 ${total} 行 diff 行）`,
  truncatedSplit: (shown, total) => `内容过长：仅显示前 ${shown} 行（共 ${total} 行对比行）`,
  close: "关闭",
};

export function DiffViewer(props: DiffViewerProps): React.ReactElement {
  return <DiffView {...props} strings={DESKTOP_DIFF_STRINGS} />;
}

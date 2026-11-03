/**
 * Diff 卡片（桌面适配器）—— 展示层只有一份，在 `packages/ui/src/patch-diff-view.tsx`。
 *
 * 这里只剩桌面自己的三件事：
 * 1. 卡片外壳（`.tool-card` / `.diff-block`）与每个 hunk 的文件头（`FileEdit` + path）；
 * 2. 卡片级「统一 / 分屏」状态（一张卡片可能有多个 hunk，但只有一个模式条）；
 * 3. 用 `getLang()` 注入桌面文案（共享层没有默认语言）。
 *
 * 行模型（hunk-aware 行号、分屏配对）在 `packages/ui/src/patch-diff.ts`；桌面不再有第二份。
 *
 * 判据 `DIFFVIEW-1..8`、`FD-WIRE-6..8`。
 */
import { useState } from "react";
import { FileEdit } from "lucide-react";
import { getLang } from "../core/i18n/lang";
import type { DiffViewMode, PatchDiffStrings } from "../core/ui/diff-view";
import { PatchDiffBody, PatchDiffModeBar } from "../../packages/ui/src/patch-diff-view";

export interface DiffHunk {
  path: string;
  oldText: string | null;
  newText: string;
}

/** 桌面文案（与迁移前逐字一致；`modeBarLabel` 保持 "diff view mode" 以不改 DOM） */
function desktopPatchDiffStrings(zh: boolean): PatchDiffStrings {
  return {
    unified: zh ? "统一" : "Unified",
    split: zh ? "分屏" : "Split",
    modeBarLabel: "diff view mode",
    truncated: (shown, total) =>
      zh
        ? `内容过长：仅显示前 ${shown} 行（共 ${total} 行 diff 行）`
        : `Too long: showing the first ${shown} of ${total} diff lines`,
  };
}

export function DiffBlockCard({ hunks }: { hunks: DiffHunk[] }) {
  const [mode, setMode] = useState<DiffViewMode>("unified");
  const strings = desktopPatchDiffStrings(getLang() === "zh");
  return (
    <div className="tool-card tool-card--scroll diff-block">
      <PatchDiffModeBar mode={mode} onModeChange={setMode} strings={strings} />
      {hunks.map((hunk, idx) => (
        <div key={idx} className="tool-card-row">
          <div className="tool-card-head">
            <FileEdit className="icon-xs" /> {hunk.path}
          </div>
          <PatchDiffBody patch={hunk.newText || ""} mode={mode} strings={strings} />
        </div>
      ))}
    </div>
  );
}

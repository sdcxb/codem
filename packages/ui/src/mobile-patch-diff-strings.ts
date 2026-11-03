/**
 * 手机壳的 patch 视图文案（**唯一一份**）。
 *
 * 共享渲染器 `patch-diff-view.tsx` 不写死任何语言；桌面 `DiffBlockCard` 用 `getLang()`
 * 注入自己的文案，手机壳（文件预览 / 差异页签 / 变更浮层）都注入这一份。
 */
import type { PatchDiffStrings } from "./patch-diff-view";

export const MOBILE_PATCH_DIFF_STRINGS: PatchDiffStrings = {
  unified: "统一",
  split: "分屏",
  modeBarLabel: "diff view mode",
  truncated: (shown, total) => `内容过长：仅显示前 ${shown} 行（共 ${total} 行）`,
};

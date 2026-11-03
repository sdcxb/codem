/**
 * 桌面 Diff 模型入口（**适配器**）。
 *
 * 纯逻辑（hunk-aware 解析 / 统一行号 / 分屏配对）已经搬到
 * `packages/ui/src/patch-diff.ts` —— 桌面与手机同一份，这里不再有第二套实现。
 *
 * 保留本文件只为让桌面侧的模型类型仍从 `core/ui` 的稳定入口取得（导入路径不变、
 * 也不会让 `src/components` 直接依赖共享包的内部文件布局）。
 */
export type { DiffViewMode } from "../../../packages/ui/src/patch-diff";
export type { PatchDiffStrings } from "../../../packages/ui/src/patch-diff-view";
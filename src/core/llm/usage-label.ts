/**
 * 成本历史里的「调用类型」标签（压缩调用必须能被人看出来）。
 *
 * 单独抽纯函数：`kind` 是数据事实，标签是展示事实；两者分开后可以各自判据，
 * 也避免把中文文案散落在 JSX 里。
 */
export function usageKindLabel(kind?: "chat" | "compaction"): string | null {
  return kind === "compaction" ? "上下文压缩" : null;
}

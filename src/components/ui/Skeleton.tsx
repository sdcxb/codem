/**
 * Skeleton —— 骨架占位（第 175 轮 P2-1）。
 *
 * 参考实现也**没有**这个组件（只有局部 shimmer），所以这里做出来是**领先项**。
 * 用途很具体：**列表/长文本在等数据时，别给一句"加载中…"**，而是给出与真实内容同形的灰条 ——
 * 布局不会在数据到达时跳动，用户也能预判"马上会出现几行、每行多宽"。
 *
 * 行为：
 * - `1.2s` 线性 shimmer（令牌 `--skeleton-duration`）；
 * - `prefers-reduced-motion: reduce` 下**关掉动画**、退化成静态灰块（不是"不动画的闪烁"）；
 * - `lines` 连续多行时逐行变窄（最后一行 60%），像真文本的收尾；
 * - 每一行 `aria-hidden`：骨架是**视觉占位**，读屏只需要知道"正在加载"（由外层 `role="status"` 负责）。
 */
import type { CSSProperties } from "react";

interface SkeletonProps {
  /** 行数（默认 1） */
  lines?: number;
  /** 单行高度（默认 12px，走令牌刻度） */
  height?: number;
  /** 宽度：数字按 px，字符串按原样（例如 "60%"） */
  width?: number | string;
  className?: string;
}

export function Skeleton({ lines = 1, height = 12, width = "100%", className }: SkeletonProps) {
  const rows = Math.max(1, lines);
  return (
    <div className={["skeleton-group", className].filter(Boolean).join(" ")} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => {
        /* 最后一行收窄：模仿真实文本的收尾（多行时才有意义） */
        const w = rows > 1 && i === rows - 1 ? "60%" : width;
        const style = {
          height: `${height}px`,
          width: typeof w === "number" ? `${w}px` : w,
        } as CSSProperties;
        return <div key={i} className="skeleton" style={style} />;
      })}
    </div>
  );
}

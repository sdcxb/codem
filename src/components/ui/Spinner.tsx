/**
 * Spinner —— 加载中的唯一实现（第 175 轮 P2-1）。
 *
 * ## 为什么要有
 *
 * 实测：CSS 里 **10 条转圈动画**用了 **3 种时长**（0.8s ×6 / 1s ×3 / 1.2s ×1），
 * TSX 里有 **4 种加载图标**（Loader2 14 / LoaderCircle 10 / RefreshCw 8 / RotateCw 3）
 * 和 **3 套类名**（spin 28 / spinner 9 / spinning 2）—— 同一个"正在加载"有十来种写法。
 * 时长已收进令牌 `--spin-duration`（门禁 COND-2 守），这里再收掉"用哪个图标/哪套类名"。
 *
 * ## 用法
 *
 * ```tsx
 * <Spinner />                    // 12px，行内
 * <Spinner size="md" />          // 14px（默认）
 * <Spinner size="lg" />          // 20px，面板级占位
 * <Spinner label="正在读取文件" />  // 读屏会念出来（默认"加载中"）
 * ```
 *
 * 组件自己带 `role="status"` + `aria-label`：加载指示器是**状态变化**，
 * 读屏用户需要知道"正在加载"，而不是看到一片空白。
 */
import type { CSSProperties } from "react";

interface SpinnerProps {
  /** 尺寸档：sm=12px / md=14px（默认）/ lg=20px —— 都取自 --icon-* 刻度 */
  size?: "sm" | "md" | "lg";
  /** 读屏文案（父容器已经有等价文字时传空字符串关掉） */
  label?: string;
  className?: string;
}

const SIZE_VAR: Record<NonNullable<SpinnerProps["size"]>, string> = {
  sm: "var(--icon-xs)",
  md: "var(--icon-sm)",
  lg: "var(--icon-lg)",
};

export function Spinner({ size = "md", label = "加载中", className }: SpinnerProps) {
  const style = { "--spinner-size": SIZE_VAR[size] } as CSSProperties;
  return (
    <span
      className={["spinner", className].filter(Boolean).join(" ")}
      style={style}
      role="status"
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    />
  );
}

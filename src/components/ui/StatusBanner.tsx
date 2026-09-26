/**
 * StatusBanner —— 状态提示条（第 175 轮 P2-1）。
 *
 * 实测现状：`role="alert"` 全仓只有 **4 处**，而错误/重试类文案有上百处 ——
 * 也就是说"出事了"这件事对读屏用户基本是**静默**的；各处的错误提示样式也各写一套。
 *
 * 目标形态（对齐参考实现的数值）：**4 档 tone**、内边距 12/16、圆角 8、1px 状态边、
 * surface 10% / border 30%；`role="alert"`，其中 error 档 `aria-live="assertive"`（其余 polite）。
 *
 * 用法：
 * ```tsx
 * <StatusBanner tone="error" onRetry={() => reload()}>保存失败</StatusBanner>
 * <StatusBanner tone="info">已切换到离线模式</StatusBanner>
 * ```
 * `onRetry` 给了才渲染重试按钮（不再每个调用点自己写一遍按钮）。
 */
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

interface StatusBannerProps {
  /** 四档：info / success / warning / error */
  tone?: "info" | "success" | "warning" | "error";
  children: ReactNode;
  /** 给了才渲染"重试"按钮 */
  onRetry?: () => void;
  /** 重试按钮文案（默认「重试」） */
  retryLabel?: string;
  /** 追加以便挂测试钩子/布局类 */
  className?: string;
  "data-testid"?: string;
}

export function StatusBanner({
  tone = "info",
  children,
  onRetry,
  retryLabel = "重试",
  className,
  "data-testid": testId,
}: StatusBannerProps) {
  return (
    <div
      className={["status-banner", `is-${tone}`, className].filter(Boolean).join(" ")}
      role="alert"
      /* 错误必须立刻打断（assertive），其余走 polite —— 与参考实现同口径 */
      aria-live={tone === "error" ? "assertive" : "polite"}
      data-testid={testId}
    >
      <div className="status-banner-text">{children}</div>
      {onRetry && (
        <button type="button" className="status-banner-retry" onClick={onRetry}>
          <RefreshCw size={12} aria-hidden="true" />
          {retryLabel}
        </button>
      )}
    </div>
  );
}

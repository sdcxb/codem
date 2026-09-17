/**
 * PetErrorBoundary — 宠物窗口的渲染错误兜底（P2-14）。
 *
 * ## 为什么不能复用主窗的 AppErrorBoundary
 *
 * 宠物窗是**独立 webview 入口**（`pet.html` → `src/pet-main.tsx`），只加载
 * `pet-window.css`；`AppErrorBoundary` 依赖主窗的 `styles.css` 与
 * localStorage 台账，把它拖进宠物窗会把宠物 bundle 的目标（~50KB）彻底打穿，
 * 而且它没有「窗口本身保持可拖动/可关闭」这条约束。
 *
 * 所以这里是一个**自包含**的最小边界：不 import 任何主窗模块（连样式都走内联），
 * 保证它在「渲染期异常 + 样式表失效」时仍然可见、可点。
 *
 * 边界一旦接管，宠物窗不会变成一块透明的死窗口：它显示一行可读的诊断文本，
 * 并给出「重新挂载」按钮（`onRetry`）。
 *
 * 局限：这里**不做**失败上报到 `reportActionFailure` —— 该通道属于主窗的
 * 存储/诊断体系（`src/core/storage/persist-failure.ts`），宠物入口刻意不加载它。
 * 宠物窗的失败以「窗口内可见横幅 + console.error」为准。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface PetErrorBoundaryProps {
  children: ReactNode;
}

interface PetErrorBoundaryState {
  hasError: boolean;
  message: string;
  /** 重试次数：用于给「反复崩溃」一个明确的下一步提示 */
  retries: number;
}

export class PetErrorBoundary extends Component<PetErrorBoundaryProps, PetErrorBoundaryState> {
  state: PetErrorBoundaryState = { hasError: false, message: "", retries: 0 };

  static getDerivedStateFromError(error: unknown): Partial<PetErrorBoundaryState> {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 宠物窗是独立 webview，主窗的控制台看不到这里 —— 保留原始栈便于真机排查
    console.error("[PetErrorBoundary] 宠物窗口渲染失败:", error, info?.componentStack ?? "");
  }

  handleRetry = (): void => {
    this.setState((s) => ({ hasError: false, message: "", retries: s.retries + 1 }));
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        data-pet-error="1"
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: 8,
          boxSizing: "border-box",
          background: "var(--pet-glass-bg-strong, rgba(24,26,38,0.92))",
          color: "var(--pet-text-muted, rgba(136,136,136,0.9))",
          // 宠物入口拿不到主窗的 --fs-* 令牌，故一律带兜底（与 PetWindowApp 的内联写法一致）
          fontSize: "var(--fs-xs, 11px)",
          lineHeight: 1.5,
          textAlign: "center",
          overflow: "hidden",
        }}
      >
        <div>⚠️ 宠物窗口渲染出错</div>
        <div style={{ opacity: 0.8, wordBreak: "break-word", maxHeight: 60, overflow: "hidden" }}>
          {this.state.message}
        </div>
        <button
          type="button"
          onClick={this.handleRetry}
          style={{
            padding: "4px 10px",
            borderRadius: "var(--radius-sm, 4px)",
            border: "1px solid var(--pet-glass-border-strong, rgba(255,255,255,0.14))",
            background: "transparent",
            color: "inherit",
            fontSize: "var(--fs-xs, 11px)",
            cursor: "pointer",
          }}
        >
          重新加载宠物界面
        </button>
        {this.state.retries >= 3 && (
          <div style={{ opacity: 0.7 }}>（已重试 {this.state.retries} 次仍失败，可右键窗口退出）</div>
        )}
      </div>
    );
  }
}

export default PetErrorBoundary;

/**
 * AppErrorBoundary — 顶层渲染崩溃恢复边界。
 *
 * 对标 dsh-desktop renderer-health / startup-recovery 的恢复理念（Electron 检测
 * renderer 崩溃后提供 recovery 窗口）：Codem 是 Tauri webview，无法从 Rust 侧
 * 直接探测渲染进程崩溃，因此在 React 树根部设一道错误边界，把"渲染阶段崩溃"
 * 从不可恢复的白屏变成可操作的恢复卡片：
 *
 *   1. 崩溃证据写入 localStorage（codem-renderer-crash，脱敏），下次启动时
 *      App 读取并给出提示（与 previous-run-unclean 崩溃提示并列）。
 *   2. 恢复卡片提供：重试渲染 / 重新加载应用 / 重置界面设置并重新加载。
 *      （会话数据在 SQLite 数据库文件中，重置界面设置不影响数据。）
 *   3. 错误详情经 redactSecrets 脱敏后才展示/持久化，避免 API key 泄漏。
 *
 * 注意：错误边界只捕获 React 渲染/生命周期阶段的同步错误；事件回调与 async
 * 错误仍由 main.tsx 的全局 error/unhandledrejection 监听记录。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { redactSecrets } from "../core/utils/redact";

/** localStorage 键：最近一次渲染崩溃证据（App 启动时消费并清除）。 */
export const RENDERER_CRASH_KEY = "codem-renderer-crash";

/** 崩溃证据记录（写入前已脱敏）。 */
export interface RendererCrashRecord {
  /** 崩溃时间（epoch ms）。 */
  occurredAt: number;
  /** 脱敏后的错误消息。 */
  message: string;
  /** 脱敏后的组件栈（截断）。 */
  componentStack: string;
  /** 崩溃时的页面 URL。 */
  url: string;
}

/** 读取最近一次渲染崩溃证据（不存在时返回 null）。 */
export function readRendererCrashRecord(): RendererCrashRecord | null {
  try {
    const raw = localStorage.getItem(RENDERER_CRASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RendererCrashRecord;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.occurredAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 清除渲染崩溃证据。 */
export function clearRendererCrashRecord(): void {
  try {
    localStorage.removeItem(RENDERER_CRASH_KEY);
  } catch {
    // localStorage 不可用（隐私模式等）时静默忽略。
  }
}

const MAX_MESSAGE_CHARS = 600;
const MAX_STACK_CHARS = 4000;

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  /** 脱敏后的错误消息。 */
  errorMessage: string;
  /** 脱敏后的组件栈（截断）。 */
  componentStack: string;
  /** 崩溃记录 id（用于展示/复制）。 */
  crashId: string;
}

/** 恢复卡片内使用的行内按钮样式（独立于全局 CSS，保证白屏时仍可读）。 */
const buttonBase: React.CSSProperties = {
  padding: "8px 18px",
  borderRadius: "8px",
  border: "1px solid var(--border-primary, rgba(128,128,128,0.35))",
  background: "var(--bg-hover, rgba(128,128,128,0.18))",
  color: "var(--text-primary, #e6e6e6)",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  transition: "opacity 0.15s ease",
};
const primaryButton: React.CSSProperties = {
  ...buttonBase,
  background: "var(--accent, #7c6cf0)",
  borderColor: "transparent",
  color: "#fff",
};
const dangerButton: React.CSSProperties = {
  ...buttonBase,
  background: "transparent",
  color: "var(--danger, #e5484d)",
  borderColor: "var(--danger, rgba(229,72,77,0.5))",
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: "",
      componentStack: "",
      crashId: "",
    };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleReload = this.handleReload.bind(this);
    this.handleResetReload = this.handleResetReload.bind(this);
  }

  static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    const message = error instanceof Error ? error.message : String(error);
    return {
      hasError: true,
      errorMessage: redactSecrets(message).slice(0, MAX_MESSAGE_CHARS),
      crashId: `crash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error);
    // 崩溃证据：脱敏后持久化，供下次启动提示（对标 crash-evidence 精神）。
    const record: RendererCrashRecord = {
      occurredAt: Date.now(),
      message: redactSecrets(message).slice(0, MAX_MESSAGE_CHARS),
      componentStack: redactSecrets(info.componentStack ?? "").slice(0, MAX_STACK_CHARS),
      url: typeof location !== "undefined" ? location.href : "",
    };
    try {
      localStorage.setItem(RENDERER_CRASH_KEY, JSON.stringify(record));
    } catch {
      // localStorage 不可用：仅记录到 console。
    }
    // eslint-disable-next-line no-console
    console.error("[AppErrorBoundary] Render crash captured:", error);
  }

  /** 重试渲染当前子树（不清任何状态/数据）。 */
  handleRetry(): void {
    this.setState({ hasError: false, errorMessage: "", componentStack: "", crashId: "" });
  }

  /** 整页重新加载：数据已持久化到数据库，刷新后自动恢复。 */
  handleReload(): void {
    location.reload();
  }

  /** 清空本地界面设置（localStorage 中 codem-* 键，不动数据库）后重新加载。 */
  handleResetReload(): void {
    let confirmText = "将清除本地界面设置（关闭行为、窗口状态等偏好），会话数据保存在数据库中、不受影响。确定继续？";
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      const ok = window.confirm(confirmText);
      if (!ok) return;
    }
    try {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith("codem-")) doomed.push(key);
      }
      for (const key of doomed) localStorage.removeItem(key);
    } catch {
      // localStorage 不可用：跳过清理，直接 reload。
    }
    location.reload();
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2147483000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-primary, #0e0f0f)",
          padding: 24,
          boxSizing: "border-box",
        }}
        data-testid="render-crash-card"
      >
        <div
          style={{
            maxWidth: 560,
            width: "100%",
            background: "var(--bg-secondary, #1a1c1c)",
            border: "1px solid var(--border-primary, rgba(128,128,128,0.25))",
            borderRadius: 12,
            padding: "28px 26px",
            boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
            boxSizing: "border-box",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "var(--danger, #e5484d)",
                flexShrink: 0,
              }}
              aria-hidden
            />
            <h2
              style={{
                margin: 0,
                fontSize: 17,
                fontWeight: 700,
                color: "var(--text-primary, #e6e6e6)",
              }}
            >
              界面渲染出现问题
            </h2>
          </div>
          <p
            style={{
              margin: "0 0 6px",
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--text-secondary, #a8a8a8)",
            }}
          >
            应用界面遇到一个意外错误。你的会话数据已保存在本地数据库中，可以放心重试或重新加载。
          </p>
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--text-muted, #7a7a7a)" }}>
            若问题反复出现，可尝试「重置界面设置并重新加载」，或前往 设置 → 会话恢复 查看历史快照。
          </p>

          <details
            style={{
              marginBottom: 20,
              fontSize: 12,
              color: "var(--text-muted, #8a8a8a)",
            }}
          >
            <summary style={{ cursor: "pointer", userSelect: "none" }}>错误详情（已自动脱敏）</summary>
            <pre
              data-testid="render-crash-detail"
              style={{
                margin: "8px 0 0",
                padding: 10,
                background: "var(--bg-tertiary, rgba(128,128,128,0.12))",
                borderRadius: 6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 180,
                overflow: "auto",
                fontFamily: "ui-monospace, Consolas, monospace",
                fontSize: 11,
                color: "var(--text-secondary, #b0b0b0)",
              }}
            >
              {this.state.errorMessage || "(无错误消息)"}
              {"\n"}
              {this.state.crashId}
            </pre>
          </details>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="button" style={primaryButton} onClick={this.handleRetry} data-testid="crash-retry">
              重试渲染
            </button>
            <button type="button" style={buttonBase} onClick={this.handleReload} data-testid="crash-reload">
              重新加载应用
            </button>
            <button type="button" style={dangerButton} onClick={this.handleResetReload} data-testid="crash-reset">
              重置界面设置并重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default AppErrorBoundary;

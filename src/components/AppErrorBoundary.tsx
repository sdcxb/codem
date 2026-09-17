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
import { resetPersistFailures } from "../core/storage/persist-failure";

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

/**
 * 重试预算：**同一个错误特征**最多允许这么多次"重试渲染"。
 *
 * 为什么需要：`handleRetry` 以前只是把 `hasError` 置回 false，不改任何状态/缓存，
 * 于是"崩溃原因还在 → 重试 → 同一处立刻再崩"可以无限循环，用户永远停在恢复卡片上
 * （点几次就放弃，且没有任何计数或下一步提示）。现在同一签名连续失败到上限后
 * 关闭重试按钮，并把下一步明确指向"重新加载应用 / 重置界面设置"。
 * 错误签名**变化**（换了一处崩）时预算重新给满 —— 这不是同一个问题的重试风暴。
 */
export const MAX_RENDERER_RETRIES = 3;

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
  /** 当前错误特征（组件栈首行，去掉行列号）—— 用来判定"是不是同一个崩溃"。 */
  errorSignature: string;
  /** 本次错误特征下已用掉的重试次数。 */
  retryCount: number;
}

/** 恢复卡片内使用的行内按钮样式（独立于全局 CSS，保证白屏时仍可读）。 */
const buttonBase: React.CSSProperties = {
  padding: "8px 18px",
  borderRadius: "var(--radius)",
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
  color: "var(--text-on-accent, #fff)",
};
const dangerButton: React.CSSProperties = {
  ...buttonBase,
  background: "transparent",
  // 崩溃兜底页要能在样式表整体失效时仍然可读，所以这里的令牌**必须带字面量兜底**
  // （正常页面里 var() 的兜底值是冗余的，这一页不是）
  color: "var(--error, #e5484d)",
  borderColor: "var(--error, #e5484d)",
};

/**
 * 错误特征：组件栈里第一行"真实组件"帧（去掉文件名与行列号）。
 *
 * 同一处崩溃重试时签名不变；换了另一处崩签名就变了。
 * 取不到组件栈时退回消息文本，末尾数字（往往是 id/时间戳）剥掉，
 * 免得"每次崩都算新错误"从而绕开重试预算。
 */
export function errorSignatureOf(errorMessage: string, componentStack: string): string {
  const firstFrame = componentStack
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at ") || /^<[A-Za-z]/.test(line));
  const base = (firstFrame || errorMessage || "unknown").trim();
  // 剥掉源码位置：`at ChatPanel (src/components/ChatPanel.tsx:120:9) in div` 里的
  // `:120:9` 与位置无关（同一处崩溃在每次构建/编辑后行号都会变），保留它会把
  // "同一处崩溃"当成新错误，从而反复给满重试预算 = 重试风暴又回来了。
  return base
    .replace(/(?::\d+){1,2}(?=[)\s]|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 复制/展示用的错误详情（已脱敏；不含任何原文未脱敏内容）。
 *
 * 单独抽成纯函数：恢复卡片要能"把详情交出去"（贴进 issue / 交给同事），
 * 而这一步不能再依赖 localStorage 或剪贴板 API 是否可用。
 */
export function buildCrashDetailText(state: {
  errorMessage: string;
  componentStack: string;
  crashId: string;
  retryCount: number;
}): string {
  const lines = [
    "【Codem 界面渲染崩溃】",
    `时间: ${new Date().toISOString()}`,
    `崩溃 id: ${state.crashId || "(已重试，本轮无 id)"}`,
    `已重试次数: ${state.retryCount}`,
    `错误: ${state.errorMessage || "(无错误消息)"}`,
  ];
  if (state.componentStack) {
    lines.push("组件栈:", state.componentStack);
  }
  return lines.join("\n");
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: "",
      componentStack: "",
      crashId: "",
      errorSignature: "",
      retryCount: 0,
    };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleReload = this.handleReload.bind(this);
    this.handleResetReload = this.handleResetReload.bind(this);
    this.handleCopyDetails = this.handleCopyDetails.bind(this);
  }

  /**
   * 是否还有重试预算。
   *
   * 计数语义：`retryCount` = **用户已经点过的重试次数**（同一个错误签名内）。
   * 初始崩溃不计一次重试（用户还没点过），所以预算是 `MAX_RENDERER_RETRIES` 次点击。
   * 签名变化（换了一处崩）时归零 —— 不是同一个问题的重试风暴。
   */
  private isRetryAllowed(): boolean {
    return this.state.retryCount < MAX_RENDERER_RETRIES;
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
    const componentStack = redactSecrets(info.componentStack ?? "").slice(0, MAX_STACK_CHARS);
    const signature = errorSignatureOf(message, componentStack);

    // 签名变了说明是另一处崩溃 → 重试计数归零（不惩罚用户）
    if (this.state.errorSignature !== signature) {
      this.setState({ errorSignature: signature, retryCount: 0, componentStack });
    } else {
      this.setState({ componentStack });
    }

    // 崩溃证据：脱敏后持久化，供下次启动提示（对标 crash-evidence 精神）。
    const record: RendererCrashRecord = {
      occurredAt: Date.now(),
      message: redactSecrets(message).slice(0, MAX_MESSAGE_CHARS),
      componentStack,
      url: typeof location !== "undefined" ? location.href : "",
    };
    try {
      localStorage.setItem(RENDERER_CRASH_KEY, JSON.stringify(record));
    } catch {
      // localStorage 不可用：仅记录到 console。
    }
    // eslint-disable-next-line no-console
    console.error(
      `[AppErrorBoundary] Render crash captured（已重试 ${this.state.retryCount} / ${MAX_RENDERER_RETRIES} 次）:`,
      error,
    );
  }

  /**
   * 重试渲染当前子树。
   *
   * 原实现只把 `hasError` 置回 false（注释还写着"不清任何状态/数据"），于是：
   *   ① 上一轮的崩溃证据仍留在 localStorage 里 —— 下次启动会提示一条**已经恢复**的崩溃；
   *   ② 恢复卡片上不显示"这是第几次重试"，也拿不到错误详情；
   *   ③ 同一处崩溃可以被无限重试。
   * 现在：清掉本边界的崩溃证据与脱敏错误缓存 + 清掉本地失败台账（重试前用户想看到的是
   * "现在还剩什么没生效"，而不是上一轮的旧账）+ 计数可见 + 有上限。
   *
   * ⚠️ 仍然做不到的事：**模块级渲染缓存/渲染态**（store 里的临时 UI 状态、各 core
   * 单例的缓存）不在这里清。本文件刻意不 import `src/store.ts`（顶层错误边界的依赖要
   * 尽可能少，store 会引入存储端口/数据库这一整条链）。要彻底修好需要 store 提供一个
   * `resetTransientUiState()` 入口 —— 已写进交付报告的"需要他人配合"。
   */
  handleRetry(): void {
    if (!this.isRetryAllowed()) return;
    // 用户在恢复卡片上已经确认过这次崩溃 → 旧证据不必再在下次启动时提示
    clearRendererCrashRecord();
    try {
      resetPersistFailures();
    } catch {
      // 失败台账清理属尽力而为，不能影响重试本身。
    }
    // 计一次重试（重试后再崩回来时，计数已经反映"用户点过几次"）；
    // 重试过程中 crashId 清空，避免用户把上一轮的 id 当成这一次的
    this.setState((prev) => ({
      hasError: false,
      errorMessage: "",
      componentStack: "",
      crashId: "",
      retryCount: prev.retryCount + 1,
    }));
  }

  /** 把脱敏后的错误详情写到剪贴板（重试仍失败时的"下一步"：把详情交出去）。 */
  handleCopyDetails(): void {
    const detail = buildCrashDetailText(this.state);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(detail).catch(() => {});
        return;
      }
    } catch {
      // 落到下面的降级路径
    }
    try {
      const area = document.createElement("textarea");
      area.value = detail;
      document.body.appendChild(area);
      area.select();
      document.execCommand?.("copy");
      area.remove();
    } catch {
      // eslint-disable-next-line no-console
      console.error("[AppErrorBoundary] 复制错误详情失败");
    }
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

    const retryExhausted = !this.isRetryAllowed();

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: "var(--z-max)",
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
            borderRadius: "var(--radius-md)",
            padding: "28px 26px",
            boxShadow: "0 12px 40px var(--shadow-color, rgba(0,0,0,0.35))",
            boxSizing: "border-box",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "var(--error, #e5484d)",
                flexShrink: 0,
              }}
              aria-hidden
            />
            <h2
              style={{
                margin: 0,
                fontSize: "var(--fs-lg)",
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
              fontSize: "var(--fs-base)",
              lineHeight: 1.6,
              color: "var(--text-secondary, #a8a8a8)",
            }}
          >
            应用界面遇到一个意外错误。你的会话数据已保存在本地数据库中，可以放心重试或重新加载。
          </p>
          <p style={{ margin: "0 0 16px", fontSize: "var(--fs-sm)", color: "var(--text-muted, #7a7a7a)" }}>
            若问题反复出现，可尝试「重置界面设置并重新加载」，或前往 设置 → 会话恢复 查看历史快照。
          </p>

          {/* 重试计数与"下一步"（P1-3）：不许静默重复失败 */}
          <p
            data-testid="crash-retry-note"
            style={{
              margin: "0 0 16px",
              fontSize: "var(--fs-sm)",
              color: retryExhausted ? "var(--error, #e5484d)" : "var(--text-muted, #7a7a7a)",
            }}
          >
            {retryExhausted
              ? `同一处错误已连续出现 ${this.state.retryCount} 次，重试渲染已停止（重试不会改变结果）。请先「复制错误详情」留证，再「重新加载应用」；仍不行就用「重置界面设置并重新加载」。`
              : `重试次数：${this.state.retryCount} / ${MAX_RENDERER_RETRIES}（同一处错误连续失败到这个上限后，重试按钮会关闭）`}
          </p>

          <details
            style={{
              marginBottom: 20,
              fontSize: "var(--fs-sm)",
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
                borderRadius: "var(--radius-sm)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 180,
                overflow: "auto",
                fontFamily: "ui-monospace, Consolas, monospace",
                fontSize: "var(--fs-sm)",
                color: "var(--text-secondary, #b0b0b0)",
              }}
            >
              {this.state.errorMessage || "(无错误消息)"}
              {"\n"}
              {this.state.crashId}
            </pre>
          </details>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button
              type="button"
              style={retryExhausted ? { ...primaryButton, opacity: 0.5, cursor: "not-allowed" } : primaryButton}
              onClick={this.handleRetry}
              disabled={retryExhausted}
              data-testid="crash-retry"
            >
              {retryExhausted ? "重试渲染（已达上限）" : "重试渲染"}
            </button>
            <button type="button" style={buttonBase} onClick={this.handleReload} data-testid="crash-reload">
              重新加载应用
            </button>
            <button type="button" style={buttonBase} onClick={this.handleCopyDetails} data-testid="crash-copy">
              复制错误详情
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

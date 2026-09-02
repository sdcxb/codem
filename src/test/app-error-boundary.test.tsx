/**
 * AppErrorBoundary 测试 — 顶层渲染崩溃恢复边界（对标 dsh renderer-health 恢复）
 *
 * 覆盖项：
 * REC-R1 正常渲染不干扰子树
 * REC-R2 渲染崩溃 → 恢复卡片出现 + 崩溃证据写入 localStorage
 * REC-R3 崩溃证据中的错误消息经 redactSecrets 脱敏（不泄漏 sk- 等密钥）
 * REC-R4 点击「重试渲染」→ 子树恢复渲染
 * REC-R5 readRendererCrashRecord 对畸形 JSON / 非法结构返回 null
 * REC-R6 「重置界面设置并重新加载」仅清理 codem-* 键并确认后才执行
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import {
  AppErrorBoundary,
  readRendererCrashRecord,
  clearRendererCrashRecord,
  RENDERER_CRASH_KEY,
  type RendererCrashRecord,
} from "../components/AppErrorBoundary";

/** 渲染阶段抛错的子组件（用于触发边界）。 */
class BoomChild extends React.Component<{ message?: string }> {
  render(): React.ReactNode {
    throw new Error(this.props.message ?? "render boom");
  }
}

/** 可控子组件：模块级开关决定是否抛错（用于验证重试恢复）。 */
let boomOn = false;
function ToggleBoomChild(): React.ReactElement {
  if (boomOn) throw new Error("toggle boom");
  return <div data-testid="recovered-node">recovered content</div>;
}

describe("AppErrorBoundary — 渲染崩溃恢复边界", () => {
  beforeEach(() => {
    boomOn = false;
    localStorage.clear();
    // React 渲染错误会向 console.error 输出大量内部日志，静默以保持测试输出干净。
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("REC-R1: 正常渲染时不影响子树", () => {
    render(
      <AppErrorBoundary>
        <div data-testid="normal-node">normal content</div>
      </AppErrorBoundary>
    );
    expect(screen.getByTestId("normal-node").textContent).toBe("normal content");
    expect(screen.queryByTestId("render-crash-card")).toBeNull();
  });

  it("REC-R2: 渲染崩溃 → 显示恢复卡片 + 崩溃证据写入 localStorage", () => {
    render(
      <AppErrorBoundary>
        <BoomChild message="boom R2" />
      </AppErrorBoundary>
    );
    expect(screen.getByTestId("render-crash-card")).toBeTruthy();
    expect(screen.getByText("界面渲染出现问题")).toBeTruthy();
    // 三个恢复动作按钮均可用
    expect(screen.getByTestId("crash-retry")).toBeTruthy();
    expect(screen.getByTestId("crash-reload")).toBeTruthy();
    expect(screen.getByTestId("crash-reset")).toBeTruthy();
    // 崩溃证据已持久化
    const record = readRendererCrashRecord();
    expect(record).not.toBeNull();
    expect(record!.message).toContain("boom R2");
    expect(record!.occurredAt).toBeGreaterThan(0);
    expect(localStorage.getItem(RENDERER_CRASH_KEY)).not.toBeNull();
  });

  it("REC-R3: 崩溃证据错误消息经脱敏，不泄漏 API key", () => {
    const secretKey = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    render(
      <AppErrorBoundary>
        <BoomChild message={`api rejected key=${secretKey}`} />
      </AppErrorBoundary>
    );
    const detail = screen.getByTestId("render-crash-detail").textContent ?? "";
    expect(detail).not.toContain(secretKey);
    expect(detail).toContain("[REDACTED_API_KEY]");
    // localStorage 中的证据同样脱敏
    const record = readRendererCrashRecord();
    expect(record!.message).not.toContain(secretKey);
  });

  it("REC-R4: 点击「重试渲染」→ 子树恢复渲染", () => {
    boomOn = true;
    render(
      <AppErrorBoundary>
        <ToggleBoomChild />
      </AppErrorBoundary>
    );
    expect(screen.getByTestId("render-crash-card")).toBeTruthy();
    // 修复崩溃源后点击重试 → 子树恢复
    boomOn = false;
    fireEvent.click(screen.getByTestId("crash-retry"));
    expect(screen.getByTestId("recovered-node").textContent).toBe("recovered content");
    expect(screen.queryByTestId("render-crash-card")).toBeNull();
  });

  it("REC-R5: readRendererCrashRecord 对畸形数据返回 null", () => {
    localStorage.setItem(RENDERER_CRASH_KEY, "not-json{{");
    expect(readRendererCrashRecord()).toBeNull();
    localStorage.setItem(RENDERER_CRASH_KEY, JSON.stringify({ message: "x" })); // 缺 occurredAt
    expect(readRendererCrashRecord()).toBeNull();
    clearRendererCrashRecord();
    expect(readRendererCrashRecord()).toBeNull();
    // 合法记录可读取
    const valid: RendererCrashRecord = { occurredAt: 123, message: "m", componentStack: "", url: "" };
    localStorage.setItem(RENDERER_CRASH_KEY, JSON.stringify(valid));
    const got = readRendererCrashRecord();
    expect(got).not.toBeNull();
    expect(got!.message).toBe("m");
  });

  it("REC-R6: 重置按钮先确认、仅清 codem-* 键；取消时不清除", () => {
    const confirmSpy = vi.fn(() => false);
    const reloadSpy = vi.fn(() => {});
    (window as any).confirm = confirmSpy;
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      configurable: true,
      writable: true,
    });
    localStorage.setItem("codem-close-behavior", "tray");
    localStorage.setItem("codem-window-state", "{}");
    localStorage.setItem("other-key", "keep-me");

    render(
      <AppErrorBoundary>
        <BoomChild message="boom R6" />
      </AppErrorBoundary>
    );
    fireEvent.click(screen.getByTestId("crash-reset"));
    // 取消确认 → 什么都不做
    expect(localStorage.getItem("codem-close-behavior")).toBe("tray");
    expect(reloadSpy).not.toHaveBeenCalled();

    confirmSpy.mockImplementation(() => true);
    fireEvent.click(screen.getByTestId("crash-reset"));
    expect(localStorage.getItem("codem-close-behavior")).toBeNull();
    expect(localStorage.getItem("codem-window-state")).toBeNull();
    expect(localStorage.getItem("other-key")).toBe("keep-me");
    expect(reloadSpy).toHaveBeenCalled();
  });
});

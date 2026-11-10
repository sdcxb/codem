/**
 * C13：**用户不做上下文管理** —— 默认配置下不存在手动压缩入口。
 *
 * ## 为什么这条判据不能只查文案
 *
 * 「压缩上下文」按钮是用户唯一能主动做的上下文管理动作。C13 要求它默认不存在；
 * 只改文案（比如把「压缩」写成「整理」）而按钮还在，用户仍然会被要求管理上下文。
 * 所以判据必须是**真实渲染后的 DOM**：默认配置下 `queryByText(/压缩上下文/)` 必须为 null，
 * 且诊断数字（压力/阈值/消息数/费用/整理状态）仍然在。
 *
 * ## 灰度保守（反向对照）
 *
 * 显式 `{ segmentEpochs: false }` 时回到旧路径，手动入口与水位告警必须**恢复** ——
 * 否则灰度回滚后用户既没有自动换段、也没有手动入口，上下文只能等死。
 *
 * ## 变异自证（会让本文件红）
 *
 * 把按钮改成无条件渲染（去掉 `!segmentOn`）⇒ MC-1 红；
 * 把显式关闭时的手动入口也一起删掉 ⇒ MC-2 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ContextMonitor } from "../components/ContextMonitor";
import { getContextManager } from "../core/context/context";
import { createMessage } from "../core/storage/message";

const SESSION = "sess-c13-entry";

function seedMessages(count = 4) {
  for (let i = 0; i < count; i += 1) {
    createMessage(
      {
        id: `c13-msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `第 ${i} 条`,
        timestamp: 1_000 + i,
        status: "done",
      },
      SESSION,
    );
  }
}

/** 等面板的 3 秒轮询先跑一次：消息数变成 4 之后，按钮的渲染条件才算真的被求值过 */
async function waitForMessageCount(count: number) {
  await waitFor(() => {
    const label = screen.getByText("消息数");
    expect(label.parentElement?.textContent ?? "").toBe(`消息数${count}`);
  });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  /* 每个用例都从默认配置开始（单例在同文件里跨用例存活） */
  getContextManager().updateConfig({ segmentEpochs: true });
});

afterEach(() => {
  cleanup();
  getContextManager().updateConfig({ segmentEpochs: true });
  vi.restoreAllMocks();
});

describe("C13：默认没有手动压缩入口（显式关闭才恢复）", () => {
  it("MC-1: 默认配置 + 有历史 ⇒ 不存在「压缩上下文」按钮，只留中性「已自动整理」与诊断数字", async () => {
    seedMessages(4);
    render(<ContextMonitor sessionId={SESSION} visible={true} />);
    await waitForMessageCount(4);

    expect(screen.queryByText(/压缩上下文/), "默认配置下不许出现手动压缩入口").toBeNull();
    expect(
      screen.queryByRole("button", { name: /压缩上下文|压缩中|已压缩/ }),
      "任何以「压缩上下文」为动作的按钮都不该有",
    ).toBeNull();
    expect(screen.queryByText(/即将满|立即压缩/), "也不许再让用户「立即压缩」（入口都不存在了）").toBeNull();

    /* 中性状态：程序已自动整理，用户不需要做什么 */
    const organized = screen.getByTestId("context-auto-organized");
    expect(organized.textContent, "状态文案只讲「已自动整理」").toContain("已自动整理");
    expect(organized.textContent, "不给用户派活（无需操作）").toContain("无需操作");

    /* 诊断数字一条不少（C13 只拿掉「手动入口」，不拿掉可检查性） */
    expect(screen.getByText("压力等级")).toBeTruthy();
    expect(screen.getByText("自动压缩阈值")).toBeTruthy();
    expect(screen.getByText("消息数")).toBeTruthy();
    expect(screen.getByText("今日费用")).toBeTruthy();
    expect(screen.getByTestId("context-manifests")).toBeTruthy();
  });

  it("MC-2（反向对照）: 显式 segmentEpochs:false ⇒ 手动压缩入口与水位告警恢复（灰度回滚仍可自救）", async () => {
    getContextManager().updateConfig({ segmentEpochs: false });
    seedMessages(4);
    render(<ContextMonitor sessionId={SESSION} visible={true} />);

    const button = await waitFor(() => {
      const el = screen.getByText(/压缩上下文/) as HTMLButtonElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(button.tagName, "恢复的必须是真正可点的按钮").toBe("BUTTON");
    expect(screen.queryByTestId("context-auto-organized"), "关闭后不再声称「已自动整理」").toBeNull();

    /* 回到旧路径的可见证据：按钮标题仍解释它会做什么 */
    expect(button.title).toContain("压缩上下文");
  });
});

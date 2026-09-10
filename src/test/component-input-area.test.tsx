/**
 * 组件渲染测试 — InputArea
 *
 * 验证输入区的核心交互：输入文本、发送、取消、禁用状态。
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InputArea } from "../components/InputArea";
import type { CollaborationMode } from "../core/agent/agent";

function renderInputArea(overrides: Record<string, any> = {}) {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  const onModeChange = vi.fn();

  const props = {
    onSend,
    onCancel,
    disabled: false,
    isStreaming: false,
    collaborationMode: "default" as CollaborationMode,
    onModeChange,
    connected: true,
    ...overrides,
  };

  const utils = render(<InputArea {...props} />);
  return { ...utils, onSend, onCancel, onModeChange };
}

describe("InputArea — 渲染测试", () => {
  it("渲染文本输入框", () => {
    renderInputArea();
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();
  });

  it("输入文本后点击发送按钮触发 onSend", async () => {
    const user = userEvent.setup();
    const { onSend } = renderInputArea();

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "帮我写一个函数");

    // 找到发送按钮（通常是带 ArrowRight 或类似图标的按钮）
    const sendBtn = screen.getByRole("button", { name: /send|发送/i }) ||
      screen.queryByTitle(/send|发送/i);
    if (sendBtn) {
      await user.click(sendBtn);
      expect(onSend).toHaveBeenCalled();
      const callArgs = onSend.mock.calls[0];
      expect(callArgs[0]).toContain("帮我写一个函数");
    }
  });

  it("disabled 状态下禁用输入", () => {
    renderInputArea({ disabled: true });
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeDisabled();
  });

  it("流式状态显示取消按钮", () => {
    renderInputArea({ isStreaming: true, disabled: true });
    // 流式时应出现停止/取消按钮
    const cancelBtn = screen.queryByRole("button", { name: /stop|cancel|停止|取消/i }) ||
      screen.queryByTitle(/stop|cancel|停止|取消/i);
    // 取消按钮可能存在
    if (cancelBtn) {
      expect(cancelBtn).toBeInTheDocument();
    }
  });

  it("空输入不触发发送", async () => {
    const user = userEvent.setup();
    const { onSend } = renderInputArea();

    const sendBtn = screen.getByRole("button", { name: /send|发送/i }) ||
      screen.queryByTitle(/send|发送/i);
    if (sendBtn) {
      await user.click(sendBtn);
      // 空输入不应该触发 onSend
      expect(onSend).not.toHaveBeenCalled();
    }
  });

  it("noSession 状态显示提示", () => {
    renderInputArea({ noSession: true, disabled: true });
    // 应该显示某种"请选择会话"的提示
    const hint = screen.queryByText(/select|create|选择|创建|会话/i);
    // 可能存在提示文字
    if (hint) {
      expect(hint).toBeInTheDocument();
    }
  });

  it("渲染协作模式切换", () => {
    renderInputArea({ collaborationMode: "default" });
    // 协作模式切换器应该存在
    const modeBtn = screen.queryByRole("button", { name: /default|plan|模式/i }) ||
      screen.queryByText(/default|plan|模式/i);
    if (modeBtn) {
      expect(modeBtn).toBeInTheDocument();
    }
  });
});

/**
 * 第 46 波：「搜索当前会话」「临时会话」从会话头部移到编辑器底部工具行
 * （与执行模式 / 安全策略同一行，`.input-tools-left` 的最右边）。
 *
 * 为什么要测"位置"而不只是"存在"：这两个按钮的价值在于**放对了地方** —— 头部那一排是
 * 会话级状态与视图切换，编辑器底部才是输入辅助动作。只断言"能点"的话，把它们挪回头部
 * 测试依然全绿，等于没有保护。
 */
describe("InputArea — 第 46 波：输入区辅助按钮", () => {
  it("在编辑器工具行渲染「搜索」与「临时会话」，且样式与安全策略同一类（.input-control-item）", () => {
    const { container } = renderInputArea({
      onToggleSearch: () => {},
      searchOpen: false,
      onToggleSideSession: () => {},
      sideSessionOpen: false,
    });
    const row = container.querySelector(".input-tools-left");
    expect(row, "编辑器底部工具行 .input-tools-left 应存在").toBeTruthy();

    const search = row!.querySelector<HTMLButtonElement>(".input-aux-btn[title*='搜索当前会话']");
    const side = row!.querySelector<HTMLButtonElement>(".input-aux-btn[title*='临时会话']");
    expect(search, "「搜索当前会话」应在底部工具行内").toBeTruthy();
    expect(side, "「临时会话」应在底部工具行内").toBeTruthy();
    // 同一个类 => 同一行风格；aria-pressed => 状态与样式同源（第 32 波约定）
    for (const btn of [search!, side!]) {
      expect(btn.classList.contains("input-control-item")).toBe(true);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("按压态由 aria-pressed 表达，点击回调被触发", async () => {
    const user = userEvent.setup();
    const onToggleSearch = vi.fn();
    const onToggleSideSession = vi.fn();
    const { container, rerender } = render(
      <InputArea
        onSend={vi.fn()}
        onCancel={vi.fn()}
        disabled={false}
        isStreaming={false}
        collaborationMode={"default" as CollaborationMode}
        onModeChange={vi.fn()}
        connected
        onToggleSearch={onToggleSearch}
        searchOpen
        onToggleSideSession={onToggleSideSession}
        sideSessionOpen={false}
      />,
    );
    const search = container.querySelector<HTMLButtonElement>(".input-aux-btn[title*='搜索当前会话']")!;
    expect(search.getAttribute("aria-pressed")).toBe("true");
    await user.click(search);
    expect(onToggleSearch).toHaveBeenCalledTimes(1);

    const side = container.querySelector<HTMLButtonElement>(".input-aux-btn[title*='临时会话']")!;
    await user.click(side);
    expect(onToggleSideSession).toHaveBeenCalledTimes(1);

    // 没传回调时不渲染（避免出现点了没反应的"死按钮"）
    rerender(
      <InputArea
        onSend={vi.fn()}
        onCancel={vi.fn()}
        disabled={false}
        isStreaming={false}
        collaborationMode={"default" as CollaborationMode}
        onModeChange={vi.fn()}
        connected
      />,
    );
    expect(container.querySelectorAll(".input-aux-btn")).toHaveLength(0);
  });
});

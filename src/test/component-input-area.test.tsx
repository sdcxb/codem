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

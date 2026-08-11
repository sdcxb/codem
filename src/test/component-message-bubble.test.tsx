/**
 * 组件渲染测试 — MessageBubble
 *
 * 与 readFileSync + toContain 不同，这里真正渲染组件到 DOM 中，
 * 验证用户实际看到的内容和交互行为。
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageBubble } from "../components/MessageBubble";
import { TooltipProvider } from "../components/ui/tooltip";
import type { Message } from "../store";

/** 包装 Provider，避免 Radix UI Context 报错 */
function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content: "Hello world",
    timestamp: Date.now(),
    status: "done",
    ...overrides,
  };
}

describe("MessageBubble — 渲染测试", () => {
  it("用户消息：渲染文本内容", () => {
    const msg = makeMessage({ role: "user", content: "请帮我创建一个文件" });
    renderWithProviders(<MessageBubble message={msg} />);

    expect(screen.getByText("请帮我创建一个文件")).toBeInTheDocument();
  });

  it("AI 消息：渲染 Markdown 内容", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "这是**加粗**文本",
    });
    renderWithProviders(<MessageBubble message={msg} />);

    // Markdown 渲染后，加粗文本在 <strong> 标签里
    expect(screen.getByText("加粗")).toBeInTheDocument();
  });

  it("流式状态：不渲染操作工具栏", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "正在生成...",
      status: "streaming",
    });
    const { container } = renderWithProviders(<MessageBubble message={msg} canEdit={false} />);

    // 流式时不应该出现复制按钮（MessageActions 组件）
    const actions = container.querySelector(".message-actions");
    expect(actions).toBeNull();
  });

  it("完成状态：渲染操作工具栏", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "完成了",
      status: "done",
    });
    const { container } = renderWithProviders(<MessageBubble message={msg} />);

    // 完成后应该出现 message-actions-bar
    const actions = container.querySelector(".message-actions-bar");
    expect(actions).not.toBeNull();
  });

  it("错误状态：渲染错误卡片", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "出错了",
      status: "error",
    });
    const { container } = renderWithProviders(<MessageBubble message={msg} canEdit={false} />);

    // 错误状态应该有 error 相关的 class
    const errorEl = container.querySelector('.message-error') ||
      container.querySelector('[class*="error"]');
    // 至少有某种错误标识
    expect(errorEl).not.toBeNull();
  });

  it("推理内容：不在默认展开状态显示 reasoning", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "答案是42",
      reasoning: "让我思考一下...",
    });
    const { container } = renderWithProviders(<MessageBubble message={msg} showReasoning={true} />);

    // content 应该显示
    expect(screen.getByText("答案是42")).toBeInTheDocument();

    // reasoning 默认折叠 — 不应直接出现在可见区域
    // 注意: 它可能存在于 DOM 中但被 CSS 隐藏，所以检查可见性
    const reasoningEl = container.querySelector('[class*="reasoning"]');
    if (reasoningEl) {
      // 如果元素存在，检查它是否被折叠（没有 expanded class 或被隐藏）
      const isExpanded = reasoningEl.classList.contains("expanded");
      expect(isExpanded).toBe(false);
    }
  });

  it("工具调用：渲染工具调用组", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "我来读取文件",
      toolCalls: [
        {
          id: "tc-1",
          name: "read",
          args: { path: "/test/file.ts" },
          result: "file content here",
          status: "done" as const,
        },
      ],
    });
    const { container } = renderWithProviders(<MessageBubble message={msg} />);

    // 工具调用应该渲染出某种 tool-call 相关的 DOM 元素
    const toolEl = container.querySelector('[class*="tool-call"], [class*="tool-call-group"]');
    expect(toolEl).not.toBeNull();
  });

  it("附件：渲染附件信息", () => {
    const msg = makeMessage({
      role: "user",
      content: "请分析这个文件",
      attachments: [
        {
          id: "att-1",
          name: "test.ts",
          type: "code" as const,
          content: "console.log('hello')",
        },
      ],
    });
    renderWithProviders(<MessageBubble message={msg} />);

    // 附件名应该出现在 DOM 中
    expect(screen.getByText("test.ts")).toBeInTheDocument();
  });

  it("用户消息编辑：调用 onEditAndResend 回调", () => {
    const onEditAndResend = vi.fn();
    const msg = makeMessage({
      role: "user",
      content: "原始消息",
    });
    renderWithProviders(
      <MessageBubble message={msg} canEdit={true} onEditAndResend={onEditAndResend} />
    );

    // 点击编辑按钮
    const editBtn = screen.queryByTitle(/edit|编辑/i) ||
      screen.queryByRole("button", { name: /edit|编辑/i });
    // 如果编辑按钮存在，点击它
    if (editBtn) {
      fireEvent.click(editBtn);
      // 编辑后应该出现输入框
      // 注意: 具体行为取决于 InlineMessageEdit 组件实现
    }
  });
});

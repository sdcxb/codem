/**
 * 回归测试：UI 卡死优化 P0/P1 —— 流式渲染降级
 *
 * 背景：提示词格式化任务（大量 Markdown + 代码块）流式输出时，每次 100ms
 * buffer flush 若都跑完整 react-markdown + Prism 高亮，主线程被同步解析阻塞
 * → UI 卡死（WebView2 单线程渲染）。
 *
 * P0: RichContent streaming 时降级纯文本 pre（零解析），非流式正常渲染 Markdown
 * P1: CodeBlockView streaming 时纯文本 pre，不渲染 SyntaxHighlighter
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { RichContent } from "../components/rich-content/RichContent";
import { CodeBlockView } from "../components/rich-content/CodeBlockView";
import { TooltipProvider } from "../components/ui/tooltip";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
);

describe("UI 卡死优化 P0: RichContent 流式降级", () => {
  it("REPRO-UI-P0-001: 流式期间渲染纯文本 pre，不解析 Markdown", () => {
    const md = "**加粗** 和 `code` 以及 [链接](https://x.com)";
    const { container } = render(
      <RichContent content={md} streaming={true} />,
      { wrapper },
    );
    // 纯文本路径：包含 streaming-plain 类 + pre 文本
    expect(container.querySelector(".rich-content.streaming-plain")).toBeTruthy();
    expect(container.querySelector(".rich-content-streaming-plain")?.textContent).toContain("**加粗**");
    // 流式期间不做 Markdown 解析：不应渲染出 strong/a
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("REPRO-UI-P0-002: 非流式正常渲染完整 Markdown", () => {
    const md = "**加粗** 和 `code` 以及 [链接](https://x.com)";
    const { container } = render(
      <RichContent content={md} streaming={false} />,
      { wrapper },
    );
    expect(container.querySelector(".rich-content.streaming-plain")).toBeNull();
    expect(container.querySelector("strong")).toBeTruthy();
  });

  it("REPRO-UI-P0-003: 流式大代码块内容走纯文本，不触发 SyntaxHighlighter", () => {
    const md = "# 标题\n\n```python\ndef foo():\n    return 1\n```";
    const { container } = render(
      <RichContent content={md} streaming={true} />,
      { wrapper },
    );
    // 纯文本 pre 包含原始代码内容
    const pre = container.querySelector(".rich-content-streaming-plain");
    expect(pre?.textContent).toContain("```python");
    // 不解析代码块结构
    expect(container.querySelector("pre code")).toBeNull();
  });
});

describe("UI 卡死优化 P1: CodeBlockView 流式降级", () => {
  it("REPRO-UI-P1-001: 流式期间渲染纯文本 pre，不实例化 SyntaxHighlighter", () => {
    const code = "def foo():\n    return 1\n".repeat(10);
    const { container } = render(
      <CodeBlockView code={code} language="python" streaming={true} />,
      { wrapper },
    );
    expect(container.querySelector(".code-block-streaming-pre")).toBeTruthy();
    expect(container.querySelector(".code-block-streaming-pre")?.textContent).toContain("def foo()");
    // SyntaxHighlighter 渲染的 pre 有特定类（react-syntax-highlighter 的 pre）
    // 流式降级路径不应包含它 —— 通过检查我们自己的 pre 类确认降级生效
    expect(container.querySelector("pre code")).toBeNull();
  });

  it("REPRO-UI-P1-002: 非流式正常渲染语法高亮", () => {
    const code = "def foo():\n    return 1\n";
    const { container } = render(
      <CodeBlockView code={code} language="python" streaming={false} />,
      { wrapper },
    );
    expect(container.querySelector(".code-block-streaming-pre")).toBeNull();
    // 正常渲染 SyntaxHighlighter 的 code 元素
    expect(container.querySelector("code")).toBeTruthy();
  });
});

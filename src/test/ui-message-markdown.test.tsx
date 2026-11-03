/**
 * 共享消息 Markdown 渲染判据（第 1 步：抽出桌面 MessageBubble 的纯展示层）。
 *
 * 这些判据钉住三件事：
 * 1. `packages/ui` 里的实现**不反向依赖桌面运行时**（store / core / Tauri）；
 * 2. 桌面 `MessageBubble` 真的用共享实现，而不是留一份旧副本（否则 jscpd 之外没有东西挡"两套"）；
 * 3. 共享实现保留桌面原有的可见行为：代码块外壳 + 注入高亮、引用点击、文件链接回调、
 *    Mermaid 注入、危险协议过滤。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageMarkdown } from "../../packages/ui/src/message-markdown";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("共享消息 Markdown — 边界", () => {
  it("UI-MM-1: packages/ui 实现不依赖桌面 store / core / Tauri", () => {
    for (const file of ["packages/ui/src/message-markdown.tsx", "packages/ui/src/mermaid-diagram.tsx"]) {
      const src = read(file);
      expect(src, `${file} 不得 import 桌面 store`).not.toContain('from "../store"');
      expect(src, `${file} 不得 import 桌面 core`).not.toContain('from "../core');
      expect(src, `${file} 不得 import 桌面 src`).not.toContain('from "../../src');
      expect(src, `${file} 不得直接使用 Tauri`).not.toContain("@tauri-apps");
    }
  });

  it("UI-MM-2: 桌面正文渲染器用共享实现，且不再保留 ReactMarkdown / 本地 Mermaid 副本", () => {
    // 第 2 步之后气泡本体在 packages/ui，桌面正文渲染器（RichContent / Markdown 二选一）
    // 挪到了平台适配器；共享实现必须仍然被真实调用。
    const platform = read("src/components/MessageBubble.tsx");
    expect(platform).toContain('from "../../packages/ui/src/message-markdown"');
    expect(platform).toContain("renderHighlight={renderShikiCode}");
    expect(platform).toContain("onLinkClick={handleFileLinkClick}");
    expect(platform).toContain("onLinkContextMenu={handleFileLinkContextMenu}");
    // 旧副本必须真的消失（不是"新文件放一份、旧文件也留一份"）
    expect(platform).not.toContain("ReactMarkdown");
    expect(platform).not.toContain("const MermaidDiagram");
    expect(platform).not.toContain("const markdownComponents");
    // 共享气泡自己也不许再带一份 Markdown 渲染
    expect(read("packages/ui/src/message-bubble.tsx")).not.toContain("ReactMarkdown");
    // 气泡入口只剩平台注入
    const entry = read("src/components/MessageBubble.tsx");
    expect(entry).not.toContain("ReactMarkdown");
    expect(entry).toContain("SharedMessageBubble");
  });
});

describe("共享消息 Markdown — 行为", () => {
  it("UI-MM-3: 代码块外壳保留，并调用注入的高亮器", () => {
    const { container } = render(
      <MessageMarkdown
        content={"```ts\nconst answer = 42\n```"}
        copyLabel="复制"
        renderHighlight={(code, language) => (
          <span data-testid="highlight">{language}:{code}</span>
        )}
      />,
    );

    expect(container.querySelector(".code-block")).not.toBeNull();
    expect(container.querySelector(".code-header span")?.textContent).toBe("ts");
    expect(container.querySelector(".copy-btn")?.textContent).toBe("复制");
    expect(container.querySelector('[data-testid="highlight"]')?.textContent).toBe(
      "ts:const answer = 42",
    );
  });

  it("UI-MM-4: 引用链接回调拿到 title 里的来源名", () => {
    const onCitationClick = vi.fn();
    const { container } = render(
      <MessageMarkdown
        content={'[1](#cite-1 "文档 A")'}
        onCitationClick={onCitationClick}
      />,
    );

    const citation = container.querySelector("sup.nb-citation-link");
    expect(citation).not.toBeNull();
    expect(citation?.getAttribute("title")).toBe("文档 A");
    fireEvent.click(citation!);
    expect(onCitationClick).toHaveBeenCalledWith("文档 A");
  });

  it("UI-MM-5: 普通链接的点击与右键交给注入回调", () => {
    const onClick = vi.fn();
    const onContextMenu = vi.fn();
    const { container } = render(
      <MessageMarkdown
        content={"[文件](src/a.ts)"}
        onLinkClick={onClick}
        onLinkContextMenu={onContextMenu}
      />,
    );

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    fireEvent.click(link!);
    fireEvent.contextMenu(link!);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][1]).toBe("src/a.ts");
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0][1]).toBe("src/a.ts");
  });

  it("UI-MM-6: Mermaid 代码块走注入的图表渲染器（不触发动态 import）", () => {
    const renderDiagram = vi.fn((chart: string) => (
      <div data-testid="diagram">{chart}</div>
    ));
    const { container } = render(
      <MessageMarkdown
        content={"```mermaid\ngraph TD\nA-->B\n```"}
        renderDiagram={renderDiagram}
      />,
    );

    expect(renderDiagram).toHaveBeenCalledWith("graph TD\nA-->B");
    expect(container.querySelector('[data-testid="diagram"]')?.textContent).toBe(
      "graph TD\nA-->B",
    );
  });

  it("UI-MM-7: 危险协议仍然被丢弃（与桌面原 urlTransform 同规则）", () => {
    const { container } = render(
      <MessageMarkdown content={"[bad](javascript:alert)"} />,
    );
    expect(container.innerHTML).not.toContain("javascript:alert");
  });
});

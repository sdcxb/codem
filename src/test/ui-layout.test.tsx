/**
 * 响应式布局判据（LAYOUT-1..8）：
 * - 宽屏双列（侧栏 280 + 对话）、窄屏单列（未选会话看列表、选中看对话）；
 * - 窄屏有返回按钮，宽屏隐藏；
 * - 桌面 Header 的返回按钮真的能回到列表；
 * - **平板/宽屏的列表可折叠**：折叠按钮、类名翻转、以及"规则只在 ≥600 生效"（手机不受影响）；
 * - **宽屏第三列**：文件 / 差异两个页签，默认「文件」，面板常驻（`hidden` 切换）；
 * - 第三列的样式契约（`ui.css` §3c）：页签选中态与 `[hidden]` 的显式隐藏；
 * - patch 差异的样式契约（`ui.css` §3d）：两端同一份，手机令牌桥可解析。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Header } from "../../packages/ui/src/components";
import { WorkspaceDetail } from "../../packages/ui/src/detail-pane";
import { SplitLayout } from "../../packages/ui/src/shell";

const root = join(__dirname, "..", "..");
const html = readFileSync(join(root, "packages/host/web/index.html"), "utf8");
/**
 * 剥掉 HTML / CSS 注释后的「可执行样式」。
 *
 * 注释里提到某个类名不算规则（本文件自己的注释就写着 `sidebar-collapsed`），
 * 断言只看真正会生效的选择器，否则「解释一句」就会把门禁判红。
 */
const css = html.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 截取一个媒体查询块（含 `@media …` 到配对右括号）。
 *
 * 判据要能区分"规则写在媒体块里"与"规则写在基础层" —— 这正是手机（<600）行为是否
 * 真的不受折叠影响的唯一机器证据：`getComputedStyle` 在 happy-dom 里不评估媒体查询，
 * 所以只能对**源码结构**断言。
 */
function mediaBlock(source: string, query: string): string {
  const start = source.indexOf(`@media ${query}`);
  expect(start, `找不到 @media ${query}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`@media ${query} 没有闭合`);
}

describe("LAYOUT-1 双列/单列", () => {
  it("有双列容器与 280px 侧栏", () => {
    expect(html).toContain(".layout { display: flex;");
    expect(html).toMatch(/\.sidebar \{[^}]*width: 280px/);
  });

  it("宽屏（≥1000）第三列常驻文件预览", () => {
    expect(html).toMatch(/@media \(min-width: 1000px\)/);
    expect(html).toContain(".detail-pane { display: flex; width: 320px;");
  });

  it("窄屏媒体查询：未选会话看列表、选中看对话", () => {
    expect(html).toMatch(/@media \(max-width: 599.98px\)/);
    expect(html).toContain(".layout:not(.in-session) .sidebar { display: flex; }");
    expect(html).toContain(".layout:not(.in-session) .chat-pane { display: none; }");
  });
});

describe("LAYOUT-2 返回按钮", () => {
  it("Header 的返回按钮触发 onBack", () => {
    const onBack = vi.fn();
    render(<Header title="会话" state={null} connected onBack={onBack} />);
    fireEvent.click(screen.getByLabelText("back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("没有 onBack 时不渲染返回按钮", () => {
    render(<Header title="会话" state={null} connected />);
    expect(screen.queryByLabelText("back")).toBeNull();
  });
});

describe("LAYOUT-4 平板折叠规则只在 ≥600 媒体块内", () => {
  it("按钮显隐与折叠规则都在 @media (min-width: 600px) 里", () => {
    const block = mediaBlock(css, "(min-width: 600px)");
    expect(block).toContain(".sidebar-collapse-toggle { display: inline-block; }");
    expect(block, "折叠必须带 in-session 前置：没选会话时列表永远显示").toContain(
      ".layout.in-session.sidebar-collapsed .sidebar { display: none; }",
    );
    // 手机（<600）不受影响：媒体块之外不许出现 sidebar-collapsed
    expect(css.replace(block, "")).not.toContain("sidebar-collapsed");
    // 按钮在基础层默认隐藏（手机窄屏看不到折叠入口）
    expect(css).toContain(".sidebar-collapse-toggle { display: none; }");
  });

  it("599px 的窄屏规则一个字符都没被折叠改动", () => {
    const narrow = mediaBlock(css, "(max-width: 599.98px)");
    expect(narrow).not.toContain("sidebar-collapsed");
    expect(narrow).toContain(".layout:not(.in-session) .sidebar { display: flex; }");
    expect(narrow).toContain(".layout.in-session .back-button { display: inline-block; }");
  });
});

describe("LAYOUT-5 平板折叠按钮契约", () => {
  it("传 handler 才渲染；aria 与文案随状态翻转；点击触发一次", () => {
    const onToggleSidebar = vi.fn();
    const { rerender } = render(
      <Header title="会话" state={null} connected onToggleSidebar={onToggleSidebar} sidebarCollapsed={false} />,
    );
    const expanded = screen.getByRole("button", { name: "收起列表" });
    expect(expanded.getAttribute("aria-controls")).toBe("session-sidebar");
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
    expect(expanded.className).toContain("sidebar-collapse-toggle");
    fireEvent.click(expanded);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);

    rerender(<Header title="会话" state={null} connected onToggleSidebar={onToggleSidebar} sidebarCollapsed />);
    const collapsed = screen.getByRole("button", { name: "列表" });
    expect(collapsed.getAttribute("aria-expanded")).toBe("false");
  });

  it("没有会话（不传 handler）时不渲染按钮", () => {
    render(<Header title="Codem Remote" state={null} connected />);
    expect(screen.queryByText("收起列表")).toBeNull();
    expect(screen.queryByText("列表")).toBeNull();
  });

  it("收起时把「已经丢掉的焦点」交给按钮（不抢别处的焦点）", () => {
    const { rerender } = render(
      <Header title="会话" state={null} connected onToggleSidebar={() => undefined} sidebarCollapsed={false} />,
    );
    // 渲染后焦点在 body（列表里的按钮被隐藏后浏览器就是这个行为）
    expect(document.activeElement).toBe(document.body);
    rerender(<Header title="会话" state={null} connected onToggleSidebar={() => undefined} sidebarCollapsed />);
    expect((document.activeElement as HTMLElement | null)?.className).toContain("sidebar-collapse-toggle");
  });
});

describe("LAYOUT-6 骨架类名翻转 + 第三列默认页签", () => {
  const detail = (
    <WorkspaceDetail tab="files" onSelectTab={() => undefined} files={<div>files</div>} diff={<div>diff</div>} />
  );

  it("折叠/会话状态只体现为类名，不改 DOM（列表仍在）", () => {
    const { container, rerender } = render(
      <SplitLayout inSession sidebarCollapsed={false} sidebar={<div>list</div>} chat={<div>chat</div>} detail={detail} />,
    );
    expect(container.querySelector(".layout")?.className).toBe("layout in-session");
    expect(container.querySelector("#session-sidebar")).not.toBeNull();

    rerender(<SplitLayout inSession sidebarCollapsed sidebar={<div>list</div>} chat={<div>chat</div>} detail={detail} />);
    expect(container.querySelector(".layout")?.className).toBe("layout in-session sidebar-collapsed");
    expect(container.querySelector("#session-sidebar"), "折叠不能卸载列表（滚动位置/搜索词要留着）").not.toBeNull();

    // 没选会话时即使折叠态为真，`.sidebar-collapsed` 也没有 `in-session` 可挂 ⇒ 列表照常显示
    rerender(<SplitLayout inSession={false} sidebarCollapsed sidebar={<div>list</div>} chat={<div>chat</div>} detail={detail} />);
    expect(container.querySelector(".layout")?.className).toBe("layout sidebar-collapsed");
  });

  it("第三列默认「文件」，两个面板常驻（hidden 切换）", () => {
    const { container } = render(
      <SplitLayout inSession sidebar={<div>list</div>} chat={<div>chat</div>} detail={detail} />,
    );
    const selected = container.querySelector('[role="tablist"] [role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe("文件");
    expect(container.querySelector("#detail-tab-files")?.getAttribute("aria-controls")).toBe("detail-panel-files");
    expect(container.querySelector("#detail-panel-files")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector("#detail-panel-diff")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("LAYOUT-8 patch 差异样式契约（共享 ui.css §3d）", () => {
  it("模式条/网格/截断说明在共享表；桌面表不再有副本；手机令牌桥可解析", () => {
    const shared = readFileSync(join(root, "packages/ui/src/ui.css"), "utf8");
    const codem = readFileSync(join(root, "src/styles/codem-ui.css"), "utf8");
    const styles = readFileSync(join(root, "src/styles.css"), "utf8");

    expect(shared, "模式条样式必须随组件进共享表（手机不加载 codem-ui.css）").toContain(".diff-view-mode-bar {");
    expect(shared).toContain(".diff-split-grid {");
    expect(shared).toContain(".patch-diff {");
    expect(shared, "网格只认 pre.diff-unified（否则 before/after 表格的 tr 会被当 grid 行）").toMatch(
      /pre\.diff-unified \.diff-line\s*\{/,
    );
    expect(shared).not.toMatch(/(?:^|\n)\.diff-unified \.diff-line\s*\{/);
    expect(shared, "截断说明是共享的（DiffView 与 patch 视图共用）").toContain(".diff-truncated-note {");

    expect(codem, "已搬到共享表，桌面不许留副本").not.toContain(".diff-view-mode-bar");
    expect(codem).not.toContain(".diff-split-grid");
    expect(codem).not.toContain(".diff-lnum");
    expect(styles, "截断说明已搬到共享表").not.toContain(".diff-truncated-note {");

    // 手机壳只加载 ui.css：新增的两个令牌必须有取值（否则 transition/border 整条失效）
    expect(html, "手机令牌桥缺 --ease-swift").toContain("--ease-swift:");
    expect(html, "手机令牌桥缺 --accent-border-strong").toContain("--accent-border-strong:");
  });
});

describe("LAYOUT-7 第三列样式契约（共享 ui.css §3c）", () => {
  it("页签/面板规则在共享表里，且 [hidden] 必须显式隐藏", () => {
    const shared = readFileSync(join(root, "packages/ui/src/ui.css"), "utf8");
    expect(shared, "页签条样式必须随组件进共享表（手机不加载桌面 styles.css）").toContain(".detail-tabs {");
    expect(shared).toContain(".detail-tab {");
    expect(shared).toMatch(/\.detail-tab\[aria-selected="true"\]\s*\{[^}]*color:\s*var\(--text-primary\)/);
    expect(shared).toMatch(/\.detail-body\s*\{[^}]*display:\s*flex/);
    /**
     * 这条不是"重复一遍 display:none"：`.detail-body` 自己写了 `display: flex`，
     * 作者样式会压过 UA 的 `[hidden]` —— 少了它，两个面板会叠着显示（DT-1/DT-4 的 DOM 断言
     * 只查 `hidden` 属性，看不见"属性在但不生效"这种失败）。
     */
    expect(shared, "`.detail-body` 的 display 会压过 UA 的 [hidden]，必须显式关掉").toMatch(
      /\.detail-body\[hidden\]\s*\{\s*display:\s*none;/,
    );
  });
});

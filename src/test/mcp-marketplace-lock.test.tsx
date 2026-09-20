/**
 * MCP「服务器目录」锁死缺陷的回归判据（第 76 轮）。
 *
 * ## 事故（真机实测，另一路走查 agent 量到 + 本轮复核）
 *
 * 点开 MCP 管理 →「服务器目录」之后**整个应用没有可用出口**，只能重载页面。四条路全部失效：
 *
 * | 出口 | 实测结果 | 根因 |
 * |---|---|---|
 * | Esc | 无效（连按 3 次、循环 12 次） | `McpMarketplace` 全组件**没有** keydown 监听 |
 * | 点遮罩背景 | 540 点网格采样 **0 个点**命中 `.modal-overlay` | 面板是 `position: fixed; inset: 0`，把整块遮罩铺满 |
 * | 面板关闭按钮 `24×27@1160,12` | 中心点被 `BUTTON.titlebar-btn-close` 接走 | titlebar `z-index: 9999` > `.modal-overlay` 的 1300，且窗口按钮带 `x∈[1154,1200] y∈[4,40]` 正好压住它 |
 * | `.mcp-manager-close`（有名字） | 中心点被 `.mcp-marketplace-search` 接走 | 面板铺满视口，管理页在它下面 |
 *
 * 读数：`.preview-shot/audit-walk-mcp-lock.{log,json}`、`audit-walk-mcp-close-geom.log`。
 *
 * ## 为什么这些判据要写在组件层
 *
 * "中心点命中自己"是**布局/层叠**问题，happy-dom 不做布局 ⇒ 只能靠 CSS 契约守；
 * 而"有没有出口"（可访问名 + Esc + 点击回调）是组件契约，可以直接渲染后断言。
 * 真机复量等出包后做，这里先把回归钉死。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpMarketplace } from "../components/McpMarketplace";

afterEach(() => cleanup());

const STYLES = readFileSync(join(__dirname, "..", "styles.css"), "utf8");

/** 取某条规则块（与 dialog-layer-contract.test.ts 同一手法） */
function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  expect(match, `应能定位规则 ${selector}`).toBeTruthy();
  return match![1];
}

/** 按**可访问名**（aria-label / title / 文本）找控件，复刻走查脚本的口径 */
function findByAccessibleName(name: string): Element | null {
  const all = Array.from(document.body.querySelectorAll("button, [role=button], [role=switch]"));
  return (
    all.find((el) => {
      const label = el.getAttribute("aria-label") || "";
      const title = el.getAttribute("title") || "";
      const text = (el.textContent || "").trim();
      return label.includes(name) || title.includes(name) || text.includes(name);
    }) || null
  );
}

/** `aria-label`/`title`/文本三者皆空的可交互控件 */
function unnamedControls(): string[] {
  const unnamed: string[] = [];
  for (const el of Array.from(document.body.querySelectorAll("button, [role=button], [role=switch]"))) {
    const label = el.getAttribute("aria-label") || "";
    const title = el.getAttribute("title") || "";
    const text = (el.textContent || "").trim();
    if (!label && !title && !text) {
      unnamed.push(`${el.tagName}.${el.className || "(no class)"} ${(el as HTMLElement).outerHTML.slice(0, 140)}`);
    }
  }
  return unnamed;
}

describe("MCP 服务器目录：连接口 1 —— 关闭按钮必须能按名字找到并点中", () => {
  it("MCP-LOCK-1: 关闭按钮有不含歧义的可访问名（真机实测它是无名纯图标按钮）", () => {
    render(<McpMarketplace onClose={() => {}} />);
    const btn = document.querySelector(".mcp-marketplace-close");
    expect(btn, "应该渲染出 .mcp-marketplace-close").toBeTruthy();
    const label = btn!.getAttribute("aria-label") || "";
    expect(label, "关闭按钮必须补可访问名（走查实测无名）").not.toBe("");
    expect(label).toContain("关闭服务器目录");
    // 与 MCP 管理面板的关闭按钮（"关闭面板 / Close panel"）不能糊成同一个名字
    expect(label).not.toBe("关闭面板 / Close panel");
    expect(findByAccessibleName("关闭服务器目录")).not.toBeNull();
  });

  it("MCP-LOCK-2: 点火关闭按钮 → onClose 被调用一次", () => {
    const onClose = vi.fn();
    render(<McpMarketplace onClose={onClose} />);
    const btn = findByAccessibleName("关闭服务器目录");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("MCP-LOCK-3: 面板内不得留下无名可交互控件", () => {
    render(<McpMarketplace onClose={() => {}} />);
    const unnamed = unnamedControls();
    expect(unnamed, `服务器目录里以下控件仍然没有可访问名：\n${unnamed.join("\n")}`).toEqual([]);
  });
});

describe("MCP 服务器目录：连接口 2 —— Esc 必须能关掉", () => {
  it("MCP-LOCK-4: keydown Escape → onClose 被调用（与 ConfirmDialog / ImageGallery 同一套写法）", () => {
    const onClose = vi.fn();
    render(<McpMarketplace onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose, "Esc 必须能关掉服务器目录（真机实测改前完全无效）").toHaveBeenCalledTimes(1);
  });

  it("MCP-LOCK-5: 只有 Escape 才关；其它按键不能误关（避免打字时把面板关掉）", () => {
    const onClose = vi.fn();
    render(<McpMarketplace onClose={onClose} />);
    for (const key of ["a", "Enter", "ArrowDown", "Tab", "Backspace"]) {
      fireEvent.keyDown(document, { key });
    }
    expect(onClose, "非 Escape 按键不应关闭面板").not.toHaveBeenCalled();
  });

  it("MCP-LOCK-6: 卸载后不再残留 keydown 监听（否则关掉面板后 Esc 还会再触发一次）", () => {
    const onClose = vi.fn();
    render(<McpMarketplace onClose={onClose} />);
    cleanup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose, "卸载后监听必须摘掉").not.toHaveBeenCalled();
  });
});

describe("MCP 服务器目录：连接口 3 —— 几何/层叠契约（happy-dom 不做布局，只能守 CSS）", () => {
  it("MCP-LOCK-7: 面板顶行必须让开 titlebar（否则关闭按钮落在窗口按钮带上，点了会关掉整个窗口）", () => {
    const mp = ruleBlock(STYLES, ".mcp-marketplace");
    // ① 仍在视口内铺满（模态语义不变）
    expect(mp, "面板本体应继续铺满视口").toMatch(/inset:\s*0/);
    // ② 内容整体下移一个 titlebar 高度 —— 用 padding-top 而不是 top
    expect(mp, "必须给内容留出 titlebar 的高度，否则关闭按钮会被 titlebar 接走").toMatch(/padding-top:\s*var\(--chrome-height\)/);
    // ③ 不能改用 top/bottom 拉伸（真机量到会砍掉 44px 内容高度：727→683、网格 573→529）
    expect(mp, "不要用 top/bottom 拉伸（真机实测会砍掉 44px 内容高度）").not.toMatch(/(?:^|[\s;])top:\s*var\(--chrome-height\)/);
    // ④ 必须 border-box，否则 padding-top 会把面板整体顶下去
    expect(mp, "padding-top 必须配合 border-box").toMatch(/box-sizing:\s*border-box/);
  });

  it("MCP-LOCK-8: --chrome-height 与 titlebar 实际高度是同一个令牌（不会各自漂移）", () => {
    // titlebar 的高度就用这个令牌 ⇒ 面板让开的量与 titlebar 高度天然一致
    const titlebar = ruleBlock(STYLES, ".titlebar");
    expect(titlebar, "titlebar 高度应走 --chrome-height").toMatch(/height:\s*var\(--chrome-height\)/);
    const mp = ruleBlock(STYLES, ".mcp-marketplace");
    expect(mp).toMatch(/padding-top:\s*var\(--chrome-height\)/);
  });

  it("MCP-LOCK-9: 关闭按钮在 header 内、且 header 不再被标题挤到换行（截图与命中都依赖它）", () => {
    const header = ruleBlock(STYLES, ".mcp-marketplace-header");
    expect(header, "header 应是两端对齐的一行").toMatch(/justify-content:\s*space-between/);
    const close = ruleBlock(STYLES, ".mcp-marketplace-close");
    expect(close, "关闭按钮不应被压到 0 尺寸").toMatch(/padding:/);
  });
});

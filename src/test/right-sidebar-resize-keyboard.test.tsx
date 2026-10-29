/**
 * 右栏宽度拖拽条：单一样式源 + 键盘可操作 + 可见焦点环（第 233 轮审计）。
 *
 * ## 为什么要有这一组判据
 *
 * 2026-10-28 的二次视觉升级把拖拽条改成「8px 命中区 + 2px 视觉线、默认透明、
 * hover/拖动才显示」（`src/styles.css` 的 `.right-sidebar-resize-handle::after`）。
 * 但 `src/styles/codem-ui.css` 里**还留着**这个类的旧定义，而它**后加载**：
 *
 *   main.tsx: styles.css → skin-hub → skin-dream → notebook-workspace → codem-ui.css
 *
 * 于是旧定义静默覆盖新定义 —— 这不是理论风险，是两条可见的真实缺陷：
 *
 * 1. `left: -3px`（旧）盖掉 `left: -4px`（新）⇒ 命中区比声明的偏 1px；
 * 2. `.right-sidebar-resize-handle.active { background: var(--accent) }`（旧）盖掉
 *    `background: transparent`（新）⇒ 拖动时**整条 8px 命中区被涂成实心 accent**，
 *    压在 `::after` 的 2px 线上，正是这次升级想消除的「粗色块」。
 *
 * `codem-ui.css:2912` 自己写着「同一个类在两个基础样式表里各写一遍、由加载顺序决定谁生效，
 * 正是这次排查出来的根因」—— 这条判据就是把那句话变成机器可检的。
 *
 * 另外 `:focus-visible { outline: none }` 没有任何替代环：键盘用户看不到焦点；
 * 而这个元素当时**根本不可聚焦**（`div` + `role="separator"`、无 `tabIndex`），
 * 也就是右栏宽度**只能鼠标拖**。判据同时钉住「可聚焦 + 方向键可调 + 焦点可见」。
 *
 * ## 变异自证
 *
 * - 把 `codem-ui.css` 的旧块加回去 ⇒ RSH-1 红；
 * - 删掉 `onKeyDown` 或 `tabIndex` ⇒ RSH-2/RSH-3 红；
 * - 把焦点环改回 `outline: none` 且不加 `box-shadow` ⇒ RSH-4 红。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { RightSidebarResizeHandle } from "../components/RightSidebarResizeHandle";

const ROOT = join(__dirname, "..", "..");
const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
const codemUi = readFileSync(join(ROOT, "src/styles/codem-ui.css"), "utf8");

/** 取某个选择器的声明块（顶层、非 @media 内） */
function block(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[2] ?? "";
}

function makeProps(overrides: Partial<Parameters<typeof RightSidebarResizeHandle>[0]> = {}) {
  return {
    width: 360,
    min: 300,
    max: 800,
    onPointerDown: vi.fn(),
    onResizeBy: vi.fn(),
    onResizeTo: vi.fn(),
    label: "拖动调整右侧栏宽度",
    ...overrides,
  };
}

describe("右栏拖拽条 · 单一样式源", () => {
  it("RSH-1: 基础几何只在 styles.css 定义，codem-ui.css 不再覆盖 left/width", () => {
    expect(block(css, ".right-sidebar-resize-handle")).toContain("left: -4px");
    // 旧的重复定义必须消失（否则后加载的它覆盖前者）
    expect(block(codemUi, ".right-sidebar-resize-handle")).toBe("");
  });

  it("RSH-1b: 拖动态只用 2px 视觉线，不整块染色", () => {
    // 权威定义：命中区本身透明，视觉线由 ::after 画
    expect(block(css, ".right-sidebar-resize-handle")).toContain("background: transparent");
    expect(block(css, ".right-sidebar-resize-handle::after")).toContain("width: 2px");
    // 任何样式表都不得给 .active 命中区铺底色（会盖住 2px 线）
    expect(block(codemUi, ".right-sidebar-resize-handle.active")).not.toContain("background:");
    expect(block(css, ".right-sidebar-resize-handle.active")).not.toContain("background:");
  });
});

describe("右栏拖拽条 · 键盘与焦点", () => {
  it("RSH-2: 可聚焦且带 separator 语义（aria-valuenow / min / max）", () => {
    const props = makeProps();
    const { getByRole } = render(<RightSidebarResizeHandle {...props} />);
    const handle = getByRole("separator");
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    expect(handle.getAttribute("aria-valuemin")).toBe("300");
    expect(handle.getAttribute("aria-valuemax")).toBe("800");
    cleanup();
  });

  it("RSH-3: 方向键调宽（左=变宽 16px，右=变窄 16px；Shift 加速）", () => {
    const props = makeProps();
    const { getByRole } = render(<RightSidebarResizeHandle {...props} />);
    const handle = getByRole("separator");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(props.onResizeBy).toHaveBeenLastCalledWith(16);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(props.onResizeBy).toHaveBeenLastCalledWith(-16);

    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(props.onResizeBy).toHaveBeenLastCalledWith(64);

    cleanup();
  });

  it("RSH-3b: Home/End 到底（min/max），其它键不抢事件", () => {
    const props = makeProps();
    const { getByRole } = render(<RightSidebarResizeHandle {...props} />);
    const handle = getByRole("separator");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(props.onResizeTo).toHaveBeenLastCalledWith(300);

    fireEvent.keyDown(handle, { key: "End" });
    expect(props.onResizeTo).toHaveBeenLastCalledWith(800);

    fireEvent.keyDown(handle, { key: "a" });
    expect(props.onResizeBy).toHaveBeenCalledTimes(0);
    expect(props.onResizeTo).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it("RSH-3c: 方向键必须 preventDefault（否则会滚动整个消息流）", () => {
    const props = makeProps();
    const { getByRole } = render(<RightSidebarResizeHandle {...props} />);
    const handle = getByRole("separator");
    const event = new window.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    handle.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    cleanup();
  });

  it("RSH-4: 焦点可见 —— 不用裸 outline:none，必须有替代环", () => {
    // 旧行为：`:focus-visible { outline: none }` 且没有替代环 ⇒ 键盘用户看不到焦点
    const focusRule = block(css, ".right-sidebar-resize-handle:focus-visible");
    expect(focusRule).not.toMatch(/outline:\s*none/);
    expect(focusRule).toMatch(/outline:\s*var\(--focus-ring-width\)\s+solid\s+var\(--focus-ring-color\)/);
  });

  it("RSH-4b: 组件把键盘回调接到 hook（不是只在测试里存在）", () => {
    const src = readFileSync(join(ROOT, "src/components/RightSidebar.tsx"), "utf8");
    expect(src).toContain("<RightSidebarResizeHandle");
    expect(src).toContain("onResizeBy={resizeBy}");
    expect(src).toContain("onResizeTo={resizeTo}");
  });

  /**
   * RSH-5：**双击复位**（二次升级 Phase B 的「重置宽度」入口）。
   *
   * 为什么值得单独一条：宽度是持久化的，而默认值随版本变过（旧版本存过 586）。
   * 没有复位入口时用户只能一格一格拖回去 —— 而"能拖回去"不等于"能一次回到默认"。
   * 判据钉两件：① 分隔条真的接了 `onReset`；② 双击触发它一次（不是两次、不是没接上）。
   */
  it("RSH-5: 双击复位到默认宽度（Phase B 的「重置宽度」）", () => {
    const onReset = vi.fn();
    const props = makeProps({ onReset });
    const { getByRole } = render(<RightSidebarResizeHandle {...props} />);
    const handle = getByRole("separator");

    // 给用户发现入口：title 里必须说明可以双击
    expect(handle.getAttribute("title") ?? "", "标题要写出「双击复位」这个入口").toContain("双击复位");

    fireEvent.doubleClick(handle);
    expect(onReset, "双击必须复位一次").toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("RSH-5b: 复位目标与「本档默认宽度」同一口径（不许出现第二套默认值）", () => {
    const src = readFileSync(join(ROOT, "src/components/RightSidebar.tsx"), "utf8");
    // 默认宽度必须只有一个函数产出，initial 与复位共用它
    expect(src, "默认宽度必须抽成函数（单一真相）").toMatch(/function rightSidebarDefaultWidth\(\)/);
    expect(src, "initial 必须用它").toContain("initial: rightSidebarDefaultWidth()");
    expect(src, "复位也必须用它").toMatch(/onReset=\{\(\) => resizeTo\(rightSidebarDefaultWidth\(\)\)\}/);
  });
});

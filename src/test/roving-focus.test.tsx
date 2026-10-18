/**
 * ROVING：通用 roving focus（方向键组内移动 / Home-End / RTL / Tab 逃逸）。
 *
 * 纯逻辑断言（`core/ui/roving-focus.ts`）+ 一次真实 DOM 渲染断言
 * （焦点确实移动到下一个按钮，Tab 不被 preventDefault）。
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { nextRovingIndex, ROVING_PAGE_SIZE, isRovingKey } from "../core/ui/roving-focus";
import { useRovingFocus } from "../hooks/useRovingFocus";

describe("ROVING 纯逻辑", () => {
  it("ROVING-1: 垂直方向键 + 两端回绕", () => {
    expect(nextRovingIndex(0, 3, "ArrowDown")).toBe(1);
    expect(nextRovingIndex(2, 3, "ArrowDown")).toBe(0); // 回绕
    expect(nextRovingIndex(0, 3, "ArrowUp")).toBe(2);
    // 垂直组里左右键不归它管
    expect(nextRovingIndex(0, 3, "ArrowRight")).toBeNull();
    expect(nextRovingIndex(0, 3, "ArrowLeft")).toBeNull();
  });

  it("ROVING-2: 水平方向键 + RTL 镜像", () => {
    expect(nextRovingIndex(0, 3, "ArrowRight", "horizontal")).toBe(1);
    expect(nextRovingIndex(0, 3, "ArrowRight", "horizontal", true)).toBe(2);
    expect(nextRovingIndex(0, 3, "ArrowLeft", "horizontal", true)).toBe(1);
    expect(nextRovingIndex(0, 3, "ArrowDown", "horizontal")).toBeNull();
  });

  it("ROVING-3: Home/End/PageUp/PageDown 与边界夹紧", () => {
    expect(nextRovingIndex(2, 5, "Home")).toBe(0);
    expect(nextRovingIndex(2, 5, "End")).toBe(4);
    expect(nextRovingIndex(0, 10, "PageDown")).toBe(ROVING_PAGE_SIZE);
    expect(nextRovingIndex(0, 3, "PageDown")).toBe(2); // 夹到末尾
    expect(nextRovingIndex(1, 10, "PageUp")).toBe(0);
  });

  it("ROVING-4: 非导航键（Tab/Enter/未知）一律返回 null", () => {
    expect(isRovingKey("Tab")).toBe(false);
    expect(nextRovingIndex(0, 3, "Tab")).toBeNull();
    expect(nextRovingIndex(0, 3, "Enter")).toBeNull();
    expect(nextRovingIndex(0, 0, "ArrowDown")).toBeNull();
  });
});

function Demo() {
  const roving = useRovingFocus<HTMLDivElement>({ orientation: "vertical" });
  return (
    <div ref={roving.containerRef} onKeyDown={roving.onKeyDown}>
      <button>一</button>
      <button>二</button>
      <button>三</button>
    </div>
  );
}

describe("ROVING DOM 接线", () => {
  it("ROVING-5: ArrowDown 把焦点移到下一项，Tab 不被吞掉", () => {
    render(<Demo />);
    const first = screen.getByRole("button", { name: "一" });
    const second = screen.getByRole("button", { name: "二" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);

    // Tab 必须能正常离开：事件未被 preventDefault
    const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    first.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(false);
  });
});

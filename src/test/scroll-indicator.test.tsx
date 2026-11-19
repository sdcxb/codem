/**
 * SCROLL-1：只有「能滚」且「滚上去了」才显示回到底部按钮（Batch 7 收口）。
 *
 * 现场：新对话空状态里也会冒出这个悬浮按钮，正好压住最后一张快速访问卡片的描述文字。
 * 原因是 `scrollPosition` 是**上一个会话**留下的 `scrolled-up`（store 常驻），
 * 而空状态根本没有可滚内容。
 *
 * 判据（行为）：容器不可滚 + 状态 scrolled-up ⇒ 不渲染；容器可滚 + 状态 scrolled-up ⇒ 渲染。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { ScrollToBottomIndicator } from "../components/ScrollToBottomIndicator";
import { useAppStore } from "../store";

/** 造一个「能滚 / 不能滚」的容器：jsdom 里 scrollHeight/clientHeight 恒为 0，得自己定义 */
function makeContainer(scrollable: boolean): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "messages-container";
  Object.defineProperty(el, "scrollHeight", { value: scrollable ? 1200 : 800, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 800, configurable: true });
  document.body.appendChild(el);
  return el;
}

function mountWith(container: HTMLDivElement) {
  const end = document.createElement("div");
  return render(
    <ScrollToBottomIndicator containerRef={{ current: container }} messagesEndRef={{ current: end }} />
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  useAppStore.getState().setScrollPosition("bottom");
});

describe("SCROLL-1：回到底部按钮的显示条件", () => {
  it("容器不可滚时，即使状态是 scrolled-up 也不显示（空状态不压内容）", () => {
    useAppStore.getState().setScrollPosition("scrolled-up");
    const { container: host } = mountWith(makeContainer(false));
    expect(host.querySelector(".scroll-to-bottom-btn"), "空状态没有可滚内容，按钮不该出现").toBeNull();
  });

  it("容器可滚且状态 scrolled-up ⇒ 显示", () => {
    useAppStore.getState().setScrollPosition("scrolled-up");
    const { container: host } = mountWith(makeContainer(true));
    expect(host.querySelector(".scroll-to-bottom-btn"), "能滚且滚上去了，按钮必须出现").not.toBeNull();
  });
});

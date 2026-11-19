/**
 * ESC-1：Esc 必须能关掉 App 级弹窗（Batch 6C）。
 *
 * 现场：审计脚本关闭 `.modal-overlay` 时发现按 Esc 毫无反应 —— 这批弹窗只有「点遮罩」「点关闭」
 * 两条路，而遮罩不可聚焦 ⇒ 键盘用户被卡在弹窗里。
 *
 * 实现口径：**键盘监听只有一处**（`useDismissableLayer`，仓里 OVERLAY-1 门禁钉死），
 * 这里测两件东西：
 *  ① 目标查找是纯函数（找最上层弹窗的显式关闭按钮）；
 *  ② 把它接到 hook 上之后，Esc 真的关掉最上层、且不碰没有关闭按钮的弹窗。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { findTopmostModalCloseButton, closeTopmostModal } from "../core/ui/modal-close-target";
import { useDismissableLayer } from "../hooks/useDismissableLayer";

function renderOverlay(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

/** 与 App.tsx 里一致的接线：hook 只负责"什么时候关"，关谁由纯函数决定 */
function Harness() {
  useDismissableLayer({ open: true, restoreFocus: false, onDismiss: () => closeTopmostModal() });
  return null;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("ESC-1：Esc 关闭最上层弹窗", () => {
  it("能找到最上层弹窗里的关闭按钮", () => {
    renderOverlay('<div class="modal-editor"><button aria-label="关闭弹窗" id="x">×</button></div>');
    expect(findTopmostModalCloseButton()?.id).toBe("x");
  });

  it("嵌套时只取最上面一层", () => {
    renderOverlay('<button aria-label="关闭第一层" id="a">×</button>');
    renderOverlay('<button aria-label="关闭第二层" id="b">×</button>');
    expect(findTopmostModalCloseButton()?.id).toBe("b");
  });

  it("没有显式关闭按钮时返回 null（不替用户取消/拒绝）", () => {
    renderOverlay('<button id="approve">批准</button>');
    expect(findTopmostModalCloseButton()).toBeNull();
    expect(closeTopmostModal()).toBe(false);
  });

  it("隐藏的弹窗不参与（display:none）", () => {
    const hidden = renderOverlay('<button aria-label="关闭隐藏层" id="h">×</button>');
    hidden.style.display = "none";
    renderOverlay('<button aria-label="关闭可见层" id="v">×</button>');
    expect(findTopmostModalCloseButton()?.id).toBe("v");
  });

  it("接到 useDismissableLayer 后，Esc 关掉最上层弹窗", () => {
    const { unmount } = render(<Harness />);
    renderOverlay('<button aria-label="关闭弹窗" id="x">×</button>');
    let closed = 0;
    document.getElementById("x")!.addEventListener("click", () => {
      closed += 1;
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(1);
    unmount();
  });

  it("没有弹窗时 Esc 是空操作（不报错、不误点）", () => {
    const { unmount } = render(<Harness />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.body.children.length).toBeGreaterThan(0);
    unmount();
  });
});

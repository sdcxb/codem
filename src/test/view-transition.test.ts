/**
 * VIEWTRANS：图片预览的共享元素转场（View Transitions API）。
 *
 * 三条判据都围绕"**动画失败不许变成点了没反应**"：
 * 支持 → 走转场；不支持 → 直接更新；转场抛错 → 仍然更新。
 */
import { describe, it, expect, vi } from "vitest";
import { supportsViewTransitions, runViewTransition } from "../core/ui/view-transition";

function fakeDoc(impl?: (cb: () => void) => unknown): Document {
  return { startViewTransition: impl } as unknown as Document;
}

describe("VIEWTRANS 共享元素转场", () => {
  it("VIEWTRANS-1: 不支持时直接执行更新，不要求任何 API", () => {
    const update = vi.fn();
    const result = runViewTransition(update, {} as unknown as Document);
    expect(result.usedViewTransition).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
    expect(supportsViewTransitions({} as unknown as Document)).toBe(false);
  });

  it("VIEWTRANS-2: 支持时把更新交给 startViewTransition（由浏览器决定何时执行）", () => {
    let captured: (() => void) | null = null;
    const update = vi.fn();
    const doc = fakeDoc((cb) => {
      captured = cb;
    });
    const result = runViewTransition(update, doc);
    expect(result.usedViewTransition).toBe(true);
    expect(update).not.toHaveBeenCalled(); // 由转场捕获后再调用
    captured!();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("VIEWTRANS-3: 转场 API 抛错时仍然执行更新（降级为普通切换）", () => {
    const update = vi.fn();
    const doc = fakeDoc(() => {
      throw new Error("boom");
    });
    const result = runViewTransition(update, doc);
    expect(result.usedViewTransition).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

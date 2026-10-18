/**
 * EDGEFADE：滚动边缘 7 档渐隐（几何计算 + 触边归零）。
 *
 * 对标 open-claude-ui 的 ScrollFadeContainer：28px 羽化、7 档非线性 alpha（y≈x^1.5）、
 * 触顶/触底时对应侧不遮。这里测纯函数（不依赖布局引擎）。
 */
import { describe, it, expect } from "vitest";
import {
  EDGE_FADE_EDGE_TOLERANCE_PX,
  EDGE_FADE_FEATHER_PX,
  EDGE_FADE_STOPS,
  edgeFadeAlpha,
  edgeFadeMask,
  edgeFadeStateFromMetrics,
} from "../core/ui/edge-fade";

const countStops = (mask: string) => (mask.match(/rgba\(0,0,0,/g) ?? []).length;

describe("EDGEFADE 边缘渐隐", () => {
  it("EDGEFADE-1: 每侧 7 档（中段不透明；不触边时两侧各 7 档 + 2 个中段锚点）", () => {
    expect(EDGE_FADE_STOPS).toBe(7);
    expect(EDGE_FADE_FEATHER_PX).toBe(28);
    const middle = edgeFadeMask({ atTop: false, atBottom: false });
    expect(countStops(middle)).toBe(7 + 2 + 7);
    expect(middle).toContain("calc(100% - 28px)");
  });

  it("EDGEFADE-2: alpha 曲线是 y≈x^1.5（端点精确、单调递增）", () => {
    expect(edgeFadeAlpha(0)).toBe(0);
    expect(edgeFadeAlpha(1)).toBe(1);
    expect(edgeFadeAlpha(0.5)).toBeCloseTo(0.354, 2);
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const a = edgeFadeAlpha(i / 10);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it("EDGEFADE-3: 触顶/触底时对应侧归零（不许把首行也渐隐成淡字）", () => {
    const top = edgeFadeMask({ atTop: true, atBottom: false });
    expect(top.startsWith("linear-gradient(to bottom, rgba(0,0,0,1) 0px")).toBe(true);
    // 没触底 ⇒ 最后一个 stop 仍是透明（外缘 100% 沿用该值）
    expect(top.trim().endsWith("calc(100% - 28px))")).toBe(true);

    const bottom = edgeFadeMask({ atTop: false, atBottom: true });
    // 触底 ⇒ 下侧退化成单个 "不透明 100%"（注意上侧仍是 7 档渐隐，所以不能全局断言无 rgba(0,0,0,0)）
    expect(bottom.trim().endsWith("rgba(0,0,0,1) calc(100% - 28px), rgba(0,0,0,1) 100%)")).toBe(true);

    const both = edgeFadeMask({ atTop: true, atBottom: true });
    expect(countStops(both)).toBe(1 + 2 + 1);
  });

  it("EDGEFADE-4: 贴边判定容差 2px（滚动几何 → 状态）", () => {
    expect(EDGE_FADE_EDGE_TOLERANCE_PX).toBe(2);
    expect(edgeFadeStateFromMetrics({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })).toEqual({
      atTop: true,
      atBottom: false,
    });
    expect(edgeFadeStateFromMetrics({ scrollTop: 2, scrollHeight: 1000, clientHeight: 400 }).atTop).toBe(true);
    expect(edgeFadeStateFromMetrics({ scrollTop: 3, scrollHeight: 1000, clientHeight: 400 }).atTop).toBe(false);
    // 600 = 1000 - 400 ⇒ 已在底部
    expect(edgeFadeStateFromMetrics({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }).atBottom).toBe(true);
    expect(edgeFadeStateFromMetrics({ scrollTop: 597, scrollHeight: 1000, clientHeight: 400 }).atBottom).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { computeVirtualWindow } from "../core/ui/virtual-window";

describe("computeVirtualWindow", () => {
  it("VW-1: 空列表 / 未知视口 fail-open", () => {
    expect(computeVirtualWindow([], 0, 0)).toEqual({ start: 0, end: 0, top: 0, bottom: 0, totalHeight: 0 });
    const all = computeVirtualWindow([10, 10, 10], 0, 0);
    expect(all).toMatchObject({ start: 0, end: 3, top: 0, bottom: 0, totalHeight: 30 });
  });

  it("VW-2: 滚动到中间只挂可视区 + overscan，上下留白正确", () => {
    const heights = Array.from({ length: 100 }, () => 10);
    const w = computeVirtualWindow(heights, 500, 100, 1);
    expect(w.start).toBe(49);
    expect(w.end).toBe(61);
    expect(w.top).toBe(490);
    expect(w.bottom).toBe(390);
    expect(w.totalHeight).toBe(1000);
  });

  it("VW-3: 负/越界 scrollTop 被夹紧；坏高度按 1 处理", () => {
    const heights = [10, Number.NaN, -5, 10];
    const top = computeVirtualWindow(heights, -100, 20, 0);
    expect(top.start).toBe(0);
    const bottom = computeVirtualWindow(heights, 99999, 20, 0);
    expect(bottom.end).toBe(4);
  });
});

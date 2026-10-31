import { describe, expect, it } from "vitest";
import { safeRenderStart } from "../core/ui/render-window";

describe("safeRenderStart", () => {
  it("RW-1: limit 大于总长 ⇒ 从 0 开始", () => {
    expect(safeRenderStart([{ skip: false }, { skip: false }], 10)).toBe(0);
  });

  it("RW-2: 切在合并组中间 ⇒ 回退到组头，不能丢整组", () => {
    const entries = [
      { skip: false },
      { skip: false }, // group head
      { skip: true },
      { skip: true },
      { skip: false },
    ];
    // 5 - 2 = 3 落在 skip 项；必须回退到 index 1 的组头
    expect(safeRenderStart(entries, 2)).toBe(1);
  });

  it("RW-3: limit 非法 ⇒ fail-open 渲染全部，不隐藏历史", () => {
    expect(safeRenderStart([{ skip: false }], 0)).toBe(0);
    expect(safeRenderStart([{ skip: false }], Number.NaN)).toBe(0);
  });
});

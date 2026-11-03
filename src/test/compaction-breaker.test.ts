/**
 * 连压熔断判据（BRK-1/2）：
 * - BRK-1：持续高水位、但每次压缩都在减重 ⇒ **不许**累加到熔断（长任务不能被误杀）；
 * - BRK-2：压完压力不降 ⇒ 正常累加，连续 3 次才允许走 overflow。
 */
import { describe, expect, it } from "vitest";

import { nextConsecutiveCompactions } from "../core/llm/compaction-budget";

const THRESHOLD = 0.7;

describe("BRK-1 有效压缩不熔断", () => {
  it("每次都降 10 个点：连压 6 次计数仍是 0", () => {
    let count = 0;
    let pressure = 0.95;
    for (let i = 0; i < 6; i++) {
      const after = pressure - 0.1;
      count = nextConsecutiveCompactions(count, pressure, after, THRESHOLD);
      pressure = after;
      expect(count, `第 ${i + 1} 次有效压缩后计数应为 0`).toBe(0);
    }
  });

  it("降幅刚好 2 个点也算有效", () => {
    expect(nextConsecutiveCompactions(2, 0.9, 0.88, THRESHOLD)).toBe(0);
  });

  it("压到阈值以下直接清零（即使之前累计过）", () => {
    expect(nextConsecutiveCompactions(2, 0.8, 0.65, THRESHOLD)).toBe(0);
  });
});

describe("BRK-2 无效压缩才累加", () => {
  it("压力不降：3 次累计到 3（交给 overflow 分支）", () => {
    let count = 0;
    for (let i = 0; i < 3; i++) count = nextConsecutiveCompactions(count, 0.95, 0.95, THRESHOLD);
    expect(count).toBe(3);
  });

  it("降幅不足 2 个点视为无效（0.9 → 0.89）", () => {
    expect(nextConsecutiveCompactions(1, 0.9, 0.89, THRESHOLD)).toBe(2);
  });

  it("压力反升视为无效", () => {
    expect(nextConsecutiveCompactions(1, 0.9, 0.95, THRESHOLD)).toBe(2);
  });
});

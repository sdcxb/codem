/**
 * 缓存命中率显示算法测试（移植 dsh token-meter token-format）
 *
 * 契约（对标 dsh TurnUsageDisclosure）：
 * - 无输入（denominator 0）→ null（不显示）
 * - 全命中 → "100"
 * - 部分命中在普通精度下会四舍五入成 100 时，自动增加小数位保持诚实
 *   （99.97% 而非 100%）——用户报告的 dsh 缓存命中率显示即此形态
 */
import { describe, it, expect } from "vitest";
import { formatCacheHitPercent } from "../core/llm/cache-percent";

describe("formatCacheHitPercent（dsh 移植）", () => {
  it("无输入分母 → null", () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull();
    expect(formatCacheHitPercent(100, 0, 1)).toBeNull();
  });

  it("全命中 → 100", () => {
    expect(formatCacheHitPercent(1000, 1000)).toBe("100");
    expect(formatCacheHitPercent(999, 999, 1)).toBe("100");
  });

  it("零命中 → 0", () => {
    expect(formatCacheHitPercent(0, 1000)).toBe("0");
    expect(formatCacheHitPercent(0, 1000, 1)).toBe("0");
  });

  it("普通命中按精度显示（50 / 99.9）", () => {
    expect(formatCacheHitPercent(500, 1000)).toBe("50");
    expect(formatCacheHitPercent(999, 1000, 1)).toBe("99.9");
  });

  it("99.97%：部分命中不四舍五入成 100（保持诚实精度）", () => {
    // 9997/10000 = 99.97% —— 1 位精度会圆成 100，自动增位显示 99.97
    expect(formatCacheHitPercent(9997, 10000, 1)).toBe("99.97");
    // 9999/10000 = 99.99%
    expect(formatCacheHitPercent(9999, 10000, 0)).toBe("99.99");
  });

  it("dsh 高频形态：999900/1000000 → 99.99（不显示 100）", () => {
    const pct = formatCacheHitPercent(999_900, 1_000_000, 1);
    expect(pct).not.toBe("100");
    expect(pct!.startsWith("99.9")).toBe(true);
  });
});

/**
 * CostTracker 缓存计价测试
 *
 * 对标 dsh billed input 口径：成本 = 未命中输入 × 输入单价
 *   + 命中输入(cacheHitTokens) × 缓存单价(cacheCostPer1k)
 *   + 输出 × 输出单价。
 * DeepSeek 缓存命中输入显著更便宜——高缓存命中率直接降低账单。
 */
import { describe, it, expect } from "vitest";
import { CostTracker } from "../core/llm/cost-tracker";

function makeTracker() {
  return new CostTracker({ maxRecords: 100 });
}

describe("CostTracker 缓存计价", () => {
  it("无 cache 字段时按全量输入计价（向后兼容）", () => {
    const t = makeTracker();
    // deepseek-v4-flash: input 0.00027/1K, output 0.0011/1K
    const cost = (t as any).calculateCost("deepseek-v4-flash", {
      promptTokens: 1000,
      completionTokens: 100,
    });
    expect(cost).toBeCloseTo(0.00027 + 0.00011, 10);
  });

  it("cacheHitTokens 存在时命中部分按缓存价（更便宜）", () => {
    const t = makeTracker();
    // 输入 1000：800 命中缓存（0.00007/1K），200 未命中（0.00027/1K），输出 100
    const cost = (t as any).calculateCost("deepseek-v4-flash", {
      promptTokens: 1000,
      completionTokens: 100,
      cacheHitTokens: 800,
    });
    const expected = (200 / 1000) * 0.00027 + (800 / 1000) * 0.00007 + (100 / 1000) * 0.0011;
    expect(cost).toBeCloseTo(expected, 12);
    // 全命中应明显低于全未命中
    const allHit = (t as any).calculateCost("deepseek-v4-flash", {
      promptTokens: 1000, completionTokens: 0, cacheHitTokens: 1000,
    });
    const noneHit = (t as any).calculateCost("deepseek-v4-flash", {
      promptTokens: 1000, completionTokens: 0, cacheHitTokens: 0,
    });
    expect(allHit).toBeLessThan(noneHit);
  });

  it("未知模型成本为 0（不误报）", () => {
    const t = makeTracker();
    const cost = (t as any).calculateCost("no-such-model", {
      promptTokens: 1000, completionTokens: 100,
    });
    expect(cost).toBe(0);
  });
});

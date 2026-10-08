/**
 * CostTracker 缓存计价测试
 *
 * 对标 dsh billed input 口径：成本 = 未命中输入 × 输入单价
 *   + 命中输入(cacheHitTokens) × 缓存单价(cacheCostPer1k)
 *   + 输出 × 输出单价。
 * DeepSeek 缓存命中输入显著更便宜——高缓存命中率直接降低账单。
 */
import { describe, it, expect, vi } from "vitest";

/** 第 184 波（G4）：把"旧版本存下的"成本数据喂给 getSettingJSON（见 COST-MIG-1 的说明） */
const legacyStore: Record<string, unknown> = {};
/**
 * settings 的 mock 走**共享基座**（`./settings-mock`，单一实现，见那里的文件头）；
 * 这里只覆盖本用例自己的 `legacyStore`（注意：它存的是**原值**而不是 JSON 字符串，
 * 所以这两条必须照原样覆盖，基座的 `getSettingJSON` 语义与此不同）。
 * 工厂内动态 import 的理由见基座文件头。
 */
vi.mock("../core/storage/settings", async () => ({
  ...(await import("./settings-mock")).createSettingsMock(),
  getSettingJSON: (key: string, fallback: unknown) => (key in legacyStore ? legacyStore[key] : fallback),
  setSettingJSON: (key: string, value: unknown) => { legacyStore[key] = value; },
}));
function setLegacyCostSetting(key: string, value: unknown): void { legacyStore[key] = value; }

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

  /**
   * ★ 第 184 波（G4）：表外模型的 0 **不是**「免费」，而是「我们不知道价格」。
   *
   * 判据随契约演进：数字仍然是 0（我们**不编价格**），但"未知"必须可被判据与界面读到
   * —— 改前正是"只有一个 0"让用量面板看起来免费、且 `checkLimits` 永不触发。
   */
  it("未知模型：cost 仍为 0（不编价格），但必须被标记为 costUnknown", () => {
    const t = makeTracker();
    const usage = { promptTokens: 1000, completionTokens: 100 };
    expect((t as any).calculateCost("no-such-model", usage), "不许编价格").toBe(0);
    expect((t as any).isCostKnown("no-such-model"), "必须承认不知道").toBe(false);
    expect((t as any).getUncostedModels(), "见过的无价目模型要记下来").toContain("no-such-model");

    // 记录里必须带上 costUnknown（否则界面只能看到一个 0）
    const rec = t.recordUsage({
      sessionId: "s-unknown",
      model: "no-such-model",
      provider: "unknown",
      usage: usage as never,
      duration: 5,
      toolCalls: 0,
    });
    expect((rec as any).costUnknown, "费用记录必须显式标记「价格未知」").toBe(true);

    // 反向对照：有价目的模型不许被标记
    const known = t.recordUsage({
      sessionId: "s-known",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      usage: usage as never,
      duration: 5,
      toolCalls: 0,
    });
    expect((known as any).costUnknown, "有价目的模型不许被标成未知").toBeUndefined();
  });

  /**
   * ★ 第 184 波（G4）：**提示长度分档定价**（对标 Pi `ModelCostTier { inputTokensAbove }`）。
   *
   * 口径与上游逐条对齐：判据是**该请求的输入总量**；命中最高满足档；
   * 该档费率适用于**整个请求**（不是分段累进）。
   */
  it("G4-分档：输入超过阈值后按更高档计费，且**整个请求**都用该档费率（不分段累进）", async () => {
    const { pickCostRates } = await import("../core/llm/cost-tracker");
    // 合成的价目表（**不往产品数据里编价格**；这里只验证算法口径）
    const model = {
      modelId: "synthetic-tiered",
      provider: "test",
      inputCostPer1k: 0.1,
      outputCostPer1k: 0.2,
      tiers: [{ inputTokensAbove: 100_000, inputCostPer1k: 0.5, outputCostPer1k: 1.0 }],
    } as never;

    // 阈值以下 ⇒ 平费率
    expect(pickCostRates(model, 99_999)).toMatchObject({ inputCostPer1k: 0.1, outputCostPer1k: 0.2 });
    // **恰好等于阈值** ⇒ 仍走平费率（上游是严格的 `>`）
    expect(pickCostRates(model, 100_000)).toMatchObject({ inputCostPer1k: 0.1 });
    // 超过阈值 ⇒ 整档生效
    expect(pickCostRates(model, 100_001)).toMatchObject({ inputCostPer1k: 0.5, outputCostPer1k: 1.0 });

    // 多档：取**最高**满足档（乱序给出也要取对）
    const multi = {
      ...(model as Record<string, unknown>),
      tiers: [
        { inputTokensAbove: 200_000, inputCostPer1k: 2.0, outputCostPer1k: 3.0 },
        { inputTokensAbove: 100_000, inputCostPer1k: 0.5, outputCostPer1k: 1.0 },
      ],
    } as never;
    expect(pickCostRates(multi, 150_000), "150k 只满足 100k 档").toMatchObject({ inputCostPer1k: 0.5 });
    expect(pickCostRates(multi, 250_000), "250k 满足最高档").toMatchObject({ inputCostPer1k: 2.0 });
    // 没有档位 ⇒ 平费率
    expect(pickCostRates({ modelId: "flat", provider: "t", inputCostPer1k: 0.3, outputCostPer1k: 0.6 } as never, 999_999))
      .toMatchObject({ inputCostPer1k: 0.3 });
  });

    it("COST-MIG-1: 旧数据（没有 uncostedCalls）恢复后补 0，不是 NaN", async () => {
      /**
       * ⚠️ 用 `vi.mock` 供给"旧数据"是**必要**的：真实 `getSettingJSON` 在未预热时会返回
       * fallback（第 182 波那条修复），测试环境没有存储端口 ⇒ 走真实设置读不到东西，
       * 判据就会变成"什么都没发生"的假绿。
       */
      const { CostTracker } = await import("../core/llm/cost-tracker");
      const KEY = "test-cost-mig-1";
      setLegacyCostSetting(KEY, {
        records: [],
        sessionCosts: [["s-old", { sessionId: "s-old", totalCost: 1, totalInputTokens: 1, totalOutputTokens: 1, totalDuration: 1, apiCalls: 1, toolCalls: 0, modelBreakdown: {} }]],
      });
      // ⚠️ 必须 persist: true —— 构造函数只在 persist 时才调 load()（第一版传 false 导致"什么都没恢复"）
      const t = new CostTracker({ storageKey: KEY, persist: true });
      const sc: any = (t as any).sessionCosts.get("s-old");
      expect(sc, "旧会话必须被恢复").toBeTruthy();
      expect(sc.uncostedCalls, "缺字段必须补 0（否则 undefined++ 会变 NaN）").toBe(0);
      // 再记一次未知模型的调用 ⇒ 计数必须能从 0 正常加到 1
      t.recordUsage({
        sessionId: "s-old",
        model: "no-such-model",
        provider: "p",
        usage: { promptTokens: 10, completionTokens: 1 } as never,
        duration: 1,
        toolCalls: 0,
      });
      expect((t as any).sessionCosts.get("s-old").uncostedCalls, "计数必须能正常累加").toBe(1);
    });
  });
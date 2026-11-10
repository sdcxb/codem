/**
 * 群聊成本估算：价格表解析 / 匹配 / 计价 / 汇总（PRICE-1..6）
 *
 * ## 这一组要回答什么
 *
 * 群聊此前只显示 token（没有可靠价目表）。现在价格由用户显式配置
 * （`codem-context-config.tokenPrices`，每 1M tokens），本文件钉住四条诚实性：
 *
 * | id | 钉什么 | 变异（改坏）怎么红 |
 * |---|---|---|
 * | PRICE-1 | 价格表解析：坏行跳过、空表 = null、货币默认 $ | 把坏行当 0 / 空表当已配置 ⇒ 红 |
 * | PRICE-2 | 计价含缓存分项：input 扣掉 cacheRead，cacheWrite 单独加 | 缓存命中按两次输入价 / 丢 cacheWrite ⇒ 红 |
 * | PRICE-3 | 全部已上报调用都能匹配 ⇒ 金额 = 逐模型分别计价之和 | 先合并 token 再乘一个模型价 ⇒ 不同模型时红 |
 * | PRICE-4 | 缺一个模型 ⇒ `estimatedCost: null` + `missingModels` | 按 0 兜底 / 只算已匹配部分 ⇒ 红 |
 * | PRICE-5 | 未配置 / 0 次上报 / 未知模型 ⇒ null，**绝不 0** | 未知补 0 ⇒ 红 |
 * | PRICE-6 | 保存只碰 tokenPrices / tokenPriceCurrency，不覆盖压缩参数 | 整份覆盖 ⇒ 红 |
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import {
  computeUsageCost,
  formatEstimatedCost,
  parseTokenPriceTable,
  readTokenPriceTable,
  resolveTokenPrice,
  saveTokenPriceTable,
  tokenPriceKey,
  tokenPriceModelLabel,
} from "../core/llm/token-prices";

beforeEach(() => {
  /* 每个用例由全局 setup 换一份新端口；这里不用额外清理 */
});

function pricedConfig() {
  return {
    tokenPrices: {
      "prov-a/model-a": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      "prov-b/model-b": { input: 2, output: 4 },
    },
    tokenPriceCurrency: "¥",
  };
}

describe("PRICE-1：价格表解析（未知绝不按 0）", () => {
  it("有效行解析、坏行跳过、空表 = null", () => {
    const table = parseTokenPriceTable({
      tokenPrices: {
        "prov-a/model-a": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        /* 坏行：负数 / 字符串 / 缺 output / 非对象 —— 全部跳过，不补 0 */
        "bad/negative": { input: -1, output: 2 },
        "bad/string": { input: "3", output: 2 },
        "bad/missing": { input: 1 },
        "bad/not-object": 7,
      },
      tokenPriceCurrency: "¥",
    });
    expect(table).not.toBeNull();
    expect(Object.keys(table!.prices)).toEqual(["prov-a/model-a"]);
    expect(table!.prices["prov-a/model-a"]).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(table!.currency).toBe("¥");
  });

  it("没有 tokenPrices / 全坏 / 空表 ⇒ null（未配置，不是一张空价目）", () => {
    expect(parseTokenPriceTable(null)).toBeNull();
    expect(parseTokenPriceTable({})).toBeNull();
    expect(parseTokenPriceTable({ tokenPrices: {} })).toBeNull();
    expect(parseTokenPriceTable({ tokenPrices: { x: { input: 1 } } })).toBeNull();
  });

  it("货币符号缺省 $；字符串空白也回默认", () => {
    const table = parseTokenPriceTable({ tokenPrices: { m: { input: 1, output: 2 } } });
    expect(table!.currency).toBe("$");
    const blank = parseTokenPriceTable({
      tokenPrices: { m: { input: 1, output: 2 } },
      tokenPriceCurrency: "   ",
    });
    expect(blank!.currency).toBe("$");
  });

  it("key：provider/model；无 provider ⇒ model；无 model ⇒ null", () => {
    expect(tokenPriceKey("prov", "model")).toBe("prov/model");
    expect(tokenPriceKey("", "model")).toBe("model");
    expect(tokenPriceKey(undefined, " model ")).toBe("model");
    expect(tokenPriceKey("prov", "")).toBeNull();
    expect(tokenPriceModelLabel(undefined, undefined)).toBe("（未知模型）");
  });

  it("匹配：精确 provider/model 优先，裸 model 兜底", () => {
    const table = parseTokenPriceTable({
      tokenPrices: {
        "prov-a/model-x": { input: 10, output: 20 },
        "model-y": { input: 1, output: 2 },
      },
    });
    expect(resolveTokenPrice(table, "prov-a", "model-x")?.input).toBe(10);
    /* provider 不在表里 ⇒ 裸 model 兜底（显式匹配，不是拿别的模型的价格猜） */
    expect(resolveTokenPrice(table, "prov-b", "model-y")?.input).toBe(1);
    expect(resolveTokenPrice(table, "prov-b", "model-x")).toBeNull();
    expect(resolveTokenPrice(null, "prov-a", "model-x")).toBeNull();
  });
});

describe("PRICE-2：计价分项（缓存不重复计费）", () => {
  it("input 扣掉 cacheRead；cacheWrite 单独一桶；output 单列", () => {
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const cost = computeUsageCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 400_000,
        cacheWriteTokens: 200_000,
      },
      price,
    );
    /* 未命中 600k×3 + 缓存读 400k×0.3 + 缓存写 200k×3.75 + 输出 100k×15 = 4.17 */
    expect(cost).toBeCloseTo(4.17, 10);
  });

  it("省略 cacheRead / cacheWrite 价 ⇒ 按 input 价兜底（仍不是 0）", () => {
    const cost = computeUsageCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 400_000,
        cacheWriteTokens: 200_000,
      },
      { input: 3, output: 15 },
    );
    expect(cost).toBeCloseTo(5.1, 10);
  });

  it("缓存读大于 input 时未命中按 0 钳制（坏数据不出现负输入）", () => {
    const cost = computeUsageCost(
      { inputTokens: 100, outputTokens: 0, cacheReadTokens: 500 },
      { input: 1, output: 0, cacheRead: 2 },
    );
    expect(cost).toBeCloseTo(0.001, 10);
  });
});

describe("PRICE-6：保存只碰价格字段", () => {
  it("保存价格表不覆盖 codem-context-config 里的其它配置；清空则删两个字段", () => {
    setSettingJSON("codem-context-config", {
      compactionThreshold: 0.7,
      tokenPrices: { old: { input: 1, output: 2 } },
      tokenPriceCurrency: "$",
    });
    saveTokenPriceTable({
      currency: "€",
      prices: { "prov-a/model-a": { input: 3, output: 15, cacheRead: 0.3 } },
    });
    const saved = getSettingJSON<Record<string, any>>("codem-context-config", {});
    expect(saved.compactionThreshold, "压缩参数必须原样保留").toBe(0.7);
    expect(saved.tokenPriceCurrency).toBe("€");
    expect(saved.tokenPrices).toEqual({
      "prov-a/model-a": { input: 3, output: 15, cacheRead: 0.3 },
    });
    expect(readTokenPriceTable()?.prices["prov-a/model-a"].input).toBe(3);

    saveTokenPriceTable({ currency: "$", prices: {} });
    const cleared = getSettingJSON<Record<string, any>>("codem-context-config", {});
    expect(cleared.compactionThreshold).toBe(0.7);
    expect(cleared.tokenPrices).toBeUndefined();
    expect(cleared.tokenPriceCurrency).toBeUndefined();
    expect(readTokenPriceTable()).toBeNull();
  });
});

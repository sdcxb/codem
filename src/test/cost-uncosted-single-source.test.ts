/**
 * ★ 第 185 波（复审 I-7）：**「费用未知的调用」只能有一个来源**。
 *
 * ## 钉的是什么
 *
 * `getStats().uncostedCalls` 从**被裁剪的** `records[]` 现算，而
 * `SessionCost.uncostedCalls` 是另一条不裁剪的累加（`cost-tracker.ts:411`）
 * ⇒ 长期使用（超过 `maxRecords`）后两个数必然分叉，且 `getStats()` 那个**偏小**
 * —— 界面上的提示（"账单可能少算了多少次"）因此变得**不保守**，
 * 恰好废掉这个字段存在的意义。
 *
 * ## 选哪个来源（报告里也要说明）
 *
 * 选**累加值**（`sessionCosts`，不裁剪）：
 * · 唯一消费方（`UsageStats.tsx`）要的是"保守警告"，不是"历史窗口内的精确统计"；
 * · `records` 只是**有界历史窗口**（`maxRecords`），拿它算"一共少算了多少次"用的是错的集合；
 * · 顺带消灭第二份计算：一处累加、一处读。
 *
 * ## 判据
 *
 * | id | 钉什么 |
 * |---|---|
 * | COST-UNC-1 | `maxRecords: 2` 下记 3 次无价目调用 ⇒ `getStats().uncostedCalls === 3`（不是被裁到 2） |
 * | COST-UNC-2 | 与 `SessionCost` 的累加**同源**（多会话求和），且读一次不多算一次 |
 * | COST-UNC-3 | 反向对照：有价目的调用不许被算进"未知" |
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../core/storage/settings", () => ({
  getSettingJSON: (_key: string, fallback: unknown) => fallback,
  setSettingJSON: () => {},
  getSetting: () => "",
  setSetting: () => {},
}));

import { CostTracker } from "../core/llm/cost-tracker";

/** 表里没有的模型名 ⇒ `costUnknown` 为真（"不知道价格" ≠ "免费"） */
const UNPRICED = "totally-unpriced-model-v9";
const PRICED = "deepseek-v4-flash";

const usage = { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 };

function makeTracker(maxRecords = 2) {
  /** `persist: true` 才会走 `save()` —— 而裁剪（`records.slice(-maxRecords)`）就在那里发生。 */
  return new CostTracker({ maxRecords, persist: true });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("I-7：uncostedCalls 只有一个来源（累加值，不裁剪）", () => {
  it("COST-UNC-1: 记录被裁剪之后，「少算了多少次」仍按**累计**计（不许偏小）", () => {
    const t = makeTracker(2);
    for (const sessionId of ["s1", "s2", "s3"]) {
      t.recordUsage({ sessionId, model: UNPRICED, provider: "p", usage, duration: 1 });
    }

    const stats = t.getStats();
    expect(stats.totalRecords, "前置：历史窗口确实被裁到了上限").toBe(2);
    expect(
      stats.uncostedCalls,
      `累计 3 次无价目调用就必须报 3（改前从被裁剪的 records 现算 ⇒ 只报 ${stats.totalRecords}）—— ` +
        `提示偏小就等于把"账单可能少算"说轻了`,
    ).toBe(3);
  });

  it("COST-UNC-2: 与 SessionCost 的累加**同源**（多会话求和、且读多次不加）", () => {
    const t = makeTracker(100);
    t.recordUsage({ sessionId: "a", model: UNPRICED, provider: "p", usage, duration: 1 });
    t.recordUsage({ sessionId: "a", model: UNPRICED, provider: "p", usage, duration: 1 });
    t.recordUsage({ sessionId: "b", model: UNPRICED, provider: "p", usage, duration: 1 });

    const first = t.getStats().uncostedCalls;
    expect(first, "多会话必须求和").toBe(3);
    expect(t.getStats().uncostedCalls, "读一次不许把计数加上去（纯读）").toBe(first);

    const summed = Array.from((t as any).sessionCosts.values()).reduce(
      (s: number, v: any) => s + (Number(v.uncostedCalls) || 0),
      0,
    );
    expect(first, "getStats 与 SessionCost 累加必须同源（同一个数）").toBe(summed);
  });

  it("COST-UNC-3: 反向对照 —— 有价目的调用不许被算进「未知」", () => {
    const t = makeTracker(100);
    t.recordUsage({ sessionId: "s", model: PRICED, provider: "deepseek", usage, duration: 1 });

    expect(t.getStats().uncostedCalls).toBe(0);
    expect(t.getStats().totalCost).toBeGreaterThan(0);
  });
});

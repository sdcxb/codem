/**
 * 第 142 波：**维护自检的等待预算必须随会话数伸缩** ✓（修 S2 的副作用 ✗）。
 *
 * ## 现象（1.16.258 真机 3331 行控制台）
 *
 * ```
 * [PersistFailure] maintenance.invariantAudit 自检：有会话没被检查（读侧镜像未就绪）：
 *   会话读侧镜像未就绪 132 个会话
 * ```
 *
 * ## 根因（两个正确的改动叠在一起 ✗）
 *
 * 1. **S2**（1.16.255 ✓，治本方向 ✓）：同一时刻只驻留最近 3 个会话
 *    ⇒ 自检按会话逐个读时，**每读一个新会话都触发一次重新加载** ✓；
 * 2. 而自检的**整轮共享预算**是写死的常量：
 *    `MIRROR_RECHECK_TOTAL_MS = 8000` ✗ —— 8 秒只够覆盖几个会话 ✗，
 *    剩下的（132 个 ✗）一律记成"读侧镜像未就绪" ✓。
 *
 * ⇒ 单独看两个改动都对 ✓，合在一起就产生了这条噪音 ✗。
 * 修法：预算**随会话数伸缩**（有上限 ✓，维护不许被拖死 ✗）。
 *
 * 变异：把预算写回常量 8000 ⇒ BUDGET-2 红。
 */
import { describe, expect, it } from "vitest";
import { mirrorRecheckTotalBudgetMs } from "../core/storage/maintenance";

describe("第 142 波：维护自检等待预算随会话数伸缩", () => {
  it("BUDGET-1: 小会话数时接近原来的 8 秒（不做无谓等待 ✗）", () => {
    const b = mirrorRecheckTotalBudgetMs(3);
    expect(b, "3 个会话不该要一分钟").toBeLessThanOrEqual(12_000);
    expect(b, "但也不该小于原来的常量").toBeGreaterThanOrEqual(8_000);
  });

  it("BUDGET-2: 132 个会话必须拿到远大于 8 秒的预算（那条噪音的来源 ✗）", () => {
    const b = mirrorRecheckTotalBudgetMs(132);
    expect(
      b,
      "S2 之后每个会话都要重载 ⇒ 8 秒的共享预算只够几个会话，其余全被记成'未就绪' ✗",
    ).toBeGreaterThan(30_000);
  });

  it("BUDGET-3: 但必须有上限（维护不许被拖死 ✗）", () => {
    expect(mirrorRecheckTotalBudgetMs(10_000), "再多的会话也不能让维护无限等下去").toBeLessThanOrEqual(180_000);
  });

  it("BUDGET-4 单调性: 会话越多预算越大（不出现反常回落）", () => {
    const a = mirrorRecheckTotalBudgetMs(10);
    const b = mirrorRecheckTotalBudgetMs(50);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

/**
 * HEADROOM：压缩后必须留出**真正的余量**，不能"压到刚好 70%"。
 *
 * 用户现场（2026-10-19）：「即使压到 70% 以下，下一轮不又报满了吗？」
 * —— 对。压缩保留预算原来是窗口 50%，提示线 70% ⇒ 压完 50–55%，涨 15–20% 又触发。
 *
 * 参考 DSH `compaction-basic`：阈值 0.8、`retainTokens` 65536（128K 窗口的 50%）⇒ 留 30% 余量；
 * 这里保留 40%：70% - 40% = **30% 余量**（同量级），且自动压缩阈值下调到 70%（提示线与压缩线一致）。
 *
 * 判据 `HEADROOM-1..3`；变异 `compaction-headroom`。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { planCompactionKeep } from "../core/llm/compaction-budget";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("HEADROOM 压缩余量", () => {
  it("HEADROOM-1: 自动压缩阈值 = 提示阈值（70%），且用 >= 比较", () => {
    const ctx = read("src/core/context/context.ts");
    expect(ctx).toContain("compactionThreshold: 0.7,");
    const loop = read("src/core/llm/agentic-loop.ts");
    expect(loop).toContain("compactionThreshold: 0.7,");
    expect(loop, "等于 70% 也要压缩（否则正好 70% 时只提示不压缩）").toContain(
      "this.state.contextPressure >= this.config.compactionThreshold",
    );
  });

  it("HEADROOM-2: 压缩保留预算 = 窗口 40%（给下一轮留 30% 余量）", () => {
    const loop = read("src/core/llm/agentic-loop.ts");
    expect(loop).toContain("Math.floor(windowTokens * 0.4)");
    expect(loop, "改回 50% 会在下一轮就再次触发提示").not.toContain("Math.floor(windowTokens * 0.5)");
  });

  it("HEADROOM-3: 保留集真的会收缩到 40% 预算以内（不是只改常量）", () => {
    const window = 128_000;
    const budget = Math.floor(window * 0.4); // 51,200
    const plan = planCompactionKeep({
      totalMessages: 300,
      desiredKeep: 300,
      minKeep: 1,
      budget,
      estimate: (n: number) => n * 1_000,
      align: (n: number) => n,
    });
    expect(plan.estimated).toBeLessThanOrEqual(budget);
    expect(plan.keepCount).toBeLessThanOrEqual(52);
  });
});

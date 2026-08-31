/**
 * Regression tests: model-aware context window + pressure estimation fixes.
 *
 * Root cause of "compaction after ~3 turns":
 * 1. TokenTracker.contextWindow defaulted to 128000 and setContextWindow()
 *    was never called — 1M-window models (MiMo/DeepSeek/Gemini) were
 *    estimated against a 128k denominator, inflating pressure ~8x.
 * 2. estimateMessagesTokens() returned baseline verbatim, ignoring the
 *    actual current message list — pressure never tracked growth.
 * 3. Micro-compact triggered on message COUNT only, not pressure.
 */
import { describe, it, expect } from "vitest";
import { TokenTracker } from "../core/llm/token-tracker";
import * as fs from "fs";
import * as path from "path";

function readAgenticLoopSource(): string {
  return fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");
}

describe("CW-01: TokenTracker 窗口感知 — contextWindow 影响压力估算", () => {
  it("默认窗口 128k 下压力偏高，设置 1M 窗口后压力大幅下降", () => {
    const tracker = new TokenTracker();
    const messages = Array(40).fill({ role: "user", content: "x".repeat(500) });

    const defaultPressure = tracker.estimatePressure(messages, []);

    // 模拟 1M 窗口模型（MiMo/DeepSeek/Gemini）
    tracker.setContextWindow(1_000_000);
    const millionPressure = tracker.estimatePressure(messages, []);

    expect(defaultPressure).toBeGreaterThan(millionPressure);
    // 1M 窗口下 40 条短消息远低于阈值
    expect(millionPressure).toBeLessThan(0.5);
  });

  it("setContextWindow 后压力不会超过 1", () => {
    const tracker = new TokenTracker(1000);
    tracker.setContextWindow(500);
    const messages = Array(100).fill({ role: "user", content: "x".repeat(1000) });
    expect(tracker.estimatePressure(messages, [])).toBeLessThanOrEqual(1);
  });
});

describe("CW-02: estimateMessagesTokens — baseline 不再忽略消息增长", () => {
  it("有 baseline 时消息增长会反映在压力上（不再恒等于 baseline）", () => {
    const tracker = new TokenTracker();
    tracker.recordActualUsage(
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      50,
      "fp-1",
    );

    // 大量消息应该显著提高估算（baseline 只是下限，不是上限）
    const small = tracker.estimatePressure([{ role: "user", content: "hi" }], []);
    const big = tracker.estimatePressure(
      Array(50).fill({ role: "user", content: "y".repeat(2000) }),
      [],
    );

    expect(big).toBeGreaterThan(small);
  });
});

describe("CW-03: AgenticLoop — 模型感知窗口接入链路", () => {
  it("run() 开头调用 resolveModelContextWindow", () => {
    const src = readAgenticLoopSource();
    expect(src).toContain("await this.resolveModelContextWindow()");
    expect(src).toContain("resolveModelContextWindow");
    expect(src).toContain("setContextWindow");
  });

  it("resolveModelContextWindow 从 provider.listModels 解析真实窗口", () => {
    const src = readAgenticLoopSource();
    expect(src).toContain("listModels()");
    expect(src).toContain("match?.contextWindow");
  });

  it("LoopConfig 提供 contextWindow 字段并同步 tracker", () => {
    const src = readAgenticLoopSource();
    expect(src).toContain("contextWindow?: number");
    expect(src).toContain("contextWindow: 128000");
  });
});

describe("CW-04: Micro-compact — 压力驱动而非纯条数", () => {
  it("micro-compact 触发需满足压力阈值", () => {
    const src = readAgenticLoopSource();
    expect(src).toContain("MICRO_COMPACT_PRESSURE_THRESHOLD");
    expect(src).toContain("estimateContextPressure(valid)");
  });

  it("压力阈值常量定义为 0.5（先剪枝，全量压缩兜底）", () => {
    const src = readAgenticLoopSource();
    expect(src).toContain("MICRO_COMPACT_PRESSURE_THRESHOLD = 0.5");
  });
});

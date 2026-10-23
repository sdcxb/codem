import { describe, it, expect } from "vitest";
import { estimateTokens } from "../core/llm/token-tracker";

describe("token 估算：大字符串快路径", () => {
  it("PERF-1：7MB ASCII 走抽样且量级正确", () => {
    const text = "a".repeat(7 * 1024 * 1024);
    const t0 = performance.now();
    const n = estimateTokens(text);
    const ms = performance.now() - t0;
    // 0.25 token/char ± 2%
    expect(n).toBeGreaterThan(0.245 * text.length);
    expect(n).toBeLessThan(0.255 * text.length);
    // 旧实现每字符两次正则，真机 ~585ms；这里留足余量但必须远低于旧值
    expect(ms).toBeLessThan(100);
  });

  it("PERF-2：1MB CJK 抽样仍按 0.6/字", () => {
    const text = "中".repeat(1024 * 1024);
    const n = estimateTokens(text);
    expect(n).toBeGreaterThan(0.59 * text.length);
    expect(n).toBeLessThan(0.61 * text.length);
  });

  it("PERF-3：小字符串保持逐字符精确分类", () => {
    // "a"×10 = 2.5；" "×2 = 0.5；"1"×2 = 0.66；"{}" = 1.0
    expect(estimateTokens("aaaaaaaaaa  11{}")).toBeCloseTo(4.66, 2);
  });
});

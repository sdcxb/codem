/**
 * usage 归一化口径测试（缓存字段精确性）
 *
 * DeepSeek：prompt_cache_hit_tokens + prompt_cache_miss_tokens（显式 miss
 * 最准）；OpenAI 兼容：cache_read_input_tokens（无 miss → prompt − cache 折中）。
 */
import { describe, it, expect } from "vitest";
import { parseProviderUsage } from "../core/llm/usage-normalize";

describe("parseProviderUsage 缓存口径", () => {
  it("DeepSeek：显式 hit + miss → uncached = miss（最准）", () => {
    const u = parseProviderUsage({
      prompt_tokens: 10000,
      completion_tokens: 500,
      prompt_cache_hit_tokens: 9990,
      prompt_cache_miss_tokens: 10,
    });
    expect(u.promptTokens).toBe(10000);
    expect(u.cacheHitTokens).toBe(9990);
    expect(u.uncachedInputTokens).toBe(10); // 不依赖 prompt−hit 的减法口径
    expect(u.totalTokens).toBe(10500);
  });

  it("OpenAI cache_read：无 miss → uncached = max(0, prompt − cacheRead)", () => {
    const u = parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      cache_read_input_tokens: 700,
    });
    expect(u.cacheHitTokens).toBe(700);
    expect(u.uncachedInputTokens).toBe(300);
  });

  /**
   * D7：缺报即缺报（undefined ≠ 0）。
   *
   * 这条断言原来写的是 `cacheHitTokens === 0`：provider 一个缓存字段都没报时，
   * 归一化层把"未知"填成"确定命中 0"，消费方（`StatsLine.cacheReported`、
   * `UsageStats` 的 `typeof r.cacheReadTokens === "number"` 过滤）就再也无法
   * 区分「没上报」与「上报了 0」，于是对着非 DeepSeek 系 provider 显示
   * 误导性的"缓存命中 0%"。现在缺报 ⇒ 键不存在（同 `token-tracker` 删掉的
   * `promptTokens * 0.3` 猜测是同一件事的两半）。
   */
  it("无任何 cache 字段 → 不产出 cache 键（undefined ≠ 0），核心口径不变", () => {
    const u = parseProviderUsage({ prompt_tokens: 1000, completion_tokens: 50 });
    expect("cacheHitTokens" in u).toBe(false);
    expect("uncachedInputTokens" in u).toBe(false);
    expect(u.promptTokens).toBe(1000);
    expect(u.completionTokens).toBe(50);
    expect(u.totalTokens).toBe(1050);
  });

  it("异常口径不产生负数（hit > prompt 时 clamp）", () => {
    const u = parseProviderUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 150,
    });
    expect(u.uncachedInputTokens).toBe(0);
    expect(u.cacheHitTokens).toBe(150);
  });
});

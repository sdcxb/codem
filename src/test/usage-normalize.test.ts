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

  it("无任何 cache 字段 → uncached = prompt（向后兼容）", () => {
    const u = parseProviderUsage({ prompt_tokens: 1000, completion_tokens: 50 });
    expect(u.cacheHitTokens).toBe(0);
    expect(u.uncachedInputTokens).toBe(1000);
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

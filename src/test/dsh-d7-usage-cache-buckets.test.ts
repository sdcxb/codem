/**
 * D7：缓存口径必须是「provider 报什么就是什么」，**不许猜**。
 *
 * ## 修的是什么
 *
 * `token-tracker.ts` 原来在 provider 没报 `cacheHitTokens` 时**编造**一个数：
 * 同一个 header 指纹下猜成 `floor(promptTokens * 0.3)`，否则填 `0`。
 * 后果有两层：
 * - 数字是假的（`ollama-provider.ts` 这类根本不报缓存字段的 provider，
 *   会被显示成"缓存命中 30%"，命中率与按缓存价计的成本系统性失真）；
 * - 「未上报」与「上报了 0」再无法区分 —— 而消费方（`StatsLine.cacheReported`、
 *   `UsageStats` 的 `typeof r.cacheReadTokens === "number"` 过滤）**正是靠这个区分**
 *   来决定"要不要显示命中率"。
 *
 * 归一化侧（`usage-normalize.ts`）同样把缺报填成 0，于是假 0 一路传到 UI。
 * 两处一起改成：**缺报即缺报（undefined），上报 0 才是 0**。
 *
 * | # | 判据 |
 * | --- | --- |
 * | D7-A | DeepSeek 形状 `{prompt 1000, hit 700, miss 300}` → `cacheHitTokens === 700`、`uncachedInputTokens === 300` |
 * | D7-B | 同一 headerFingerprint 连续两次、usage 里**没有** cache 字段 → 两次都是 `undefined`（不是 300） |
 * | D7-C | 缺报时归一化结果**不含** cache 键（undefined ≠ 0），prompt/completion 口径不受影响 |
 * | D7-D | provider **上报 0** 时仍然是 0（没把"确定没命中"一起抹掉） |
 */
import { describe, it, expect, vi } from "vitest";
import { parseProviderUsage } from "../core/llm/usage-normalize";
import { TokenTracker } from "../core/llm/token-tracker";
import { OpenAICompatibleProvider } from "../core/llm/provider";

const FINGERPRINT = "fp-same-system-prompt-and-tools";

describe("D7：缓存桶只信 provider 上报，绝不猜", () => {
  it("D7-A：DeepSeek 形状 hit 700 / miss 300 → 归一化分别落在两个桶里", () => {
    const u = parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 700,
      prompt_cache_miss_tokens: 300,
    });
    expect(u.cacheHitTokens).toBe(700);
    expect(u.uncachedInputTokens).toBe(300);
    expect(u.totalTokens).toBe(1010);
  });

  it("D7-B：同一 header 指纹下缺报两次 → 两次都是 undefined（不是 300）", () => {
    const tracker = new TokenTracker(128000);
    const usage = { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 };

    const first = tracker.recordActualUsage(usage, 0, FINGERPRINT);
    const second = tracker.recordActualUsage(usage, 0, FINGERPRINT);

    // 旧实现：第二次（同指纹）会被猜成 floor(1000 * 0.3) = 300
    expect(
      second.cacheHitTokens,
      "同指纹不等于缓存命中 —— 没有上报就必须是 undefined，而不是 promptTokens * 0.3",
    ).toBeUndefined();
    expect(first.cacheHitTokens, "第一次（指纹不同）旧实现填 0；0 同样是编造").toBeUndefined();

    // 累计 prompt/completion 不受缓存口径影响
    const cumulative = tracker.getCumulative();
    expect(cumulative.promptTokens).toBe(2000);
    expect(cumulative.completionTokens).toBe(20);
    expect(cumulative.totalTokens).toBe(2020);
  });

  it("D7-C：缺报时归一化结果不含 cache 键（undefined ≠ 0），核心口径不受影响", () => {
    const u = parseProviderUsage({ prompt_tokens: 1000, completion_tokens: 50 });
    expect(
      "cacheHitTokens" in u,
      "provider 一个缓存字段都没报 ⇒ 不能产出 0（那会被 UI 当成『确定没命中』）",
    ).toBe(false);
    expect(
      "uncachedInputTokens" in u,
      "同上：uncached 只在真的上报了缓存字段时才有意义",
    ).toBe(false);
    // 新旧一致的三个核心字段
    expect(u.promptTokens).toBe(1000);
    expect(u.completionTokens).toBe(50);
    expect(u.totalTokens).toBe(1050);
  });

  it("D7-D：provider 明确上报 0 时仍然保留 0（区分『没报』与『报了 0』）", () => {
    const u = parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 0,
    });
    expect(u.cacheHitTokens).toBe(0);
    expect(u.uncachedInputTokens).toBe(1000);

    const tracker = new TokenTracker(128000);
    const turn = tracker.recordActualUsage(
      { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cacheHitTokens: 0 },
      0,
      FINGERPRINT,
    );
    expect(turn.cacheHitTokens).toBe(0);
  });

  /**
   * D7-E（契约已补上，2026 波）：`complete()` 必须把缓存桶带出来。
   *
   * `OpenAICompatibleProvider.complete()` 是压缩摘要等**非流式调用**的唯一出口，
   * 原来它手写 usage 的三个字段、**丢掉缓存桶**（而流式路径走 `parseProviderUsage`
   * 会把两个桶带出来）。于是这些调用的缓存命中在统计里恒为"未上报"，
   * 命中率与成本都算错。
   *
   * 这里用真实 provider + 桩 fetch 端到端断言：
   * - 报了缓存字段 ⇒ 两个桶按上报值落地（700 / 300）；
   * - 一个缓存字段都没报 ⇒ 两个键**不出现**（缺报即缺报，不是 0）。
   */
  async function completeWithUsage(usage: Record<string, unknown>) {
    const provider = new OpenAICompatibleProvider({
      id: "d7-provider",
      name: "D7 Mock",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      models: [
        {
          id: "d7-model",
          name: "D7 Model",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
    });
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "",
      json: async () => ({
        id: "chatcmpl-d7",
        choices: [{ message: { content: "摘要" }, finish_reason: "stop" }],
        usage,
      }),
    })) as never;

    return provider.complete({
      model: "d7-model",
      messages: [{ id: "m1", role: "user", content: "总结一下" }],
      stream: false,
    } as never);
  }

  it("D7-E: complete() 携带 provider 上报的缓存桶；缺报时不产出 0", async () => {
    const withCache = await completeWithUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 700,
      prompt_cache_miss_tokens: 300,
    });
    expect(
      (withCache.usage as any).cacheHitTokens,
      "压缩摘要调用同样要带缓存命中 —— 否则命中率与缓存价成本系统性失真",
    ).toBe(700);
    expect((withCache.usage as any).uncachedInputTokens).toBe(300);
    // 三个核心字段照旧
    expect(withCache.usage.promptTokens).toBe(1000);
    expect(withCache.usage.completionTokens).toBe(10);

    vi.restoreAllMocks();

    const noCache = await completeWithUsage({ prompt_tokens: 1000, completion_tokens: 50 });
    expect(
      "cacheHitTokens" in (noCache.usage as any),
      "provider 没报缓存 ⇒ 不能填 0（那会被 UI 当成『确定没命中』）",
    ).toBe(false);
    expect("uncachedInputTokens" in (noCache.usage as any)).toBe(false);
    expect(noCache.usage.promptTokens).toBe(1000);
    expect(noCache.usage.completionTokens).toBe(50);
  });
});

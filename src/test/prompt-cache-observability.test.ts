/**
 * `PROMPT-CACHE-1`：服务端前缀缓存的**读数必须可复核**（第 191 波：O-48 的证据基础）。
 *
 * ## 为什么这条判据是 O-48 的前置条件
 *
 * O-48 问的是「要不要为提示装配引入跨轮状态（delta 通道）」—— 答案取决于
 * **服务端 KV 缓存到底命中到哪一段**。`docs/GAP-LIST.md` 的 O-54 把这一点归为
 * 「三家服务端 KV 命中率**不可观测**」，但那是**对标取证**（OpenClaw / Hermes / DSH）的口径；
 * **我们自己的链路是可观测的**：`usage-normalize.ts` 早就把 DeepSeek 的
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（以及 OpenAI 形状的
 * `cache_read_input_tokens`）归一化进了 `TokenUsage.cacheHitTokens`，`cost-tracker` 也按它计价 ——
 * 只是**从来没有按请求打进日志**（界面上只有一个百分比）。
 *
 * 所以本判据钉两件事：
 * - `PC-1`：读数函数的口径 —— 报了就给出 `hit/miss/prompt/ratio`；**没报就必须是 `?`**，
 *   绝不许写成 `hit=0`（那是编造一个"全未命中"的读数，会让 O-48 的判断反过来）；
 * - `PC-2`：接线 —— `agentic-loop` 每一次拿到 usage 都必须留下这一行（源码级接线检查 +
 *   变异自证：删掉那一行 ⇒ 判据红）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatPromptCacheLog } from "../core/llm/cache-percent";

const ROOT = process.cwd();

describe("PROMPT-CACHE-1：服务端前缀缓存读数必须可复核（O-48）", () => {
  it("PC-1: provider 报了缓存字段 ⇒ 给出 hit/miss/prompt/ratio（ratio 走唯一百分比实现）", () => {
    const line = formatPromptCacheLog({ promptTokens: 10_000, cacheHitTokens: 9_000, uncachedInputTokens: 1_000 });
    // 百分比文案走唯一实现 `formatCacheHitPercent`：整十的不补 `.0`（这是它的既有口径）
    expect(line).toBe("[prompt-cache] hit=9000 miss=1000 prompt=10000 ratio=90%");
    // miss 缺报时用 prompt − hit 推（但不许把"未命中"当成 0 上报）
    const derived = formatPromptCacheLog({ promptTokens: 1_000, cacheHitTokens: 750 });
    expect(derived).toBe("[prompt-cache] hit=750 miss=250 prompt=1000 ratio=75%");
    // 全命中：比率实现**不许**把部分命中圆成 100（本仓既有纪律）
    expect(formatPromptCacheLog({ promptTokens: 1_000, cacheHitTokens: 999 })).toContain("ratio=99.9%");
    expect(formatPromptCacheLog({ promptTokens: 1_000, cacheHitTokens: 1_000 })).toContain("ratio=100%");
  });

  it("PC-1b 诚实纪律: provider 没报缓存字段 ⇒ 必须是 `?`，绝不许编成 0", () => {
    const line = formatPromptCacheLog({ promptTokens: 5_000 });
    expect(line, "缺报时必须如实写 ?").toContain("hit=?");
    expect(line).toContain("miss=?");
    expect(line).toContain("ratio=?");
    expect(line, "缺报时说清原因（不许让读日志的人以为全未命中）").toContain("未上报");
    expect(line.includes("hit=0"), "缺报写成 hit=0 是**编造读数**：它会让「要不要做 delta 通道」判断反过来").toBe(false);
  });

  it("PC-2: agentic-loop 每次拿到 usage 都必须留下这一行（接线检查）", () => {
    const code = readFileSync(path.join(ROOT, "src/core/llm/agentic-loop.ts"), "utf8");
    expect(code, "必须 import 唯一实现").toContain('import { formatPromptCacheLog } from "./cache-percent"');
    expect(code, "必须在 usage 落账处调用它（这一行是 O-48 的唯一证据来源）").toContain("console.log(formatPromptCacheLog(usage))");
  });
});

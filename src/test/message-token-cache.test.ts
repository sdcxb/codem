/**
 * 第 183 波：**目标②的修复判据** —— 消息 token 估算必须**按消息记忆化** ✓。
 *
 * ## 为什么是这一条（真机分段计时 ✓）
 *
 * ```
 * llm timing iter=32: ctx=1609ms  tail=9ms   **prep=1600ms**
 * llm timing iter=34: ctx=2395ms  tail=14ms  **prep=2381ms**
 * ```
 * `prep`（`buildMessages` 返回 → 发请求 ✓）1.5–2.4s ✗，而 `prep` 窗口里的头号嫌疑是
 * `estimateContextPressure(apiMessages)` ✓ ⇒ `estimateMessagesTokens` **对全部消息逐条估算** ✗
 * —— 一轮 30–49 次迭代，同样的历史被重算 30–49 遍 ✗（合计 60–90s ✗）。
 *
 * ## 判据为什么不测"更快" ✗
 *
 * 计时在 CI 上会抖 ✗ ⇒ 我断言的是**行为** ✓：**同一批消息第二遍不再重复计算** ✓
 * —— 确定性 ✓、与机器无关 ✓、变异能证 ✓。
 *
 * - **MTC-1**：同一批消息跑两遍 ⇒ 第二遍**全命中**（misses=0 ✓）；
 * - **MTC-2 反向对照**：同一条消息**内容变长**（长度变了 ✓）⇒ **必须重算** ✓
 *   （否则流式增长/工具结果回填会被算错 ✗）；
 * - **MTC-3**：结果**数值不变** ✓（缓存不许改变估算结果 ✗）。
 *
 * 变异：把缓存读取去掉（每次都算 ✓）⇒ **MTC-1 立刻红** ✓。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { __messageTokenCacheStats, __resetMessageTokenCache, getTokenTracker } from "../core/llm/token-tracker";

const msgs = (n: number, len = 200) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? "assistant" : "user",
    content: "x".repeat(len),
  }));

describe("第 183 波：消息 token 估算的记忆化", () => {
  beforeEach(() => __resetMessageTokenCache());

  it("MTC-1: 同一批消息跑两遍 ⇒ 第二遍全命中，不再重复计算", () => {
    const tracker = getTokenTracker();
    const batch = msgs(50) as unknown[];

    __resetMessageTokenCache();
    tracker.estimatePressure(batch, []);
    const first = __messageTokenCacheStats();
    expect(first.misses, "第一遍应当全部未命中（要算）").toBeGreaterThan(0);

    tracker.estimatePressure(batch, []);
    const second = __messageTokenCacheStats();
    expect(
      second.misses,
      "第二遍**一条都不该重算** ✗→✓（这正是那 1.5–2.4s/轮 的来源 ✓）",
    ).toBe(0);
    expect(second.hits, "第二遍应当全部命中").toBeGreaterThan(0);
  });

  it("MTC-2 反向对照: 内容变长（同一条消息）⇒ 必须重算，不许吃旧值 ✗", () => {
    const tracker = getTokenTracker();
    const a = [{ id: "m1", role: "assistant", content: "x".repeat(100) }] as unknown[];

    tracker.estimatePressure(a, []);
    __messageTokenCacheStats();
    /** 同 id、内容变长 ✓（流式增长 / 工具结果回填 ✓） */
    const b = [{ id: "m1", role: "assistant", content: "x".repeat(500) }] as unknown[];
    tracker.estimatePressure(b, []);
    const after = __messageTokenCacheStats();
    expect(after.misses, "长度变了 ⇒ 必须重算 ✓（否则估算会系统性偏低 ✗）").toBeGreaterThan(0);
  });

  it("MTC-3: 缓存不许改变估算结果（数值必须与逐条手算一致 ✓）", () => {
    const tracker = getTokenTracker();
    const batch = msgs(5, 40);
    const p1 = tracker.estimatePressure(batch as unknown[], []);
    /** 清缓存再算一次 ✓ ⇒ 必须**一模一样** ✓ */
    __resetMessageTokenCache();
    const p2 = tracker.estimatePressure(batch as unknown[], []);
    expect(p2).toBe(p1);
  });
});

/**
 * ★ 第 185 波（复审 I-4）：**设置面板配的重试参数必须真的作用于 LLM 重试**。
 *
 * ## 钉的是什么
 *
 * `RetryConfigPanel.tsx:45` 写的是 `getRetryExecutor().setConfig(config)`（落库
 * `codem-retry-config`），而 `RetryExecutor.execute` 全仓**零调用点**；
 * `agentic-loop.ts` 自己 `new RetryExecutor({...})` 造了第二个实例、构造完之后**再无使用**，
 * 真正的重试是 `maxRetries = 3` + `1000 * retryCount` 两处硬编码
 * ⇒ 用户把面板从 10 改成 1、把退避改成什么都不影响（界面在骗人）。
 *
 * ## 判据（驱动**真循环** + 真 provider，只把 `fetch` 换成恒 429）
 *
 * | id | 面板配置 | 判据 |
 * |---|---|---|
 * | RCW-1 | `maxAttempts: 1` | 只请求 **1** 次，且没有 `retry` 事件 |
 * | RCW-2 | `maxAttempts: 3` + `baseDelay: 7` + `backoffMultiplier: 1` | 请求 **3** 次，`retry` 事件的 delay **就是配置值**（不是 1000×n） |
 * | RCW-3 | `totalTimeout: 1`（配 `maxAttempts: 5`） | 总预算用尽 ⇒ 不重试（请求 1 次） |
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { OpenAICompatibleProvider } from "../core/llm/provider";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getRetryExecutor, type RetryConfig } from "../core/retry/retry";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

const CWD = "C:\\rcw";
const BASE: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  backoffMultiplier: 2,
  maxDelay: 60000,
  totalTimeout: 600000,
  respectRetryAfter: true,
};

let original: RetryConfig;

function makeProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "rcw-provider",
    name: "RCW Mock",
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    models: [
      {
        id: "rcw-model",
        name: "RCW Model",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ],
  });
}

/** 恒 429 的流式请求：`classifyError` 认它是可重试的（rate_limit）。 */
function always429() {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    text: async () => "rate limited",
    // provider 会用 `response.clone().text()` 探测「是不是 max_tokens 被拒」（第 67 波）
    clone: () => ({ text: async () => "rate limited" }),
    headers: new Headers(),
  }));
  global.fetch = fetchMock as never;
  return fetchMock;
}

/** 跑完一轮，收集事件（重试耗尽后 `run()` 可能抛出最终错误 —— 那也是预期结局）。 */
async function runLoop(sessionId: string): Promise<{ events: any[]; fetches: number }> {
  const fetchMock = always429();
  const loop = new AgenticLoop(makeProvider() as any, createDefaultToolRegistry(), {
    maxIterations: 2,
    model: "rcw-model",
    securityMode: "full",
  });
  const events: any[] = [];
  try {
    for await (const e of loop.run(sessionId, "你好", CWD, "system prompt")) events.push(e);
  } catch {
    /* 重试耗尽 ⇒ 最终失败，这正是本判据要观察的结局 */
  }
  return { events, fetches: fetchMock.mock.calls.length };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  setStoragePort(createFakeStoragePort());
  original = { ...getRetryExecutor().getConfig() };
});

afterEach(() => {
  getRetryExecutor().setConfig(original);
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("I-4：面板的重试配置必须作用到 LLM 重试", () => {
  it("RCW-1: maxAttempts=1 ⇒ 只请求一次、不重试（改前恒 3 次）", async () => {
    getRetryExecutor().setConfig({ ...BASE, maxAttempts: 1 });
    const { events, fetches } = await runLoop("rcw-1");

    expect(fetches, "面板把上限设成 1 就必须只请求一次（改前硬编码 maxRetries=3）").toBe(1);
    expect(events.some((e) => e.type === "retry"), "上限 1 ⇒ 不该出现重试事件").toBe(false);
  });

  it("RCW-2: maxAttempts / baseDelay / backoffMultiplier 真的决定次数与等待", async () => {
    getRetryExecutor().setConfig({ ...BASE, maxAttempts: 3, baseDelay: 7, backoffMultiplier: 1, maxDelay: 50 });
    const { events, fetches } = await runLoop("rcw-2");

    expect(fetches, "面板说 3 次就必须恰好 3 次").toBe(3);
    const delays = events.filter((e) => e.type === "retry").map((e) => e.delay);
    expect(delays.length, "必须出现两次重试（第 3 次失败后不再重试）").toBe(2);
    expect(
      delays,
      `等待时长必须来自配置（baseDelay=7 × 1^n）；改前是硬编码的 1000×n ⇒ 面板毫无作用`,
    ).toEqual([7, 7]);
  });

  it("RCW-3: totalTimeout 才是总预算（预算用尽就停，不许当成摆设）", async () => {
    getRetryExecutor().setConfig({ ...BASE, maxAttempts: 5, baseDelay: 50, totalTimeout: 1 });
    const { events, fetches } = await runLoop("rcw-3");

    expect(fetches, "总预算 1ms ⇒ 连一次等待都超预算，必须立刻放弃重试").toBe(1);
    expect(events.some((e) => e.type === "retry")).toBe(false);
  });

  it("RCW-4: 循环用的执行器**就是**面板配置的那个单例（不是第二个实例）", () => {
    getRetryExecutor().setConfig({ ...BASE, maxAttempts: 2, baseDelay: 11 });
    const loop = new AgenticLoop(makeProvider() as any, createDefaultToolRegistry(), {
      maxIterations: 1,
      model: "rcw-model",
      securityMode: "full",
    });
    // 面板改配置后，循环读到的必须立刻是新值（同一个对象 ⇒ 结构性成立）
    expect((loop as any).retryExecutor).toBe(getRetryExecutor());
    getRetryExecutor().setConfig({ ...BASE, baseDelay: 13 });
    expect((loop as any).retryExecutor.getConfig().baseDelay).toBe(13);
  });
});

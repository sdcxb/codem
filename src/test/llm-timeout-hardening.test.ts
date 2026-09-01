/**
 * LLM 请求超时加固 — 回归测试
 *
 * 背景：对话4/对话5 卡死根因是 provider.fetch 无请求级超时——
 * 服务端接受连接但不返回时 fetch 永久挂起，主循环卡死、finally 不执行、
 * activeSessions 残留 → 会话永久无响应。
 *
 * 修复（对标 DSH request_timeout_seconds）：
 * 1. complete() 非流式总超时 120s
 * 2. stream() 连接阶段超时 60s（首字节后沿用 idle timeout）
 * 3. LLMEngine.abort() 遍历 loopPool + abortSession(sessionId)
 *
 * 测试覆盖：超时触发、外部 abort 优先、正常请求不受影响、abort 链路。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../core/i18n/lang", () => ({
  getLang: vi.fn().mockReturnValue("zh"),
}));

import { OpenAICompatibleProvider, withRequestTimeout } from "../core/llm/provider";
import type { LLMRequest } from "../core/llm/types";

// 模拟真实 fetch 的 abort 行为：监听 signal，abort 时 reject AbortError。
// 真实 fetch 在 signal abort 时会 reject；mock 若不监听，fetch 会永久 pending。
function hangingFetch() {
  const mockFetch = vi.fn();
  mockFetch.mockImplementation((_url: unknown, opts: any) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    });
  }));
  return mockFetch;
}

function makeProvider() {
  return new OpenAICompatibleProvider({
    id: "test",
    name: "Test",
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    models: [{
      id: "test-model",
      name: "Test Model",
      contextWindow: 128000,
      maxOutputTokens: 4096,
      supportsTools: true,
      supportsStreaming: true,
    }],
  });
}

function makeRequest(overrides?: Partial<LLMRequest>): LLMRequest {
  return {
    model: "test-model",
    messages: [{ id: "system", role: "system", content: "test" }],
    stream: false,
    ...overrides,
  };
}

describe("withRequestTimeout (对标 DSH request deadline)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("超时触发后 signal.aborted=true 且 isTimeout()=true", () => {
    const { signal, cleanup, isTimeout } = withRequestTimeout(undefined, 1000, "test");
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(signal.aborted).toBe(true);
    expect(isTimeout()).toBe(true);
    cleanup();
  });

  it("外部 abort 触发后 isTimeout()=false（不是超时）", () => {
    const external = new AbortController();
    const { signal, cleanup, isTimeout } = withRequestTimeout(external.signal, 1000, "test");
    external.abort();
    expect(signal.aborted).toBe(true);
    expect(isTimeout()).toBe(false);
    cleanup();
  });

  it("cleanup() 后超时不再触发", () => {
    const { signal, cleanup, isTimeout } = withRequestTimeout(undefined, 1000, "test");
    cleanup();
    vi.advanceTimersByTime(5000);
    expect(signal.aborted).toBe(false);
    expect(isTimeout()).toBe(false);
  });
});

describe("OpenAICompatibleProvider.complete() 请求超时", () => {
  let mockFetch: ReturnType<typeof hangingFetch>;
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = hangingFetch();
    global.fetch = mockFetch as any;
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetch 挂起时 120s 后抛超时错误（不再永久等待）", async () => {
    const provider = makeProvider();
    const promise = provider.complete(makeRequest());

    // 119s 内仍在等待（未 settle）
    await vi.advanceTimersByTimeAsync(119_000);
    let settled = false;
    promise.then(() => { settled = true; }).catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    // 过 120s：超时触发 → fetch reject → 抛带诊断的超时错误
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).rejects.toThrow(/timed out after 120000ms/);
  });

  it("正常响应不受超时影响", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "resp-1",
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });

    const provider = makeProvider();
    const resp = await provider.complete(makeRequest());
    expect(resp.content).toBe("hi");
  });

  it("外部 abort 优先于超时（用户取消立即生效，不误报超时）", async () => {
    const external = new AbortController();
    const provider = makeProvider();

    const promise = provider.complete(makeRequest({ abortSignal: external.signal }));
    external.abort();

    await expect(promise).rejects.toThrow();
  });
});

describe("OpenAICompatibleProvider.stream() 连接超时", () => {
  let mockFetch: ReturnType<typeof hangingFetch>;
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = hangingFetch();
    global.fetch = mockFetch as any;
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetch 挂起时 60s 后抛连接超时错误", async () => {
    const provider = makeProvider();
    const gen = provider.stream(makeRequest({ stream: true }));

    const it = gen[Symbol.asyncIterator]();
    const first = it.next();
    // 提前挂 handler，避免 fake timers 推进期间 rejection 触发 unhandledRejection
    const rejection = first.then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_001);
    const err = await rejection;
    expect(String(err)).toMatch(/timed out after 60000ms/);
  });
});

describe("LLMEngine abort 链路", () => {
  it("abortSession 调用对应 session 的 loop.abort；abort() 遍历 loopPool", async () => {
    const { LLMEngine } = await import("../core/llm/index");
    const engine = new LLMEngine();

    // 直接注入 fake loops（loopPool 是运行时可访问的私有字段）
    const loopA = { abort: vi.fn() };
    const loopB = { abort: vi.fn() };
    (engine as any).loopPool.set("session-a", loopA);
    (engine as any).loopPool.set("session-b", loopB);

    // per-session abort：只影响目标 session
    engine.abortSession("session-a");
    expect(loopA.abort).toHaveBeenCalledTimes(1);
    expect(loopB.abort).not.toHaveBeenCalled();

    // 全局 abort：遍历所有 pooled loop
    engine.abort();
    expect(loopB.abort).toHaveBeenCalledTimes(1);

    // 不存在的 session 不抛错
    expect(() => engine.abortSession("session-unknown")).not.toThrow();
  });
});

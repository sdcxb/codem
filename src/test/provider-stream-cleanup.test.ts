/**
 * `OpenAICompatibleProvider.stream()` 的**尾部清理必须无条件执行**（第 44 轮渲染层审计 P2-1）。
 *
 * ## 这条守的是什么
 *
 * 清理（移除 abort 监听、dispose idle 定时器、cancel reader）原来写在生成器体的**末尾**：
 * 只有"正常读到底"才会走到。而下面三条路都不会：
 *   ① idle 超时（`idlePromise` reject）；
 *   ② `reader.read()` 因网络错误 reject；
 *   ③ **消费方在迭代中抛错**（`agentic-loop.ts` 的 `EMPTY_RESPONSE` 重试路径就是这条）。
 *
 * 后果不是"少释放一点内存"，而是：HTTP 响应体/连接一直挂着（reader 从没 `cancel()`）、
 * idle 定时器的 interval 不被 dispose、`idlePromise` 的拒绝无人 await → **未处理拒绝**。
 * 也就是说：**最需要回收资源的那三条路，恰好是唯一不回收的三条路。**
 *
 * ## 为什么用 mock 掉 idle-tracker 的方式测
 *
 * `createIdleTimeout` 是纯内部依赖：mock 掉它之后，"清理有没有执行"就变成可观察的事实
 * （`dispose` 被调用几次），而不必靠等真实时钟。reader 的取消用 `ReadableStream` 的
 * `cancel` 回调观察（那是浏览器/undici 里真正被调用的东西）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const idleSpies = {
  disposed: 0,
  rejected: null as null | ((e: unknown) => void),
};

vi.mock("../core/llm/idle-tracker", () => ({
  createIdleTracker: () => ({
    pulse: () => {},
    isIdle: () => false,
    dispose: () => {},
  }),
  createIdleTimeout: () => {
    let rejectFn: ((e: unknown) => void) | null = null;
    const promise = new Promise<never>((_res, rej) => {
      rejectFn = rej;
    });
    // 让测试能主动触发"空闲超时"
    idleSpies.rejected = (e: unknown) => rejectFn?.(e);
    // 未处理拒绝会让 vitest 报错；这里挂一个空的 catch，真实拒绝仍由 stream() 侧竞争
    promise.catch(() => {});
    return {
      promise,
      pulse: () => {},
      dispose: () => {
        idleSpies.disposed += 1;
      },
    };
  },
}));

vi.mock("../core/i18n/lang", () => ({ getLang: vi.fn().mockReturnValue("zh") }));

import { OpenAICompatibleProvider } from "../core/llm/provider";
import type { LLMRequest } from "../core/llm/types";

/** 造一个"永不结束、但能被 cancel 的"SSE 响应体，并暴露它是否被 cancel 过 */
function controllableStream() {
  const state = { cancelled: false, pulls: 0 };
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      // 先吐一个合法的 SSE 数据帧，让 stream() 进入读循环（已经在流里了，不是连接阶段）
      c.enqueue(new TextEncoder().encode('data: {"id":"m1","choices":[{"delta":{"content":"hi"}}]}\n\n'));
    },
    pull() {
      state.pulls += 1;
      // 之后不再产出任何东西（模拟"服务端不返回了"）
      return new Promise<void>(() => {});
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    state,
    response: {
      ok: true,
      status: 200,
      body,
      text: async () => "",
      headers: new Headers(),
    },
    push: (s: string) => controller?.enqueue(new TextEncoder().encode(s)),
    close: () => controller?.close(),
  };
}

function makeProvider() {
  return new OpenAICompatibleProvider({
    id: "test",
    name: "Test",
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    models: [
      {
        id: "test-model",
        name: "Test Model",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ],
  });
}

function makeRequest(overrides?: Partial<LLMRequest>): LLMRequest {
  return {
    model: "test-model",
    messages: [{ id: "system", role: "system", content: "test" }],
    stream: true,
    ...overrides,
  };
}

beforeEach(() => {
  idleSpies.disposed = 0;
  idleSpies.rejected = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stream() 尾部清理（P2-1）", () => {
  it("PSC-1: **消费方抛错**时 reader 必须被 cancel、idle 定时器必须被 dispose", async () => {
    const s = controllableStream();
    global.fetch = vi.fn(async () => s.response) as never;

    const provider = makeProvider();
    const ac = new AbortController();

    // 消费方在拿到第一个事件之后抛错（等价于 agentic-loop 的 EMPTY_RESPONSE 重试路径）
    const consume = async () => {
      for await (const _ev of provider.stream(makeRequest({ abortSignal: ac.signal }))) {
        throw new Error("消费方抛错（模拟 EMPTY_RESPONSE）");
      }
    };
    await expect(consume()).rejects.toThrow(/消费方抛错/);

    /*
     * 判据一：reader 被 cancel。
     * 改前这里恒为 false —— 清理写在生成器体末尾，消费方抛错时生成器不会走到那里。
     */
    expect(s.state.cancelled, "消费方抛错后 reader 必须被 cancel（否则连接一直挂着）").toBe(true);
    /* 判据二：idle 定时器被 dispose（改前恒为 0） */
    expect(idleSpies.disposed, "清理必须执行：idle 定时器要 dispose").toBeGreaterThan(0);
  });

  it("PSC-2: **idle 超时**时同样要 cancel + dispose（而且会把超时错误抛给消费方）", async () => {
    const s = controllableStream();
    global.fetch = vi.fn(async () => s.response) as never;

    const provider = makeProvider();
    const consume = async () => {
      for await (const _ev of provider.stream(makeRequest())) {
        // 拿到第一个事件后触发空闲超时
        idleSpies.rejected?.(new Error("idle"));
      }
    };
    await expect(consume()).rejects.toThrow(/idle timeout|idle/);

    expect(s.state.cancelled, "空闲超时后 reader 必须被 cancel").toBe(true);
    expect(idleSpies.disposed, "空闲超时后 idle 定时器必须被 dispose（否则 interval 泄漏）").toBeGreaterThan(0);
  });

  it("PSC-3: 正常读完（`[DONE]`）时也照常清理，且不改变事件序列", async () => {
    const s = controllableStream();
    global.fetch = vi.fn(async () => s.response) as never;
    const provider = makeProvider();

    const events: string[] = [];
    const consume = async () => {
      for await (const ev of provider.stream(makeRequest())) {
        events.push(ev.type);
        if (ev.type === "start") {
          s.push('data: {"id":"m1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
          // 关掉流 = `reader.read()` 返回 done → 走"正常读完"这条路（清理原来只在这条路上执行）
          s.close();
        }
      }
    };
    await consume();

    expect(events[0], "start 事件仍然第一个发出（清理改造不许改变事件序列）").toBe("start");
    expect(idleSpies.disposed, "正常读完这条路本来就会清理，改完仍然要清理（不许把正常路径改坏）").toBeGreaterThan(0);
    /*
     * 注意：这里**不断言**底层 `cancel` 回调被调用 —— 流已经 `close()` 之后，
     * `reader.cancel()` 在规范层面是"对已关闭流的空操作"，底层 source 的 `cancel()` 不会被调用。
     * 这正是这个缺陷能在"正常路径"上一直看不出来的原因，也是 PSC-1/PSC-2 必须存在的理由：
     * 只有异常/超时那两条路上，`cancel` 才是真正需要补的那一次。
     */
    expect(s.state.cancelled, "已关闭的流：cancel 是空操作，底层回调不该被调用").toBe(false);
  });
});

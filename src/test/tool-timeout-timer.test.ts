/**
 * 工具执行的超时定时器**不得残留**（第 44 轮渲染层审计 P2-3）。
 *
 * ## 这条守的是什么
 *
 * `Timeout` 原来是这样造的：
 * ```ts
 * private timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(...), ms)); }
 * ```
 * 它被丢进 `Promise.race` —— 而 **race 的败者不会被取消**。于是只要工具在超时前完成
 * （也就是几乎每一次调用），那个 60 秒定时器就一直挂着，到期时产生一次
 * **无人观察的拒绝**：`Unhandled Rejection: Tool execution timed out after 60000ms`。
 * 用户无感，但它会污染日志与诊断导出，并在长时间多工具会话里持续累积。
 *
 * ## 判据为什么用"定时器数量的增量"
 *
 * 直接用 `vi.getTimerCount()` 的绝对值会被**环境里既有的**定时器干扰（import 期、其它模块的
 * 周期性任务）。这里用**增量**：执行前后各取一次，增量必须为 0。
 * 改前这个增量是 1（每个工具调用一个）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  StreamingToolExecutorImpl,
  type StreamingToolCall,
  type ToolExecutorContext,
  type ToolExecutorEvent,
} from "../core/llm/streaming-executor";
import type { ToolCallResult } from "../core/llm/types";

function ctx(): ToolExecutorContext {
  return {
    sessionId: "test-session",
    messageId: "test-msg",
    cwd: "C:/tmp/test",
    messages: [],
    metadata: () => {},
    abort: new AbortController().signal,
  };
}

function okHandler(): (name: string, args: Record<string, unknown>) => Promise<ToolCallResult> {
  return async (name, args) => ({ id: String(args.id ?? name), name, input: args, output: "ok", status: "completed" });
}

function tool(id: string, name = "read"): StreamingToolCall {
  return { id, name, input: { id }, status: "pending" };
}

async function drain(gen: AsyncGenerator<ToolExecutorEvent>): Promise<ToolExecutorEvent[]> {
  const out: ToolExecutorEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("工具超时定时器（P2-3）：用完必须取消", () => {
  it("TTO-1: 单个工具在超时前完成 → 不得留下任何待决定时器", async () => {
    vi.useFakeTimers();
    const executor = new StreamingToolExecutorImpl({ toolTimeout: 60_000, maxConcurrent: 5, concurrencySafeTools: ["read"] });

    const before = vi.getTimerCount();
    const events = await drain(executor.execute([tool("t1")], ctx(), okHandler()));
    const after = vi.getTimerCount();

    expect(events.some((e) => e.type === "tool_complete"), "工具应当正常完成（这条用例不能靠失败来通过）").toBe(true);
    expect(
      after - before,
      "工具正常完成后不得残留超时定时器（改前这里恒为 1 → 60 秒后一次无人观察的拒绝）",
    ).toBe(0);
  });

  it("TTO-2: 并发一批工具全部提前完成 → 同样一个定时器都不许留", async () => {
    vi.useFakeTimers();
    const executor = new StreamingToolExecutorImpl({
      toolTimeout: 60_000,
      maxConcurrent: 5,
      concurrencySafeTools: ["read"],
    });

    const before = vi.getTimerCount();
    const events = await drain(
      executor.execute([tool("t1"), tool("t2"), tool("t3")], ctx(), okHandler()),
    );
    const after = vi.getTimerCount();

    expect(events.filter((e) => e.type === "tool_complete")).toHaveLength(3);
    expect(after - before, "每个提前完成的工具都会留一个定时器（3 个工具 = 3 个残留）").toBe(0);
  });

  it("TTO-3: 反向保证 —— 工具真的挂住时，超时**仍然**要触发（别把守卫改没了）", async () => {
    const executor = new StreamingToolExecutorImpl({
      toolTimeout: 40, // 40ms：让真实时钟也能很快跑完这条用例
      maxConcurrent: 5,
      concurrencySafeTools: ["read"],
    });

    const hang = () => new Promise<ToolCallResult>(() => {}); // 永不 resolve
    const events = await drain(executor.execute([tool("t1")], ctx(), hang));

    const err = events.find((e) => e.type === "tool_error");
    expect(err, "挂住的工具必须被超时终止，而不是永远等下去").toBeTruthy();
    expect(String((err as { error?: string }).error)).toMatch(/timed out after 40ms/);
  });
});

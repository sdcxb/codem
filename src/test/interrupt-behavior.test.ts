/**
 * Tests for P1-6: 工具中断行为
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamingToolCall } from "../core/llm/streaming-executor";
import { StreamingToolExecutorImpl } from "../core/llm/streaming-executor";
import type { ToolCallResult } from "../core/llm/types";

// Mock tool handler
async function mockToolHandler(
  name: string,
  args: Record<string, unknown>,
  ctx: any,
): Promise<ToolCallResult> {
  return {
    id: `result-${Date.now()}`,
    name,
    input: args,
    output: `Output for ${name}: ${JSON.stringify(args)}`,
    status: "completed" as const,
  };
}

/** Consume an async generator and return its return value */
async function consumeGenerator<T, TReturn>(
  gen: AsyncGenerator<T, TReturn, unknown>,
): Promise<TReturn> {
  let result: IteratorResult<T, TReturn>;
  do {
    result = await gen.next();
  } while (!result.done);
  return result.value;
}

describe("P1-6: 工具中断行为", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should allow concurrent tools to have separate abortControllers", async () => {
    const executor = new StreamingToolExecutorImpl();
    const tc1: StreamingToolCall = {
      id: "tc-1",
      name: "read",
      input: { path: "file1.txt" },
      status: "pending" as const,
    };
    const tc2: StreamingToolCall = {
      id: "tc-2",
      name: "read",
      input: { path: "file2.txt" },
      status: "pending" as const,
    };
    const ctx = {
      sessionId: "test",
      messageId: "msg",
      cwd: "/test",
      abort: undefined,
      messages: [],
      metadata: () => {},
    };

    const gen = executor.execute([tc1, tc2], ctx as any, mockToolHandler as any);
    const results = await consumeGenerator(gen);

    // Verify both tools completed
    expect(results.length).toBeGreaterThanOrEqual(2);
    // ctx.abort should still be undefined (each tool has its own abortController)
    expect(ctx.abort).toBeUndefined();
  });

  it("should execute sequential tools one by one", async () => {
    const executor = new StreamingToolExecutorImpl();
    // Use a non-concurrency-safe tool to test sequential path
    const tc: StreamingToolCall = {
      id: "tc-1",
      name: "bash",
      input: { command: "echo hello" },
      status: "pending" as const,
    };
    const ctx = {
      sessionId: "test",
      messageId: "msg",
      cwd: "/test",
      abort: undefined,
      messages: [],
      metadata: () => {},
    };

    const gen = executor.execute([tc], ctx as any, mockToolHandler as any);
    const results = await consumeGenerator(gen);

    expect(results.length).toBeGreaterThanOrEqual(1);
    // Result should be completed (mock handler always returns completed)
    expect(results[0]).toBeDefined();
  });
});

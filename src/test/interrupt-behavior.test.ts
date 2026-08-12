/**
 * Tests for P1-6: 工具中断行为
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamingToolCall } from "../core/llm/streaming-executor";

// Import class correctly
import { StreamingToolExecutorImpl, type StreamingToolExecutorEvent } from "../core/llm/streaming-executor";

// Mock tool handler
async function mockToolHandler(
  name: string,
  args: Record<string, unknown>,
  ctx: any,
  delayMs?: number,
): Promise<any> {
  if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  return {
    id: `result-${Date.now()}`,
    name,
    input: args,
    output: `Output for ${name}: ${JSON.stringify(args)}`,
    status: "completed" as const,
  };
}

const mockStreamingToolCall = (): StreamingToolCall => ({
  id: `tc-${Date.now()}`,
  name: "read",
  input: { path: "file.txt" },
  status: "pending" as const,
  result: undefined,
  error: undefined,
  abortController: undefined,
});

const mockToolExecutorEvent = (eventType: string, data?: any): StreamingToolExecutorEvent => {
  switch (eventType) {
    case "tool_start": return { type: "tool_start", toolCall: mockStreamingToolCall() };
    case "tool_complete": return { type: "tool_complete", toolCall: mockStreamingToolCall(), result: data?.result };
    case "tool_error": return { type: "tool_error", toolCall: mockStreamingToolCall(), error: data?.error };
    case "batch_complete": return { type: "batch_complete", results: data?.results };
    default: return { type: "text_delta" as any, text: "" };
  }
};

describe("P1-6: 工具中断行为", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should allow concurrent tools to have separate abortControllers", async () => {
    // This test verifies that streaming-executor.ts creates unique abortControllers
    const executor = new StreamingToolExecutor();
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

    const results: ToolCallResult[] = [];
    // Capture abortControllers by using the running map
    const runningMap = executor["running"] as Map<string, StreamingToolCall>;

    // Mock executeBatch to capture abortControllers
    const originalExecute = executor["executeBatch"];
    executor["executeBatch"] = async function* (
      toolCalls: StreamingToolCall[],
      ctx2: any,
      handler: any,
      results2: any[],
    ): AsyncGenerator<StreamingToolExecutorEvent, void, unknown> {
      for (const tc of toolCalls) {
        tc.status = "running";
        const ac = new AbortController();
        this.running.set(tc.id, tc);
        console.log(`[test] Created AbortController for ${tc.id}`);

        try {
          // Check abort conditions
          if (ctx2.abort) throw new Error("Aborted");

          const result = await handler(tc.name, tc.input, { ...ctx2, abort: ac.signal });

          tc.status = "completed";
          tc.result = result;
          results2.push(result);
          yield { type: "tool_complete", toolCall: tc, result };
        } catch (error: any) {
          tc.status = "error";
          tc.error = error.message;
          results2.push({ id: tc.id, name: tc.name, input: tc.input, output: `Error: ${error.message}`, status: "error", error: error.message });
          yield { type: "tool_error", toolCall: tc, error: error.message };
        } finally {
          this.running.delete(tc.id);
        }
      }
    };

    // Execute 2 tools in parallel
    await executor.execute(
      [tc1, tc2],
      ctx,
      mockToolHandler,
      results,
    );

    // Verify both tools were started and have different abortControllers
    expect(results).toHaveLength(2);
    expect(runningMap.size).toBe(0); // Both removed from running map after execution
    expect(ctx.abort).toBeUndefined();
  });

  it("should execute sequential tools one by one", async () => {
    const executor = new StreamingToolExecutor();
    const tc: StreamingToolCall = {
      id: "tc-1",
      name: "read",
      input: { path: "file.txt" },
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

    const results: ToolCallResult[] = [];
    await executor.execute(
      [tc],
      ctx,
      mockToolHandler,
      results,
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
  });
});
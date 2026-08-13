/**
 * Tests for P0-3: Micro-compact
 */
import { describe, it, expect } from "vitest";
import { microCompact, isAlreadyMicroCompacted } from "../core/llm/micro-compact";

// Helper: build LLM-style messages with tool results
function buildMessagesWithToolResults(count: number, toolName: string, resultSize: number): any[] {
  const msgs: any[] = [];
  for (let i = 0; i < count; i++) {
    // Assistant message with tool_call
    const toolCallId = `tc-${i}`;
    msgs.push({
      role: "assistant",
      id: `asst-${i}`,
      content: `Let me check that.`,
      tool_calls: [{
        id: toolCallId,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify({ path: `file-${i}.ts` }) },
      }],
    });
    // Tool result
    msgs.push({
      role: "tool",
      toolCallId,
      content: "x".repeat(resultSize),
    });
  }
  return msgs;
}

describe("P0-3: Micro-compact", () => {
  it("should not compact when messages are too few (< 12)", () => {
    const msgs = buildMessagesWithToolResults(3, "read", 2000);
    const result = microCompact(msgs);
    expect(result.compactedCount).toBe(0);
    expect(result.charsSaved).toBe(0);
    expect(result.messages).toBe(msgs); // Same reference
  });

  it("should compact old tool results for compactable tools", () => {
    // 10 tool calls = 20 messages (assistant + tool each), threshold is 12
    const msgs = buildMessagesWithToolResults(10, "read", 2000);
    const result = microCompact(msgs);
    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.charsSaved).toBeGreaterThan(0);
    // Original messages array should NOT be modified (new array returned)
    expect(result.messages).not.toBe(msgs);
    // Original messages should still have full content
    const originalToolMsg = msgs.find(m => m.role === "tool");
    expect(originalToolMsg.content.length).toBe(2000);
  });

  it("should NOT compact recent tool results (last 10 messages)", () => {
    const msgs = buildMessagesWithToolResults(10, "read", 2000);
    const result = microCompact(msgs);
    // Check that the last few tool results are NOT compacted
    const lastToolMsg = result.messages[result.messages.length - 1];
    expect(lastToolMsg.role).toBe("tool");
    expect(lastToolMsg.content.length).toBe(2000); // Full content preserved
  });

  it("should NOT compact results from non-compactable tools", () => {
    const msgs = buildMessagesWithToolResults(10, "write", 2000);
    const result = microCompact(msgs);
    expect(result.compactedCount).toBe(0);
  });

  it("should NOT compact results from spawn_subagent", () => {
    const msgs = buildMessagesWithToolResults(10, "spawn_subagent", 2000);
    const result = microCompact(msgs);
    expect(result.compactedCount).toBe(0);
  });

  it("should NOT compact results from wait_for_subagent", () => {
    const msgs = buildMessagesWithToolResults(10, "wait_for_subagent", 2000);
    const result = microCompact(msgs);
    expect(result.compactedCount).toBe(0);
  });

  it("should NOT compact short results (< 500 chars)", () => {
    const msgs = buildMessagesWithToolResults(10, "read", 100); // Small results
    const result = microCompact(msgs);
    expect(result.compactedCount).toBe(0);
  });

  it("should replace compacted content with placeholder", () => {
    const msgs = buildMessagesWithToolResults(10, "bash", 5000);
    const result = microCompact(msgs);
    const compactedMsg = result.messages.find(
      m => m.role === "tool" && m.content.startsWith("[Tool result compacted"),
    );
    expect(compactedMsg).toBeDefined();
    expect(compactedMsg!.content).toContain("bash");
    expect(compactedMsg!.content).toContain("chars");
    expect(compactedMsg!.content).toContain("preview");
  });

  it("should detect already compacted messages", () => {
    const msgs = buildMessagesWithToolResults(10, "read", 2000);
    const firstResult = microCompact(msgs);
    expect(isAlreadyMicroCompacted(firstResult.messages)).toBe(true);
    expect(isAlreadyMicroCompacted(msgs)).toBe(false);
  });

  it("should preserve tool call structure (assistant tool_calls remain)", () => {
    const msgs = buildMessagesWithToolResults(10, "read", 2000);
    const result = microCompact(msgs);
    // Every tool result should still have a preceding assistant with tool_calls
    for (let i = 0; i < result.messages.length; i++) {
      if (result.messages[i].role === "tool") {
        const prev = result.messages[i - 1];
        expect(prev.role).toBe("assistant");
        expect(prev.tool_calls).toBeDefined();
        expect(prev.tool_calls.length).toBeGreaterThan(0);
      }
    }
  });

  it("should compact lsp tool results", () => {
    const msgs = buildMessagesWithToolResults(10, "lsp", 2000);
    const result = microCompact(msgs);
    expect(result.compactedCount).toBeGreaterThan(0);
  });

  it("should not compact show_todo results", () => {
    const msgs = buildMessagesWithToolResults(10, "show_todo", 2000);
    const result = microCompact(msgs);
    expect(result.compactedCount).toBe(0);
  });

  it("should not compact ask_clarification results", () => {
    const msgs = buildMessagesWithToolResults(10, "ask_clarification", 2000);
    const result = microCompact(msgs);
    expect(result.compactedCount).toBe(0);
  });
});

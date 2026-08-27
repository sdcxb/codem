/**
 * Tests for P1-5: Tool Result Disk Persistence
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { maybePersistToolResult, NEVER_PERSIST_TOOLS, DEFAULT_MAX_RESULT_SIZE_CHARS } from "../core/llm/tool-result-storage";

// Mock file-api writeFile
vi.mock("../core/file-api", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe("P1-5: Tool Result Disk Persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("maybePersistToolResult", () => {
    it("should not persist small results (< 50KB)", async () => {
      const result = await maybePersistToolResult(
        "bash",
        "small output",
        "session-123",
        "C:/project",
      );
      expect(result.persisted).toBe(false);
      expect(result.output).toBe("small output");
      expect(result.filePath).toBeUndefined();
    });

    it("should persist large results (> 50KB)", async () => {
      const largeOutput = "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1);
      const result = await maybePersistToolResult(
        "bash",
        largeOutput,
        "session-123",
        "C:/project",
      );
      expect(result.persisted).toBe(true);
      expect(result.output).toContain("<persisted-output>");
      expect(result.output).toContain("Output too large");
      expect(result.output).toContain("Preview");
      expect(result.output).toContain("Full output file:");
      expect(result.output).toContain("C:/project/.codem-tool-results/session-123/");
      expect(result.filePath).toBeDefined();
      // Preview should contain the first 500 chars
      expect(result.output).toContain("x".repeat(500));
    });

    it("should NOT persist when maxResultSizeChars is Infinity", async () => {
      const largeOutput = "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1000);
      const result = await maybePersistToolResult(
        "read",
        largeOutput,
        "session-123",
        "C:/project",
        Infinity,
      );
      expect(result.persisted).toBe(false);
      expect(result.output).toBe(largeOutput);
    });

    it("should respect custom maxResultSizeChars", async () => {
      const mediumOutput = "x".repeat(2000);
      const result = await maybePersistToolResult(
        "bash",
        mediumOutput,
        "session-123",
        "C:/project",
        1000, // custom threshold: 1000 chars
      );
      expect(result.persisted).toBe(true);
      expect(result.output).toContain("<persisted-output>");
    });

    it("should fall back to truncation if disk write fails", async () => {
      const { writeFile } = await import("../core/file-api");
      (writeFile as any).mockRejectedValueOnce(new Error("Disk full"));

      const largeOutput = "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1);
      const result = await maybePersistToolResult(
        "bash",
        largeOutput,
        "session-123",
        "C:/project",
      );
      expect(result.persisted).toBe(false);
      expect(result.output).toContain("... (truncated, output too large, disk persistence failed)");
    });

    it("should include file path in persisted output so LLM can read it back", async () => {
      const largeOutput = "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1);
      const result = await maybePersistToolResult(
        "bash",
        largeOutput,
        "session-456",
        "C:/my-project",
      );
      expect(result.persisted).toBe(true);
      expect(result.output).toContain("Use the 'read' tool with this path");
      expect(result.output).toContain("C:/my-project/.codem-tool-results/session-456/");
    });
  });

  describe("NEVER_PERSIST_TOOLS", () => {
    it("should include 'read' tool to prevent infinite loops", () => {
      expect(NEVER_PERSIST_TOOLS.has("read")).toBe(true);
    });

    it("should include tools that return task IDs", () => {
      expect(NEVER_PERSIST_TOOLS.has("subagent")).toBe(true);
      expect(NEVER_PERSIST_TOOLS.has("send_message")).toBe(true);
      expect(NEVER_PERSIST_TOOLS.has("delegate_to_session")).toBe(true);
      expect(NEVER_PERSIST_TOOLS.has("wait_for_delegation")).toBe(true);
    });

    it("should include 'show_todo' tool", () => {
      expect(NEVER_PERSIST_TOOLS.has("show_todo")).toBe(true);
    });
  });
});

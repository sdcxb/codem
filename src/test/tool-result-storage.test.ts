/**
 * Tests for P1-5: Tool Result Disk Persistence
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  maybePersistToolResult,
  shouldPersistResult,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
} from "../core/llm/tool-result-storage";
import { createDefaultToolRegistry } from "../core/llm/tools";
import {
  createSubagentTool,
  createSendMessageTool,
  createListAgentsTool,
  createReportTool,
} from "../core/llm/tools/subagent-tools";

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

    /**
     * 第 110 波：**大块输出的预览必须带上尾部**。
     *
     * 证据（真实仓库档评测）：agent 跑 `npx vitest run` 大套件时输出远超 50KB 阈值，
     * 而旧实现只把**前 500 字符**给模型 —— vitest 的汇总行（`Tests 404 passed`）在**尾部**，
     * 于是模型看不到自己那次验证的结论。同一任务里它"红过的判据文件再没复跑"，
     * 与"看不到结果"一致；这同时会让模型**不敢**跑大套件（跑了也读不到结论）。
     *
     * 变异自证：把尾部那段删掉（只留头）⇒ 本用例立刻红。
     */
    it("大块输出的预览必须包含**尾部**（否则模型看不到测试汇总/构建结论）", async () => {
      const summary = "\n Test Files  1 failed | 12 passed (13)\n      Tests  2 failed | 404 passed (406)\n";
      const largeOutput = "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1000) + summary;
      const result = await maybePersistToolResult("bash", largeOutput, "session-123", "C:/project");

      expect(result.persisted).toBe(true);
      expect(result.output, "尾部必须保留：汇总行就在最后").toContain("Tests  2 failed | 404 passed (406)");
      expect(result.output, "要标出中间省略了多少").toMatch(/中间省略 [\d,]+ 字符/);
      // 头仍然保留（模型需要看到命令开头/第一批输出）
      expect(result.output).toContain("x".repeat(500));
    });

    it("预览不会因为加尾巴而无限膨胀（头 500 + 尾 2000 为界）", async () => {
      const largeOutput = "y".repeat(500_000);
      const result = await maybePersistToolResult("bash", largeOutput, "session-123", "C:/project");
      expect(result.persisted).toBe(true);
      // 预览体本身（去掉固定说明行）不应超过 头+尾+标记 的量级
      const preview = result.output;
      expect(preview.length, `预览长度 ${preview.length} 过大`).toBeLessThan(6000);
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

  describe("落盘豁免：主判据是契约，名字表只兜底", () => {
    // 第 120 轮：判据从「名字在不在 NEVER_PERSIST_TOOLS 里」改成
    // 「工具契约的 persistResult」。名字表只剩**运行时注册工具**的兜底，
    // 所以这里改成断言契约 —— 那才是现在真正生效的判据。
    it("should include 'read' tool to prevent infinite loops", () => {
      const registry = createDefaultToolRegistry();
      expect(registry.getContract("read").persistResult).toBe(false);
      expect(shouldPersistResult("read", (n) => registry.getContract(n))).toBe(false);
    });

    it("should include tools that return task IDs", () => {
      // 这几个不在默认 registry 里（由 LLMEngine 在 subagent 就绪后注册），
      // 直接建工具验契约
      const byId: Record<string, () => { contract?: { persistResult?: boolean } }> = {
        subagent: createSubagentTool,
        send_message: createSendMessageTool,
        list_agents: createListAgentsTool,
        report: createReportTool,
      };
      for (const [id, factory] of Object.entries(byId)) {
        expect(factory().contract?.persistResult, `${id} 必须声明 persistResult: false`).toBe(
          false,
        );
      }
      // 兜底表仍覆盖不在本仓注册路径上的委派工具
      expect(shouldPersistResult("delegate_to_session")).toBe(false);
      expect(shouldPersistResult("wait_for_delegation")).toBe(false);

      // 反向对照：普通工具仍要落盘（否则「豁免」等于没有边界）
      const registry = createDefaultToolRegistry();
      expect(shouldPersistResult("write", (n) => registry.getContract(n))).toBe(true);
    });

    it("should include 'show_todo' tool", () => {
      const registry = createDefaultToolRegistry();
      expect(registry.getContract("show_todo").persistResult).toBe(false);
    });
  });
});

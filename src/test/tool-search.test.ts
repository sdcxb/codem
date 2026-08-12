/**
 * Tests for P0-2: ToolSearch — Deferred tool loading
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDefaultToolRegistry, ToolRegistry } from "../core/llm/tools";
import { createToolSearchTool } from "../core/llm/tools/tool-search";
import type { ToolContext } from "../core/llm/tools";

// Mock file-api for registry creation
vi.mock("../core/file-api", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  executeCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  globSearch: vi.fn().mockResolvedValue([]),
  grepSearch: vi.fn().mockResolvedValue([]),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

// Mock settings
vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn().mockReturnValue(null),
  getSettingJSON: vi.fn().mockReturnValue(null),
  setSettingJSON: vi.fn(),
}));

// Mock database
vi.mock("../core/storage/database", () => ({
  getDatabase: () => ({
    run: vi.fn(),
    exec: vi.fn().mockReturnValue([]),
  }),
  persistDatabase: vi.fn(),
  saveMessage: vi.fn(),
  listMessages: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessagesByIds: vi.fn(),
  messagesToLLMMessages: vi.fn().mockReturnValue([]),
}));

const mockCtx: ToolContext = {
  sessionId: "test-session",
  messageId: "test-msg",
  cwd: "/test",
  abort: undefined,
  messages: [],
  metadata: () => {},
};

describe("P0-2: ToolSearch — Deferred tool loading", () => {

  describe("ToolRegistry deferred tool support", () => {
    let registry: ToolRegistry;

    beforeEach(() => {
      vi.clearAllMocks();
      registry = createDefaultToolRegistry();
    });

    it("should have tool_search registered", () => {
      const tool = registry.get("tool_search");
      expect(tool).toBeDefined();
      expect(tool!.id).toBe("tool_search");
    });

    it("should have lsp tool marked as shouldDefer=true", () => {
      const tool = registry.get("lsp");
      expect(tool).toBeDefined();
      expect(tool!.shouldDefer).toBe(true);
      expect(tool!.searchHint).toBeDefined();
      expect(tool!.searchHint!.length).toBeGreaterThan(10);
    });

    it("getCoreDefinitions should exclude deferred tools", () => {
      const coreDefs = registry.getCoreDefinitions();
      const names = coreDefs.map((d) => d.name);
      expect(names).not.toContain("lsp");
      // tool_search itself should be in core definitions
      expect(names).toContain("tool_search");
    });

    it("getCoreDefinitions should include all non-deferred tools", () => {
      const coreDefs = registry.getCoreDefinitions();
      const names = coreDefs.map((d) => d.name);
      expect(names).toContain("read");
      expect(names).toContain("write");
      expect(names).toContain("bash");
      expect(names).toContain("grep");
      expect(names).toContain("glob");
    });

    it("getDeferredDefinitions should only return deferred tools", () => {
      const deferred = registry.getDeferredDefinitions();
      expect(deferred.length).toBeGreaterThanOrEqual(1);
      const names = deferred.map((d) => d.name);
      expect(names).toContain("lsp");
      // Core tools should NOT be in deferred list
      expect(names).not.toContain("read");
      expect(names).not.toContain("bash");
    });

    it("getDeferredDefinitions should return searchHint", () => {
      const deferred = registry.getDeferredDefinitions();
      const lsp = deferred.find((d) => d.name === "lsp");
      expect(lsp).toBeDefined();
      expect(lsp!.searchHint.toLowerCase()).toContain("code navigation");
    });

    it("getDeferredDefinition should return full schema for deferred tool", () => {
      const def = registry.getDeferredDefinition("lsp");
      expect(def).toBeDefined();
      expect(def!.name).toBe("lsp");
      expect(def!.description).toContain("Language Server Protocol");
      expect(def!.parameters).toBeDefined();
    });

    it("getDeferredDefinition should return undefined for non-deferred tool", () => {
      const def = registry.getDeferredDefinition("read");
      expect(def).toBeUndefined();
    });

    it("getDeferredDefinition should return undefined for unknown tool", () => {
      const def = registry.getDeferredDefinition("nonexistent");
      expect(def).toBeUndefined();
    });

    it("getDefinitions should still return ALL tools (backward compat)", () => {
      const allDefs = registry.getDefinitions();
      const names = allDefs.map((d) => d.name);
      // Both core and deferred should be present
      expect(names).toContain("read");
      expect(names).toContain("lsp");
      expect(names).toContain("tool_search");
    });
  });

  describe("tool_search execution", () => {
    let registry: ToolRegistry;

    beforeEach(() => {
      vi.clearAllMocks();
      registry = createDefaultToolRegistry();
    });

    it("should return full schema for exact name match", async () => {
      const tool = createToolSearchTool(registry);
      const result = await tool.execute({ query: "lsp" }, mockCtx);
      expect(result.output).toContain("lsp");
      expect(result.output).toContain("schema loaded successfully");
      expect(result.output).toContain("Language Server Protocol");
    });

    it("should support select: prefix syntax", async () => {
      const tool = createToolSearchTool(registry);
      const result = await tool.execute({ query: "select:lsp" }, mockCtx);
      expect(result.output).toContain("schema loaded successfully");
    });

    it("should be case-insensitive for tool name", async () => {
      const tool = createToolSearchTool(registry);
      const result = await tool.execute({ query: "LSP" }, mockCtx);
      expect(result.output).toContain("schema loaded successfully");
    });

    it("should return error for empty query", async () => {
      const tool = createToolSearchTool(registry);
      const result = await tool.execute({ query: "" }, mockCtx);
      expect(result.output).toContain("Error");
      expect(result.output).toContain("required");
    });

    it("should list all deferred tools when no match found", async () => {
      const tool = createToolSearchTool(registry);
      const result = await tool.execute({ query: "nonexistent_tool" }, mockCtx);
      expect(result.output).toContain("No deferred tool matched");
      expect(result.output).toContain("lsp");
    });

    it("should support fuzzy search by keyword", async () => {
      const tool = createToolSearchTool(registry);
      const result = await tool.execute({ query: "code navigation" }, mockCtx);
      // Should find lsp by keyword match in searchHint
      expect(result.output).toContain("lsp");
    });
  });

  describe("Deferred tool hint injection", () => {
    it("should have lsp tool with searchHint containing useful keywords", () => {
      const registry = createDefaultToolRegistry();
      const lsp = registry.get("lsp");
      expect(lsp!.searchHint.toLowerCase()).toContain("code navigation");
      expect(lsp!.searchHint.toLowerCase()).toContain("definitions");
      expect(lsp!.searchHint.toLowerCase()).toContain("references");
    });

    it("tool_search should NOT be deferred (it's always available)", () => {
      const registry = createDefaultToolRegistry();
      const toolSearch = registry.get("tool_search");
      expect(toolSearch!.shouldDefer).toBeFalsy();
    });
  });
});

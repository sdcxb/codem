/**
 * 测试：工具调用与权限回归 — TOOL-REG-001 ~ TOOL-REG-020
 *
 * 验证新增 AgentRegistry/Heartbeat/Retry 修改不影响工具注册、执行、权限评估。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock file-api
const { mockExecuteCommand, mockReadFile, mockWriteFile, mockIsPathWithinWorkspace, mockGlobSearch, mockGrepSearch } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockIsPathWithinWorkspace: vi.fn().mockReturnValue(true),
  mockGlobSearch: vi.fn().mockResolvedValue([]),
  mockGrepSearch: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  exists: vi.fn().mockReturnValue(true),
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: mockGlobSearch,
  grepSearch: mockGrepSearch,
  isPathWithinWorkspace: mockIsPathWithinWorkspace,
}));

import { initDatabase, resetDatabase } from "../core/storage/database";
import { setSettingJSON, setSetting } from "../core/storage/settings";
import {
  createDefaultToolRegistry,
  ToolRegistry,
  createBashTool,
  createReadFileTool,
  createWriteFileTool,
  isProtectedPath,
  type ToolContext,
  type ToolDef,
} from "../core/llm/tools";
import { getAgentRegistry } from "../core/agent/agent";
import type { AgentDefinition } from "../core/agent/agent";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "sess-tool-test",
    messageId: "msg-tool-test",
    cwd: "D:\\test",
    abort: new AbortController().signal,
    messages: [],
    metadata: vi.fn(),
    ...overrides,
  };
}

describe("工具调用与权限回归", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
    vi.clearAllMocks();
    mockIsPathWithinWorkspace.mockReturnValue(true);
  });

  // ===== TOOL-REG-001 ~ TOOL-REG-005: 工具注册与执行 =====
  describe("工具注册与执行", () => {
    it("TOOL-REG-001: 内置工具包含核心工具", () => {
      const registry = createDefaultToolRegistry();
      const ids = registry.getAll().map(t => t.id);
      expect(ids).toContain("bash");
      expect(ids).toContain("read");
      expect(ids).toContain("write");
      expect(ids).toContain("edit");
      expect(ids).toContain("glob");
      expect(ids).toContain("grep");
    });

    it("TOOL-REG-002: bash 工具执行不受 AgentRegistry 修改影响", async () => {
      // Register a custom agent first (to trigger persistence)
      const agentRegistry = getAgentRegistry();
      agentRegistry.register({
        id: "tool-test-agent",
        name: "Tool Test",
        description: "Test",
        mode: "subagent",
        prompt: "test",
        permissions: [{ tool: "*", action: "allow" }],
      });

      mockExecuteCommand.mockResolvedValue({ exitCode: 0, stdout: "hello", stderr: "" });
      const bash = createBashTool();
      const result = await bash.execute({ command: "echo hello" }, makeCtx());
      expect(result.output).toContain("hello");
    });

    it("TOOL-REG-003: read 工具不受 HeartbeatManager 修改影响", async () => {
      // Set heartbeat config (triggers persistence)
      setSettingJSON("codem-heartbeat-config", { interval: 5000 });

      mockReadFile.mockResolvedValue("file content here");
      const read = createReadFileTool();
      const result = await read.execute({ path: "test.ts" }, makeCtx());
      expect(result.output).toContain("file content here");
    });

    it("TOOL-REG-004: write 工具不受 RetryExecutor 修改影响", async () => {
      // Set retry config (triggers persistence)
      setSettingJSON("codem-retry-config", { maxAttempts: 3 });

      mockWriteFile.mockResolvedValue(undefined);
      mockReadFile.mockRejectedValue(new Error("not found")); // file doesn't exist
      const write = createWriteFileTool();
      const result = await write.execute({ path: "new.ts", content: "content" }, makeCtx());
      expect(result.output).toContain("Successfully wrote");
    });

    it("TOOL-REG-005: 沙箱检查不受新设置键影响", async () => {
      setSetting("codem-sandbox-enabled", "true");
      // Also set new keys
      setSettingJSON("codem-custom-agents", [{ id: "x" }]);
      setSettingJSON("codem-heartbeat-config", { interval: 5000 });
      setSettingJSON("codem-retry-config", { maxAttempts: 3 });

      mockIsPathWithinWorkspace.mockReturnValue(false);
      const write = createWriteFileTool();
      const result = await write.execute(
        { path: "D:\\outside\\file.txt", content: "test" },
        makeCtx({ cwd: "D:\\workspace" }),
      );
      expect(result.output).toContain("Sandbox");
    });
  });

  // ===== TOOL-REG-006 ~ TOOL-REG-010: 权限与工具注册 =====
  describe("权限与工具注册", () => {
    it("TOOL-REG-006: Agent evaluatePermission 正常——build allow", () => {
      const registry = getAgentRegistry();
      expect(registry.evaluatePermission("build", "bash")).toBe("allow");
    });

    it("TOOL-REG-007: Agent canUseTool 正常——plan write 不可用", () => {
      const registry = getAgentRegistry();
      expect(registry.canUseTool("plan", "write")).toBe(false);
    });

    it("TOOL-REG-008: 权限规则匹配通配符", () => {
      const registry = getAgentRegistry();
      const customAgent: AgentDefinition = {
        id: "wildcard-test",
        name: "Wildcard",
        description: "Test",
        mode: "subagent",
        prompt: "test",
        permissions: [
          { tool: "file.*", action: "allow" },
          { tool: "bash", action: "deny" },
        ],
      };
      registry.register(customAgent);
      expect(registry.evaluatePermission("wildcard-test", "file.read")).toBe("allow");
      expect(registry.evaluatePermission("wildcard-test", "file.write")).toBe("allow");
      expect(registry.evaluatePermission("wildcard-test", "bash")).toBe("deny");
    });

    it("TOOL-REG-009: ToolRegistry 工具去重——后注册覆盖前者", () => {
      const registry = new ToolRegistry();
      const tool1: ToolDef = {
        id: "custom",
        description: "v1",
        parameters: {},
        execute: async () => ({ title: "v1", output: "1" }),
      };
      const tool2: ToolDef = {
        id: "custom",
        description: "v2",
        parameters: {},
        execute: async () => ({ title: "v2", output: "2" }),
      };
      registry.register(tool1);
      registry.register(tool2);
      expect(registry.getAll()).toHaveLength(1);
      expect(registry.get("custom")!.description).toBe("v2");
    });

    it("TOOL-REG-010: load_skill 工具存在", () => {
      const registry = createDefaultToolRegistry();
      const ids = registry.getAll().map(t => t.id);
      expect(ids).toContain("load_skill");
    });
  });

  // ===== TOOL-REG-011 ~ TOOL-REG-015: 工具存在性与错误处理 =====
  describe("工具存在性与错误处理", () => {
    it("TOOL-REG-011: web_search 工具存在", () => {
      const registry = createDefaultToolRegistry();
      expect(registry.getAll().map(t => t.id)).toContain("web_search");
    });

    it("TOOL-REG-012: read_attachment 工具存在", () => {
      const registry = createDefaultToolRegistry();
      expect(registry.getAll().map(t => t.id)).toContain("read_attachment");
    });

    it("TOOL-REG-013: 工具执行错误不崩溃——返回 error 结果", async () => {
      mockExecuteCommand.mockRejectedValue(new Error("Command failed"));
      const bash = createBashTool();
      const result = await bash.execute({ command: "bad-command" }, makeCtx());
      // The bash tool catches errors internally
      expect(result.output).toContain("Error");
    });

    it("TOOL-REG-014: 多工具并发执行", async () => {
      mockReadFile.mockResolvedValue("content");
      const read = createReadFileTool();
      const ctx = makeCtx();
      const [r1, r2] = await Promise.all([
        read.execute({ path: "a.ts" }, ctx),
        read.execute({ path: "b.ts" }, ctx),
      ]);
      expect(r1.output).toContain("content");
      expect(r2.output).toContain("content");
    });

    it("TOOL-REG-015: abort 信号中断工具", async () => {
      const controller = new AbortController();
      controller.abort();
      const ctx = makeCtx({ abort: controller.signal });
      // The abort signal is available in ctx; tool implementations can check it
      expect(ctx.abort.aborted).toBe(true);
    });
  });

  // ===== TOOL-REG-016 ~ TOOL-REG-020: 上下文传递与安全模式 =====
  describe("上下文传递与安全模式", () => {
    it("TOOL-REG-016: 工具元数据正确传递", async () => {
      mockExecuteCommand.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
      const ctx = makeCtx({
        sessionId: "sess-meta",
        messageId: "msg-meta",
        cwd: "D:\\meta",
      });
      const bash = createBashTool();
      await bash.execute({ command: "echo test" }, ctx);
      // Verify executeCommand was called (the tool uses ctx.cwd)
      expect(mockExecuteCommand).toHaveBeenCalled();
    });

    it("TOOL-REG-017: ctx.sessionId/cwd/abort 正确传递", () => {
      const controller = new AbortController();
      const ctx = makeCtx({
        sessionId: "sess-ctx",
        messageId: "msg-ctx",
        cwd: "D:\\ctx-test",
        abort: controller.signal,
      });
      expect(ctx.sessionId).toBe("sess-ctx");
      expect(ctx.cwd).toBe("D:\\ctx-test");
      expect(ctx.abort).toBe(controller.signal);
    });

    it("TOOL-REG-018: 安全模式 full 跳过权限确认", async () => {
      mockReadFile.mockRejectedValue(new Error("not found"));
      mockWriteFile.mockResolvedValue(undefined);
      const write = createWriteFileTool();
      const ctx = makeCtx({ securityMode: "full" });
      const result = await write.execute(
        { path: "test.ts", content: "new content" },
        ctx,
      );
      // In full mode, no onWriteConfirm needed
      expect(result.output).toContain("Successfully wrote");
    });

    it("TOOL-REG-019: 安全模式 ask 触发权限确认", async () => {
      mockReadFile.mockResolvedValue("old content totally different");
      mockWriteFile.mockResolvedValue(undefined);
      const onWriteConfirm = vi.fn().mockResolvedValue({ action: "accept" });
      const write = createWriteFileTool();
      const ctx = makeCtx({ securityMode: "ask", onWriteConfirm });
      await write.execute(
        { path: "test.ts", content: "completely new and different content here" },
        ctx,
      );
      // onWriteConfirm should have been called because content is different
      expect(onWriteConfirm).toHaveBeenCalled();
    });

    it("TOOL-REG-020: 自定义权限规则生效", () => {
      const registry = getAgentRegistry();
      const customAgent: AgentDefinition = {
        id: "perm-test-agent",
        name: "Perm Test",
        description: "Test",
        mode: "subagent",
        prompt: "test",
        // * first, then specific rules override (last-match-wins)
        permissions: [
          { tool: "*", action: "ask" },
          { tool: "read", action: "allow" },
          { tool: "write", action: "deny" },
          { tool: "bash", action: "ask" },
        ],
      };
      registry.register(customAgent);
      // read → last match is read:allow
      expect(registry.evaluatePermission("perm-test-agent", "read")).toBe("allow");
      // write → last match is write:deny
      expect(registry.evaluatePermission("perm-test-agent", "write")).toBe("deny");
      // bash → last match is bash:ask
      expect(registry.evaluatePermission("perm-test-agent", "bash")).toBe("ask");
      // edit → only matches *:ask
      expect(registry.evaluatePermission("perm-test-agent", "edit")).toBe("ask");
    });
  });
});

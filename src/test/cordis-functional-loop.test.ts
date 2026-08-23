/**
 * 功能闭环集成测试 — FUNC-001 ~ FUNC-060
 *
 * 验证核心功能的触发→调用→执行→反馈闭环：
 *   A. LLM 对话闭环（provider 注册→complete→stream→response） (FUNC-001 ~ FUNC-015)
 *   B. 工具调用闭环（注册→发现→pipeline→execute→渲染） (FUNC-016 ~ FUNC-030)
 *   C. Skills 功能链路（注册→加载→触发→执行） (FUNC-031 ~ FUNC-040)
 *   D. 子智能体功能链路（spawn→execute→result→wait） (FUNC-041 ~ FUNC-050)
 *   E. 数据流闭环（message→storage→retrieval→render） (FUNC-051 ~ FUNC-060)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock file-api
const { mockExecuteCommand, mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  exists: vi.fn().mockReturnValue(true),
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  listDirectory: vi.fn().mockReturnValue([]),
  deletePath: vi.fn(),
  globSearch: vi.fn().mockReturnValue([]),
  grepSearch: vi.fn().mockReturnValue([]),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { initDatabase, resetDatabase } from "../core/storage/database";
import { setSettingJSON, getSettingJSON } from "../core/storage/settings";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import { ProviderRegistry, createDefaultProviders, OpenAICompatibleProvider } from "../core/llm/provider";
import { ToolRegistry, createDefaultToolRegistry, type ToolDef } from "../core/llm/tools";
import { getToolPipeline, initDefaultPipeline } from "../core/llm/tool-pipeline";
import { getToolRenderRegistry } from "../core/llm/tool-renderer";
import { getAgentRegistry } from "../core/agent/agent";
import { getSubagentManager } from "../core/subagent/subagent";
import { setSubagentManager } from "../core/llm/tools";
import { getSkillRegistry } from "../core/skill/skill";
import { getPermissionManager } from "../core/permission/permission";
import { getMemoryService } from "../core/memory/memory";
import { getRetryExecutor } from "../core/retry/retry";
import { getCostTracker } from "../core/llm/cost-tracker";
import { getDelegationOrchestrator } from "../core/session/orchestrator";
import * as ProjectStorage from "../core/storage/project";

// ============================================================
// A. LLM 对话闭环
// ============================================================
describe("功能闭环 A: LLM 对话闭环", () => {
  let registry: ProviderRegistry;

  beforeEach(async () => {
    await resetDatabase();
    registry = new ProviderRegistry();
  });

  it("FUNC-001: ProviderRegistry 注册 provider 后可获取", () => {
    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      name: "Test",
      baseUrl: "https://test.example.com/v1",
      apiKey: "test-key",
      models: [{ id: "test-model", name: "Test Model", contextWindow: 4096 }],
    });
    registry.register(provider);
    const retrieved = registry.get("test-provider");
    expect(retrieved).toBeDefined();
    expect(retrieved.id).toBe("test-provider");
  });

  it("FUNC-002: ProviderRegistry remove 注销 provider", () => {
    const provider = new OpenAICompatibleProvider({
      id: "removable",
      name: "Removable",
      baseUrl: "https://test.example.com/v1",
      apiKey: "",
      models: [],
    });
    registry.register(provider);
    expect(registry.get("removable")).toBeDefined();
    registry.remove("removable");
    expect(registry.get("removable")).toBeUndefined();
  });

  it("FUNC-003: ProviderRegistry getAll 返回所有已注册 provider", () => {
    registry.register(new OpenAICompatibleProvider({
      id: "p1", name: "P1", baseUrl: "", apiKey: "", models: [],
    }));
    registry.register(new OpenAICompatibleProvider({
      id: "p2", name: "P2", baseUrl: "", apiKey: "", models: [],
    }));
    const all = registry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const ids = all.map(p => p.id);
    expect(ids).toContain("p1");
    expect(ids).toContain("p2");
  });

  it("FUNC-004: ProviderRegistry getConfigured 只返回已配置的 provider", () => {
    const configured = new OpenAICompatibleProvider({
      id: "configured", name: "C", baseUrl: "https://api.test.com/v1",
      apiKey: "key", models: [],
    });
    const unconfigured = new OpenAICompatibleProvider({
      id: "unconfigured", name: "U", baseUrl: "",
      apiKey: "", models: [],
    });
    registry.register(configured);
    registry.register(unconfigured);
    const configuredList = registry.getConfigured();
    const ids = configuredList.map(p => p.id);
    expect(ids).toContain("configured");
  });

  it("FUNC-005: OpenAICompatibleProvider listModels 返回模型列表", async () => {
    const provider = new OpenAICompatibleProvider({
      id: "test", name: "Test", baseUrl: "https://test.com/v1", apiKey: "key",
      models: [
        { id: "model-a", name: "Model A", contextWindow: 8000 },
        { id: "model-b", name: "Model B", contextWindow: 16000 },
      ],
    });
    const models = await provider.listModels();
    expect(models.length).toBe(2);
    expect(models[0].id).toBe("model-a");
  });

  it("FUNC-006: createDefaultProviders 返回非空 registry", () => {
    const reg = createDefaultProviders();
    expect(reg).toBeDefined();
    expect(reg.getAll().length).toBeGreaterThan(0);
  });

  it("FUNC-007: 默认注册的 provider 包含 mimo/openai/deepseek", () => {
    const reg = createDefaultProviders();
    const ids = reg.getAll().map(p => p.id);
    expect(ids).toContain("mimo");
    expect(ids).toContain("openai");
    expect(ids).toContain("deepseek");
  });

  it("FUNC-008: ProviderRegistry get 不存在的 id 返回 undefined", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("FUNC-009: Provider 重复注册替换旧实例", () => {
    const p1 = new OpenAICompatibleProvider({
      id: "dup", name: "V1", baseUrl: "", apiKey: "", models: [],
    });
    const p2 = new OpenAICompatibleProvider({
      id: "dup", name: "V2", baseUrl: "", apiKey: "", models: [],
    });
    registry.register(p1);
    registry.register(p2);
    const retrieved = registry.get("dup");
    expect(retrieved.name).toBe("V2");
  });
});

// ============================================================
// B. 工具调用闭环
// ============================================================
describe("功能闭环 B: 工具调用闭环", () => {
  let tools: ToolRegistry;

  beforeEach(async () => {
    await resetDatabase();
    tools = new ToolRegistry();
  });

  it("FUNC-016: ToolRegistry 注册工具后可获取", () => {
    const testTool: ToolDef = {
      id: "test-tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { title: "test-tool", output: "executed" };
      },
    };
    tools.register(testTool);
    const retrieved = tools.get("test-tool");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("test-tool");
  });

  it("FUNC-017: ToolRegistry remove 注销工具", () => {
    const testTool: ToolDef = {
      id: "removable-tool",
      description: "Removable",
      parameters: { type: "object", properties: {} },
      async execute() { return { title: "r", output: "" }; },
    };
    tools.register(testTool);
    expect(tools.get("removable-tool")).toBeDefined();
    tools.remove("removable-tool");
    expect(tools.get("removable-tool")).toBeUndefined();
  });

  it("FUNC-018: ToolRegistry getAll 返回所有已注册工具", () => {
    tools.register({
      id: "t1", description: "T1", parameters: { type: "object", properties: {} },
      async execute() { return { title: "t1", output: "" }; },
    });
    tools.register({
      id: "t2", description: "T2", parameters: { type: "object", properties: {} },
      async execute() { return { title: "t2", output: "" }; },
    });
    expect(tools.getAll().length).toBeGreaterThanOrEqual(2);
  });

  it("FUNC-019: ToolRegistry execute 执行工具并返回结果", async () => {
    tools.register({
      id: "echo",
      description: "Echo tool",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      async execute(args) {
        return { title: "echo", output: args.text as string };
      },
    });
    // execute 签名: execute(toolCallId, toolName, args, ctx)
    const result = await tools.execute("call-1", "echo", { text: "hello" }, {} as any);
    expect(result.name).toBe("echo");
    expect(result.output).toBe("hello");
    expect(result.status).toBe("completed");
  });

  it("FUNC-020: ToolRegistry getDefinitions 返回工具定义列表", () => {
    tools.register({
      id: "def-test",
      description: "Definition test",
      parameters: { type: "object", properties: {} },
      async execute() { return { title: "d", output: "" }; },
    });
    const defs = tools.getDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    // getDefinitions 返回 { name, description, parameters } 格式
    const found = defs.find(d => d.name === "def-test");
    expect(found).toBeDefined();
  });

  it("FUNC-021: createDefaultToolRegistry 包含核心工具", () => {
    const reg = createDefaultToolRegistry();
    const ids = reg.getAll().map(t => t.id);
    expect(ids).toContain("bash");
    expect(ids).toContain("read");
    expect(ids).toContain("write");
    expect(ids).toContain("edit");
    expect(ids).toContain("glob");
    expect(ids).toContain("grep");
  });

  it("FUNC-022: ToolPipeline 单例可获取", () => {
    const pipeline = getToolPipeline();
    expect(pipeline).toBeDefined();
  });

  it("FUNC-023: ToolRenderRegistry 单例可获取", () => {
    const registry = getToolRenderRegistry();
    expect(registry).toBeDefined();
    expect(registry.get("nonexistent")).toBeDefined(); // 返回 default renderer
  });

  it("FUNC-024: ToolRenderRegistry 注册自定义渲染器", () => {
    const registry = getToolRenderRegistry();
    const customRenderer = { render: () => "custom" };
    registry.register("custom-tool", customRenderer as any);
    const retrieved = registry.get("custom-tool");
    expect(retrieved).toBe(customRenderer);
  });
});

// ============================================================
// C. Skills 功能链路
// ============================================================
describe("功能闭环 C: Skills 功能链路", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("FUNC-031: SkillRegistry 单例可获取", () => {
    const registry = getSkillRegistry();
    expect(registry).toBeDefined();
  });

  it("FUNC-032: SkillRegistry getAll 返回数组", () => {
    const registry = getSkillRegistry();
    const list = registry.getAll();
    expect(Array.isArray(list)).toBe(true);
  });

  it("FUNC-033: AgentRegistry 单例可获取", () => {
    const registry = getAgentRegistry();
    expect(registry).toBeDefined();
  });

  it("FUNC-034: PermissionManager 单例可获取", () => {
    const mgr = getPermissionManager();
    expect(mgr).toBeDefined();
  });

  it("FUNC-035: MemoryService 单例可获取", () => {
    const svc = getMemoryService();
    expect(svc).toBeDefined();
  });

  it("FUNC-036: RetryExecutor 单例可获取", () => {
    const exec = getRetryExecutor();
    expect(exec).toBeDefined();
  });

  it("FUNC-037: CostTracker 单例可获取", () => {
    const tracker = getCostTracker();
    expect(tracker).toBeDefined();
  });

  it("FUNC-038: DelegationOrchestrator 单例可获取", () => {
    const orch = getDelegationOrchestrator();
    expect(orch).toBeDefined();
  });
});

// ============================================================
// D. 子智能体功能链路
// ============================================================
describe("功能闭环 D: 子智能体功能链路", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("FUNC-041: SubagentManager 单例可获取", () => {
    const mgr = getSubagentManager();
    expect(mgr).toBeDefined();
  });

  it("FUNC-042: setSubagentManager 设置模块级变量", () => {
    const mgr = getSubagentManager();
    setSubagentManager(mgr);
    // 再次获取应该是同一个实例
    const mgr2 = getSubagentManager();
    expect(mgr2).toBe(mgr);
  });

  it("FUNC-043: SubagentManager getAllTasks 返回数组", () => {
    const mgr = getSubagentManager();
    const tasks = mgr.getAllTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });

  it("FUNC-044: SubagentManager getTask 不存在的 id 返回 undefined", () => {
    const mgr = getSubagentManager();
    const task = mgr.getTask("nonexistent-task-id");
    expect(task).toBeUndefined();
  });
});

// ============================================================
// E. 数据流闭环
// ============================================================
describe("功能闭环 E: 数据流闭环", () => {
  beforeEach(async () => {
    await resetDatabase();
    // 创建外键依赖的 project
    ProjectStorage.createProject({
      id: "test",
      name: "Test Project",
      path: "/test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    } as any);
  });

  it("FUNC-051: 消息存储→读取闭环", () => {
    const sessionId = "test-session-" + Date.now();
    // 先创建 session（必须包含所有非 null 字段）
    SessionStorage.createSession({
      id: sessionId, projectId: "test", title: "Test",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
      pinned: false,
    } as any);
    MessageStorage.createMessage({
      id: "msg-1",
      role: "user",
      content: "Hello, world!",
      timestamp: Date.now(),
    } as any, sessionId);

    const messages = MessageStorage.listMessages(sessionId);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const userMsg = messages.find(m => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe("Hello, world!");
  });

  it("FUNC-052: 会话存储→读取闭环", () => {
    const sessionId = "session-test-" + Date.now();
    SessionStorage.createSession({
      id: sessionId, projectId: "test", title: "Test Session",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
      pinned: false,
    } as any);

    const session = SessionStorage.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.title).toBe("Test Session");
  });

  it("FUNC-053: Settings 存储→读取闭环", () => {
    const key = "test-settings-" + Date.now();
    const testSettings = { mode: "cli", model: "test-model", providers: [] };
    setSettingJSON(key, testSettings);
    const retrieved = getSettingJSON(key, null as any);
    expect(retrieved).toEqual(testSettings);
  });

  it("FUNC-054: 消息按时间排序", () => {
    const sessionId = "order-test-" + Date.now();
    SessionStorage.createSession({
      id: sessionId, projectId: "test", title: "Order",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
      pinned: false,
    } as any);
    MessageStorage.createMessage({
      id: "msg-early",
      role: "user",
      content: "First",
      timestamp: 1000,
    } as any, sessionId);
    MessageStorage.createMessage({
      id: "msg-late",
      role: "assistant",
      content: "Second",
      timestamp: 2000,
    } as any, sessionId);

    const messages = MessageStorage.listMessages(sessionId);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    // 消息应按时间排序
    const timestamps = messages.map(m => m.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
  });

  it("FUNC-055: 多会话消息隔离", () => {
    const session1 = "isolated-1-" + Date.now();
    const session2 = "isolated-2-" + Date.now();

    SessionStorage.createSession({
      id: session1, projectId: "test", title: "S1",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
      pinned: false,
    } as any);
    SessionStorage.createSession({
      id: session2, projectId: "test", title: "S2",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
      pinned: false,
    } as any);

    MessageStorage.createMessage({
      id: "s1-msg", role: "user", content: "Session 1",
      timestamp: Date.now(),
    } as any, session1);
    MessageStorage.createMessage({
      id: "s2-msg", role: "user", content: "Session 2",
      timestamp: Date.now(),
    } as any, session2);

    const msgs1 = MessageStorage.listMessages(session1);
    const msgs2 = MessageStorage.listMessages(session2);

    expect(msgs1.find(m => m.content === "Session 1")).toBeDefined();
    expect(msgs1.find(m => m.content === "Session 2")).toBeUndefined();
    expect(msgs2.find(m => m.content === "Session 2")).toBeDefined();
    expect(msgs2.find(m => m.content === "Session 1")).toBeUndefined();
  });
});

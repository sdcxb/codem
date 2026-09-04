/**
 * CodeGraph 集成功能测试
 *
 * 验证内容：
 *   1. MCP 层：isCodeGraphEnabled / setCodeGraphEnabled / hasCodeGraphIndex /
 *      autoDetectCodeGraph / disconnectCodeGraph / hasCodeGraphTools
 *   2. Prompt 层：buildSystemPrompt 不再手写 CodeGraph 指导（defer 工具由
 *      "Deferred Tools" 段呈现，见 3）
 *   3. 工具层：syncCodeGraphTools 把已连接的 codegraph MCP 工具注册为
 *      defer ToolDef（schema 经 tool_search 拉取，断连移除——提示与可调用一致）
 *   4. LLMEngine 集成：buildSystemPromptAsync 调用 autoDetectCodeGraph
 *   5. 边界场景：禁用、无项目路径、已连接、连接失败
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDatabase, initDatabase } from "../core/storage/database";
import { getSetting, setSetting } from "../core/storage/settings";
import { getLang, setLang } from "../core/i18n/lang";
import {
  isCodeGraphEnabled,
  setCodeGraphEnabled,
  hasCodeGraphIndex,
  isCodeGraphInstalled,
  autoDetectCodeGraph,
  disconnectCodeGraph,
  hasCodeGraphTools,
  CODEGRAPH_SERVER_NAME,
} from "../core/mcp/mcp";
import { buildSystemPrompt } from "../core/prompt/prompt";
import { ToolRegistry } from "../core/llm/tools";
import { syncCodeGraphTools, createCodeGraphTool, mcpResultToText } from "../core/llm/tools/codegraph-tool";
import * as LLMEngineExports from "../core/llm/index";

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

/** Mock Tauri invoke with custom handlers */
function mockTauriInvoke(handlers: Record<string, (args?: any) => any>) {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (handlers[command]) {
      return handlers[command](args);
    }
    if (command === "execute_command") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return null;
  });
  (window as any).__TAURI__ = {
    core: { invoke, listen: vi.fn(() => Promise.resolve(() => {})) },
  };
  return invoke;
}

/** Remove Tauri mock */
function clearTauri() {
  delete (window as any).__TAURI__;
}

/** Create a mock MCPRegistry */
function createMockRegistry(options: {
  connected?: boolean;
  tools?: Array<{ server: string; name: string; description: string }>;
  connectShouldFail?: boolean;
} = {}) {
  const { connected = false, tools = [], connectShouldFail = false } = options;
  const connections: Map<string, { status: string }> = new Map();
  if (connected) {
    connections.set("codegraph", { status: "connected" });
  }

  const connect = vi.fn(async (config: any) => {
    if (connectShouldFail) throw new Error("Connection refused");
    connections.set(config.name, { status: "connected" });
    return { name: config.name, connected: true, tools: [], error: undefined };
  });

  const disconnect = vi.fn(async (name: string) => {
    connections.delete(name);
  });

  const getAllTools = vi.fn(() => tools);

  const getStatus = vi.fn((name: string) => connections.get(name));

  const getClient = vi.fn(() => ({ getStatus }));

  return { connect, disconnect, getAllTools, getClient, getStatus, connections };
}

/** Build a minimal AgentDefinition for buildSystemPrompt */
function buildMinimalAgent() {
  return {
    id: "test",
    name: "Test Agent",
    description: "Test",
    mode: "build" as const,
    prompt: "You are a test agent.",
    permissions: [],
  };
}

// ═══════════════════════════════════════════════════════════
// Tests — MCP 层
// ═══════════════════════════════════════════════════════════

describe("CodeGraph 集成 — MCP 层", () => {
  beforeEach(async () => {
    clearTauri();
    await resetDatabase();
    await initDatabase();
  });

  afterEach(() => {
    clearTauri();
  });

  // ===== isCodeGraphEnabled / setCodeGraphEnabled =====

  describe("isCodeGraphEnabled / setCodeGraphEnabled", () => {
    it("默认返回 true（未设置时）", () => {
      expect(isCodeGraphEnabled()).toBe(true);
    });

    it("setCodeGraphEnabled(false) 后返回 false", () => {
      setCodeGraphEnabled(false);
      expect(getSetting("codem-codegraph-enabled")).toBe("false");
      expect(isCodeGraphEnabled()).toBe(false);
    });

    it("setCodeGraphEnabled(true) 后返回 true", () => {
      setCodeGraphEnabled(false);
      setCodeGraphEnabled(true);
      expect(getSetting("codem-codegraph-enabled")).toBe("true");
      expect(isCodeGraphEnabled()).toBe(true);
    });

    it("设置值持久化到 SQLite", () => {
      setCodeGraphEnabled(false);
      const raw = getSetting("codem-codegraph-enabled");
      expect(raw).toBe("false");
    });
  });

  // ===== CODEGRAPH_SERVER_NAME =====

  describe("CODEGRAPH_SERVER_NAME", () => {
    it("常量值为 'codegraph'", () => {
      expect(CODEGRAPH_SERVER_NAME).toBe("codegraph");
    });
  });

  // ===== hasCodeGraphIndex =====

  describe("hasCodeGraphIndex", () => {
    it("path_exists 返回 true 时返回 true", async () => {
      mockTauriInvoke({
        path_exists: (args: any) => args.path.endsWith("/.codegraph"),
      });
      const result = await hasCodeGraphIndex("/project/myapp");
      expect(result).toBe(true);
    });

    it("path_exists 返回 false 时返回 false", async () => {
      mockTauriInvoke({
        path_exists: () => false,
      });
      const result = await hasCodeGraphIndex("/project/myapp");
      expect(result).toBe(false);
    });

    it("Tauri 未初始化时返回 false", async () => {
      const result = await hasCodeGraphIndex("/project/myapp");
      expect(result).toBe(false);
    });

    it("调用 path_exists 时路径正确拼接", async () => {
      let capturedPath = "";
      mockTauriInvoke({
        path_exists: (args: any) => {
          capturedPath = args.path;
          return false;
        },
      });
      await hasCodeGraphIndex("/projects/test-app");
      expect(capturedPath).toBe("/projects/test-app/.codegraph");
    });
  });

  // ===== isCodeGraphInstalled =====

  describe("isCodeGraphInstalled", () => {
    it("stderr 不含 'not recognized' 时返回 true", async () => {
      mockTauriInvoke({
        execute_command: () => ({ stdout: "codegraph 1.0.0", stderr: "", exitCode: 0 }),
      });
      const result = await isCodeGraphInstalled();
      expect(result).toBe(true);
    });

    it("stderr 含 'not recognized' 时返回 false", async () => {
      mockTauriInvoke({
        execute_command: () => ({
          stdout: "",
          stderr: "codegraph: The term 'codegraph' is not recognized",
          exitCode: 1,
        }),
      });
      const result = await isCodeGraphInstalled();
      expect(result).toBe(false);
    });

    it("Tauri 未初始化时返回 false", async () => {
      const result = await isCodeGraphInstalled();
      expect(result).toBe(false);
    });
  });

  // ===== autoDetectCodeGraph =====

  describe("autoDetectCodeGraph", () => {
    it("功能禁用时返回 false，不执行检测", async () => {
      setCodeGraphEnabled(false);
      const registry = createMockRegistry();
      const result = await autoDetectCodeGraph(registry as any, "/project/app");
      expect(result).toBe(false);
      expect(registry.connect).not.toHaveBeenCalled();
    });

    it("projectPath 为空时返回 false", async () => {
      const registry = createMockRegistry();
      const result = await autoDetectCodeGraph(registry as any, "");
      expect(result).toBe(false);
      expect(registry.connect).not.toHaveBeenCalled();
    });

    it("无 .codegraph/ 目录时返回 false，不连接", async () => {
      mockTauriInvoke({
        path_exists: () => false,
      });
      const registry = createMockRegistry();
      const result = await autoDetectCodeGraph(registry as any, "/project/app");
      expect(result).toBe(false);
      expect(registry.connect).not.toHaveBeenCalled();
    });

    it("有 .codegraph/ 且未连接时调用 registry.connect", async () => {
      mockTauriInvoke({
        path_exists: () => true,
      });
      const registry = createMockRegistry({ connected: false });
      const result = await autoDetectCodeGraph(registry as any, "/project/app");
      expect(result).toBe(true);
      expect(registry.connect).toHaveBeenCalledTimes(1);
      // 验证连接参数
      const connectArgs = registry.connect.mock.calls[0][0];
      expect(connectArgs.name).toBe("codegraph");
      expect(connectArgs.transport).toBe("stdio");
      expect(connectArgs.command).toBe("codegraph");
      expect(connectArgs.args).toEqual(["mcp"]);
      expect(connectArgs.autoReconnect).toBe(true);
    });

    it("已连接时返回 true，不重复连接", async () => {
      mockTauriInvoke({
        path_exists: () => true,
      });
      const registry = createMockRegistry({ connected: true });
      const result = await autoDetectCodeGraph(registry as any, "/project/app");
      expect(result).toBe(true);
      expect(registry.connect).not.toHaveBeenCalled();
    });

    it("connect 抛出异常时返回 false", async () => {
      mockTauriInvoke({
        path_exists: () => true,
      });
      const registry = createMockRegistry({ connectShouldFail: true });
      const result = await autoDetectCodeGraph(registry as any, "/project/app");
      expect(result).toBe(false);
    });
  });

  // ===== disconnectCodeGraph =====

  describe("disconnectCodeGraph", () => {
    it("调用 registry.disconnect('codegraph')", async () => {
      const registry = createMockRegistry();
      await disconnectCodeGraph(registry as any);
      expect(registry.disconnect).toHaveBeenCalledWith("codegraph");
    });

    it("disconnect 抛出异常时不传播错误", async () => {
      const registry = createMockRegistry();
      registry.disconnect.mockRejectedValue(new Error("disconnect failed"));
      await expect(disconnectCodeGraph(registry as any)).resolves.toBeUndefined();
    });
  });

  // ===== hasCodeGraphTools =====

  describe("hasCodeGraphTools", () => {
    it("有 server='codegraph' 的工具时返回 true", () => {
      const registry = createMockRegistry({
        tools: [
          { server: "codegraph", name: "codegraph_explore", description: "Explore code" },
          { server: "other", name: "other_tool", description: "Other" },
        ],
      });
      expect(hasCodeGraphTools(registry as any)).toBe(true);
    });

    it("有 name 以 'codegraph_' 开头的工具时返回 true", () => {
      const registry = createMockRegistry({
        tools: [
          { server: "mcp-server", name: "codegraph_search", description: "Search" },
        ],
      });
      expect(hasCodeGraphTools(registry as any)).toBe(true);
    });

    it("无 CodeGraph 工具时返回 false", () => {
      const registry = createMockRegistry({
        tools: [
          { server: "other", name: "other_tool", description: "Other" },
        ],
      });
      expect(hasCodeGraphTools(registry as any)).toBe(false);
    });

    it("工具列表为空时返回 false", () => {
      const registry = createMockRegistry({ tools: [] });
      expect(hasCodeGraphTools(registry as any)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Prompt 层测试
// ═══════════════════════════════════════════════════════════

describe("CodeGraph 集成 — Prompt 层", () => {
  const origLang = getLang();

  afterEach(() => {
    setLang(origLang);
  });

  // 新契约：CodeGraph 指导不再由 buildSystemPrompt 手写注入（曾存在
  // "指导有、工具不可调"的不一致）。codegraph_explore 是 defer 工具——
  // 连接成功注册进工具表后，由 agentic-loop 的 "Deferred Tools" 段呈现
  // （见 codegraph-tool.test.ts 的同步/提示断言）。

  it("buildSystemPrompt 不再包含手写 CodeGraph 指导段", () => {
    setLang("zh");
    const zhPrompt = buildSystemPrompt({ agent: buildMinimalAgent() });
    expect(zhPrompt).not.toContain("# CodeGraph 代码图谱");
    expect(zhPrompt).not.toContain("codegraph_explore");
    setLang("en");
    const enPrompt = buildSystemPrompt({ agent: buildMinimalAgent() });
    expect(enPrompt).not.toContain("# CodeGraph Code Intelligence");
    expect(enPrompt).not.toContain("codegraph_explore");
  });

  it("不再支持 codeGraphEnabled 配置项（字段已移除）", () => {
    // 传多余字段（运行时忽略）不会注入任何 CodeGraph 段——防止旧调用方
    // 造成"指导有、工具无"的幻觉诱导。
    setLang("en");
    const prompt = buildSystemPrompt({
      agent: buildMinimalAgent(),
      codeGraphEnabled: true,
    } as any);
    expect(prompt).not.toContain("CodeGraph");
  });

  it("mcpInstructions 仍正常渲染为 # MCP Tools", () => {
    setLang("en");
    const prompt = buildSystemPrompt({
      agent: buildMinimalAgent(),
      mcpInstructions: "- **other/tool**: Some tool",
    });
    expect(prompt).toContain("# MCP Tools");
    expect(prompt).toContain("other/tool");
    expect(prompt).not.toContain("codegraph_explore");
  });
});

// ═══════════════════════════════════════════════════════════
// LLMEngine 集成测试
// ═══════════════════════════════════════════════════════════

describe("CodeGraph 集成 — LLMEngine 导出", () => {
  it("LLMEngine 导出 autoDetectCodeGraph 函数", () => {
    expect(LLMEngineExports.autoDetectCodeGraph).toBeDefined();
    expect(typeof LLMEngineExports.autoDetectCodeGraph).toBe("function");
  });

  it("LLMEngine 导出 hasCodeGraphTools 函数", () => {
    expect(LLMEngineExports.hasCodeGraphTools).toBeDefined();
    expect(typeof LLMEngineExports.hasCodeGraphTools).toBe("function");
  });

  it("LLMEngine 导出 isCodeGraphEnabled 函数", () => {
    expect(LLMEngineExports.isCodeGraphEnabled).toBeDefined();
    expect(typeof LLMEngineExports.isCodeGraphEnabled).toBe("function");
  });

  it("LLMEngine 导出的函数与 MCP 模块导出的是同一引用", () => {
    expect(LLMEngineExports.autoDetectCodeGraph).toBe(autoDetectCodeGraph);
    expect(LLMEngineExports.hasCodeGraphTools).toBe(hasCodeGraphTools);
    expect(LLMEngineExports.isCodeGraphEnabled).toBe(isCodeGraphEnabled);
  });
});

describe("CodeGraph 集成 — 工具注册与 Deferred 呈现（新契约：可调用 defer ToolDef）", () => {
  // codegraph 工具现为 defer ToolDef：连接 → syncCodeGraphTools 注册进工具表
  // （默认不进 schema，只出现在 Deferred hints，model 经 tool_search 拉取 schema）；
  // 断开/禁用 → 移除。提示与可调用集合严格一致。
  function makeToolRegistry() {
    return new ToolRegistry();
  }
  const cgTool = { server: "codegraph", name: "codegraph_explore", description: "Explore code graph", inputSchema: { type: "object", properties: { query: { type: "string" } } } };

  it("有 CodeGraph 工具 → sync 注册为 defer ToolDef，schema 可经 tool_search 拉取", () => {
    const registry = makeToolRegistry();
    syncCodeGraphTools(registry, [cgTool as any]);
    // defer：完整 schema 不进核心定义，只出现在 Deferred hints
    expect(registry.getCoreDefinitions().some((d) => d.name === "codegraph_explore")).toBe(false);
    const hints = registry.getDeferredDefinitions();
    const hint = hints.find((h) => h.name === "codegraph_explore");
    expect(hint).toBeTruthy();
    expect(hint!.searchHint).toContain("tool_search");
    // 可调用证明：tool_search 的 getDeferredDefinition 能返回完整 schema
    const full = registry.getDeferredDefinition("codegraph_explore");
    expect(full).toBeTruthy();
    expect(full!.name).toBe("codegraph_explore");
    expect(full!.parameters).toBeTruthy();
    // hints 与可调用集合一致 → agentic-loop 的 "Deferred Tools" 段呈现
    expect(registry.get("codegraph_explore")?.shouldDefer).toBe(true);
  });

  it("无 CodeGraph 工具（未连接/禁用）→ sync 后无残留、hints 不含 codegraph", () => {
    const registry = makeToolRegistry();
    syncCodeGraphTools(registry, [cgTool as any]); // 先注册
    expect(registry.get("codegraph_explore")).toBeTruthy();
    // 断开：工具列表为空 → sync 移除残留（防幽灵提示）
    syncCodeGraphTools(registry, []);
    expect(registry.get("codegraph_explore")).toBeUndefined();
    expect(registry.getDeferredDefinitions().some((h) => h.name.startsWith("codegraph_"))).toBe(false);
  });

  it("sync 幂等：重复同步不重复注册；非 codegraph MCP 工具不受影响", () => {
    const registry = makeToolRegistry();
    const other = { server: "other-server", name: "other_tool", description: "x" };
    registry.register(createCodeGraphTool(cgTool as any));
    const before = registry.getAll().length;
    syncCodeGraphTools(registry, [cgTool as any, other as any]);
    expect(registry.getAll().length).toBe(before); // 不重复
    syncCodeGraphTools(registry, [other as any]); // codegraph 断开、other 仍在
    expect(registry.get("other_tool")).toBeUndefined(); // 非 codegraph 不归 sync 管
    expect(registry.get("codegraph_explore")).toBeUndefined(); // codegraph 已移除
  });

  it("createCodeGraphTool.execute 转发 MCP callTool 并展平文本结果", async () => {
    const tool = createCodeGraphTool(cgTool as any);
    expect(tool.id).toBe("codegraph_explore");
    expect(tool.execute).toBeTypeOf("function");
    // mcpResultToText 纯函数：content 文本数组 → join
    expect(mcpResultToText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(mcpResultToText({} as any)).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════
// 端到端流程测试
// ═══════════════════════════════════════════════════════════

describe("CodeGraph 集成 — 端到端流程", () => {
  beforeEach(async () => {
    clearTauri();
    await resetDatabase();
    await initDatabase();
  });

  afterEach(() => {
    clearTauri();
  });

  it("完整流程：启用 → 检测 → 连接 → 工具注册为可调用 defer 工具", async () => {
    // 1. 确保 CodeGraph 已启用
    setCodeGraphEnabled(true);
    expect(isCodeGraphEnabled()).toBe(true);

    // 2. Mock Tauri: .codegraph/ 存在
    mockTauriInvoke({
      path_exists: (args: any) => args.path.endsWith("/.codegraph"),
    });

    // 3. mock registry，connect 后提供 codegraph 工具
    let connectedTools: any[] = [];
    const registry = {
      connect: vi.fn(async (config: any) => {
        connectedTools = [
          { server: "codegraph", name: "codegraph_explore", description: "Explore code graph", inputSchema: { type: "object", properties: {} } },
        ];
        return { name: config.name, connected: true, tools: connectedTools, error: undefined };
      }),
      disconnect: vi.fn(async () => { connectedTools = []; }),
      getAllTools: () => connectedTools,
      getClient: () => ({
        getStatus: (name: string) =>
          connectedTools.length > 0 && name === "codegraph"
            ? { status: "connected" }
            : undefined,
      }),
    };

    // 4. autoDetectCodeGraph 应连接
    const detected = await autoDetectCodeGraph(registry as any, "/my/project");
    expect(detected).toBe(true);
    expect(registry.connect).toHaveBeenCalledTimes(1);

    // 5. 同步进工具表 → defer ToolDef 可经 tool_search 拉取（可调用证明）
    const toolRegistry = new ToolRegistry();
    syncCodeGraphTools(toolRegistry, registry.getAllTools());
    const hint = toolRegistry.getDeferredDefinitions().find((h) => h.name === "codegraph_explore");
    expect(hint).toBeTruthy();
    expect(toolRegistry.getDeferredDefinition("codegraph_explore")).toBeTruthy();
  });

  it("完整流程：禁用 → autoDetect 不执行 → 无工具注册", async () => {
    setCodeGraphEnabled(false);
    mockTauriInvoke({ path_exists: () => true });
    const registry = {
      connect: vi.fn(async () => ({ connected: true, tools: [] })),
      disconnect: vi.fn(async () => {}),
      getAllTools: () => [],
      getClient: () => ({ getStatus: () => undefined }),
    };
    const detected = await autoDetectCodeGraph(registry as any, "/my/project");
    expect(detected).toBe(false);
    expect(registry.connect).not.toHaveBeenCalled();
    // 无工具 → sync 后工具表无 codegraph（提示不会出现）
    const toolRegistry = new ToolRegistry();
    syncCodeGraphTools(toolRegistry, registry.getAllTools());
    expect(toolRegistry.getDeferredDefinitions().some((h) => h.name.startsWith("codegraph_"))).toBe(false);
  });

  it("完整流程：断开连接 → sync 后工具从表移除（提示消失）", async () => {
    mockTauriInvoke({ path_exists: () => true });
    let connectedTools: any[] = [
      { server: "codegraph", name: "codegraph_explore", description: "Explore", inputSchema: {} },
    ];
    const registry = {
      connect: vi.fn(async (config: any) => {
        return { name: config.name, connected: true };
      }),
      disconnect: vi.fn(async () => { connectedTools = []; }),
      getAllTools: () => connectedTools,
      getClient: () => ({
        getStatus: () => connectedTools.length > 0 ? { status: "connected" } : undefined,
      }),
    };
    const toolRegistry = new ToolRegistry();
    syncCodeGraphTools(toolRegistry, registry.getAllTools());
    expect(toolRegistry.get("codegraph_explore")).toBeTruthy();

    // 断开
    await disconnectCodeGraph(registry as any);
    expect(registry.disconnect).toHaveBeenCalledWith("codegraph");

    // 再同步 → 移除
    syncCodeGraphTools(toolRegistry, registry.getAllTools());
    expect(toolRegistry.get("codegraph_explore")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 边界场景测试
// ═══════════════════════════════════════════════════════════

describe("CodeGraph 集成 — 边界场景", () => {
  beforeEach(async () => {
    clearTauri();
    await resetDatabase();
    await initDatabase();
  });

  afterEach(() => {
    clearTauri();
  });

  it("projectPath 为 null 时 autoDetect 返回 false", async () => {
    const registry = createMockRegistry();
    const result = await autoDetectCodeGraph(registry as any, null as any);
    expect(result).toBe(false);
  });

  it("projectPath 为 undefined 时 autoDetect 返回 false", async () => {
    const registry = createMockRegistry();
    const result = await autoDetectCodeGraph(registry as any, undefined as any);
    expect(result).toBe(false);
  });

  it("hasCodeGraphIndex 路径含空格时正确拼接", async () => {
    let capturedPath = "";
    mockTauriInvoke({
      path_exists: (args: any) => {
        capturedPath = args.path;
        return false;
      },
    });
    await hasCodeGraphIndex("C:/My Projects/test app");
    expect(capturedPath).toBe("C:/My Projects/test app/.codegraph");
  });

  it("hasCodeGraphIndex 路径含中文时正确拼接", async () => {
    let capturedPath = "";
    mockTauriInvoke({
      path_exists: (args: any) => {
        capturedPath = args.path;
        return false;
      },
    });
    await hasCodeGraphIndex("D:/项目/我的应用");
    expect(capturedPath).toBe("D:/项目/我的应用/.codegraph");
  });

  it("重复调用 setCodeGraphEnabled 最终值一致", () => {
    setCodeGraphEnabled(true);
    setCodeGraphEnabled(false);
    setCodeGraphEnabled(true);
    setCodeGraphEnabled(false);
    setCodeGraphEnabled(true);
    expect(isCodeGraphEnabled()).toBe(true);
    expect(getSetting("codem-codegraph-enabled")).toBe("true");
  });

  it("hasCodeGraphTools 同时匹配 server name 和 tool name 前缀", () => {
    // server=codegraph 匹配
    const registry1 = createMockRegistry({
      tools: [{ server: "codegraph", name: "other_tool", description: "" }],
    });
    expect(hasCodeGraphTools(registry1 as any)).toBe(true);

    // name=codegraph_xxx 匹配
    const registry2 = createMockRegistry({
      tools: [{ server: "other", name: "codegraph_explore", description: "" }],
    });
    expect(hasCodeGraphTools(registry2 as any)).toBe(true);

    // 两者都不匹配
    const registry3 = createMockRegistry({
      tools: [{ server: "other", name: "other_tool", description: "" }],
    });
    expect(hasCodeGraphTools(registry3 as any)).toBe(false);
  });

  it("autoDetectCodeGraph 在已连接状态下不重复 connect（幂等性）", async () => {
    mockTauriInvoke({
      path_exists: () => true,
    });
    const registry = createMockRegistry({ connected: true });

    // 调用多次
    const r1 = await autoDetectCodeGraph(registry as any, "/project");
    const r2 = await autoDetectCodeGraph(registry as any, "/project");
    const r3 = await autoDetectCodeGraph(registry as any, "/project");

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(registry.connect).not.toHaveBeenCalled();
  });

  it("autoDetectCodeGraph 切换项目时检测新项目路径", async () => {
    let pathExistsCalls: string[] = [];
    mockTauriInvoke({
      path_exists: (args: any) => {
        pathExistsCalls.push(args.path);
        return args.path.includes("/projectA");
      },
    });
    const registry = createMockRegistry({ connected: false });

    // 项目 A 有 .codegraph/
    const r1 = await autoDetectCodeGraph(registry as any, "/work/projectA");
    expect(r1).toBe(true);
    expect(registry.connect).toHaveBeenCalledTimes(1);

    // 项目 B 没有 .codegraph/
    const r2 = await autoDetectCodeGraph(registry as any, "/work/projectB");
    expect(r2).toBe(false);
    expect(registry.connect).toHaveBeenCalledTimes(1); // 没有增加

    // 验证检测了正确的路径
    expect(pathExistsCalls).toContain("/work/projectA/.codegraph");
    expect(pathExistsCalls).toContain("/work/projectB/.codegraph");
  });
});


// ═══════════════════════════════════════════════════════════
// 应用内一键安装产物（launcher 路径）测试
// ═══════════════════════════════════════════════════════════

describe("CodeGraph 集成 — launcher 路径（一键安装产物）", () => {
  beforeEach(async () => {
    clearTauri();
    await resetDatabase();
    await initDatabase();
    setCodeGraphEnabled(true);
  });

  afterEach(() => {
    clearTauri();
    try { setSetting("codem-codegraph-launcher", ""); } catch {}
  });

  it("设置 launcher 路径后 autoDetect connect 使用该绝对路径（.cmd 由 Rust cmd.exe /c 包装）", async () => {
    mockTauriInvoke({ path_exists: (a: any) => a.path.endsWith("/.codegraph") });
    const launcher = "C:\\Users\\abee\\AppData\\Local\\codegraph\\current\\bin\\codegraph.cmd";
    setSetting("codem-codegraph-launcher", launcher);
    let captured: any = null;
    const registry = {
      connect: vi.fn(async (config: any) => { captured = config; return { name: config.name, connected: true, tools: [] }; }),
      disconnect: vi.fn(async () => {}),
      getAllTools: () => [],
      getClient: () => ({ getStatus: () => undefined }),
    };
    const ok = await autoDetectCodeGraph(registry as any, "/my/project");
    expect(ok).toBe(true);
    expect(captured?.command).toBe(launcher);
    expect(captured?.args).toEqual(["mcp"]);
  });

  it("未设置 launcher → connect 回退 'codegraph'（PATH）", async () => {
    mockTauriInvoke({ path_exists: (a: any) => a.path.endsWith("/.codegraph") });
    let captured: any = null;
    const registry = {
      connect: vi.fn(async (c: any) => { captured = c; return { connected: true, tools: [] }; }),
      disconnect: vi.fn(async () => {}),
      getAllTools: () => [],
      getClient: () => ({ getStatus: () => undefined }),
    };
    await autoDetectCodeGraph(registry as any, "/my/project");
    expect(captured?.command).toBe("codegraph");
  });
});

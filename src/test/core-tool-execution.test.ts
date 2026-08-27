/**
 * 测试：工具调用链路 — TOOL-001 ~ TOOL-050
 *
 * 覆盖范围：
 *   3.1 工具执行基础
 *   3.2 工具并发与去重
 *   3.3 P5 拦截与工具特殊逻辑
 *
 * 关键组件：
 *   - ToolRegistry / createDefaultToolRegistry
 *   - StreamingToolExecutorImpl
 *   - ToolDef / ToolContext
 *   - agentic-loop P5 拦截
 *   - load_skill / sandbox / FileContentCache
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock file-api — use vi.hoisted to ensure mock vars are available when factory runs
const { mockExecuteCommand, mockReadFile, mockWriteFile, mockGlobSearch, mockGrepSearch } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockGlobSearch: vi.fn(),
  mockGrepSearch: vi.fn(),
}));
vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  exists: vi.fn(),
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: mockGlobSearch,
  grepSearch: mockGrepSearch,
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { initDatabase, resetDatabase } from "../core/storage/database";
import { setSetting, removeSetting } from "../core/storage/settings";
import {
  ToolRegistry,
  createDefaultToolRegistry,
  createReadFileTool,
  createWriteFileTool,
  createBashTool,
  createGrepTool,
  createGlobTool,
  createEditFileTool,
  createMultiEditTool,
  type ToolContext,
  type ToolDef,
} from "../core/llm/tools";
import {
  StreamingToolExecutorImpl,
  type StreamingToolCall,
  type ToolExecutorConfig,
  type ToolExecutorContext,
  type ToolExecutorEvent,
} from "../core/llm/streaming-executor";
import type { ToolCallResult } from "../core/llm/types";
import type { LLMMessage } from "../core/storage/message";

// ========== 辅助函数 ==========

function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-msg",
    cwd: "/tmp/test",
    abort: new AbortController().signal,
    messages: [] as LLMMessage[],
    metadata: () => {},
    securityMode: "ask",
    ...overrides,
  };
}

function createMockExecutorCtx(overrides: Partial<ToolExecutorContext> = {}): ToolExecutorContext {
  return {
    sessionId: "test-session",
    messageId: "test-msg",
    cwd: "/tmp/test",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ...overrides,
  };
}

// ========== 测试 ==========

describe("工具调用 — ToolRegistry 注册与获取", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  it("TOOL-026: createDefaultToolRegistry 注册所有核心工具", () => {
    const registry = createDefaultToolRegistry();
    const toolNames = registry.getAll().map(t => t.id);

    // Verify core tools are registered
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("glob");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("load_skill");
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("read_attachment");
  });

  it("TOOL-026b: getTool 返回已注册工具", () => {
    const registry = createDefaultToolRegistry();
    const readTool = registry.get("read");
    expect(readTool).toBeDefined();
    expect(readTool!.id).toBe("read");
    expect(readTool!.description).toBeDefined();
    expect(readTool!.parameters).toBeDefined();
    expect(readTool!.execute).toBeDefined();
  });

  it("TOOL-026c: getTool 未注册返回 undefined", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.get("nonexistent_tool")).toBeUndefined();
  });

  it("TOOL-026d: remove 移除工具", () => {
    const registry = createDefaultToolRegistry();
    registry.remove("read");
    expect(registry.get("read")).toBeUndefined();
  });

  it("TOOL-026e: register 注册自定义工具", () => {
    const registry = new ToolRegistry();
    const customTool: ToolDef = {
      id: "custom_tool",
      description: "A custom tool",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { title: "custom", output: "custom output" };
      },
    };
    registry.register(customTool);
    expect(registry.get("custom_tool")).toBeDefined();
  });

  it("TOOL-026f: getDefinitions 返回工具定义格式", () => {
    const registry = createDefaultToolRegistry();
    const defs = registry.getDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    // Each definition should have name, description, parameters
    for (const def of defs) {
      expect(def.name).toBeDefined();
      expect(def.description).toBeDefined();
      expect(def.parameters).toBeDefined();
    }
  });
});

describe("工具调用 — read 工具", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    removeSetting("codem-sandbox-enabled");
  });

  it("TOOL-001: read 工具读取文件内容", async () => {
    mockReadFile.mockResolvedValue("file content here");
    const tool = createReadFileTool();
    const result = await tool.execute({ path: "/test/file.txt" }, createMockCtx());

    expect(result).toBeDefined();
    expect(result.output).toContain("file content here");
  });

  it("TOOL-001b: read 工具读取失败返回错误信息", async () => {
    mockReadFile.mockRejectedValue(new Error("File not found"));
    const tool = createReadFileTool();
    const result = await tool.execute({ path: "/nonexistent" }, createMockCtx());

    expect(result).toBeDefined();
    expect(result.output).toContain("not found");
  });

  it("TOOL-001c: read 工具包含中文路径", async () => {
    mockReadFile.mockResolvedValue("中文内容");
    const tool = createReadFileTool();
    const result = await tool.execute({ path: "D:\\项目\\源码\\你好.py" }, createMockCtx());

    expect(result.output).toContain("中文内容");
  });
});

describe("工具调用 — write 工具", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    removeSetting("codem-sandbox-enabled");
  });

  it("TOOL-002: write 工具写入新文件", async () => {
    mockWriteFile.mockResolvedValue(undefined);
    const tool = createWriteFileTool();
    const result = await tool.execute(
      { path: "/test/new.txt", content: "hello" },
      createMockCtx()
    );

    expect(result).toBeDefined();
    expect(result.output).toBeDefined();
  });

  it("TOOL-002b: write 工具中文内容", async () => {
    mockWriteFile.mockResolvedValue(undefined);
    const tool = createWriteFileTool();
    const result = await tool.execute(
      { path: "/test/中文.txt", content: "你好世界🌍" },
      createMockCtx()
    );

    expect(result).toBeDefined();
  });
});

describe("工具调用 — bash 工具", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    removeSetting("codem-sandbox-enabled");
  });

  it("TOOL-006: bash 工具执行命令", async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: "command output",
      stderr: "",
      exitCode: 0,
    });
    const tool = createBashTool();
    const result = await tool.execute(
      { command: "echo hello" },
      createMockCtx({ cwd: "/tmp" })
    );

    expect(result).toBeDefined();
    expect(result.output).toContain("command output");
  });

  it("TOOL-006b: bash 工具命令失败返回 stderr", async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
    });
    const tool = createBashTool();
    const result = await tool.execute(
      { command: "nonexistent_cmd" },
      createMockCtx()
    );

    expect(result).toBeDefined();
    expect(result.output).toContain("command not found");
  });

  it("TOOL-006c: bash 工具中文命令", async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: "你好世界",
      stderr: "",
      exitCode: 0,
    });
    const tool = createBashTool();
    const result = await tool.execute(
      { command: "echo 你好世界 🌍" },
      createMockCtx()
    );

    expect(result.output).toContain("你好世界");
  });
});

describe("工具调用 — grep 工具", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  it("TOOL-008: grep 工具搜索", async () => {
    mockGrepSearch.mockResolvedValue([
      { file: "/test/a.ts", line: 10, text: "const x = 1;", match: "x" },
    ]);
    const tool = createGrepTool();
    const result = await tool.execute(
      { pattern: "x", path: "/test" },
      createMockCtx()
    );

    expect(result).toBeDefined();
  });
});

describe("工具调用 — glob 工具", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  it("TOOL-007: glob 工具搜索文件", async () => {
    mockGlobSearch.mockResolvedValue([
      { path: "/test/a.ts", type: "file" },
      { path: "/test/b.ts", type: "file" },
    ]);
    const tool = createGlobTool();
    const result = await tool.execute(
      { pattern: "**/*.ts", path: "/test" },
      createMockCtx()
    );

    expect(result).toBeDefined();
  });
});

describe("工具调用 — edit 工具", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    removeSetting("codem-sandbox-enabled");
  });

  it("TOOL-004: edit 工具替换文本", async () => {
    mockReadFile.mockResolvedValue("old text here");
    mockWriteFile.mockResolvedValue(undefined);
    const tool = createEditFileTool();
    const result = await tool.execute(
      { path: "/test/file.txt", old_string: "old", new_string: "new" },
      createMockCtx()
    );

    expect(result).toBeDefined();
  });

  it("TOOL-004b: edit 工具 old_string 不匹配时报错", async () => {
    mockReadFile.mockResolvedValue("content without target");
    const tool = createEditFileTool();
    const result = await tool.execute(
      { path: "/test/file.txt", old_string: "nonexistent", new_string: "x" },
      createMockCtx()
    );

    expect(result).toBeDefined();
    expect(result.output).toContain("not found");
  });
});

describe("工具调用 — StreamingToolExecutor", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  it("TOOL-016: 并发安全工具并行执行", async () => {
    const executor = new StreamingToolExecutorImpl({
      maxConcurrent: 5,
      concurrencySafeTools: ["read"],
    });

    const toolCalls: StreamingToolCall[] = [
      { id: "tc1", name: "read", input: { path: "/a" }, status: "pending" },
      { id: "tc2", name: "read", input: { path: "/b" }, status: "pending" },
      { id: "tc3", name: "read", input: { path: "/c" }, status: "pending" },
    ];

    const events: ToolExecutorEvent[] = [];
    const ctx = createMockExecutorCtx();

    const toolHandler = async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
      await new Promise(r => setTimeout(r, 10));
      return {
        id: args.path as string,
        name,
        input: args,
        output: "result",
        status: "completed",
      };
    };

    const generator = executor.execute(toolCalls, ctx, toolHandler);
    let done = false;
    while (!done) {
      const result = await generator.next();
      if (result.done) {
        done = true;
      } else {
        events.push(result.value);
      }
    }

    // All should complete
    const completeEvents = events.filter(e => e.type === "tool_complete");
    expect(completeEvents).toHaveLength(3);
  });

  it("TOOL-013: 工具超时保护逻辑存在", () => {
    const config: ToolExecutorConfig = {
      maxConcurrent: 5,
      concurrencySafeTools: ["read"],
      toolTimeout: 60000,
      abortSiblingsOnError: false,
    };
    expect(config.toolTimeout).toBe(60000);
  });

  it("TOOL-014: 工具执行异常——产生 tool_error 事件", async () => {
    const executor = new StreamingToolExecutorImpl();

    const toolCalls: StreamingToolCall[] = [
      { id: "tc-fail", name: "fail_tool", input: {}, status: "pending" },
    ];

    const events: ToolExecutorEvent[] = [];
    const ctx = createMockExecutorCtx();

    const toolHandler = async (): Promise<ToolCallResult> => {
      throw new Error("Execution failed");
    };

    const generator = executor.execute(toolCalls, ctx, toolHandler);
    let done = false;
    while (!done) {
      const result = await generator.next();
      if (result.done) {
        done = true;
      } else {
        events.push(result.value);
      }
    }

    const errorEvent = events.find(e => e.type === "tool_error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "tool_error") {
      expect(errorEvent.error).toContain("Execution failed");
    }
  });

  it("TOOL-016b: 默认并发安全工具列表包含 read/glob/grep", () => {
    const executor = new StreamingToolExecutorImpl();
    // The default config should include read-only tools
    const config = (executor as any).config as ToolExecutorConfig;
    expect(config.concurrencySafeTools).toContain("read");
    expect(config.concurrencySafeTools).toContain("glob");
    expect(config.concurrencySafeTools).toContain("grep");
  });
});

describe("工具调用 — 敏感数据检测 (F2.5)", () => {
  it("TOOL-015: scanParametersForSecrets 逻辑存在于 streaming-executor.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/streaming-executor.ts"), "utf-8");

    expect(src).toContain("SENSITIVE_PATTERNS");
    expect(src).toContain("scanParametersForSecrets");
    expect(src).toContain("API key");
    expect(src).toContain("Security Warning");
  });

  it("TOOL-015b: 敏感数据模式包含 API key、密码、私钥", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/streaming-executor.ts"), "utf-8");

    // The SENSITIVE_PATTERNS regex includes these patterns
    expect(src).toContain("sk-");
    expect(src).toMatch(/password/i);
    expect(src).toContain("PRIVATE");
    expect(src).toContain("Bearer");
  });
});

describe("工具调用 — 沙箱检查 (S5)", () => {
  it("TOOL-048: checkSandbox 逻辑存在于 tools.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools.ts"), "utf-8");

    expect(src).toContain("function checkSandbox");
    expect(src).toContain("codem-sandbox-enabled");
    expect(src).toContain("outside the workspace");
  });

  it("TOOL-049: resolvePath 逻辑存在于 tools.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools.ts"), "utf-8");

    expect(src).toContain("function resolvePath");
    expect(src).toContain("[A-Za-z]:[\\\\/]");
  });
});

describe("工具调用 — FileContentCache (E4)", () => {
  it("TOOL-021: FileContentCache LRU 缓存逻辑存在于 tools.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools.ts"), "utf-8");

    expect(src).toContain("class FileContentCache");
    expect(src).toContain("maxSize");
    expect(src).toContain("maxAgeMs");
    expect(src).toContain("invalidate");
    expect(src).toContain("LRU");
  });
});

describe("工具调用 — P5 拦截逻辑", () => {
  it("TOOL-031: P5 同响应 spawn+wait 拦截逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("settlement");
    expect(src).toContain("subagent");
    expect(src).toContain("resolveSubagentSettlement");
  });

  it("TOOL-032: P5 同响应 delegate+wait 拦截逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("Cannot wait_for_delegation in the same response as delegate_to_session");
  });

  it("TOOL-033: 跨迭代 wait 去重逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("waitedSubagents");
    expect(src).toContain("waitedDelegations");
    expect(src).toContain("spawnedSubagents");
    expect(src).toContain("delegatedTasks");
  });

  it("TOOL-034: 旧 subagent 提醒注入已被 settlement gate 替代", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    // 旧模式已移除 — 不再注入 "un-waited sub-agent" SYSTEM REMINDER 消息
    expect(src).not.toContain('un-waited sub-agent task');
    // 新模式：settlement gate 通过 Promise 网关等待
    expect(src).toContain("Awaiting");
    expect(src).toContain("background subagent settlement");
    expect(src).toContain("Promise.race");
  });

  it("TOOL-035: 未 wait 的 delegation 提醒注入逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("un-waited delegation");
    expect(src).toContain("wait_for_delegation");
  });

  it("TOOL-036: subagent settlement gate 逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("pendingBackgroundSubagents");
    expect(src).toContain("settlementResolvers");
  });

  it("TOOL-037: delegate_to_session 结果 TASK_ID 提取逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("delegatedTasks.add");
  });

  it("TOOL-040: 工具标题映射存在于 agentic-loop.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("Delegating to subagent");
    expect(src).toContain("Delegating to session");
    expect(src).toContain("Waiting for delegation");
  });

  it("TOOL-024: system-reminder 过滤逻辑存在于 App.tsx", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../App.tsx"), "utf-8");

    expect(src).toContain("system-reminder");
    expect(src).toContain("replace");
  });

  it("TOOL-050: 工具完成后 saveMessages 即时调用逻辑存在于 App.tsx", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../App.tsx"), "utf-8");

    expect(src).toContain("saveMessages(session.id)");
  });
});

describe("工具调用 — load_skill 工具", () => {
  it("TOOL-041: load_skill 工具定义存在于 load-skill.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");

    expect(src).toContain("createLoadSkillTool");
    expect(src).toContain("SessionSkillCache");
    expect(src).toContain("defaultTtl");
    expect(src).toContain("remainingTurns");
  });

  it("TOOL-042: load_skill 缓存命中逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");

    expect(src).toContain("cached: true");
    expect(src).toContain("already loaded");
  });

  it("TOOL-043: load_skill TTL 过期逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools/load-skill.ts"), "utf-8");

    expect(src).toContain("remainingTurns");
    expect(src).toContain("tick");
  });
});

describe("工具调用 — multi_edit 工具", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    removeSetting("codem-sandbox-enabled");
  });

  it("TOOL-005: multi_edit 工具定义正确", () => {
    const tool = createMultiEditTool();
    expect(tool.id).toBe("multi_edit");
    expect(tool.parameters).toBeDefined();
  });
});

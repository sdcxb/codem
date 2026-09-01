/**
 * 复现测试：完整 Cordis ctx 环境下（llmEngine + agentEngine + agentLoop 全注册）
 * getAgenticLoop 委托 agentLoopProvider，securityMode:"full" 必须生效。
 *
 * 之前 CTX-001 失败是因为 ctx 缺少 'llm' 服务导致 AgenticLoop 构造时
 * "Critical service llm not available" —— 真实环境 App.tsx 会注册所有服务。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockReadFile, mockWriteFile, mockExecuteCommand } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockExecuteCommand: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  exists: vi.fn().mockReturnValue(true),
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  listDirectory: vi.fn().mockReturnValue([]),
  deletePath: vi.fn(),
  globSearch: vi.fn().mockResolvedValue([]),
  grepSearch: vi.fn().mockResolvedValue([]),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
  getAppDataDir: vi.fn().mockResolvedValue("C:\\AppData"),
}));

import { initDatabase, resetDatabase } from "../core/storage/database";
import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";
import * as MessageStorage from "../core/storage/message";
import { LLMEngine, getLLMEngine } from "../core/llm";
import { agentLoopProvider } from "../core/provider/agent-loop-provider";
import { agentEngineProvider } from "../core/provider/agent-engine-provider";
import { getEffectiveSecurityMode, setProjectSecurityMode } from "../core/permission/security-mode";

const PROJECT_PATH = "C:\\proj-ctx2";
const PROJECT_ID = "proj-ctx2";
const SESSION_ID = "sess-ctx2";
const TARGET_FILE = "C:\\proj-ctx2\\target.txt";
const OLD_CONTENT = "旧的文件内容，与即将写入的新内容完全不同，确保相似度低于阈值";
const NEW_CONTENT = "全新的文件内容，用于触发覆盖确认流程，与旧内容毫无相似之处";

class ScriptedProvider {
  id = "mock-provider";
  name = "Mock";
  config: any = { apiKey: "sk-test", models: [{ id: "mock-model", contextWindow: 128000 }] };
  dynamicModels: any[] | null = null;
  private queue: any[][] = [];

  setScript(scripts: any[][]) {
    this.queue = scripts;
  }

  isConfigured() {
    return true;
  }

  async *stream(_request: any): AsyncGenerator<any> {
    const script = this.queue.length > 0 ? this.queue.shift()! : [
      { type: "text_delta", text: "（脚本耗尽）" },
      { type: "end", finishReason: "stop" },
    ];
    for (const event of script) {
      yield event;
    }
  }

  async complete(_request: any) {
    return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }

  async listModels() {
    return [{ id: "mock-model", name: "Mock Model", contextWindow: 128000, maxOutputTokens: 4096, supportsTools: true, supportsStreaming: true }];
  }

  async fetchModelsFromServer() {
    return this.listModels();
  }
}

function writeToolCallEvents(callId: string): any[] {
  return [
    { type: "tool_use_start", id: callId, name: "write" },
    {
      type: "tool_use_delta",
      id: callId,
      input: JSON.stringify({ path: TARGET_FILE, content: NEW_CONTENT }),
    },
    { type: "tool_use_end", id: callId, input: { path: TARGET_FILE, content: NEW_CONTENT } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function textResponseEvents(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

describe("复现：完整 Cordis ctx 委托路径 securityMode", () => {
  let engine: LLMEngine;
  let provider: ScriptedProvider;
  let onWriteConfirmCalls: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();

    ProjectStorage.createProject({
      id: PROJECT_ID,
      name: "复现项目",
      path: PROJECT_PATH,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: "复现会话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path === TARGET_FILE) return Promise.resolve(OLD_CONTENT);
      return Promise.reject(new Error("ENOENT: " + path));
    });
    mockWriteFile.mockResolvedValue(undefined);
    mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    onWriteConfirmCalls = 0;
    provider = new ScriptedProvider();
  });

  it("CTX2-001: 完整 ctx（llmEngine+agentEngine+agentLoop）下 full 模式 write 直接成功", async () => {
    // 构造真实 ctx（模拟 App.tsx 的注册流程）
    const services = new Map<string, any>();
    const ctx: any = {
      provide(name: string, svc: any) {
        services.set(name, svc);
        return () => services.delete(name);
      },
      get(name: string) {
        return services.get(name);
      },
    };

    // 1. 注册 llmEngine（App.tsx 行为）
    const engineWithCtx = new LLMEngine({}, undefined, ctx);
    ctx.provide("llmEngine", engineWithCtx);
    engine = engineWithCtx;
    engine.providers.register(provider as any);
    (engine as any).config.defaultProvider = "mock-provider";
    (engine as any).config.defaultModel = "mock-model";

    // AgenticLoop.checkCriticalServices 要求 llm/tools/messageStorage 三个服务存在
    // （真实环境由 App.tsx 注册；测试环境补注册避免 critical_service_unavailable 提前停止）
    ctx.provide("llm", provider);
    ctx.provide("tools", { list: () => [], get: () => undefined, has: () => false, register: () => {} });
    ctx.provide("messageStorage", MessageStorage);

    // 2. 注册 agentEngine（依赖 llmEngine）
    agentEngineProvider(ctx as any);
    // 3. 注册 agentLoop（依赖 agentEngine）
    agentLoopProvider(ctx as any);

    // 模拟用户设置项目级 full
    setProjectSecurityMode(PROJECT_PATH, "full");
    expect(getEffectiveSecurityMode(PROJECT_PATH)).toBe("full");

    let rejectedText = false;
    provider.setScript([
      writeToolCallEvents("tc-ctx2-full"),
      textResponseEvents("已写入完成"),
    ]);
    for await (const event of engine.process(SESSION_ID, "请写入文件", PROJECT_PATH, undefined, {
      securityMode: "full",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    })) {
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
    }

    expect(rejectedText).toBe(false);
    expect(onWriteConfirmCalls).toBe(0);
    const targetWrites = mockWriteFile.mock.calls.filter((c: any[]) => c[0] === TARGET_FILE);
    expect(targetWrites.length).toBe(1);
  });

  it("CTX2-002: 同一 session 先 ask 拒绝后切 full（ctx 委托 + 复用）→ write 成功", async () => {
    const services = new Map<string, any>();
    const ctx: any = {
      provide(name: string, svc: any) {
        services.set(name, svc);
        return () => services.delete(name);
      },
      get(name: string) {
        return services.get(name);
      },
    };

    const engineWithCtx = new LLMEngine({}, undefined, ctx);
    ctx.provide("llmEngine", engineWithCtx);
    engine = engineWithCtx;
    engine.providers.register(provider as any);
    (engine as any).config.defaultProvider = "mock-provider";
    (engine as any).config.defaultModel = "mock-model";

    // AgenticLoop.checkCriticalServices 要求 llm/tools/messageStorage 三个服务存在
    ctx.provide("llm", provider);
    ctx.provide("tools", { list: () => [], get: () => undefined, has: () => false, register: () => {} });
    ctx.provide("messageStorage", MessageStorage);

    agentEngineProvider(ctx as any);
    agentLoopProvider(ctx as any);

    // Run#1: ask 拒绝
    provider.setScript([writeToolCallEvents("tc-ctx2-ask")]);
    for await (const event of engine.process(SESSION_ID, "请写入", PROJECT_PATH, undefined, {
      securityMode: "ask",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    })) {
      // drain
    }
    expect(onWriteConfirmCalls).toBe(1);

    // 切 full
    setProjectSecurityMode(PROJECT_PATH, "full");
    let rejectedText = false;
    provider.setScript([
      writeToolCallEvents("tc-ctx2-full2"),
      textResponseEvents("已写入完成"),
    ]);
    for await (const event of engine.process(SESSION_ID, "请重新写入", PROJECT_PATH, undefined, {
      securityMode: "full",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    })) {
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
    }

    expect(rejectedText).toBe(false);
    expect(onWriteConfirmCalls).toBe(1);
    const targetWrites = mockWriteFile.mock.calls.filter((c: any[]) => c[0] === TARGET_FILE);
    expect(targetWrites.length).toBe(1);
  });
});

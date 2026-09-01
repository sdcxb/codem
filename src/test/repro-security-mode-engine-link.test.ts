/**
 * 复现测试：LLMEngine.process 完整链路下，full 模式写操作仍被审批层拦截
 *
 * REPRO-001 只测了 AgenticLoop 层（直接 new AgenticLoop + updateConfig）。
 * 真实链路是：App.tsx → engine.process({securityMode}) → getAgenticLoop
 * → loop.updateConfig → loop.run → tools.ts write 工具读 ctx.securityMode。
 *
 * 用户场景：清理 codem-db.bin 后重新初始化，无论 ask/auto/full 都报
 * "写入已被拒绝。用户未确认文件覆盖"（writeRejected 分支），且无弹窗。
 *
 * 本测试验证 LLMEngine.process 传 securityMode:"full" 后：
 * 1. loop.config.securityMode === "full"
 * 2. write 工具不再触发 onWriteConfirm
 * 3. 不输出"写入已被拒绝"
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
}));

import { initDatabase, resetDatabase } from "../core/storage/database";
import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";
import { LLMEngine } from "../core/llm";

const PROJECT_ID = "proj-engine-link";
const SESSION_ID = "sess-engine-link";
const TARGET_FILE = "C:\\repro-engine\\target.txt";
const OLD_CONTENT = "旧的文件内容，与即将写入的新内容完全不同，确保相似度低于阈值";
const NEW_CONTENT = "全新的文件内容，用于触发覆盖确认流程，与旧内容毫无相似之处";

/** 事件脚本驱动的 mock provider — 每次 stream() 调用消费一个脚本 */
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

function setupProjectAndSession(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID,
    name: "复现项目",
    path: "C:\\repro-engine",
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
}

describe("复现：LLMEngine.process 完整链路 full 模式写操作被拦截", () => {
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
    setupProjectAndSession();

    mockReadFile.mockImplementation((path: string) => {
      if (path === TARGET_FILE) return Promise.resolve(OLD_CONTENT);
      return Promise.reject(new Error("ENOENT: " + path));
    });
    mockWriteFile.mockResolvedValue(undefined);
    mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    onWriteConfirmCalls = 0;
    provider = new ScriptedProvider();

    engine = new LLMEngine();
    // 注册 mock provider 并设为默认，走 getAgenticLoop → resolveSlot 链路
    engine.providers.register(provider as any);
    (engine as any).config.defaultProvider = "mock-provider";
    (engine as any).config.defaultModel = "mock-model";
  });

  it("ENGINE-001: process({securityMode:'full'}) → loop.config.securityMode === 'full'", async () => {
    const events: any[] = [];
    provider.setScript([
      textResponseEvents("直接回答，不调用工具"),
    ]);
    for await (const event of engine.process(SESSION_ID, "你好", "C:\\repro-engine", undefined, {
      securityMode: "full",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    })) {
      events.push(event);
    }
    // 从 loopPool 取 loop 验证 config
    const loop = (engine as any).loopPool.get(SESSION_ID);
    expect(loop).toBeDefined();
    expect(loop.config.securityMode).toBe("full");
  });

  it("ENGINE-002: process({securityMode:'full'}) → write 直接成功，不触发 onWriteConfirm", async () => {
    const events: any[] = [];
    let rejectedText = false;
    provider.setScript([
      writeToolCallEvents("tc-full"),
      textResponseEvents("已写入完成"),
    ]);
    for await (const event of engine.process(SESSION_ID, "请写入文件", "C:\\repro-engine", undefined, {
      securityMode: "full",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    })) {
      events.push(event);
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
    }

    expect(rejectedText).toBe(false);
    expect(onWriteConfirmCalls).toBe(0);
    const targetWrites = mockWriteFile.mock.calls.filter((c: any[]) => c[0] === TARGET_FILE);
    expect(targetWrites.length).toBe(1);
  });

  it("ENGINE-003: 同一 session 先 ask 拒绝后切 full（loopPool 复用），write 应直接成功", async () => {
    // Run #1: ask 模式，用户拒绝 → writeRejected
    const events1: any[] = [];
    provider.setScript([writeToolCallEvents("tc-ask")]);
    for await (const event of engine.process(SESSION_ID, "请写入", "C:\\repro-engine", undefined, {
      securityMode: "ask",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    })) {
      events1.push(event);
    }
    expect(onWriteConfirmCalls).toBe(1);

    // 切换 full（App.tsx 事件 → setSecurityMode → 下次 process 传 full）
    const events2: any[] = [];
    let rejectedText = false;
    provider.setScript([
      writeToolCallEvents("tc-full2"),
      textResponseEvents("已写入完成"),
    ]);
    for await (const event of engine.process(SESSION_ID, "请重新写入", "C:\\repro-engine", undefined, {
      securityMode: "full",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    })) {
      events2.push(event);
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
    }

    expect(rejectedText).toBe(false);
    expect(onWriteConfirmCalls).toBe(1); // 没有新增确认调用
    const targetWrites = mockWriteFile.mock.calls.filter((c: any[]) => c[0] === TARGET_FILE);
    expect(targetWrites.length).toBe(1);
  });
});

/**
 * 复现测试：项目级 securityMode 完整链路（设置 → 读取 → engine.process → write）
 *
 * 用户场景：清理 codem-db.bin 后，选择"完全访问"仍报"写入已被拒绝"。
 * 检查项目级模式写入后，App.tsx 读取 getEffectiveSecurityMode(currentProject.path)
 * 是否能拿到 full，并真正传到 engine。
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
import { setProjectSecurityMode, getEffectiveSecurityMode, setGlobalSecurityMode } from "../core/permission/security-mode";

const PROJECT_PATH = "C:\\proj-full-mode";
const PROJECT_ID = "proj-full-mode";
const SESSION_ID = "sess-full-mode";
const TARGET_FILE = "C:\\proj-full-mode\\target.txt";
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

describe("复现：项目级 full 模式完整链路", () => {
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
    engine = new LLMEngine();
    engine.providers.register(provider as any);
    (engine as any).config.defaultProvider = "mock-provider";
    (engine as any).config.defaultModel = "mock-model";
  });

  it("PROJ-001: 项目级 full 写入后 getEffectiveSecurityMode(项目路径) 返回 full，且 engine 收到 full", async () => {
    // 模拟用户在 InputArea 选择"完全访问"（有项目 → 项目级）
    setProjectSecurityMode(PROJECT_PATH, "full");
    expect(getEffectiveSecurityMode(PROJECT_PATH)).toBe("full");

    // 模拟 App.tsx: securityMode state = getEffectiveSecurityMode(currentProject?.path)
    const appSecurityMode = getEffectiveSecurityMode(PROJECT_PATH);
    expect(appSecurityMode).toBe("full");

    const events: any[] = [];
    let rejectedText = false;
    provider.setScript([
      writeToolCallEvents("tc-proj-full"),
      textResponseEvents("已写入完成"),
    ]);
    for await (const event of engine.process(SESSION_ID, "请写入文件", PROJECT_PATH, undefined, {
      securityMode: appSecurityMode,
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

  it("PROJ-002: 项目级 ask + 全局 full → 项目级优先，engine 收到 ask（写需确认）", async () => {
    setGlobalSecurityMode("full");
    setProjectSecurityMode(PROJECT_PATH, "ask");
    expect(getEffectiveSecurityMode(PROJECT_PATH)).toBe("ask");

    const appSecurityMode = getEffectiveSecurityMode(PROJECT_PATH);
    expect(appSecurityMode).toBe("ask");

    let rejectedText = false;
    provider.setScript([
      writeToolCallEvents("tc-proj-ask"),
      textResponseEvents("已写入完成"),
    ]);
    for await (const event of engine.process(SESSION_ID, "请写入文件", PROJECT_PATH, undefined, {
      securityMode: appSecurityMode,
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    })) {
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
    }

    expect(rejectedText).toBe(true);
    expect(onWriteConfirmCalls).toBe(1);
    const targetWrites = mockWriteFile.mock.calls.filter((c: any[]) => c[0] === TARGET_FILE);
    expect(targetWrites.length).toBe(0);
  });
});

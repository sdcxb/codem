/**
 * 复现测试：模拟 App.tsx 完整 UI 逻辑（清理 DB 后选择 full）
 *
 * 用户报告：清理 codem-db.bin 后重新初始化，编辑框下方选择"完全访问"，
 * UI 显示已切换，但写操作仍报"写入已被拒绝"，且没有任何审批界面出现。
 *
 * 本测试模拟 App.tsx 的 securityMode state 生命周期：
 * 1. 清理 DB（settings 空）→ useState 初始值 = getEffectiveSecurityMode(...) = "ask"
 * 2. 用户在 InputArea 选择 full → onModeChange → setProjectSecurityMode/setGlobalSecurityMode
 *    → dispatch codem-security-mode-changed 事件
 * 3. App.tsx 监听事件 → setSecurityMode(getEffectiveSecurityMode(currentProject?.path))
 * 4. engine.process({ securityMode }) → write 应直接成功
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
import {
  getEffectiveSecurityMode,
  setGlobalSecurityMode,
  setProjectSecurityMode,
  getGlobalSecurityMode,
} from "../core/permission/security-mode";

const PROJECT_PATH = "C:\\proj-ui-sync";
const PROJECT_ID = "proj-ui-sync";
const SESSION_ID = "sess-ui-sync";
const TARGET_FILE = "C:\\proj-ui-sync\\target.txt";
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

/** 模拟 App.tsx 的 securityMode state 生命周期（清理 DB 后首次渲染） */
function simulateAppState(projectPath: string | null): { get: () => string; onModeChange: (m: string) => void } {
  // App.tsx:584 — useState 初始值（挂载时计算一次）
  let state: string = getEffectiveSecurityMode(projectPath ?? undefined);
  // App.tsx:644-650 — 监听 codem-security-mode-changed 事件
  const handler = () => {
    state = getEffectiveSecurityMode(projectPath ?? undefined);
  };
  window.addEventListener("codem-security-mode-changed", handler);
  return {
    get: () => state,
    onModeChange: (m: string) => {
      // InputArea:1216-1220 onModeChange
      // setSecurityMode(m) — InputArea 本地 state（UI 显示立即切换）
      // 然后写 DB + dispatch 事件
      if (projectPath) setProjectSecurityMode(projectPath, m as any);
      else setGlobalSecurityMode(m as any);
    },
  };
}

describe("复现：清理 DB 后 UI 选择 full 未生效", () => {
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

  it("UI-001: 清理 DB 后初始 state 为 ask，选择 full 后 state 变为 full（事件同步）", () => {
    const app = simulateAppState(PROJECT_PATH);
    expect(app.get()).toBe("ask"); // 清理 DB 后默认 ask

    // 用户在 InputArea 选择"完全访问"
    app.onModeChange("full");

    // 事件同步后 App.tsx state 应变为 full
    expect(app.get()).toBe("full");
    expect(getEffectiveSecurityMode(PROJECT_PATH)).toBe("full");
  });

  it("UI-002: 清理 DB 后选择 full → engine.process 收到 full → write 直接成功", async () => {
    const app = simulateAppState(PROJECT_PATH);
    expect(app.get()).toBe("ask");

    // 用户选择 full → state 同步为 full
    app.onModeChange("full");
    expect(app.get()).toBe("full");

    const events: any[] = [];
    let rejectedText = false;
    provider.setScript([
      writeToolCallEvents("tc-ui-full"),
      textResponseEvents("已写入完成"),
    ]);
    for await (const event of engine.process(SESSION_ID, "请写入文件", PROJECT_PATH, undefined, {
      securityMode: app.get() as any,
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

  it("UI-003: 无项目（全局对话）选择 full → engine 收到 full", async () => {
    const app = simulateAppState(null);
    expect(app.get()).toBe("ask");

    app.onModeChange("full");
    expect(app.get()).toBe("full");
    expect(getGlobalSecurityMode()).toBe("full");

    const events: any[] = [];
    let rejectedText = false;
    provider.setScript([
      writeToolCallEvents("tc-ui-global"),
      textResponseEvents("已写入完成"),
    ]);
    for await (const event of engine.process(SESSION_ID, "请写入文件", "C:\\global", undefined, {
      securityMode: app.get() as any,
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
  });
});

/**
 * 复现测试：选择"完全访问"后写操作仍被审批层拦截
 *
 * 用户报告：
 *   对话编辑框下方选择安全策略【请求批准、替我审批、完全访问】，
 *   即使选择了完全访问，写操作/命令被审批层拦截，没弹窗审批，
 *   直接提示"写入已被拒绝。用户未确认文件覆盖"。
 *
 * 场景复刻（主会话链路，loop 按 session 池化复用）：
 *   Run #1: ask 模式，write 覆盖 → onWriteConfirm 返回 reject → loop 停止
 *   用户在编辑框下方切换为"完全访问"
 *   Run #2: engine.process({securityMode:"full"}) → loop.updateConfig → 同一 loop 实例重跑
 *           （模拟 LLMEngine.loopPool 按 sessionId 复用 loop 的真实行为）
 *   预期：write 直接成功，不触发 onWriteConfirm，不输出"写入已被拒绝"
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
import { createDefaultToolRegistry } from "../core/llm/tools";
import { AgenticLoop } from "../core/llm/agentic-loop";

const PROJECT_ID = "proj-secu-repro";
const SESSION_ID = "sess-secu-repro";
const TARGET_FILE = "C:\\repro\\target.txt";
const OLD_CONTENT = "旧的文件内容，与即将写入的新内容完全不同，确保相似度低于阈值";
const NEW_CONTENT = "全新的文件内容，用于触发覆盖确认流程，与旧内容毫无相似之处";

/** 事件脚本驱动的 mock provider — 每次 stream() 调用消费一个脚本 */
class ScriptedProvider {
  id = "mock-provider";
  config: any = {};
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
    path: "C:\\repro",
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

describe("复现：完全访问模式下写操作仍被审批层拦截", () => {
  let provider: ScriptedProvider;
  let loop: AgenticLoop;
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

    // 文件已存在，内容与写入内容完全不同（相似度 < 0.1 → 触发覆盖确认）
    mockReadFile.mockImplementation((path: string) => {
      if (path === TARGET_FILE) return Promise.resolve(OLD_CONTENT);
      return Promise.reject(new Error("ENOENT: " + path));
    });
    mockWriteFile.mockResolvedValue(undefined);
    mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    onWriteConfirmCalls = 0;
    provider = new ScriptedProvider();
    const registry = createDefaultToolRegistry();
    loop = new AgenticLoop(provider as any, registry, {
      maxIterations: 10,
      model: "mock-model",
    });
  });

  it("REPRO-001: ask 模式拒绝后切换 full（同一 loop 复用），write 应直接成功", async () => {
    // ===== Run #1: ask 模式，用户在 Diff 审批中点了"拒绝" =====
    loop.updateConfig({
      securityMode: "ask",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    });
    provider.setScript([
      writeToolCallEvents("tc-run1"),
    ]);

    const events1: any[] = [];
    let result1: any;
    for await (const event of loop.run(SESSION_ID, "请把新内容写入目标文件", "C:\\repro", "system prompt")) {
      events1.push(event);
      if (event.type === "end") result1 = event.result;
    }

    // Run #1 应以 write_rejected_by_user 停止（复现"写入已被拒绝"消息的前置条件）
    expect(result1.reason).toBe("write_rejected_by_user");
    expect(onWriteConfirmCalls).toBe(1);
    const targetWritesRun1 = mockWriteFile.mock.calls.filter((c: any[]) => c[0] === TARGET_FILE);
    expect(targetWritesRun1.length).toBe(0);

    // ===== 用户切换"完全访问"：engine.process 会调用 loop.updateConfig =====
    loop.updateConfig({ securityMode: "full" });

    // ===== Run #2: 同一 loop 实例（loopPool 按 sessionId 复用）重发 =====
    provider.setScript([
      writeToolCallEvents("tc-run2"),
      textResponseEvents("已写入完成"),
    ]);

    const events2: any[] = [];
    let result2: any;
    let rejectedText = false;
    for await (const event of loop.run(SESSION_ID, "请重新写入目标文件", "C:\\repro", "system prompt")) {
      events2.push(event);
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
      if (event.type === "end") result2 = event.result;
    }

    // 核心断言：full 模式下 write 应成功，不再触发确认，更不能出现"写入已被拒绝"
    expect(rejectedText).toBe(false);
    expect(result2.reason).not.toBe("write_rejected_by_user");
    expect(onWriteConfirmCalls).toBe(1); // 没有新增确认调用
    expect(mockWriteFile).toHaveBeenCalledWith(TARGET_FILE, NEW_CONTENT, expect.anything());
  });

  it("REPRO-002: full 模式下 bash 危险命令应直接放行（命令不被审批层拦截）", async () => {
    loop.updateConfig({
      securityMode: "full",
      onPermissionRequest: async () => {
        throw new Error("full 模式不应请求权限审批");
      },
    });
    provider.setScript([
      [
        { type: "tool_use_start", id: "tc-bash", name: "bash" },
        {
          type: "tool_use_delta",
          id: "tc-bash",
          input: JSON.stringify({ command: "rm -rf /tmp/whatever" }),
        },
        { type: "tool_use_end", id: "tc-bash", input: { command: "rm -rf /tmp/whatever" } },
        { type: "end", finishReason: "tool_use" },
      ],
      textResponseEvents("命令已执行"),
    ]);

    let result: any;
    let permissionDeniedText = false;
    for await (const event of loop.run(SESSION_ID, "执行清理命令", "C:\\repro", "system prompt")) {
      if (event.type === "text_delta" && /Permission denied|权限/.test(event.text)) permissionDeniedText = true;
      if (event.type === "end") result = event.result;
    }

    expect(permissionDeniedText).toBe(false);
    expect(result.reason).not.toBe("write_rejected_by_user");
    expect(mockExecuteCommand).toHaveBeenCalled();
  });

  it("REPRO-003: ask 模式 onWriteConfirm 缺失时（子智能体场景），write 不应被拒", async () => {
    // processSubagent 不设置 onWriteConfirm/securityMode —— 子智能体默认 ask
    loop.updateConfig({ securityMode: undefined as any, onWriteConfirm: undefined });
    provider.setScript([
      writeToolCallEvents("tc-sub"),
      textResponseEvents("子智能体写入完成"),
    ]);

    let result: any;
    for await (const event of loop.run(SESSION_ID, "子智能体写入任务", "C:\\repro", "system prompt")) {
      if (event.type === "end") result = event.result;
    }

    // 无确认回调时应直接写入（tools.ts:1101 "proceeding without confirmation"）
    expect(result.reason).not.toBe("write_rejected_by_user");
    expect(mockWriteFile).toHaveBeenCalled();
  });
});

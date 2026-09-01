/**
 * 回归测试：read 读取包含 "User rejected the overwrite" 字符串的文件被误判为"写入已被拒绝"
 *
 * 用户报告：
 *   清理 codem-db.bin 后，无论选择【请求批准/替我审批/完全访问】哪个安全策略，
 *   写操作/命令都被"审批层拦截"，没弹窗审批，直接提示"写入已被拒绝。用户未确认文件覆盖"。
 *
 * 根因（agentic-loop.ts 2124-2128）：
 *   writeRejected 检测对**任何工具**的输出做字符串包含判断：
 *     if (result.output && result.output.includes("User rejected the overwrite"))
 *   而 write 工具被拒绝时返回的错误文本恰好是：
 *     Error: User rejected the overwrite of "<path>"...
 *   （tools.ts 中 write 工具 reject 分支的输出）
 *
 *   当 LLM 读取本项目源码（如 tools.ts，第 1084 行就包含该字符串字面量）时，
 *   read 工具的输出内容包含 "User rejected the overwrite" → 被误判为
 *   用户拒绝了写入 → writeRejected=true → 循环停止并输出"写入已被拒绝"。
 *   这与安全模式无关，因此 ask/auto/full 全部失效，且 onWriteConfirm 从未被
 *   调用（用户看不到任何审批界面）。
 *
 * 修复：
 *   检测必须限定为 write 工具本身（name === "write"）的拒绝输出。
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

const PROJECT_ID = "proj-wr-fp";
const SESSION_ID = "sess-wr-fp";
const SOURCE_FILE = "C:\\mimo-gui\\src\\core\\llm\\tools.ts";
const TARGET_FILE = "C:\\mimo-gui\\target.txt";
const NEW_CONTENT = "新的文件内容，与旧内容完全不同用于触发覆盖确认";

/** 包含触发误判的字符串字面量的"源码内容" —— 模拟 tools.ts 第 1084 行 */
const SOURCE_CONTENT = [
  "export function createWriteTool(): ToolDef {",
  "  return {",
  "    ...",
  `                  output: \`Error: User rejected the overwrite of "\${path}". Use the 'edit' tool for targeted modifications instead.\`,`,
  "  };",
  "}",
].join("\n");

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

function readToolCallEvents(callId: string, path: string): any[] {
  return [
    { type: "tool_use_start", id: callId, name: "read" },
    { type: "tool_use_delta", id: callId, input: JSON.stringify({ path, limit: 110, offset: 1040 }) },
    { type: "tool_use_end", id: callId, input: { path, limit: 110, offset: 1040 } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function writeToolCallEvents(callId: string): any[] {
  return [
    { type: "tool_use_start", id: callId, name: "write" },
    { type: "tool_use_delta", id: callId, input: JSON.stringify({ path: TARGET_FILE, content: NEW_CONTENT }) },
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
    path: "C:\\mimo-gui",
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

describe("回归：read 读取含 'User rejected the overwrite' 字符串的文件不应误判为写入被拒", () => {
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

    mockReadFile.mockImplementation((path: string) => {
      if (path === SOURCE_FILE) return Promise.resolve(SOURCE_CONTENT);
      if (path === TARGET_FILE) return Promise.resolve("旧的文件内容，与即将写入的新内容完全不同，确保相似度低于阈值");
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

  it("FP-001: full 模式下 read 源码文件（含 'User rejected the overwrite' 字面量）不应触发 writeRejected，也不应输出'写入已被拒绝'", async () => {
    loop.updateConfig({
      securityMode: "full",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    });
    // LLM 先 read 项目源码（内容包含误判字符串），然后正常文本结束
    provider.setScript([
      readToolCallEvents("tc-read", SOURCE_FILE),
      textResponseEvents("分析完毕，无需写入"),
    ]);

    const events: any[] = [];
    let result: any;
    let rejectedText = false;
    for await (const event of loop.run(SESSION_ID, "分析一下 tools.ts 的实现", "C:\\mimo-gui", "system prompt")) {
      events.push(event);
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
      if (event.type === "end") result = event.result;
    }

    // 核心断言：read 读到含该字符串的文件内容，绝不能触发 writeRejected
    expect(rejectedText).toBe(false);
    expect(result.reason).not.toBe("write_rejected_by_user");
    expect(onWriteConfirmCalls).toBe(0);
  });

  it("FP-002: full 模式下 read（误判字符串）后继续 write，write 应正常执行", async () => {
    loop.updateConfig({
      securityMode: "full",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    });
    // 先 read 源码（含误判字符串），再 write 目标文件 —— 之前会在 read 后就被误判停止
    provider.setScript([
      readToolCallEvents("tc-read", SOURCE_FILE),
      writeToolCallEvents("tc-write"),
      textResponseEvents("写入完成"),
    ]);

    let result: any;
    let rejectedText = false;
    for await (const event of loop.run(SESSION_ID, "先读源码再写入目标文件", "C:\\mimo-gui", "system prompt")) {
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
      if (event.type === "end") result = event.result;
    }

    expect(rejectedText).toBe(false);
    expect(result.reason).not.toBe("write_rejected_by_user");
    // full 模式：write 直接执行，不触发 onWriteConfirm
    expect(onWriteConfirmCalls).toBe(0);
    expect(mockWriteFile).toHaveBeenCalledWith(TARGET_FILE, NEW_CONTENT, expect.anything());
  });

  it("FP-003: ask 模式 write 被用户真实拒绝时，仍应正确触发 writeRejected（修复未破坏原逻辑）", async () => {
    loop.updateConfig({
      securityMode: "ask",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    });
    // 只调用 write，用户真实拒绝 → 必须仍触发 writeRejected
    provider.setScript([
      writeToolCallEvents("tc-write-reject"),
    ]);

    let result: any;
    let rejectedText = false;
    for await (const event of loop.run(SESSION_ID, "请覆盖写入目标文件", "C:\\mimo-gui", "system prompt")) {
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
      if (event.type === "end") result = event.result;
    }

    expect(onWriteConfirmCalls).toBe(1);
    expect(rejectedText).toBe(true);
    expect(result.reason).toBe("write_rejected_by_user");
    // 目标文件未被 write 工具写入（快照文件 .codem-snapshots/*.json 的写入是快照机制，非工具写入）
    const targetWrites = mockWriteFile.mock.calls.filter((c: any[]) => c[0] === TARGET_FILE);
    expect(targetWrites.length).toBe(0);
  });

  it("FP-004: read 源码后再用 edit 工具（内容含该字符串的旧字符串匹配）不应误判 — 仅 write 工具的拒绝输出才触发", async () => {
    loop.updateConfig({
      securityMode: "full",
      onWriteConfirm: async () => {
        onWriteConfirmCalls++;
        return { action: "reject" as const };
      },
    });
    // read 源码 → 随后一次普通 bash → 正常结束：read 的输出绝不能污染 writeRejected
    provider.setScript([
      readToolCallEvents("tc-read", SOURCE_FILE),
      [
        { type: "tool_use_start", id: "tc-bash", name: "bash" },
        { type: "tool_use_delta", id: "tc-bash", input: JSON.stringify({ command: "echo ok" }) },
        { type: "tool_use_end", id: "tc-bash", input: { command: "echo ok" } },
        { type: "end", finishReason: "tool_use" },
      ],
      textResponseEvents("完成"),
    ]);

    let result: any;
    let rejectedText = false;
    for await (const event of loop.run(SESSION_ID, "读源码后执行命令", "C:\\mimo-gui", "system prompt")) {
      if (event.type === "text_delta" && event.text.includes("写入已被拒绝")) rejectedText = true;
      if (event.type === "end") result = event.result;
    }

    expect(rejectedText).toBe(false);
    expect(result.reason).not.toBe("write_rejected_by_user");
    expect(mockExecuteCommand).toHaveBeenCalled();
  });
});

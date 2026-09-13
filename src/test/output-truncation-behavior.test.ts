/**
 * 行为测试：回复被输出上限截断（finish_reason=length）时，循环**不会**当成"完成"（第 68 波）。
 *
 * 复现用户场景：说"继续之前没完成的任务"，模型吐了半截文字、结束原因是 length，
 * 旧的循环把它当正常完成 → 用户看到"任务又中断了"。现在必须继续（自动续写），
 * 直到模型给出正常结束（stop/tool_use）或续写预算用尽。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

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
  globSearch: vi.fn().mockResolvedValue([]),
  grepSearch: vi.fn().mockResolvedValue([]),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { initDatabase, resetDatabase } from "../core/storage/database";
import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { AgenticLoop } from "../core/llm/agentic-loop";

const SESSION_ID = "sess-trunc-continue";
const PROJECT_ID = "proj-trunc-continue";

/** 脚本化 provider：按顺序给出每一轮的流事件；记录被调用了多少次（= 续写了几次） */
class ScriptedProvider {
  id = "mock-provider";
  config: any = {};
  dynamicModels: any[] | null = null;
  streamCalls = 0;
  private scripts: any[][] = [];

  setScript(scripts: any[][]) {
    this.scripts = scripts;
    this.streamCalls = 0;
  }
  isConfigured() {
    return true;
  }
  async *stream(_request: any): AsyncGenerator<any> {
    this.streamCalls++;
    const script = this.scripts.shift() ?? [
      { type: "text_delta", text: "（脚本耗尽）" },
      { type: "end", finishReason: "stop" },
    ];
    for (const e of script) yield e;
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
}

describe("输出被截断 ⇒ 自动续写（行为）", () => {
  let provider: ScriptedProvider;
  let agentLoop: AgenticLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExecuteCommand.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockWriteFile.mockResolvedValue(undefined);
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    ProjectStorage.createProject({
      id: PROJECT_ID,
      name: "截断续写测试",
      path: "C:\\trunc-test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: "截断续写会话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });
    provider = new ScriptedProvider();
    agentLoop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 12,
      model: "mock-model",
      securityMode: "full",
    });
  });

  async function run() {
    const events: any[] = [];
    for await (const e of agentLoop.run(SESSION_ID, "继续之前没完成的任务", "C:\\trunc-test", "system")) {
      events.push(e);
    }
    return events;
  }

  it("TRUNC-B1: 第一轮 finish_reason=length（纯文本、无工具）→ 不会结束，而是继续请求", async () => {
    provider.setScript([
      [{ type: "text_delta", text: "前半段内容……" }, { type: "end", finishReason: "length" }],
      [{ type: "text_delta", text: "后半段内容，任务完成。" }, { type: "end", finishReason: "stop" }],
    ]);

    const events = await run();
    expect(provider.streamCalls, "截断后必须再请求一次（自动续写）").toBe(2);
    const endEvent = events.find((e) => e.type === "end");
    expect(endEvent.result.reason, "正常结束（不是被截断当成完成）").toBe("completed");
    // 用户能看到"正在续写"的说明，而不是莫名其妙就断了
    expect(events.some((e) => e.type === "text_delta" && /续写/.test(e.text))).toBe(true);
  });

  it("TRUNC-B2: 连续被截断到预算用尽 → 明确停下，理由为 output_truncated", async () => {
    // 每一轮都给 length：4 轮后（首次 + 3 次续写）应当停
    const lengthScript = () => [{ type: "text_delta", text: "又被截断……" }, { type: "end", finishReason: "length" }];
    provider.setScript([lengthScript(), lengthScript(), lengthScript(), lengthScript(), lengthScript(), lengthScript()]);

    const events = await run();
    const endEvent = events.find((e) => e.type === "end");
    expect(endEvent.result.reason).toBe("output_truncated");
    expect(provider.streamCalls, "首次 + 3 次续写 = 4 次请求").toBe(4);
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("\n");
    expect(text, "要告诉用户发生了什么").toMatch(/被截断/);
    expect(text, "并给出下一步建议").toMatch(/append: true|maxTokens/);
  });

  it("TRUNC-B3: 正常回复（stop）不受影响 —— 不会凭空续写", async () => {
    provider.setScript([
      [{ type: "text_delta", text: "任务已经完成。" }, { type: "end", finishReason: "stop" }],
    ]);
    const events = await run();
    expect(provider.streamCalls).toBe(1);
    expect(events.find((e) => e.type === "end").result.reason).toBe("completed");
  });
});

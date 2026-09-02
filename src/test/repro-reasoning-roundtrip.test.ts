/**
 * 回归测试：DeepSeek thinking mode 要求历史 assistant 消息的 reasoning_content
 * 必须回传 API —— 之前剥离导致 HTTP 400
 *   "The `reasoning_content` in the thinking mode must be passed back to the API."
 *
 * 用户日志（超长会话 860 条消息，迭代 11 连续 3 次 400）：
 *   [Provider] API error: 400 {"error":{"message":"The `reasoning_content` in the
 *   thinking mode must be passed back to the API.",...}}
 *
 * 修复：
 *   1. message.ts messagesToLLMMessages：保留 msg.reasoning 到 LLMMessage.reasoning
 *   2. provider.ts toAPIMessage：assistant 消息带 reasoning 时输出 reasoning_content
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";
import * as MessageStorage from "../core/storage/message";
import { messagesToLLMMessages } from "../core/storage/message";
import { OpenAICompatibleProvider } from "../core/llm/provider";

const PROJECT_ID = "proj-reason-rb";
const SESSION_ID = "sess-reason-rb";

function makeProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "deepseek-test",
    name: "DeepSeek Test",
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com/v1",
    models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
  });
}

function setup(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID, name: "推理回传项目", path: "C:\\reason",
    createdAt: Date.now(), lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SESSION_ID, projectId: PROJECT_ID, title: "推理回传会话",
    createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  });
}

describe("DeepSeek thinking mode: reasoning_content 必须回传 API", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setup();
  });

  it("RB-001: messagesToLLMMessages 保留 assistant 的 reasoning 字段（不再剥离）", async () => {
    MessageStorage.createMessage({
      id: "a1", role: "assistant",
      content: "我来分析这个项目结构",
      reasoning: "用户想改造终端，我需要先理解现有实现。\n第一步：查看终端相关组件。",
      timestamp: 1, status: "done",
      toolCalls: [{ id: "tc1", tool: "bash", args: { command: "ls" }, result: "src", status: "done" }],
    }, SESSION_ID);

    const raw = MessageStorage.listMessages(SESSION_ID);
    const llm = messagesToLLMMessages(raw);
    const assistant = llm.find((m: any) => m.role === "assistant" && m.id === "a1");
    expect(assistant).toBeDefined();
    // 关键断言：reasoning 必须保留
    expect(assistant.reasoning).toContain("用户想改造终端");
    expect(assistant.reasoning).toContain("第一步");
  });

  it("RB-002: provider toAPIMessage 输出 reasoning_content（字符串 content 路径）", async () => {
    const provider = makeProvider();
    const apiMsg = (provider as any).toAPIMessage({
      id: "a1",
      role: "assistant",
      content: "分析结果",
      reasoning: "思考过程：需要回传",
    });
    expect(apiMsg.role).toBe("assistant");
    expect(apiMsg.content).toBe("分析结果");
    expect(apiMsg.reasoning_content).toBe("思考过程：需要回传");
  });

  it("RB-003: 无 reasoning 的 assistant 消息不输出 reasoning_content 字段", async () => {
    const provider = makeProvider();
    const apiMsg = (provider as any).toAPIMessage({
      id: "a2",
      role: "assistant",
      content: "普通回复",
    });
    expect(apiMsg.reasoning_content).toBeUndefined();
  });

  it("RB-004: 完整链路 — DB 消息 → messagesToLLMMessages → toAPIMessage 含 reasoning_content", async () => {
    MessageStorage.createMessage({
      id: "a2", role: "assistant",
      content: "改造 TitleBar",
      reasoning: "TitleBar 需要显示执行模式切换按钮。",
      timestamp: 2, status: "done",
    }, SESSION_ID);

    const raw = MessageStorage.listMessages(SESSION_ID);
    const llm = messagesToLLMMessages(raw);
    const assistant = llm.find((m: any) => m.role === "assistant" && m.id === "a2");

    const provider = makeProvider();
    const apiMsg = (provider as any).toAPIMessage(assistant);
    expect(apiMsg.reasoning_content).toContain("TitleBar");
  });
});

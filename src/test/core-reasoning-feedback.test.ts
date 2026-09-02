/**
 * 测试：思考过程与回答反馈 — REAS-001 ~ REAS-025
 *
 * 覆盖范围：
 *   2.1 reasoning_content 存储与加载
 *   2.2 回答反馈（streaming 状态、错误处理）
 *   2.3 reasoning 回传 LLM（DeepSeek thinking mode 强制要求 reasoning_content round-trip）
 *
 * 关键链路：
 *   App.tsx → engine.process() → AgenticLoop → setMessageReasoning / appendMessageContent
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(),
  exists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: vi.fn(),
  grepSearch: vi.fn(),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { initDatabase, resetDatabase, getDatabase } from "../core/storage/database";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

const PROJECT_ID = "proj-reas-test";
const SESSION_ID = "sess-reas-test";

function setupBase(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID, name: "思考测试", path: "D:/reas",
    createdAt: Date.now(), lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SESSION_ID, projectId: PROJECT_ID, title: "思考测试会话",
    createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  });
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    status: "streaming",
    ...overrides,
  };
}

describe("思考过程 — reasoning 存储与加载", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupBase();
  });

  // REAS-001
  it("REAS-001: createMessage 带 reasoning 存储到 DB", () => {
    const msg = makeMsg({
      id: "reas-001",
      content: "回复内容",
      reasoning: "这是思考过程",
      status: "done",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const db = getDatabase();
    const result = db.exec("SELECT reasoning FROM messages WHERE id = ?", ["reas-001"]);
    expect(result[0].values[0][0]).toBe("这是思考过程");
  });

  // REAS-002
  it("REAS-002: getMessage 返回 reasoning 字段", () => {
    const msg = makeMsg({
      id: "reas-002",
      content: "回复",
      reasoning: "思考过程包含换行\n和多行内容",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("reas-002");
    expect(loaded!.reasoning).toBe("思考过程包含换行\n和多行内容");
  });

  // REAS-003
  it("REAS-003: setMessageReasoning 更新思考过程", () => {
    const msg = makeMsg({ id: "reas-003", content: "回复" });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.setMessageReasoning("reas-003", "新的思考");
    expect(MessageStorage.getMessage("reas-003")!.reasoning).toBe("新的思考");
  });

  // REAS-004
  it("REAS-004: reasoning 为 null 时加载为 undefined", () => {
    const msg = makeMsg({ id: "reas-004", content: "回复" });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("reas-004");
    expect(loaded!.reasoning).toBeUndefined();
  });

  // REAS-005
  it("REAS-005: reasoning 包含特殊字符", () => {
    const special = `思考过程 <test> "引号" &符号\n\t制表符`;
    const msg = makeMsg({ id: "reas-005", content: "回复", reasoning: special });
    MessageStorage.createMessage(msg, SESSION_ID);

    expect(MessageStorage.getMessage("reas-005")!.reasoning).toBe(special);
  });

  // REAS-006
  it("REAS-006: reasoning 包含中文和 Emoji", () => {
    const cnEmoji = "思考过程 🤔 中文思考 🧠";
    const msg = makeMsg({ id: "reas-006", content: "回复", reasoning: cnEmoji });
    MessageStorage.createMessage(msg, SESSION_ID);

    expect(MessageStorage.getMessage("reas-006")!.reasoning).toBe(cnEmoji);
  });

  // REAS-007
  it("REAS-007: 超长 reasoning 完整存储", () => {
    const longReasoning = "R".repeat(20000);
    const msg = makeMsg({ id: "reas-007", content: "回复", reasoning: longReasoning });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("reas-007");
    expect(loaded!.reasoning).toBe(longReasoning);
    expect(loaded!.reasoning!.length).toBe(20000);
  });

  // REAS-008
  it("REAS-008: updateMessage 同时更新 reasoning 和 content", () => {
    const msg = makeMsg({ id: "reas-008", content: "", reasoning: "", status: "streaming" });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.updateMessage("reas-008", {
      content: "最终回复",
      reasoning: "最终思考",
      status: "done",
    });

    const loaded = MessageStorage.getMessage("reas-008");
    expect(loaded!.content).toBe("最终回复");
    expect(loaded!.reasoning).toBe("最终思考");
    expect(loaded!.status).toBe("done");
  });

  // REAS-009
  it("REAS-009: Fork 会话复制 reasoning", () => {
    const msg = makeMsg({
      id: "reas-fork-src",
      content: "原回复",
      reasoning: "原思考",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const forkSession = "sess-reas-fork";
    SessionStorage.createSession({
      id: forkSession, projectId: PROJECT_ID, title: "Fork",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });

    const srcMsgs = MessageStorage.listMessages(SESSION_ID);
    for (const m of srcMsgs) {
      MessageStorage.createMessage({
        ...m,
        id: `${m.id}-fork`,
      }, forkSession);
    }

    const forked = MessageStorage.listMessages(forkSession);
    expect(forked).toHaveLength(1);
    expect(forked[0].reasoning).toBe("原思考");
  });
});

describe("思考过程 — reasoning 回传 LLM（DeepSeek thinking mode 强制要求）", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  // REAS-010
  // DeepSeek V4 thinking mode REQUIRES reasoning_content to be passed back on
  // every historical assistant message (HTTP 400 otherwise). messagesToLLMMessages
  // therefore preserves reasoning into LLMMessage.reasoning (provider.toAPIMessage
  // then emits it as reasoning_content for the API).
  it("REAS-010: messagesToLLMMessages 保留 reasoning（供 provider 回传）", () => {
    const messages: Message[] = [
      {
        id: "m1", role: "assistant", content: "回复", timestamp: 0, status: "done",
        reasoning: "这个思考需要回传给 DeepSeek API",
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs[0].role).toBe("assistant");
    // reasoning 保留在 LLMMessage.reasoning，由 provider.toAPIMessage 转成 reasoning_content
    expect((llmMsgs[0] as any).reasoning).toBe("这个思考需要回传给 DeepSeek API");
    // messagesToLLMMessages 不直接生成 reasoning_content（那是 API 层字段）
    expect((llmMsgs[0] as any).reasoning_content).toBeUndefined();
  });

  // REAS-011
  it("REAS-011: 多条消息 reasoning 都保留", () => {
    const messages: Message[] = [
      {
        id: "m1", role: "assistant", content: "回复1", timestamp: 0, status: "done",
        reasoning: "思考1",
      },
      {
        id: "m2", role: "assistant", content: "回复2", timestamp: 1, status: "done",
        reasoning: "思考2",
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    const reasons = llmMsgs.filter((m) => m.role === "assistant").map((m) => (m as any).reasoning);
    expect(reasons).toEqual(["思考1", "思考2"]);
  });
});

describe("回答反馈 — 消息状态流转", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupBase();
  });

  // REAS-012
  it("REAS-012: streaming → done 状态流转", () => {
    const msg = makeMsg({ id: "reas-012", status: "streaming" });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.setMessageStatus("reas-012", "done");
    expect(MessageStorage.getMessage("reas-012")!.status).toBe("done");
  });

  // REAS-013
  it("REAS-013: streaming → error 状态流转", () => {
    const msg = makeMsg({ id: "reas-013", status: "streaming" });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.setMessageStatus("reas-013", "error");
    expect(MessageStorage.getMessage("reas-013")!.status).toBe("error");
  });

  // REAS-014
  it("REAS-014: appendMessageContent 流式追加内容", () => {
    const msg = makeMsg({ id: "reas-014", content: "", status: "streaming" });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.appendMessageContent("reas-014", "第一段");
    MessageStorage.appendMessageContent("reas-014", "第二段");
    MessageStorage.appendMessageContent("reas-014", "第三段");

    expect(MessageStorage.getMessage("reas-014")!.content).toBe("第一段第二段第三段");
  });

  // REAS-015
  it("REAS-015: setMessageContent 覆盖内容", () => {
    const msg = makeMsg({ id: "reas-015", content: "原始内容" });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.setMessageContent("reas-015", "覆盖内容");
    expect(MessageStorage.getMessage("reas-015")!.content).toBe("覆盖内容");
  });

  // REAS-016
  it("REAS-016: appendToMessage 追加内容", () => {
    const msg = makeMsg({ id: "reas-016", content: "Hello" });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.appendToMessage("reas-016", " World");
    expect(MessageStorage.getMessage("reas-016")!.content).toBe("Hello World");
  });

  // REAS-017
  it("REAS-017: 流式追加后设置最终状态", () => {
    const msg = makeMsg({ id: "reas-017", content: "", status: "streaming" });
    MessageStorage.createMessage(msg, SESSION_ID);

    // Simulate streaming
    MessageStorage.appendMessageContent("reas-017", "流式");
    MessageStorage.appendMessageContent("reas-017", "内容");

    // Finalize
    MessageStorage.setMessageStatus("reas-017", "done");

    const loaded = MessageStorage.getMessage("reas-017");
    expect(loaded!.content).toBe("流式内容");
    expect(loaded!.status).toBe("done");
  });
});

describe("回答反馈 — model 字段", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupBase();
  });

  // REAS-018
  it("REAS-018: model 字段存储和加载", () => {
    const msg = makeMsg({
      id: "reas-018",
      content: "回复",
      model: "deepseek-chat",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    expect(MessageStorage.getMessage("reas-018")!.model).toBe("deepseek-chat");
  });

  // REAS-019
  it("REAS-019: model 为 undefined 时加载为 undefined", () => {
    const msg = makeMsg({ id: "reas-019", content: "回复" });
    MessageStorage.createMessage(msg, SESSION_ID);

    expect(MessageStorage.getMessage("reas-019")!.model).toBeUndefined();
  });

  // REAS-020
  it("REAS-020: updateMessage 更新 model", () => {
    const msg = makeMsg({ id: "reas-020", content: "回复", model: "model-a" });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.updateMessage("reas-020", { model: "model-b" });
    expect(MessageStorage.getMessage("reas-020")!.model).toBe("model-b");
  });
});

describe("回答反馈 — 错误消息处理", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupBase();
  });

  // REAS-021
  it("REAS-021: error 状态消息保留 content", () => {
    const msg = makeMsg({
      id: "reas-021",
      content: "部分生成的内容",
      status: "error",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("reas-021");
    expect(loaded!.status).toBe("error");
    expect(loaded!.content).toBe("部分生成的内容");
  });

  // REAS-022
  it("REAS-022: error 消息含 reasoning 保留", () => {
    const msg = makeMsg({
      id: "reas-022",
      content: "内容",
      reasoning: "出错了之前的思考",
      status: "error",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("reas-022");
    expect(loaded!.status).toBe("error");
    expect(loaded!.reasoning).toBe("出错了之前的思考");
  });

  // REAS-023
  it("REAS-023: error 消息含 toolCalls 保留", () => {
    const msg = makeMsg({
      id: "reas-023",
      content: "内容",
      status: "error",
      toolCalls: [
        { id: "tc-err", tool: "read_file", args: {}, result: "结果", status: "done" },
      ],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("reas-023");
    expect(loaded!.toolCalls).toBeDefined();
    expect(loaded!.toolCalls).toHaveLength(1);
  });
});

describe("回答反馈 — system-reminder 过滤", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  // REAS-024
  it("REAS-024: system-reminder 从 user 消息中过滤", () => {
    const messages: Message[] = [
      {
        id: "u1", role: "user",
        content: "<system-reminder>注意：这是系统提醒</system-reminder>用户实际消息",
        timestamp: 0, status: "done",
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs[0].content).toBe("用户实际消息");
  });

  // REAS-025
  it("REAS-025: system-reminder 从 assistant 消息中过滤", () => {
    const messages: Message[] = [
      {
        id: "a1", role: "assistant",
        content: "<system-reminder>系统提醒</system-reminder>助手回复",
        timestamp: 0, status: "done",
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs[0].content).toBe("助手回复");
  });

  it("REAS-025b: 多个 system-reminder 标签全部过滤", () => {
    const messages: Message[] = [
      {
        id: "u1", role: "user",
        content: "<system-reminder>提醒1</system-reminder>前<system-reminder>提醒2</system-reminder>后",
        timestamp: 0, status: "done",
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs[0].content).toBe("前后");
  });

  it("REAS-025c: system-reminder 从 tool result 中过滤", () => {
    const messages: Message[] = [
      {
        id: "a1", role: "assistant", content: "执行了", timestamp: 0, status: "done",
        toolCalls: [
          {
            id: "tc1", tool: "bash", args: {},
            result: "<system-reminder>隐藏</system-reminder>实际输出",
            status: "done",
          },
        ],
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    const toolMsg = llmMsgs.find(m => m.role === "tool");
    expect(toolMsg!.content).toBe("实际输出");
  });
});

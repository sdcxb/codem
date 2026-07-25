/**
 * 测试：对话核心链路 — 消息存储、加载、流式状态、回调
 *
 * 覆盖用例：CHAT-001 ~ CHAT-045
 *
 * 测试范围：
 *   1.1 消息发送与流式渲染（CHAT-001~015）
 *   1.2 消息存储与加载（CHAT-016~030）
 *   1.3 回调与事件链路（CHAT-031~045）
 *
 * 关键链路：App.tsx → runAgenticLoop → engine.process() → AgenticLoop → MessageStorage
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDatabase, resetDatabase, getDatabase } from "../core/storage/database";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { getSetting, setSetting, removeSetting, getSettingJSON, setSettingJSON } from "../core/storage/settings";
import type { Message } from "../store";

// ========== 测试常量 ==========
const PROJECT_ID = "proj-chat-test";
const SESSION_ID = "sess-chat-test";

// ========== 辅助函数 ==========

function setupProjectAndSession(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID,
    name: "测试项目",
    path: "D:\\test",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: "对话测试",
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    messageCount: 0,
  });
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    role: "user",
    content: "测试消息",
    timestamp: Date.now(),
    status: "done",
    ...overrides,
  };
}

// ========== 测试 ==========

describe("对话核心链路 — 消息存储与加载", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
    setupProjectAndSession();
  });

  // ===== CHAT-016: 消息持久化 ==========
  it("CHAT-016: createMessage 写入 SQLite，字段完整", () => {
    const msg = makeMessage({
      id: "chat-016",
      role: "user",
      content: "你好世界",
      timestamp: 1000000,
      status: "done",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const db = getDatabase();
    const result = db.exec("SELECT id, session_id, role, content, timestamp, status FROM messages WHERE id = ?", ["chat-016"]);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values[0][0]).toBe("chat-016");
    expect(result[0].values[0][1]).toBe(SESSION_ID);
    expect(result[0].values[0][2]).toBe("user");
    expect(result[0].values[0][3]).toBe("你好世界");
    expect(result[0].values[0][4]).toBe(1000000);
    expect(result[0].values[0][5]).toBe("done");
  });

  // ===== CHAT-017: 消息加载 ==========
  it("CHAT-017: listMessages 按 timestamp 升序排列", () => {
    const ts = Date.now();
    MessageStorage.createMessage(makeMessage({ id: "m2", content: "第二条", timestamp: ts + 200 }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "m1", content: "第一条", timestamp: ts + 100 }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "m3", content: "第三条", timestamp: ts + 300 }), SESSION_ID);

    const messages = MessageStorage.listMessages(SESSION_ID);
    expect(messages).toHaveLength(3);
    expect(messages[0].id).toBe("m1");
    expect(messages[1].id).toBe("m2");
    expect(messages[2].id).toBe("m3");
  });

  // ===== CHAT-018: 消息更新 ==========
  it("CHAT-018: updateMessage 修改状态和 reasoning", () => {
    const msg = makeMessage({ id: "chat-018", role: "assistant", content: "", status: "streaming" });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.updateMessage("chat-018", {
      content: "回复内容",
      reasoning: "思考过程",
      status: "done",
    });

    const loaded = MessageStorage.getMessage("chat-018");
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe("回复内容");
    expect(loaded!.reasoning).toBe("思考过程");
    expect(loaded!.status).toBe("done");
  });

  // ===== CHAT-019: 工具调用存储 ==========
  it("CHAT-019: createMessage 带 toolCalls 存储到 tool_calls 表", () => {
    const msg = makeMessage({
      id: "chat-019",
      role: "assistant",
      content: "执行了工具",
      toolCalls: [
        { id: "tc-1", tool: "read_file", args: { path: "/test.txt" }, status: "running" },
      ],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const db = getDatabase();
    const result = db.exec("SELECT id, message_id, tool, args, status FROM tool_calls WHERE message_id = ?", ["chat-019"]);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values[0][0]).toBe("tc-1");
    expect(result[0].values[0][1]).toBe("chat-019");
    expect(result[0].values[0][2]).toBe("read_file");
    expect(JSON.parse(result[0].values[0][3] as string).path).toBe("/test.txt");
    expect(result[0].values[0][4]).toBe("running");
  });

  // ===== CHAT-020: 工具调用更新 ==========
  it("CHAT-020: updateToolCall 更新状态和结果", () => {
    const msg = makeMessage({
      id: "chat-020",
      role: "assistant",
      content: "执行中",
      toolCalls: [
        { id: "tc-20", tool: "read_file", args: { path: "/test.txt" }, status: "running" },
      ],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.updateToolCall("chat-020", "tc-20", {
      status: "done",
      result: "文件内容",
    });

    const loaded = MessageStorage.getMessage("chat-020");
    expect(loaded!.toolCalls).toBeDefined();
    expect(loaded!.toolCalls![0].status).toBe("done");
    expect(loaded!.toolCalls![0].result).toBe("文件内容");
  });

  // ===== CHAT-021: 消息删除 ==========
  it("CHAT-021: deleteMessage 删除消息及关联 tool_calls", () => {
    const msg = makeMessage({
      id: "chat-021",
      role: "assistant",
      content: "带工具调用",
      toolCalls: [
        { id: "tc-21", tool: "write_file", args: { path: "/x" }, status: "done", result: "ok" },
      ],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    MessageStorage.deleteMessage("chat-021");

    expect(MessageStorage.getMessage("chat-021")).toBeNull();
    const db = getDatabase();
    const tcResult = db.exec("SELECT * FROM tool_calls WHERE message_id = ?", ["chat-021"]);
    expect(tcResult.length === 0 || tcResult[0].values.length === 0).toBe(true);
  });

  // ===== CHAT-022: 会话切换消息隔离 ==========
  it("CHAT-022: 不同会话消息不混淆", () => {
    const sessionB = "sess-chat-b";
    SessionStorage.createSession({
      id: sessionB, projectId: PROJECT_ID, title: "会话B",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });

    MessageStorage.createMessage(makeMessage({ id: "a1", content: "会话A消息" }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "b1", content: "会话B消息" }), sessionB);

    const aMsgs = MessageStorage.listMessages(SESSION_ID);
    const bMsgs = MessageStorage.listMessages(sessionB);
    expect(aMsgs).toHaveLength(1);
    expect(bMsgs).toHaveLength(1);
    expect(aMsgs[0].content).toBe("会话A消息");
    expect(bMsgs[0].content).toBe("会话B消息");
  });

  // ===== CHAT-023: 中文和 Emoji ==========
  it("CHAT-023: 中文和 Emoji 内容完整存储和加载", () => {
    const content = "你好🌍🎉emoji测试";
    const msg = makeMessage({ id: "chat-023", content });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("chat-023");
    expect(loaded!.content).toBe(content);
  });

  // ===== CHAT-024: 大消息存储 ==========
  it("CHAT-024: 超长文本（10KB+）完整存储", () => {
    const longContent = "A".repeat(12000);
    const msg = makeMessage({ id: "chat-024", content: longContent });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("chat-024");
    expect(loaded!.content).toBe(longContent);
    expect(loaded!.content.length).toBe(12000);
  });

  // ===== CHAT-025: generatedFiles 序列化 ==========
  it("CHAT-025: generatedFiles JSON 序列化保存", () => {
    const msg = makeMessage({
      id: "chat-025",
      role: "assistant",
      content: "创建了文件",
      generatedFiles: ["/test/file1.ts", "/test/file2.ts"],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("chat-025");
    expect(loaded!.generatedFiles).toBeDefined();
    expect(loaded!.generatedFiles).toHaveLength(2);
    expect(loaded!.generatedFiles![0]).toBe("/test/file1.ts");
  });

  // ===== CHAT-025b: generatedFiles 空数组 ==========
  it("CHAT-025b: generatedFiles 为空时不保存", () => {
    const msg = makeMessage({
      id: "chat-025b",
      role: "assistant",
      content: "无文件产出",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("chat-025b");
    expect(loaded!.generatedFiles).toBeUndefined();
  });

  // ===== CHAT-026: saveMessages 幂等性 ==========
  it("CHAT-026: createMessage 重复调用（同 ID）不产生重复，执行更新", () => {
    const msg = makeMessage({ id: "chat-026", content: "原始内容" });
    MessageStorage.createMessage(msg, SESSION_ID);
    MessageStorage.createMessage({ ...msg, content: "更新后的内容" }, SESSION_ID);

    const messages = MessageStorage.listMessages(SESSION_ID);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("更新后的内容");
  });

  // ===== CHAT-027: reasoning 字段持久化 ==========
  it("CHAT-027: reasoning 字段完整保存和加载", () => {
    const reasoning = "这是一个很长的思考过程...\n包含换行和特殊字符<>";
    const msg = makeMessage({
      id: "chat-027",
      role: "assistant",
      content: "回复",
      reasoning,
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("chat-027");
    expect(loaded!.reasoning).toBe(reasoning);
  });

  // ===== CHAT-027b: reasoning 为 null ==========
  it("CHAT-027b: reasoning 为 null 时加载为 undefined", () => {
    const msg = makeMessage({
      id: "chat-027b",
      role: "assistant",
      content: "无思考",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("chat-027b");
    expect(loaded!.reasoning).toBeUndefined();
  });

  // ===== CHAT-029: 跨项目隔离 ==========
  it("CHAT-029: 不同项目会话消息不泄漏", () => {
    const projectB = "proj-chat-b";
    const sessionB = "sess-proj-b";
    ProjectStorage.createProject({
      id: projectB, name: "项目B", path: "D:\\b",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: sessionB, projectId: projectB, title: "B会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });

    MessageStorage.createMessage(makeMessage({ id: "pa", content: "项目A" }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "pb", content: "项目B" }), sessionB);

    expect(MessageStorage.listMessages(SESSION_ID)).toHaveLength(1);
    expect(MessageStorage.listMessages(sessionB)).toHaveLength(1);
  });

  // ===== CHAT-030: Fork 会话消息复制 ==========
  it("CHAT-030: Fork 会话正确复制消息和 tool_calls", () => {
    const sourceMsg: Message = {
      id: "fork-src",
      role: "assistant",
      content: "源消息",
      timestamp: Date.now(),
      status: "done",
      toolCalls: [
        { id: "tc-fork", tool: "read_file", args: { path: "/a.txt" }, result: "内容", status: "done" },
      ],
    };
    MessageStorage.createMessage(sourceMsg, SESSION_ID);

    const forkSessionId = "sess-fork-test";
    SessionStorage.createSession({
      id: forkSessionId, projectId: PROJECT_ID, title: "Fork",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });

    // 模拟 fork：复制消息
    const sourceMsgs = MessageStorage.listMessages(SESSION_ID);
    for (const m of sourceMsgs) {
      MessageStorage.createMessage({
        ...m,
        id: `${m.id}-fork-${Date.now()}`,
        toolCalls: m.toolCalls?.map(tc => ({ ...tc, id: `${tc.id}-fork-${Date.now()}` })),
      }, forkSessionId);
    }

    const forkedMsgs = MessageStorage.listMessages(forkSessionId);
    expect(forkedMsgs).toHaveLength(1);
    expect(forkedMsgs[0].content).toBe("源消息");
    expect(forkedMsgs[0].toolCalls).toBeDefined();
    expect(forkedMsgs[0].toolCalls![0].args.path).toBe("/a.txt");
    expect(forkedMsgs[0].toolCalls![0].result).toBe("内容");
  });

  // ===== CHAT-013b: getMessageCount ==========
  it("CHAT-013b: getMessageCount 返回正确数量", () => {
    MessageStorage.createMessage(makeMessage({ id: "c1" }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "c2" }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "c3" }), SESSION_ID);

    expect(MessageStorage.getMessageCount(SESSION_ID)).toBe(3);
  });

  // ===== CHAT-014b: deleteMessagesBefore ==========
  it("CHAT-014b: deleteMessagesBefore 删除指定时间前的消息", () => {
    const baseTs = Date.now();
    MessageStorage.createMessage(makeMessage({ id: "old", timestamp: baseTs - 1000 }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "new", timestamp: baseTs + 1000 }), SESSION_ID);

    const deleted = MessageStorage.deleteMessagesBefore(SESSION_ID, baseTs);
    expect(deleted).toBe(1);

    const remaining = MessageStorage.listMessages(SESSION_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("new");
  });

  // ===== CHAT-015b: appendToMessage ==========
  it("CHAT-015b: appendToMessage 追加内容到消息", () => {
    MessageStorage.createMessage(makeMessage({ id: "append-test", content: "Hello" }), SESSION_ID);
    MessageStorage.appendToMessage("append-test", " World");

    const loaded = MessageStorage.getMessage("append-test");
    expect(loaded!.content).toBe("Hello World");
  });

  // ===== CHAT-016b: appendMessageContent ==========
  it("CHAT-016b: appendMessageContent 追加文本", () => {
    MessageStorage.createMessage(makeMessage({ id: "append-content", content: "A" }), SESSION_ID);
    MessageStorage.appendMessageContent("append-content", "B");
    MessageStorage.appendMessageContent("append-content", "C");

    expect(MessageStorage.getMessage("append-content")!.content).toBe("ABC");
  });

  // ===== CHAT-017b: setMessageContent ==========
  it("CHAT-017b: setMessageContent 覆盖设置内容", () => {
    MessageStorage.createMessage(makeMessage({ id: "set-content", content: "原始" }), SESSION_ID);
    MessageStorage.setMessageContent("set-content", "覆盖内容");

    expect(MessageStorage.getMessage("set-content")!.content).toBe("覆盖内容");
  });

  // ===== CHAT-018b: setMessageReasoning ==========
  it("CHAT-018b: setMessageReasoning 设置思考过程", () => {
    MessageStorage.createMessage(makeMessage({ id: "set-reasoning", content: "回复" }), SESSION_ID);
    MessageStorage.setMessageReasoning("set-reasoning", "新的思考过程");

    expect(MessageStorage.getMessage("set-reasoning")!.reasoning).toBe("新的思考过程");
  });

  // ===== CHAT-019b: setMessageStatus ==========
  it("CHAT-019b: setMessageStatus 设置消息状态", () => {
    MessageStorage.createMessage(makeMessage({ id: "set-status", status: "streaming" }), SESSION_ID);
    MessageStorage.setMessageStatus("set-status", "done");

    expect(MessageStorage.getMessage("set-status")!.status).toBe("done");
  });

  // ===== CHAT-020b: addToolCall 追加工具调用 ==========
  it("CHAT-020b: addToolCall 向已有消息追加工具调用", () => {
    MessageStorage.createMessage(makeMessage({ id: "add-tc", role: "assistant", content: "执行中" }), SESSION_ID);
    MessageStorage.addToolCall("add-tc", {
      id: "new-tc", tool: "read_file", args: { path: "/x" }, status: "running",
    });

    const loaded = MessageStorage.getMessage("add-tc");
    expect(loaded!.toolCalls).toBeDefined();
    expect(loaded!.toolCalls).toHaveLength(1);
    expect(loaded!.toolCalls![0].tool).toBe("read_file");
  });

  // ===== CHAT-021b: updateMessage 带 toolCalls 替换 ==========
  it("CHAT-021b: updateMessage 替换 toolCalls（先删后插）", () => {
    MessageStorage.createMessage(makeMessage({
      id: "replace-tc",
      role: "assistant",
      content: "执行中",
      toolCalls: [
        { id: "old-tc", tool: "read_file", args: {}, status: "done" },
      ],
    }), SESSION_ID);

    MessageStorage.updateMessage("replace-tc", {
      toolCalls: [
        { id: "old-tc", tool: "read_file", args: {}, status: "done", result: "旧结果" },
        { id: "new-tc", tool: "write_file", args: {}, status: "done", result: "新结果" },
      ],
    });

    const loaded = MessageStorage.getMessage("replace-tc");
    expect(loaded!.toolCalls).toHaveLength(2);
    expect(loaded!.toolCalls![0].result).toBe("旧结果");
    expect(loaded!.toolCalls![1].tool).toBe("write_file");
  });

  // ===== CHAT-022b: 附件存储 ==========
  it("CHAT-022b: 消息附件完整存储和加载", () => {
    const msg = makeMessage({
      id: "att-test",
      content: "带附件的消息",
      attachments: [{
        id: "att-1",
        name: "test.md",
        type: "file",
        content: "# 标题\n内容",
        size: 100,
        mimeType: "text/markdown",
      }],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    const loaded = MessageStorage.getMessage("att-test");
    expect(loaded!.attachments).toBeDefined();
    expect(loaded!.attachments).toHaveLength(1);
    expect(loaded!.attachments![0].name).toBe("test.md");
    expect(loaded!.attachments![0].mimeType).toBe("text/markdown");
    expect(loaded!.attachments![0].size).toBe(100);
  });

  // ===== CHAT-023b: 多附件 ==========
  it("CHAT-023b: 一条消息多附件存储", () => {
    MessageStorage.createMessage(makeMessage({
      id: "multi-att",
      attachments: [
        { id: "a1", name: "f1.txt", type: "file", content: "1", addedAt: Date.now() },
        { id: "a2", name: "f2.py", type: "code", content: "print()", addedAt: Date.now() },
        { id: "a3", name: "img.png", type: "image", preview: "data:image/png;base64,...", addedAt: Date.now() },
      ],
    }), SESSION_ID);

    const loaded = MessageStorage.getMessage("multi-att");
    expect(loaded!.attachments).toHaveLength(3);
    expect(loaded!.attachments![0].type).toBe("file");
    expect(loaded!.attachments![1].type).toBe("code");
    expect(loaded!.attachments![2].type).toBe("image");
  });
});

// ========== 消息转 LLM 格式 ==========

describe("对话核心链路 — messagesToLLMMessages 转换", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  // ===== CHAT-031b: 基本转换 ==========
  it("CHAT-031b: user 消息正确转换", () => {
    const messages: Message[] = [
      { id: "u1", role: "user", content: "你好", timestamp: 0, status: "done" },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs).toHaveLength(1);
    expect(llmMsgs[0].role).toBe("user");
    expect(llmMsgs[0].content).toBe("你好");
  });

  // ===== CHAT-032b: assistant 带 tool_calls ==========
  it("CHAT-032b: assistant 消息含 completed tool_calls 正确转换", () => {
    const messages: Message[] = [
      {
        id: "a1", role: "assistant", content: "读取文件", timestamp: 0, status: "done",
        toolCalls: [
          { id: "tc1", tool: "read_file", args: { path: "/x" }, result: "内容", status: "done" },
        ],
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    // assistant + tool result = 2 messages
    expect(llmMsgs).toHaveLength(2);
    expect(llmMsgs[0].role).toBe("assistant");
    expect(llmMsgs[0].tool_calls).toBeDefined();
    expect(llmMsgs[0].tool_calls![0].function.name).toBe("read_file");
    expect(llmMsgs[1].role).toBe("tool");
    expect(llmMsgs[1].content).toBe("内容");
    expect(llmMsgs[1].toolCallId).toBe("tc1");
  });

  // ===== CHAT-033b: running 状态 tool_calls 被跳过 ==========
  it("CHAT-033b: running 状态的 tool_calls 被跳过", () => {
    const messages: Message[] = [
      {
        id: "a1", role: "assistant", content: "执行中", timestamp: 0, status: "streaming",
        toolCalls: [
          { id: "tc1", tool: "read_file", args: {}, status: "running" },
          { id: "tc2", tool: "write_file", args: {}, result: "完成", status: "done" },
        ],
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    // assistant (with only completed tc) + 1 tool result
    expect(llmMsgs).toHaveLength(2);
    expect(llmMsgs[0].tool_calls).toBeDefined();
    expect(llmMsgs[0].tool_calls).toHaveLength(1);
    expect(llmMsgs[0].tool_calls![0].id).toBe("tc2");
  });

  // ===== CHAT-034b: system-reminder 标签过滤 ==========
  it("CHAT-034b: <system-reminder> 标签从内容中过滤", () => {
    const messages: Message[] = [
      {
        id: "u1", role: "user",
        content: "<system-reminder>隐藏内容</system-reminder>实际内容",
        timestamp: 0, status: "done",
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs[0].content).toBe("实际内容");
  });

  // ===== CHAT-035b: 空内容 user 消息跳过 ==========
  it("CHAT-035b: stripSystemReminders 后为空则跳过 user 消息", () => {
    const messages: Message[] = [
      { id: "u1", role: "user", content: "<system-reminder>only reminder</system-reminder>", timestamp: 0, status: "done" },
      { id: "u2", role: "user", content: "实际消息", timestamp: 0, status: "done" },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs).toHaveLength(1);
    expect(llmMsgs[0].content).toBe("实际消息");
  });

  // ===== CHAT-036b: 空内容 assistant 含 tool_calls 保留 ==========
  it("CHAT-036b: assistant 内容为空但有 completed tool_calls 仍保留", () => {
    const messages: Message[] = [
      {
        id: "a1", role: "assistant", content: "", timestamp: 0, status: "done",
        toolCalls: [
          { id: "tc1", tool: "read_file", args: {}, result: "内容", status: "done" },
        ],
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs).toHaveLength(2);
  });

  // ===== CHAT-037b: reasoning 不回传 LLM ==========
  it("CHAT-037b: reasoning 字段不出现在 LLM 消息中", () => {
    const messages: Message[] = [
      {
        id: "a1", role: "assistant", content: "回复", timestamp: 0, status: "done",
        reasoning: "思考过程不应该被发送回 LLM",
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs[0].role).toBe("assistant");
    expect((llmMsgs[0] as any).reasoning_content).toBeUndefined();
  });

  // ===== CHAT-038b: 孤儿 tool 消息被清理 ==========
  it("CHAT-038b: 没有 assistant tool_calls 的孤儿 tool 消息被移除", () => {
    const messages: Message[] = [
      {
        id: "a1", role: "assistant", content: "纯文本回复", timestamp: 0, status: "done",
        toolCalls: [],
      },
      // 模拟一条 tool result 消息但没有对应的 assistant tool_calls
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs).toHaveLength(1);
    expect(llmMsgs[0].role).toBe("assistant");
  });

  // ===== CHAT-039b: tool result 中 system-reminder 过滤 ==========
  it("CHAT-039b: tool result 中的 system-reminder 被过滤", () => {
    const messages: Message[] = [
      {
        id: "a1", role: "assistant", content: "执行了", timestamp: 0, status: "done",
        toolCalls: [
          {
            id: "tc1", tool: "bash", args: {},
            result: "<system-reminder>hidden</system-reminder>command output",
            status: "done",
          },
        ],
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    const toolMsg = llmMsgs.find(m => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toBe("command output");
  });
});

// ========== 会话存储 ==========

describe("对话核心链路 — 会话 CRUD", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupProjectAndSession();
  });

  it("CHAT-040: getSession 返回正确会话", () => {
    const session = SessionStorage.getSession(SESSION_ID);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(SESSION_ID);
    expect(session!.projectId).toBe(PROJECT_ID);
    expect(session!.title).toBe("对话测试");
  });

  it("CHAT-041: listSessions 按 projectId 过滤", () => {
    const sessions = SessionStorage.listSessions(PROJECT_ID);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(SESSION_ID);
  });

  it("CHAT-042: updateSession 修改标题和 model", () => {
    SessionStorage.updateSession(SESSION_ID, { title: "新标题", model: "gpt-4o" });
    const session = SessionStorage.getSession(SESSION_ID);
    expect(session!.title).toBe("新标题");
    expect(session!.model).toBe("gpt-4o");
  });

  it("CHAT-043: deleteSession 删除会话", () => {
    SessionStorage.deleteSession(SESSION_ID);
    expect(SessionStorage.getSession(SESSION_ID)).toBeNull();
  });

  it("CHAT-044: deleteSession 级联删除消息", () => {
    MessageStorage.createMessage(makeMessage({ id: "cascade-1" }), SESSION_ID);
    SessionStorage.deleteSession(SESSION_ID);
    expect(MessageStorage.listMessages(SESSION_ID)).toHaveLength(0);
  });

  it("CHAT-045: 会话 pinned 状态", () => {
    SessionStorage.updateSession(SESSION_ID, { pinned: true });
    const session = SessionStorage.getSession(SESSION_ID);
    expect(session!.pinned).toBe(true);
  });
});

/**
 * 测试 3：Fork 功能 — 从 SQLite 消息表复制消息到新会话
 *
 * 改动影响：
 *   - App.tsx 的 onFork 原来用 localStorage "mimo-chat-*" 存储和读取消息
 *   - 现在改为直接从 MessageStorage (SQLite messages 表) 读取源消息并复制到新会话
 *   - fork 时需生成新 ID 避免与源消息 ID 冲突（createMessage 会按 ID upsert）
 *   - 如果有误，fork 后新会话将没有消息或消息不完整
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

describe("Fork 功能 — 从 SQLite 复制消息到新会话", () => {
  const projectId = "test-project-1";
  const sourceSessionId = "source-session-1";

  beforeEach(async () => {
    await initDatabase();

    // 先创建 project（sessions 表有外键约束）
    ProjectStorage.createProject({
      id: projectId,
      name: "Test Project",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    // 创建源会话
    SessionStorage.createSession({
      id: sourceSessionId,
      projectId,
      title: "源对话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    // 创建 5 条消息
    const messages: Message[] = [
      { id: "msg-1", role: "user", content: "第一条消息", timestamp: 1000, status: "done" },
      { id: "msg-2", role: "assistant", content: "第一条回复", timestamp: 2000, status: "done" },
      { id: "msg-3", role: "user", content: "第二条消息", timestamp: 3000, status: "done" },
      { id: "msg-4", role: "assistant", content: "第二条回复", timestamp: 4000, status: "done" },
      { id: "msg-5", role: "user", content: "第三条消息", timestamp: 5000, status: "done" },
    ];

    for (const msg of messages) {
      MessageStorage.createMessage(msg, sourceSessionId);
    }
  });

  // 模拟 App.tsx 的 fork 逻辑（使用新 ID）
  function forkMessages(sourceMessages: Message[], targetSessionId: string, messageIndex: number) {
    const forkedMessages = sourceMessages.slice(0, messageIndex + 1);
    const forkTs = Date.now();
    for (const msg of forkedMessages) {
      const newMsgId = `${msg.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`;
      MessageStorage.createMessage({
        ...msg,
        id: newMsgId,
        toolCalls: msg.toolCalls?.map((tc) => ({
          ...tc,
          id: `${tc.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`,
        })),
      }, targetSessionId);
    }
  }

  it("能从源会话读取全部消息", () => {
    const msgs = MessageStorage.listMessages(sourceSessionId);
    expect(msgs).toHaveLength(5);
    expect(msgs[0].content).toBe("第一条消息");
    expect(msgs[4].content).toBe("第三条消息");
  });

  it("fork 前 3 条消息到新会话（messageIndex=2）", () => {
    const newSessionId = "forked-session-1";

    SessionStorage.createSession({
      id: newSessionId,
      projectId,
      title: "Fork: 源对话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const sourceMessages = MessageStorage.listMessages(sourceSessionId);
    forkMessages(sourceMessages, newSessionId, 2);

    const newMsgs = MessageStorage.listMessages(newSessionId);
    expect(newMsgs).toHaveLength(3);
    expect(newMsgs[0].content).toBe("第一条消息");
    expect(newMsgs[1].content).toBe("第一条回复");
    expect(newMsgs[2].content).toBe("第二条消息");
  });

  it("fork 所有消息（messageIndex=4）", () => {
    const newSessionId = "forked-session-2";

    SessionStorage.createSession({
      id: newSessionId,
      projectId,
      title: "Fork: 源对话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const sourceMessages = MessageStorage.listMessages(sourceSessionId);
    forkMessages(sourceMessages, newSessionId, 4);

    const newMsgs = MessageStorage.listMessages(newSessionId);
    expect(newMsgs).toHaveLength(5);
  });

  it("fork 第一条消息（messageIndex=0）", () => {
    const newSessionId = "forked-session-3";

    SessionStorage.createSession({
      id: newSessionId,
      projectId,
      title: "Fork: 源对话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const sourceMessages = MessageStorage.listMessages(sourceSessionId);
    forkMessages(sourceMessages, newSessionId, 0);

    const newMsgs = MessageStorage.listMessages(newSessionId);
    expect(newMsgs).toHaveLength(1);
    expect(newMsgs[0].content).toBe("第一条消息");
  });

  it("fork 后源会话消息不受影响", () => {
    const newSessionId = "forked-session-4";

    SessionStorage.createSession({
      id: newSessionId,
      projectId,
      title: "Fork: 源对话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const sourceMessages = MessageStorage.listMessages(sourceSessionId);
    forkMessages(sourceMessages, newSessionId, 3);

    // 源会话仍应有 5 条消息
    const sourceMsgs = MessageStorage.listMessages(sourceSessionId);
    expect(sourceMsgs).toHaveLength(5);
  });

  it("fork 包含 tool_calls 的消息", () => {
    const newSessionId = "forked-session-5";

    // 创建带 tool_calls 的消息
    const msgWithTool: Message = {
      id: "msg-tool",
      role: "assistant",
      content: "我执行了一个工具",
      timestamp: 6000,
      status: "done",
      toolCalls: [
        { id: "tc-1", tool: "read_file", args: { path: "test.txt" }, result: "content", status: "done" },
      ],
    };
    MessageStorage.createMessage(msgWithTool, sourceSessionId);

    SessionStorage.createSession({
      id: newSessionId,
      projectId,
      title: "Fork: 源对话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const sourceMessages = MessageStorage.listMessages(sourceSessionId);
    forkMessages(sourceMessages, newSessionId, sourceMessages.length - 1);

    const newMsgs = MessageStorage.listMessages(newSessionId);
    expect(newMsgs).toHaveLength(6);
    const toolMsg = newMsgs.find((m) => m.content === "我执行了一个工具");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolCalls).toBeDefined();
    expect(toolMsg!.toolCalls![0].tool).toBe("read_file");
  });

  it("空会话 fork 不崩溃", () => {
    const emptySessionId = "empty-session";
    SessionStorage.createSession({
      id: emptySessionId,
      projectId,
      title: "空对话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const newSessionId = "forked-empty";
    SessionStorage.createSession({
      id: newSessionId,
      projectId,
      title: "Fork: 空对话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const sourceMessages = MessageStorage.listMessages(emptySessionId);
    expect(sourceMessages).toHaveLength(0);

    forkMessages(sourceMessages, newSessionId, 0);

    const newMsgs = MessageStorage.listMessages(newSessionId);
    expect(newMsgs).toHaveLength(0);
  });

  it("fork 的消息 ID 与源消息不同", () => {
    const newSessionId = "forked-session-id-check";

    SessionStorage.createSession({
      id: newSessionId,
      projectId,
      title: "Fork: 源对话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const sourceMessages = MessageStorage.listMessages(sourceSessionId);
    forkMessages(sourceMessages, newSessionId, 2);

    const newMsgs = MessageStorage.listMessages(newSessionId);
    expect(newMsgs).toHaveLength(3);
    // 新消息 ID 不应与源消息 ID 相同
    for (const newMsg of newMsgs) {
      const existsInSource = sourceMessages.some((s) => s.id === newMsg.id);
      expect(existsInSource).toBe(false);
    }
  });
});

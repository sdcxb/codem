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

import { getStoragePort, hasStoragePort } from "../core/storage/port";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

/**
 * 读回某条消息的工具调用 —— 读**产品真正把 tool_calls 写进去的那一侧**。
 *
 * - **B 态**（端口已注册，默认）：`createMessage` → `messages.upsert_index`（整批替换）
 *   → 端口的 `tool_calls` 表（真实 Rust 侧读它就是 `tool_calls.list`）；
 * - **A 态**（`CODEM_TEST_PORT=0`）：旧库是唯一数据源，从 `getMessage` 读回。
 *
 * 顺带把"fork 到底有没有把工具调用复制过去"钉在**存储层**上：端口那张表里
 * 有没有新消息 id 的行，是这件事唯一可信的判据。
 *
 * ⚠️ 这条用例在端口模式下仍红，且**是产品缺口不是测试问题**：`App.tsx` 的 fork 只用
 * `MessageStorage.listMessages`（同步），而端口模式下同步读路径拿不到 tool_calls ——
 * `writeIndexViaRust` 不填 `toolCallCache`（与 `message.ts` 注释里"upsert_index 也维护缓存"
 * 不符），镜像行不含这一列，异步预热只在 `getMessage` 里触发。于是 fork 复制的是
 * `msg.toolCalls === undefined`：**真机上 fork 出来的消息会丢掉工具调用**。
 */
function toolCallsOf(messageId: string): Array<{ id: string; tool: string; args: Record<string, unknown> }> {
  if (hasStoragePort()) {
    const port = getStoragePort() as unknown as { __table(name: string): Array<Record<string, unknown>> };
    return port
      .__table("tool_calls")
      .filter((r) => r.message_id === messageId)
      .map((r) => ({
        id: String(r.id ?? ""),
        tool: String(r.tool ?? ""),
        args: (typeof r.args === "string" ? JSON.parse(r.args) : (r.args ?? {})) as Record<string, unknown>,
      }));
  }
  return (MessageStorage.getMessage(messageId)?.toolCalls ?? []) as Array<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
  }>;
}

describe("Fork 功能 — 从 SQLite 复制消息到新会话", () => {
  const projectId = "test-project-1";
  const sourceSessionId = "source-session-1";

  beforeEach(async () => {

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
    // fork 有没有把 tool_calls 一起复制过去 —— 判据是端口里新消息 id 下的那一行
    const forkedCalls = toolCallsOf(toolMsg!.id);
    expect(forkedCalls).toHaveLength(1);
    expect(forkedCalls[0].tool).toBe("read_file");
    expect(forkedCalls[0].args.path).toBe("test.txt");
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

  /**
   * 第 44 轮：分叉必须**留下谱系**（`parent_id`）。
   *
   * ## 这条测试守的是什么
   *
   * `parent_id` 全仓**唯一**的写点是 `SessionStorage.forkSession`，而它原来
   * **零 UI 调用者** —— UI 里那三份内联 fork 实现都不写 `parent_id`。
   * 后果是一条能被实测验证的功能空洞：`session_trace`（按 `parent_id` 追溯祖先/后代）
   * 在生产里永远只报 `Parent: (root)` / `Ancestors: []` / `Descendants: (none)`，
   * 也就是说"完整谱系"这个能力从来没有数据。
   *
   * 现在 UI 的分叉走 `useProjectStore.forkSession` → `SessionStorage.forkSession`。
   * 这里直接对存储层断言"子会话行里真的有 `parent_id`"，而不是对着源码文本猜。
   */
  it("分叉写 parent_id：子会话行里能读回源会话 id（session_trace 的谱系依赖它）", () => {
    const childId = "forked-lineage-1";
    const child = SessionStorage.forkSession(sourceSessionId, childId, projectId, "Fork: 源对话");
    expect(child, "forkSession 应返回子会话（源会话存在时）").not.toBeNull();
    expect(child?.id).toBe(childId);

    // 从会话行读回：`parent_id` 是 ALTER 加的列，读映射必须把它带出来
    const read = getStoragePort().__table("sessions").find((r) => r.id === childId);
    expect(read, "子会话行必须真的写进库").toBeTruthy();
    expect(String(read?.parent_id ?? ""), "子会话必须记住它从哪来").toBe(sourceSessionId);
  });

  it("分叉源会话不存在时不写任何行（不制造孤儿会话）", () => {
    const child = SessionStorage.forkSession("不存在的源会话", "forked-orphan-1", projectId, "Fork: x");
    expect(child).toBeNull();
    expect(getStoragePort().__table("sessions").some((r) => r.id === "forked-orphan-1")).toBe(false);
  });
});

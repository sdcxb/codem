import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, getDatabase } from "../core/storage/database";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

describe("全局对话持久化修复", () => {
  beforeEach(async () => {
    localStorage.clear();
    await initDatabase();
  });

  it("initDatabase 自动种子全局 project (id='')", () => {
    const db = getDatabase();
    const result = db.exec("SELECT id, name FROM projects WHERE id = ''");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values.length).toBe(1);
    expect(result[0].values[0][0]).toBe("");
    expect(result[0].values[0][1]).toBe("全局对话");
  });

  it("全局对话 session 能存进 DB（不再 FK 失败）", () => {
    const sessionId = "global-session-test";
    SessionStorage.createSession({
      id: sessionId,
      projectId: "",
      title: "全局对话 1",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
      pinned: false,
    });

    const db = getDatabase();
    const result = db.exec("SELECT id, project_id, title FROM sessions WHERE id = ?", [sessionId]);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values[0][0]).toBe(sessionId);
    expect(result[0].values[0][1]).toBe("");
    expect(result[0].values[0][2]).toBe("全局对话 1");
  });

  it("全局对话 message + attachment 完整往返", () => {
    const sessionId = "global-session-roundtrip";
    SessionStorage.createSession({
      id: sessionId,
      projectId: "",
      title: "全局对话测试",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
      pinned: false,
    });

    const messageId = `global-msg-${Date.now()}`;
    const attId = `global-att-${Date.now()}`;
    const message: Message = {
      id: messageId,
      role: "user",
      content: "<attachment>file content here</attachment>\n\n帮我分析这个文件的内容",
      timestamp: Date.now(),
      status: "done",
      attachments: [{
        id: attId,
        name: "hermes提示词截取.md",
        type: "file",
        content: "file content here",
        size: 8500,
        mimeType: "text/markdown",
        sandboxPath: ".attachments/global-att-hermes.md",
      }],
    };

    MessageStorage.createMessage(message, sessionId);

    // 从 DB 读回来
    const loaded = MessageStorage.listMessages(sessionId);
    expect(loaded.length).toBe(1);
    expect(loaded[0].content).toContain("帮我分析这个文件的内容");
    expect(loaded[0].attachments).toBeDefined();
    expect(loaded[0].attachments!.length).toBe(1);
    expect(loaded[0].attachments![0].name).toBe("hermes提示词截取.md");
    expect(loaded[0].attachments![0].sandboxPath).toBe(".attachments/global-att-hermes.md");
    expect(loaded[0].attachments![0].size).toBe(8500);
  });

  it("全局对话 saveMessages 多次调用（更新分支）不丢 attachment", () => {
    const sessionId = "global-session-update";
    SessionStorage.createSession({
      id: sessionId,
      projectId: "",
      title: "全局对话更新测试",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
      pinned: false,
    });

    const messageId = `global-msg-upd-${Date.now()}`;
    const attId = `global-att-upd-${Date.now()}`;
    const message: Message = {
      id: messageId,
      role: "user",
      content: "原始内容",
      timestamp: Date.now(),
      status: "done",
      attachments: [{
        id: attId,
        name: "test.md",
        type: "file",
        content: "test content",
        size: 100,
      }],
    };

    // 第一次：INSERT 分支
    MessageStorage.createMessage(message, sessionId);
    // 第二次：UPDATE 分支（模拟 saveMessages 再次调用）
    MessageStorage.createMessage({ ...message, content: "更新后的内容" }, sessionId);

    const loaded = MessageStorage.listMessages(sessionId);
    expect(loaded.length).toBe(1);
    expect(loaded[0].content).toBe("更新后的内容");
    expect(loaded[0].attachments).toBeDefined();
    expect(loaded[0].attachments!.length).toBe(1);
    expect(loaded[0].attachments![0].name).toBe("test.md");
  });

  it("listProjects 不包含全局 project (id='')", () => {
    const projects = ProjectStorage.listProjects();
    const hasGlobal = projects.some(p => p.id === "");
    expect(hasGlobal).toBe(false);
  });

  it("listSessions('') 能查到全局对话", () => {
    const sessionId = "global-list-test";
    SessionStorage.createSession({
      id: sessionId,
      projectId: "",
      title: "全局列表测试",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
      pinned: false,
    });

    const sessions = SessionStorage.listSessions("");
    const found = sessions.find(s => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found!.title).toBe("全局列表测试");
  });
});

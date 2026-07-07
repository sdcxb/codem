/**
 * 测试 17：SQL 注入和特殊字符测试
 *
 * 改动影响：
 *   - SQLite 使用参数化查询（placeholder），但如果某个存储函数遗漏了参数化
 *   - 用户输入的消息内容、设置值中可能包含 SQL 特殊字符
 *   - 需验证单引号、分号、注释符等不会破坏查询或导致注入
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import { getSetting, setSetting, getSettingJSON, setSettingJSON } from "../core/storage/settings";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

describe("SQL 注入和特殊字符测试 — Settings", () => {
  beforeEach(async () => {
    await initDatabase();
  });

  it("值包含单引号", () => {
    const val = "it's a test";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("值包含双引号", () => {
    const val = 'say "hello"';
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("值包含分号", () => {
    const val = "a; b; c";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("值包含 SQL 注入模式 — DROP TABLE", () => {
    const val = "'); DROP TABLE settings; --";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);

    // settings 表应仍然存在
    setSetting("codem-check", "ok");
    expect(getSetting("codem-check")).toBe("ok");
  });

  it("值包含 SQL 注入模式 — UNION SELECT", () => {
    const val = "' UNION SELECT * FROM settings --";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("值包含 SQL 注入模式 — 多语句注入", () => {
    const val = "'; INSERT INTO settings VALUES('hack', 'data'); --";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);

    // 验证注入的 INSERT 没有执行
    expect(getSetting("hack")).toBeNull();
  });

  it("JSON 值包含 SQL 特殊字符", () => {
    const data = {
      name: "O'Brien",
      query: "SELECT * FROM users WHERE name = 'admin'; DROP TABLE users; --",
      path: "D:\\test'; --.txt",
    };
    setSettingJSON("codem-test", data);
    const loaded = getSettingJSON<typeof data>("codem-test", null as any);
    expect(loaded.name).toBe("O'Brien");
    expect(loaded.query).toContain("DROP TABLE");
    expect(loaded.path).toBe("D:\\test'; --.txt");
  });

  it("key 包含特殊字符", () => {
    setSetting("codem-key with spaces", "val1");
    expect(getSetting("codem-key with spaces")).toBe("val1");

    setSetting("codem-key'with'quotes", "val2");
    expect(getSetting("codem-key'with'quotes")).toBe("val2");
  });

  it("值包含反斜杠和换行", () => {
    const val = "C:\\Users\\test\nNew Line\tTab";
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
  });

  it("值包含 Unicode 控制字符", () => {
    const val = "hello\u0001\u0002\u0003world";
    setSetting("codem-test", val);
    const loaded = getSetting("codem-test");
    expect(loaded).not.toBeNull();
    // 控制字符应被保留或安全处理
    expect(loaded!.startsWith("hello")).toBe(true);
  });

  it("超长值（100KB）", () => {
    const val = "x".repeat(100000);
    setSetting("codem-test", val);
    expect(getSetting("codem-test")).toBe(val);
    expect(getSetting("codem-test")!.length).toBe(100000);
  });
});

describe("SQL 注入和特殊字符测试 — 消息内容", () => {
  const projectId = "proj-sql-test";
  const sessionId = "sess-sql-test";

  beforeEach(async () => {
    await initDatabase();
    ProjectStorage.createProject({
      id: projectId,
      name: "SQL注入测试",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: sessionId,
      projectId,
      title: "SQL注入测试",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });
  });

  it("消息内容包含 DROP TABLE", () => {
    const content = "'); DROP TABLE messages; --";
    const msg: Message = {
      id: "msg-sql-1",
      role: "user",
      content,
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-sql-1");
    expect(loaded!.content).toBe(content);

    // messages 表应仍然存在
    const allMsgs = MessageStorage.listMessages(sessionId);
    expect(allMsgs).toHaveLength(1);
  });

  it("消息内容包含单引号和分号", () => {
    const content = "it's a test; let's check; don't break";
    const msg: Message = {
      id: "msg-sql-2",
      role: "user",
      content,
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-sql-2");
    expect(loaded!.content).toBe(content);
  });

  it("消息 reasoning 包含 SQL 注入模式", () => {
    const msg: Message = {
      id: "msg-sql-3",
      role: "assistant",
      content: "回答",
      reasoning: "'); DELETE FROM sessions; --",
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-sql-3");
    expect(loaded!.reasoning).toBe("'); DELETE FROM sessions; --");

    // sessions 表应仍然存在
    const session = SessionStorage.getSession(sessionId);
    expect(session).not.toBeNull();
  });

  it("tool call result 包含 SQL 注入模式", () => {
    const msg: Message = {
      id: "msg-sql-4",
      role: "assistant",
      content: "执行了命令",
      timestamp: Date.now(),
      status: "done",
      toolCalls: [
        {
          id: "tc-sql",
          tool: "execute_command",
          args: { command: "echo test" },
          result: "test\n'); DROP TABLE messages; --",
          status: "done",
        },
      ],
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-sql-4");
    expect(loaded!.toolCalls![0].result).toBe("test\n'); DROP TABLE messages; --");

    // 验证表还在
    expect(MessageStorage.listMessages(sessionId)).toHaveLength(1);
  });

  it("消息 ID 包含特殊字符", () => {
    const msg: Message = {
      id: "msg'id;drop--",
      role: "user",
      content: "测试ID特殊字符",
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg'id;drop--");
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe("测试ID特殊字符");
  });
});

describe("SQL 注入和特殊字符测试 — 项目和会话", () => {
  beforeEach(async () => {
    await initDatabase();
  });

  it("项目名包含 SQL 注入模式", () => {
    ProjectStorage.createProject({
      id: "proj-inj",
      name: "'); DROP TABLE projects; --",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    const project = ProjectStorage.getProject("proj-inj");
    expect(project!.name).toBe("'); DROP TABLE projects; --");

    // projects 表应仍然存在
    expect(ProjectStorage.listProjects()).toHaveLength(1);
  });

  it("会话标题包含 SQL 注入模式", () => {
    ProjectStorage.createProject({
      id: "proj-sess-inj",
      name: "Test",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    SessionStorage.createSession({
      id: "sess-inj",
      projectId: "proj-sess-inj",
      title: "'); DELETE FROM sessions; --",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const session = SessionStorage.getSession("sess-inj");
    expect(session!.title).toBe("'); DELETE FROM sessions; --");
    expect(SessionStorage.listSessions("proj-sess-inj")).toHaveLength(1);
  });

  it("项目路径包含单引号", () => {
    ProjectStorage.createProject({
      id: "proj-quote-path",
      name: "Test",
      path: "D:\\O'Brien's folder",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    const project = ProjectStorage.getProject("proj-quote-path");
    expect(project!.path).toBe("D:\\O'Brien's folder");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { getStoragePort, setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

/** 用例自己的干净端口（播种对象必须是"本用例的那一个"） */
function installPort(seed: Record<string, Array<Record<string, unknown>>> = {}): FakeStoragePort {
  const port = createFakeStoragePort({ seed });
  setStoragePort(port);
  return port;
}

function currentPort(): FakeStoragePort {
  return getStoragePort() as unknown as FakeStoragePort;
}

/**
 * 按 id 读回 `sessions` 行 —— 读**产品真正把会话写进去的那一侧**。
 *
 * 原来这里有一条 A 态分支：端口未注册时 `getDatabase().exec("SELECT … FROM sessions")`。
 * A 态（旧库回退）在第 17 轮（L4）已删除，`initDatabase()` 在 rust 模式下直接抛错 ——
 * 也就是说那条分支读的是一份**没有人写的库**（本用例组最初的失败原因正是它）。
 * 现在只剩端口这一条路，判据（id / project_id / title 逐字相等）没有放宽。
 */
function selectSessionRow(sessionId: string): Record<string, unknown> | undefined {
  return currentPort()
    .__table("sessions")
    .find((r) => r.id === sessionId);
}

/** 全局项目行（`id = ''`）：锁住 `projects` 表里那一行的形状 */
function globalProjectRow(): Record<string, unknown> {
  return {
    id: "",
    name: "全局对话",
    path: "",
    description: "Global chat (no project context)",
    pinned: 0,
    created_at: 1,
    last_accessed_at: 1,
  };
}

describe("全局对话持久化修复", () => {
  beforeEach(async () => {
    localStorage.clear();
    installPort();
  });

  /**
   * 全局项目行（`id = ''`）的**播种**是引擎的活：旧实现是 `initDatabase()` 里的 SCHEMA 种子，
   * 新架构里由 `codem-db` 的 schema/migrate 负责（Rust 侧自己的测试守它）。
   *
   * 渲染侧真正要守的是**这一行的可见性契约**（`project.ts` 的注释写着：
   * 镜像路径必须保持 `id != ''` 这条过滤，否则"全局对话"会突然出现在项目列表里）。
   * 所以这里把引擎会有的那一行播种进端口，再断言同一组事实：
   * 行在、id 是 `''`、name 是"全局对话"，且**不出现在 `listProjects()` 里**。
   */
  it("全局 project (id='') 由引擎播种：端口读得到，且不进项目列表", () => {
    installPort({ projects: [globalProjectRow()] });

    const rows = currentPort().__table("projects").filter((r) => r.id === "");
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("");
    expect(rows[0].name).toBe("全局对话");

    // 读路径（域端口）拿得到它 —— 全局会话因此不会撞外键
    expect(ProjectStorage.getProject("")?.name).toBe("全局对话");
    // 但它**不是**一个"项目"：列表里绝不能出现
    expect(ProjectStorage.listProjects().some((p) => p.id === "")).toBe(false);
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

    const row = selectSessionRow(sessionId);
    expect(row).toBeDefined();
    expect(row!.id).toBe(sessionId);
    expect(row!.project_id).toBe("");
    expect(row!.title).toBe("全局对话 1");
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

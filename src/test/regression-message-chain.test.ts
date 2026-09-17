/**
 * 测试：消息链路与存储完整性 — MSGC-001 ~ MSGC-020
 *
 * 验证所有修改后，消息创建、读取、更新、删除的完整链路仍然正常。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getStoragePort, setStoragePort } from "../core/storage/port";
import { createRustEngineSemanticsPort } from "./rust-engine-semantics-port";
import type { FakeStoragePort } from "./fake-storage-port";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

const PROJECT_ID = "proj-msgc-test";
const SESSION_ID = "sess-msgc-test";

/**
 * 本文件用**带真引擎语义**的假端口（见 `rust-engine-semantics-port.ts`）：
 *
 * - 消息列表按 `ORDER BY timestamp ASC, id ASC`（`repo.rs:942`）—— MSGC-020 验的就是这条；
 * - `crud.delete` 按 `ON DELETE CASCADE` 带走子行（`engine.rs:87` + `schema.sql`）——
 *   MSGC-014 验的"删项目级联"在旧实现里正是靠它，端口模式下列表由引擎负责，替身不实现就会假红。
 *
 * 这个 hook 属于**根套件**，先于 `describe` 里的 beforeEach 执行 —— 所以下面的
 * `setupProjectAndSession()` 建的项目/会话落在同一份数据里（不会出现"断言读的是空端口"的假绿）。
 */
beforeEach(() => {
  setStoragePort(createRustEngineSemanticsPort());
});

/** 当前用例生效的端口（断言"写穿到端口"用） */
function currentPort(): FakeStoragePort {
  return getStoragePort() as unknown as FakeStoragePort;
}

function setupProjectAndSession(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID,
    name: "消息测试项目",
    path: "D:\\test",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: "消息测试会话",
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

describe("消息链路与存储完整性", () => {
  beforeEach(async () => {
    /*
     * L1 收尾：这里原来是 `try { await resetDatabase() } catch { await initDatabase() }`
     * （每例重建一次旧库）。旧引擎在 rust 模式下刻意不加载（`initDatabase()` 直接抛），
     * 而产品读写的是**端口** —— 本文件的 `beforeEach` 钩子（文件顶部）每例注册一个
     * 带真引擎语义的假端口，这就是唯一的存储基座。断言一条未改。
     */
    localStorage.clear();
    setupProjectAndSession();
  });

  // ===== MSGC-001 ~ MSGC-010: 基本 CRUD =====
  it("MSGC-001: 消息创建后 DB 可查", () => {
    const msg = makeMessage({ id: "msgc-001", content: "创建测试" });
    MessageStorage.createMessage(msg, SESSION_ID);
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs.find((m: any) => m.id === "msgc-001")).toBeDefined();
  });

  it("MSGC-002: 消息更新后 DB 反映变更", () => {
    const msg = makeMessage({ id: "msgc-002", status: "streaming" });
    MessageStorage.createMessage(msg, SESSION_ID);
    MessageStorage.updateMessage("msgc-002", { status: "done" });
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs.find((m: any) => m.id === "msgc-002")!.status).toBe("done");
  });

  it("MSGC-003: 消息删除后 DB 不含", () => {
    const msg = makeMessage({ id: "msgc-003" });
    MessageStorage.createMessage(msg, SESSION_ID);
    MessageStorage.deleteMessage("msgc-003");
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs.find((m: any) => m.id === "msgc-003")).toBeUndefined();
  });

  it("MSGC-004: 批量删除消息后 DB 正确", () => {
    for (let i = 0; i < 10; i++) {
      MessageStorage.createMessage(makeMessage({ id: `msgc-004-${i}` }), SESSION_ID);
    }
    const idsToDelete = Array.from({ length: 5 }, (_, i) => `msgc-004-${i}`);
    MessageStorage.deleteMessagesByIds(idsToDelete);
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs).toHaveLength(5);
  });

  it("MSGC-005: 工具调用创建并关联消息", () => {
    const msg = makeMessage({ id: "msgc-005" });
    MessageStorage.createMessage(msg, SESSION_ID);
    MessageStorage.addToolCall("msgc-005", {
      id: "tc-005",
      tool: "bash",
      args: { command: "echo hello" },
      result: "hello",
      status: "done",
    });
    const msgs = MessageStorage.listMessages(SESSION_ID);
    const m = msgs.find((m: any) => m.id === "msgc-005")!;
    expect(m.toolCalls).toBeDefined();
    expect(m.toolCalls).toHaveLength(1);
    expect(m.toolCalls![0].tool).toBe("bash");
  });

  it("MSGC-006: 工具调用更新状态", () => {
    const msg = makeMessage({ id: "msgc-006" });
    MessageStorage.createMessage(msg, SESSION_ID);
    MessageStorage.addToolCall("msgc-006", {
      id: "tc-006",
      tool: "read",
      args: {},
      status: "running",
    });
    MessageStorage.updateToolCall("msgc-006", "tc-006", {
      status: "done",
      result: "file content",
    });
    const msgs = MessageStorage.listMessages(SESSION_ID);
    const tc = msgs.find((m: any) => m.id === "msgc-006")!.toolCalls![0];
    expect(tc.status).toBe("done");
    expect(tc.result).toBe("file content");
  });

  it("MSGC-007: 中文+Emoji 消息不乱码", () => {
    const msg = makeMessage({ id: "msgc-007", content: "你好🌍🎉世界" });
    MessageStorage.createMessage(msg, SESSION_ID);
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs.find((m: any) => m.id === "msgc-007")!.content).toBe("你好🌍🎉世界");
  });

  it("MSGC-008: 大消息（10KB）完整存储", () => {
    const longContent = "A".repeat(10000);
    const msg = makeMessage({ id: "msgc-008", content: longContent });
    MessageStorage.createMessage(msg, SESSION_ID);
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs.find((m: any) => m.id === "msgc-008")!.content).toHaveLength(10000);
  });

  it("MSGC-009: 会话切换加载正确消息", () => {
    const SESSION_B = "sess-msgc-009b";
    SessionStorage.createSession({
      id: SESSION_B, projectId: PROJECT_ID, title: "B",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    for (let i = 0; i < 10; i++) {
      MessageStorage.createMessage(makeMessage({ id: `msgc-009-a-${i}` }), SESSION_ID);
    }
    for (let i = 0; i < 5; i++) {
      MessageStorage.createMessage(makeMessage({ id: `msgc-009-b-${i}` }), SESSION_B);
    }
    expect(MessageStorage.listMessages(SESSION_ID)).toHaveLength(10);
    expect(MessageStorage.listMessages(SESSION_B)).toHaveLength(5);
    // 切回 A
    expect(MessageStorage.listMessages(SESSION_ID)).toHaveLength(10);
  });

  it("MSGC-010: 跨项目消息隔离", () => {
    const PROJECT_B = "proj-msgc-010b";
    const SESSION_B = "sess-msgc-010b";
    ProjectStorage.createProject({
      id: PROJECT_B, name: "B", path: "D:\\b",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: SESSION_B, projectId: PROJECT_B, title: "B",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    MessageStorage.createMessage(makeMessage({ id: "msgc-010-a" }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "msgc-010-b" }), SESSION_B);
    const sessionsA = SessionStorage.listSessions(PROJECT_ID);
    const sessionsB = SessionStorage.listSessions(PROJECT_B);
    expect(sessionsA.find(s => s.id === SESSION_B)).toBeUndefined();
    expect(sessionsB.find(s => s.id === SESSION_ID)).toBeUndefined();
  });

  // ===== MSGC-011 ~ MSGC-020 =====
  it("MSGC-011: saveMessages 幂等——重复不产生副本", () => {
    const msg = makeMessage({ id: "msgc-011" });
    MessageStorage.createMessage(msg, SESSION_ID);
    // 再次创建同 ID（upsert 行为）
    MessageStorage.createMessage(msg, SESSION_ID);
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs.filter((m: any) => m.id === "msgc-011")).toHaveLength(1);
  });

  it("MSGC-012: reasoning 字段持久化", () => {
    const msg = makeMessage({ id: "msgc-012", reasoning: "思考过程内容" });
    MessageStorage.createMessage(msg, SESSION_ID);
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs.find((m: any) => m.id === "msgc-012")!.reasoning).toBe("思考过程内容");
  });

  it("MSGC-013: generatedFiles 序列化", () => {
    /*
     * 断言改读**端口表** `messages` 的 `generated_files` 列。
     *
     * 读路径的消息镜像刻意只装正文那 9 个字段（内存预算，见 message.ts 的说明），
     * `listMessages()[…].generatedFiles` 在端口模式下拿不到；而这条数据的真实落点是
     * `messages.upsert_index` 写进端口的 `generated_files` —— 本用例要守的就是"写穿了"。
     */
    const msg = makeMessage({
      id: "msgc-013",
      generatedFiles: ["test.ts", "config.json"],
    });
    MessageStorage.createMessage(msg, SESSION_ID);
    const row = currentPort().__table("messages").find((r) => r.id === "msgc-013");
    expect(row?.generated_files).toEqual(["test.ts", "config.json"]);
  });

  it("MSGC-014: 项目删除级联清理", () => {
    MessageStorage.createMessage(makeMessage({ id: "msgc-014" }), SESSION_ID);
    ProjectStorage.deleteProject(PROJECT_ID);
    // 会话应被删除（外键 ON DELETE CASCADE：删父行时引擎带走子行）
    const sessions = SessionStorage.listSessions(PROJECT_ID);
    expect(sessions).toHaveLength(0);
    // 消息也应被级联删除
    expect(MessageStorage.listMessages(SESSION_ID)).toHaveLength(0);
    // 端口表上同样不该留下子行（"只改了内存镜像"不算数）
    expect(currentPort().__table("sessions")).toHaveLength(0);
    expect(currentPort().__table("messages")).toHaveLength(0);
  });

  it("MSGC-015: delegation_tasks 域可用（读写都落到端口）", async () => {
    /*
     * 原来这条查的是**旧库的 sqlite_master**：`SELECT name FROM sqlite_master
     * WHERE type='table' AND name='delegation_tasks'` —— 那是**引擎 schema 自省**
     * （DDL 住在引擎里，随引擎一起删；Rust 侧由 `codem-db` 的 schema 迁移与
     * cargo test 守同一件事）。
     *
     * 端口语义下"这张表在"等于"这个域在存储层真的可写可读"：写一条 → 立刻读回。
     * 判据没有放宽：原来只证明表存在，现在还要求写入真的落到端口表上。
     */
    const { createDelegationTask, getDelegationTask } = await import("../core/session/delegation-storage");
    createDelegationTask({
      id: "deleg-msgc-015",
      sourceSessionId: SESSION_ID,
      targetSessionId: "sess-msgc-015-target",
      task: "表可用性探测",
      status: "pending",
      projectId: PROJECT_ID,
      createdAt: Date.now(),
    });
    expect(getDelegationTask("deleg-msgc-015")?.task).toBe("表可用性探测");
    expect(currentPort().__table("delegation_tasks").map((r) => r.id)).toContain("deleg-msgc-015");
  });

  it("MSGC-016: 200+ 消息查询不超时", () => {
    for (let i = 0; i < 200; i++) {
      MessageStorage.createMessage(makeMessage({ id: `msgc-016-${i}`, content: `msg ${i}` }), SESSION_ID);
    }
    const start = Date.now();
    const msgs = MessageStorage.listMessages(SESSION_ID);
    const elapsed = Date.now() - start;
    expect(msgs.length).toBe(200);
    expect(elapsed).toBeLessThan(5000); // 5 秒内
  });

  it("MSGC-017: 并发写入不互相覆盖", async () => {
    const SESSION_A = "sess-msgc-017a";
    const SESSION_B = "sess-msgc-017b";
    SessionStorage.createSession({ id: SESSION_A, projectId: PROJECT_ID, title: "A", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0 });
    SessionStorage.createSession({ id: SESSION_B, projectId: PROJECT_ID, title: "B", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0 });

    // 模拟并发写入
    const promisesA = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve(MessageStorage.createMessage(makeMessage({ id: `msgc-017a-${i}` }), SESSION_A))
    );
    const promisesB = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve(MessageStorage.createMessage(makeMessage({ id: `msgc-017b-${i}` }), SESSION_B))
    );
    await Promise.all([...promisesA, ...promisesB]);

    expect(MessageStorage.listMessages(SESSION_A)).toHaveLength(50);
    expect(MessageStorage.listMessages(SESSION_B)).toHaveLength(50);
  });

  it("MSGC-018: Fork 会话消息复制正确", () => {
    // 创建含工具调用的消息
    const msg = makeMessage({ id: "msgc-018", content: "原始消息" });
    MessageStorage.createMessage(msg, SESSION_ID);
    MessageStorage.addToolCall("msgc-018", {
      id: "tc-018", tool: "bash", args: { command: "ls" }, status: "done", result: "output",
    });

    // Fork 会话
    const FORKED_SESSION = "sess-msgc-018-fork";
    SessionStorage.createSession({
      id: FORKED_SESSION, projectId: PROJECT_ID, title: "Fork",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });

    // 复制消息到新会话（清除 toolCalls 避免唯一约束冲突）
    const originalMsgs = MessageStorage.listMessages(SESSION_ID);
    for (const m of originalMsgs) {
      const { toolCalls, ...msgWithoutToolCalls } = m;
      MessageStorage.createMessage({ ...msgWithoutToolCalls, id: `fork-${m.id}` } as Message, FORKED_SESSION);
    }

    const forkedMsgs = MessageStorage.listMessages(FORKED_SESSION);
    expect(forkedMsgs).toHaveLength(1);
    expect(forkedMsgs[0].content).toBe("原始消息");
  });

  it("MSGC-019: 会话标题含 Emoji 不乱码", () => {
    const EMOJI_SESSION = "sess-msgc-019";
    SessionStorage.createSession({
      id: EMOJI_SESSION, projectId: PROJECT_ID, title: "测试🎉会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    const sessions = SessionStorage.listSessions(PROJECT_ID);
    expect(sessions.find(s => s.id === EMOJI_SESSION)!.title).toBe("测试🎉会话");
  });

  it("MSGC-020: 消息按 timestamp 升序", () => {
    MessageStorage.createMessage(makeMessage({ id: "msgc-020-c", timestamp: 3000 }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "msgc-020-a", timestamp: 1000 }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "msgc-020-b", timestamp: 2000 }), SESSION_ID);
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs[0].id).toBe("msgc-020-a");
    expect(msgs[1].id).toBe("msgc-020-b");
    expect(msgs[2].id).toBe("msgc-020-c");
  });
});

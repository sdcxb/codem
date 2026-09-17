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
import { getStoragePort, setStoragePort } from "../core/storage/port";
import { flushSessionLogWrites, __resetJsonlCache } from "../core/storage/session-jsonl";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { getSetting, setSetting, removeSetting, getSettingJSON, setSettingJSON } from "../core/storage/settings";
import type { Message } from "../store";

// ========== 测试常量 ==========
const PROJECT_ID = "proj-chat-test";
const SESSION_ID = "sess-chat-test";

// ========== 辅助函数 ==========

/**
 * 当前注册的存储端口（`setup.ts` 每个用例前注册一个内存假端口）。
 *
 * 端口模式下（B 态）产品**只读写端口**，旧库在真机上刻意不存在 ——
 * 所以断言一律读端口表（`__table` / `__writes`），不再 `getDatabase().exec(...)`。
 */
function port(): FakeStoragePort {
  return getStoragePort() as unknown as FakeStoragePort;
}

/**
 * 用例内**自己**注册一个内存端口（覆盖 `setup.ts` 那一个），随后由 `setupProjectAndSession()`
 * 把项目 / 会话夹具写进它。
 *
 * 为什么必须显式：这些用例断言的是**端口契约**（B 态）。`setup.ts` 默认注册的也是假端口，
 * 但 `CODEM_TEST_PORT=0`（A 态对照）下它注册的是 `null`，断言目标就变成旧库了 ——
 * 显式注册让两种档位验证同一条契约（`message-port-coverage.test.ts` / `domain-store.test.ts`
 * 是同一个写法）。
 */
function useFreshPort(): FakeStoragePort {
  const p = createFakeStoragePort();
  setStoragePort(p);
  return p;
}

/** 端口行里 `args` 可能是对象（线协议形状）或 JSON 文本（Rust 侧 JSON 列） */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return (raw ?? {}) as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 假端口**没有实现外键级联**，而真实引擎是 `PRAGMA foreign_keys = ON`
 * （`migrate.rs`）+ `sql/schema.sql` 里的 `ON DELETE CASCADE`
 * （`sessions.project_id → projects.id`、`messages.session_id → sessions.id`、
 * `tool_calls.message_id → messages.id`、`attachments.session_id → sessions.id`）。
 *
 * 产品侧删会话只发**一条** `crud.delete`（见 `session.ts` 关于 `confirmBulk` 的注释：
 * "删 1 个会话会级联删掉它的全部消息 / 工具调用 / 事件" —— 级联是引擎的活，不是渲染侧的活），
 * 所以"删了会话之后消息也没了"这条断言必须让测试双具备引擎那一步，否则测的是测试双的缺陷。
 *
 * ⚠️ 级联挂在 `data.execute` 上（而不是在断言前自己删一遍）：只有**产品真的发出了删除命令**，
 * 级联才会发生 —— 断言因此仍然与产品行为因果相连，不是自证。
 */
function installForeignKeyCascade(p: FakeStoragePort): void {
  const execute = p.data.execute.bind(p.data);
  /** 直接复用端口自己的写命令，落表语义与端口一致 */
  const deleteRows = (table: string, where: Record<string, unknown>) => {
    void execute("crud.delete", { table, where });
  };
  const cascadeSession = (sessionId: string): void => {
    // tool_calls 挂在 messages 上（FK 是 message_id），所以先按会话取 message id 再删
    for (const m of p.__table("messages").filter((r) => r.session_id === sessionId)) {
      deleteRows("tool_calls", { message_id: m.id });
    }
    deleteRows("messages", { session_id: sessionId });
    deleteRows("attachments", { session_id: sessionId });
    deleteRows("session_events", { session_id: sessionId });
  };
  const cascade = (table: string, where: Record<string, unknown>): void => {
    if (table === "sessions") {
      cascadeSession(String(where.id ?? ""));
      return;
    }
    if (table === "projects") {
      const projectId = String(where.id ?? "");
      for (const s of p.__table("sessions").filter((r) => r.project_id === projectId)) {
        cascadeSession(String(s.id));
        deleteRows("sessions", { id: s.id });
      }
    }
  };
  p.data.execute = (command: string, params?: Record<string, unknown>) => {
    const result = execute(command, params); // 假端口的落表本身就是同步的
    if (command === "crud.delete") cascade(String(params?.table ?? ""), (params?.where as Record<string, unknown>) ?? {});
    return result;
  };
}

/**
 * 把**权威日志（会话 JSONL）**在测试里真正打通。
 *
 * 为什么这几条用例需要它：本仓库的分层是"追加日志 = 权威存储，SQLite/端口 = 可重建的查询索引"，
 * 而读路径 `listMessages` 是**索引 ∪ 权威日志**（合并后按 timestamp 升序）。
 * 没有 Tauri 文件通道时日志是死的 → 合并那一步永远不发生 → 只能看到索引那一份，
 * 与真机行为（进会话时会 `hydrateSessionLog`）不一致。
 * 同一个桩在 `silent-write-guard.test.ts` 里也是这么用的。
 */
function installSessionLogStub(): void {
  const files = new Map<string, string>();
  const stub = {
    core: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") { files.set(args.path as string, args.content as string); return undefined; }
        if (cmd === "append_file") {
          files.set(args.path as string, (files.get(args.path as string) ?? "") + (args.content as string) + "\n");
          return undefined;
        }
        if (cmd === "read_file") {
          if (!files.has(args.path as string)) throw new Error("no such file");
          return files.get(args.path as string);
        }
        if (cmd === "exists") return files.has(args.path as string);
        if (cmd === "list_directory") return [];
        return undefined;
      },
    },
  };
  (window as any).__TAURI__ = stub;
  (globalThis as any).__TAURI__ = stub;
  __resetJsonlCache();
  MessageStorage.clearSessionLogCache();
}

function removeSessionLogStub(): void {
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  __resetJsonlCache();
  MessageStorage.clearSessionLogCache();
}

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
    useFreshPort();
    setupProjectAndSession();
    const msg = makeMessage({
      id: "chat-016",
      role: "user",
      content: "你好世界",
      timestamp: 1000000,
      status: "done",
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    // 端口模式（B 态）：这条索引行落在**端口**上（`messages.upsert_index`），旧库刻意没有它
    const rows = port().__table("messages").filter((r) => r.id === "chat-016");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe("chat-016");
    expect(row.session_id).toBe(SESSION_ID);
    expect(row.role).toBe("user");
    expect(row.content).toBe("你好世界");
    expect(row.timestamp).toBe(1000000);
    expect(row.status).toBe("done");
  });

  // ===== CHAT-017: 消息加载 ==========
  it("CHAT-017: listMessages 按 timestamp 升序排列", async () => {
    useFreshPort();
    setupProjectAndSession();
    /**
     * 真实引擎里 `messages.list` 是 `ORDER BY timestamp ASC, id ASC`（`repo.rs`），
     * 而 `listMessages` = 索引 ∪ 权威日志、**合并后按 timestamp 升序**（`listMessagesMerged`）。
     * 后者才是这条断言在真机上的依据 —— 所以先把权威日志打通再读（见 installSessionLogStub）。
     */
    installSessionLogStub();
    try {
      const ts = Date.now();
      MessageStorage.createMessage(makeMessage({ id: "m2", content: "第二条", timestamp: ts + 200 }), SESSION_ID);
      MessageStorage.createMessage(makeMessage({ id: "m1", content: "第一条", timestamp: ts + 100 }), SESSION_ID);
      MessageStorage.createMessage(makeMessage({ id: "m3", content: "第三条", timestamp: ts + 300 }), SESSION_ID);
      await flushSessionLogWrites();
      await MessageStorage.hydrateSessionLog(SESSION_ID);

      const messages = MessageStorage.listMessages(SESSION_ID);
      expect(messages).toHaveLength(3);
      expect(messages[0].id).toBe("m1");
      expect(messages[1].id).toBe("m2");
      expect(messages[2].id).toBe("m3");
    } finally {
      removeSessionLogStub();
    }
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
    useFreshPort();
    setupProjectAndSession();
    const msg = makeMessage({
      id: "chat-019",
      role: "assistant",
      content: "执行了工具",
      toolCalls: [
        { id: "tc-1", tool: "read_file", args: { path: "/test.txt" }, status: "running" },
      ],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    // 工具调用由 `messages.upsert_index` 的 `tool_calls` 整批替换落到端口的 tool_calls 表
    const rows = port().__table("tool_calls").filter((r) => r.message_id === "chat-019");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("tc-1");
    expect(rows[0].message_id).toBe("chat-019");
    expect(rows[0].tool).toBe("read_file");
    expect(parseArgs(rows[0].args).path).toBe("/test.txt");
    expect(rows[0].status).toBe("running");
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
    useFreshPort();
    setupProjectAndSession();
    const msg = makeMessage({
      id: "chat-025",
      role: "assistant",
      content: "创建了文件",
      generatedFiles: ["/test/file1.ts", "/test/file2.ts"],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    // generated_files 是 `messages.upsert_index` 的一个参数（Rust 侧落进 JSON 列）
    const row = port().__table("messages").find((r) => r.id === "chat-025");
    expect(row, "消息行必须落在端口上").toBeTruthy();
    const generated = typeof row!.generated_files === "string" ? JSON.parse(row!.generated_files as string) : row!.generated_files;
    expect(generated).toBeDefined();
    expect(generated).toHaveLength(2);
    expect(generated[0]).toBe("/test/file1.ts");
    expect(generated).toEqual(["/test/file1.ts", "/test/file2.ts"]);
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
  it("CHAT-030: Fork 会话正确复制消息和 tool_calls", async () => {
    /**
     * Fork 是"读一个会话、写进另一个会话"，而工具调用**不在端口镜像行里**
     * （镜像刻意只有 9 个字段，工具结果全文不进镜像）：它来自权威日志
     * （`listMessagesMerged` 的合并会带上日志记录里的 toolCalls）。
     * 真机上进会话时就会 `hydrateSessionLog`，所以这里照做 —— 否则测的是"测试环境没有文件通道"。
     */
    installSessionLogStub();
    try {
      useFreshPort();
      setupProjectAndSession();
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
      await flushSessionLogWrites();
      await MessageStorage.hydrateSessionLog(SESSION_ID);
      const sourceMsgs = MessageStorage.listMessages(SESSION_ID);
      expect(sourceMsgs).toHaveLength(1);
      expect(sourceMsgs[0].toolCalls, "源会话必须读得到 tool_calls（它来自权威日志）").toBeDefined();
      for (const m of sourceMsgs) {
        MessageStorage.createMessage({
          ...m,
          id: `${m.id}-fork-${Date.now()}`,
          toolCalls: m.toolCalls?.map(tc => ({ ...tc, id: `${tc.id}-fork-${Date.now()}` })),
        }, forkSessionId);
      }

      await flushSessionLogWrites();
      await MessageStorage.hydrateSessionLog(forkSessionId);
      const forkedMsgs = MessageStorage.listMessages(forkSessionId);
      expect(forkedMsgs).toHaveLength(1);
      expect(forkedMsgs[0].content).toBe("源消息");
      expect(forkedMsgs[0].toolCalls).toBeDefined();
      expect(forkedMsgs[0].toolCalls![0].args.path).toBe("/a.txt");
      expect(forkedMsgs[0].toolCalls![0].result).toBe("内容");
    } finally {
      removeSessionLogStub();
    }
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
    useFreshPort();
    setupProjectAndSession();
    const baseTs = Date.now();
    MessageStorage.createMessage(makeMessage({ id: "old", timestamp: baseTs - 1000 }), SESSION_ID);
    MessageStorage.createMessage(makeMessage({ id: "new", timestamp: baseTs + 1000 }), SESSION_ID);

    /**
     * B 态下删除候选是**从会话镜像上算的**；镜像未就绪时产品会如实返回 0 并登记"就绪后补做"
     * （契约见 `message-port-coverage.test.ts` 的 PC-3：不假装删了）。
     * 真机上用户就在这个会话里、镜像已加载，所以先让镜像就绪再断言真实删除条数。
     */
    port().messages.ensureLoaded(SESSION_ID);
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
    useFreshPort();
    setupProjectAndSession();
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

    // 「整表替换」由 `messages.upsert_index` 的 `tool_calls` 参数实现（Rust 侧同一语义），落到端口表
    const rows = port().__table("tool_calls").filter((r) => r.message_id === "replace-tc");
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("old-tc");
    expect(rows[0].result).toBe("旧结果");
    expect(rows[1].tool).toBe("write_file");
    expect(rows.map((r) => r.id)).toEqual(["old-tc", "new-tc"]);
  });

  // ===== CHAT-022b: 附件存储 ==========
  /**
   * ⚠️ 已知产品缺陷（B 态，本批未修 —— 属产品代码那条线）：
   * `createMessage` 在端口模式下 **一条附件都不落**（`writeMessageIndex` 走
   * `writeIndexViaRust` 之后直接 return，附件那段旧库 INSERT 在 1450 行、永不执行；
   * 端口也没有对应的附件写命令），而读路径同样不返回附件
   * （`getMessage` / `listMessages` 在 B 态都不读 `attachments` 域）。
   * 断言保持不动 —— 这是"写进了端口但读路径没走端口"的真实缺陷，不该改测试迁就。
   */
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
  /** ⚠️ 同 CHAT-022b：B 态附件既不落端口也不由读路径返回（产品缺陷，断言保持不动） */
  it("CHAT-023b: 一条消息多附件存储", () => {
    MessageStorage.createMessage(makeMessage({
      id: "multi-att",
      attachments: [
        { id: "a1", name: "f1.txt", type: "file", content: "1" },
        { id: "a2", name: "f2.py", type: "code", content: "print()" },
        { id: "a3", name: "img.png", type: "image", preview: "data:image/png;base64,..." },
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

  // ===== CHAT-037b: reasoning 保留在 LLMMessage.reasoning（API 层转 reasoning_content）=====
  it("CHAT-037b: reasoning 保留在 LLMMessage.reasoning 字段", () => {
    const messages: Message[] = [
      {
        id: "a1", role: "assistant", content: "回复", timestamp: 0, status: "done",
        reasoning: "思考过程（DeepSeek thinking mode 需回传 API）",
      },
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(messages);
    expect(llmMsgs[0].role).toBe("assistant");
    // reasoning 保留（messagesToLLMMessages 层不生成 reasoning_content，那是 provider 层字段）
    expect((llmMsgs[0] as any).reasoning).toBe("思考过程（DeepSeek thinking mode 需回传 API）");
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
    useFreshPort();
    setupProjectAndSession(); // 被删的会话要在端口里真实存在
    installForeignKeyCascade(port()); // 级联是引擎的活（PRAGMA foreign_keys=ON + ON DELETE CASCADE），测试双要补上
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

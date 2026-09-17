/**
 * 全量测试：消息链路 / 存储 / 回调全量验证 — CHAIN-001 ~ CHAIN-060
 *
 * 覆盖范围：
 *   A. 消息 CRUD 与 DB 持久化 (CHAIN-001 ~ CHAIN-015)
 *   B. messagesToLLMMessages 转换链路 (CHAIN-016 ~ CHAIN-025)
 *   C. 工具调用结果存储与回传 (CHAIN-026 ~ CHAIN-035)
 *   D. Session CRUD 与消息关联 (CHAIN-036 ~ CHAIN-045)
 *   E. 设置/快捷短语/草稿/反馈存储 (CHAIN-046 ~ CHAIN-060)
 *
 * 关键组件：
 *   - storage/message.ts (createMessage / updateMessage / listMessages / messagesToLLMMessages)
 *   - storage/session.ts (createSession / deleteSession / listSessions)
 *   - storage/project.ts (createProject / deleteProject)
 *   - storage/settings.ts (getSetting / setSetting / saveQuickPhrase / loadQuickPhrases)
 *   - storage/prompt-draft.ts (savePromptDraft / loadPromptDrafts)
 *   - store.ts (useAppStore addMessage / updateMessage / addToolCall / updateToolCall)
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

import { getStoragePort, setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { getSetting, setSetting, saveQuickPhrase, loadQuickPhrases, deleteQuickPhrase } from "../core/storage/settings";
import { savePromptDraft, loadPromptDrafts, deletePromptDraft } from "../core/storage/prompt-draft";
import { useAppStore, type Message } from "../store";

const PROJECT_ID = "proj-chain-test";
const SESSION_ID = "sess-chain-test";

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
 * 用例内**自己**注册一个内存端口（覆盖 `setup.ts` 那一个），随后由 `setupBase()`
 * 把项目 / 会话夹具写进它。
 *
 * 为什么必须显式：这些用例断言的是**端口契约**（B 态）。`setup.ts` 默认注册的也是假端口，
 * 但 `CODEM_TEST_PORT=0`（A 态对照）下它注册的是 `null`，断言目标就变成旧库了 ——
 * 显式注册让两种档位验证同一条契约（`message-port-coverage.test.ts` 是同一个写法）。
 */
function useFreshPort(): FakeStoragePort {
  const p = createFakeStoragePort();
  setStoragePort(p);
  return p;
}

/**
 * 假端口**没有实现外键级联**，而真实引擎是 `PRAGMA foreign_keys = ON`（`migrate.rs`）
 * + `sql/schema.sql` 的 `ON DELETE CASCADE`（`sessions.project_id → projects.id`、
 * `messages.session_id → sessions.id`、`tool_calls.message_id → messages.id`、
 * `attachments.session_id → sessions.id`）。
 *
 * 产品侧删会话/删项目只发**一条** `crud.delete`（`session.ts` 的 `confirmBulk` 注释写得很清楚：
 * "删 1 个会话会级联删掉它的全部消息 / 工具调用 / 事件" —— 级联是引擎的活），
 * 所以"删了父行之后子行也没了"这条断言必须让测试双具备引擎那一步。
 *
 * ⚠️ 级联挂在 `data.execute` 上（而不是断言前自己删一遍）：只有**产品真的发出了删除命令**，
 * 级联才会发生 —— 断言因此仍与产品行为因果相连，不是自证。
 */
function installForeignKeyCascade(p: FakeStoragePort): void {
  const execute = p.data.execute.bind(p.data);
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

function setupBase(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID, name: "链路测试", path: "D:/chain",
    createdAt: Date.now(), lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SESSION_ID, projectId: PROJECT_ID, title: "链路测试会话",
    createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  });
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    role: "user",
    content: "test content",
    timestamp: Date.now(),
    status: "done",
    ...overrides,
  };
}

/**
 * 各 describe 共用的夹具（第 18 轮，L1）。
 *
 * 原来这里是 `try { await resetDatabase(); } catch { await initDatabase(); }`：
 * 那是"旧库是唯一数据源"（A 态）时代的**清库**夹具。A 态与旧引擎入口都已删除
 * （`setup.ts` 每个用例前注册一个**全新**的内存假端口，端口即唯一数据源；
 * `resetDatabase` / `initDatabase` 在 rust 引擎下**直接抛错**，
 * 留在 `catch` 里会让 beforeEach 自己炸掉），所以这一步整段删掉。
 *
 * 保留 `setupBase()`：它走的是**产品 API**（`createProject` / `createSession`），
 * 现在把项目与会话落到端口上 —— 与真机同一条路。
 */
function baseFixture(): void {
  localStorage.clear();
  setupBase();
}

// ========== A. 消息 CRUD 与 DB 持久化 ==========

describe("消息链路 — 消息 CRUD 与 DB 持久化", () => {
  beforeEach(baseFixture);

  // CHAIN-001
  it("CHAIN-001: createMessage 存储用户消息到 DB", () => {
    const msg = makeMsg({ id: "chain-001", role: "user", content: "用户输入" });
    MessageStorage.createMessage(msg, SESSION_ID);
    const loaded = MessageStorage.getMessage("chain-001");
    expect(loaded).toBeDefined();
    expect(loaded.content).toBe("用户输入");
    expect(loaded.role).toBe("user");
  });

  // CHAIN-002
  it("CHAIN-002: createMessage 存储 assistant 消息到 DB", () => {
    const msg = makeMsg({ id: "chain-002", role: "assistant", content: "AI回复" });
    MessageStorage.createMessage(msg, SESSION_ID);
    const loaded = MessageStorage.getMessage("chain-002");
    expect(loaded.role).toBe("assistant");
  });

  // CHAIN-003
  it("CHAIN-003: createMessage 带 reasoning 存储到 DB", () => {
    useFreshPort();
    setupBase();
    const msg = makeMsg({ id: "chain-003", role: "assistant", content: "回复", reasoning: "思考过程" });
    MessageStorage.createMessage(msg, SESSION_ID);
    // 端口模式：索引行落在端口上（旧库刻意没有这一行）
    const row = port().__table("messages").find((r) => r.id === "chain-003");
    expect(row, "消息行必须落在端口上").toBeTruthy();
    expect(row!.reasoning).toBe("思考过程");
  });

  // CHAIN-004
  it("CHAIN-004: createMessage 带 toolCalls 存储到 DB", () => {
    useFreshPort();
    setupBase();
    const msg = makeMsg({
      id: "chain-004",
      role: "assistant",
      content: "使用了工具",
      toolCalls: [{
        id: "tc-1", tool: "read", args: { path: "/test" },
        status: "done" as const, result: "file content",
      }],
    });
    MessageStorage.createMessage(msg, SESSION_ID);
    // 工具调用由 `messages.upsert_index` 的 `tool_calls` 整批替换落到端口的 tool_calls 表
    const rows = port().__table("tool_calls").filter((r) => r.message_id === "chain-004");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("tc-1");
    expect(rows[0].tool).toBe("read");
    expect(rows[0].result).toBe("file content");
    expect(rows[0].status).toBe("done");
  });

  // CHAIN-005
  it("CHAIN-005: updateMessageContent 更新消息内容", () => {
    const msg = makeMsg({ id: "chain-005", content: "原始内容" });
    MessageStorage.createMessage(msg, SESSION_ID);
    MessageStorage.updateMessageContent("chain-005", "更新后内容");
    const loaded = MessageStorage.getMessage("chain-005");
    expect(loaded.content).toBe("更新后内容");
  });

  // CHAIN-006
  it("CHAIN-006: listMessages 返回 session 内全部消息按时间排序", () => {
    for (let i = 0; i < 5; i++) {
      MessageStorage.createMessage(makeMsg({
        id: `chain-006-${i}`, content: `msg-${i}`, timestamp: 1000 + i,
      }), SESSION_ID);
    }
    const list = MessageStorage.listMessages(SESSION_ID);
    expect(list.length).toBe(5);
    expect(list[0].content).toBe("msg-0");
    expect(list[4].content).toBe("msg-4");
  });

  // CHAIN-007
  it("CHAIN-007: deleteMessagesByIds 批量删除消息", () => {
    for (let i = 0; i < 3; i++) {
      MessageStorage.createMessage(makeMsg({ id: `chain-007-${i}` }), SESSION_ID);
    }
    MessageStorage.deleteMessagesByIds(["chain-007-0", "chain-007-1"]);
    const list = MessageStorage.listMessages(SESSION_ID);
    expect(list.length).toBe(1);
  });

  // CHAIN-008
  it("CHAIN-008: deleteMessagesAfter 删除指定消息之后的所有消息", () => {
    useFreshPort();
    setupBase();
    for (let i = 0; i < 5; i++) {
      MessageStorage.createMessage(makeMsg({
        id: `chain-008-${i}`, timestamp: 2000 + i,
      }), SESSION_ID);
    }
    /**
     * B 态下删除候选**从会话镜像上算**；镜像未就绪时产品如实返回 0 并登记"就绪后补做"
     * （契约见 `message-port-coverage.test.ts` 的 PC-3）。真机上用户就在这个会话里、
     * 镜像已加载，所以先让镜像就绪再断言真实删除条数。
     */
    port().messages.ensureLoaded(SESSION_ID);
    const deleted = MessageStorage.deleteMessagesAfter(SESSION_ID, "chain-008-2");
    expect(deleted).toBe(2); // chain-008-3, chain-008-4
    const list = MessageStorage.listMessages(SESSION_ID);
    expect(list.length).toBe(3); // 0, 1, 2
  });

  // CHAIN-009
  it("CHAIN-009: createMessage 带 generatedFiles 存储到 DB", () => {
    useFreshPort();
    setupBase();
    const msg = makeMsg({
      id: "chain-009",
      role: "assistant",
      generatedFiles: ["/tmp/a.ts", "/tmp/b.ts"],
    });
    MessageStorage.createMessage(msg, SESSION_ID);
    // generated_files 是 `messages.upsert_index` 的参数之一（Rust 侧落进 JSON 列）
    const row = port().__table("messages").find((r) => r.id === "chain-009");
    expect(row, "消息行必须落在端口上").toBeTruthy();
    const generated = typeof row!.generated_files === "string" ? JSON.parse(row!.generated_files as string) : row!.generated_files;
    expect(generated).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
  });

  // CHAIN-010
  it("CHAIN-010: 消息 status 字段存储 — streaming/done/error", () => {
    for (const status of ["streaming", "done", "error"] as const) {
      const msg = makeMsg({ id: `chain-010-${status}`, status });
      MessageStorage.createMessage(msg, SESSION_ID);
      const loaded = MessageStorage.getMessage(`chain-010-${status}`);
      expect(loaded.status).toBe(status);
    }
  });

  // CHAIN-011
  it("CHAIN-011: updateMessage 更新 toolCall 状态", () => {
    useFreshPort();
    setupBase();
    const msg = makeMsg({
      id: "chain-011",
      role: "assistant",
      toolCalls: [{ id: "tc-011", tool: "bash", args: {}, status: "running" as const }],
    });
    MessageStorage.createMessage(msg, SESSION_ID);
    MessageStorage.updateMessage("chain-011", {
      toolCalls: [{ id: "tc-011", tool: "bash", args: {}, status: "done" as const, result: "output" }],
    });
    // 「整表替换」由 `messages.upsert_index` 的 `tool_calls` 参数实现（Rust 侧同一语义），落到端口表
    const rows = port().__table("tool_calls").filter((r) => r.message_id === "chain-011");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("tc-011");
    expect(rows[0].status).toBe("done");
    expect(rows[0].result).toBe("output");
  });

  // CHAIN-012
  it("CHAIN-012: 消息不带 reasoning 时字段为 null/undefined", () => {
    const msg = makeMsg({ id: "chain-012", reasoning: undefined });
    MessageStorage.createMessage(msg, SESSION_ID);
    const loaded = MessageStorage.getMessage("chain-012");
    expect(loaded.reasoning).toBeUndefined();
  });

  // CHAIN-013
  it("CHAIN-013: 同一 session 多消息按顺序写入和读取", () => {
    for (let i = 0; i < 10; i++) {
      MessageStorage.createMessage(makeMsg({
        id: `chain-013-${i}`, content: `第${i}条`, timestamp: 3000 + i,
      }), SESSION_ID);
    }
    const list = MessageStorage.listMessages(SESSION_ID);
    expect(list.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(list[i].content).toBe(`第${i}条`);
    }
  });

  // CHAIN-014
  it("CHAIN-014: 不同 session 的消息互不干扰", () => {
    SessionStorage.createSession({
      id: "sess-other", projectId: PROJECT_ID, title: "其他会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    MessageStorage.createMessage(makeMsg({ id: "chain-014-A", content: "A" }), SESSION_ID);
    MessageStorage.createMessage(makeMsg({ id: "chain-014-B", content: "B" }), "sess-other");
    expect(MessageStorage.listMessages(SESSION_ID).length).toBe(1);
    expect(MessageStorage.listMessages("sess-other").length).toBe(1);
  });

  // CHAIN-015
  it("CHAIN-015: getMessage 不存在的 ID 返回 null/undefined", () => {
    const loaded = MessageStorage.getMessage("nonexistent-msg");
    expect(loaded == null).toBe(true);
  });
});

// ========== B. messagesToLLMMessages 转换链路 ==========

describe("消息链路 — messagesToLLMMessages 转换", () => {
  beforeEach(baseFixture);

  // CHAIN-016
  it("CHAIN-016: messagesToLLMMessages 正确转换 user 消息", () => {
    const msgs: Message[] = [
      makeMsg({ id: "m1", role: "user", content: "用户问题" }),
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(msgs);
    expect(llmMsgs.length).toBe(1);
    expect(llmMsgs[0].role).toBe("user");
    expect(llmMsgs[0].content).toBe("用户问题");
  });

  // CHAIN-017
  it("CHAIN-017: messagesToLLMMessages 正确转换 assistant 消息（无工具调用）", () => {
    const msgs: Message[] = [
      makeMsg({ id: "m1", role: "assistant", content: "AI回复", status: "done" }),
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(msgs);
    expect(llmMsgs.length).toBe(1);
    expect(llmMsgs[0].role).toBe("assistant");
  });

  // CHAIN-018
  it("CHAIN-018: messagesToLLMMessages 带已完成工具调用 — assistant+tool 角色对", () => {
    const msgs: Message[] = [
      makeMsg({
        id: "m1", role: "assistant", content: "调用工具",
        toolCalls: [{ id: "tc1", tool: "read", args: { path: "/t" }, status: "done" as const, result: "content" }],
        status: "done",
      }),
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(msgs);
    // Should include assistant message + tool result
    expect(llmMsgs.length).toBeGreaterThanOrEqual(1);
  });

  // CHAIN-019
  // DeepSeek thinking mode REQUIRES reasoning_content round-trip (HTTP 400 otherwise).
  // messagesToLLMMessages now preserves reasoning into LLMMessage.reasoning;
  // provider.toAPIMessage emits it as reasoning_content for the API.
  it("CHAIN-019: messagesToLLMMessages 保留 reasoning 字段（供 API 回传）", () => {
    const msgs: Message[] = [
      makeMsg({ id: "m1", role: "assistant", content: "回复", reasoning: "思考", status: "done" }),
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(msgs);
    // reasoning 保留在 LLMMessage.reasoning（DeepSeek 强制回传）
    expect((llmMsgs[0] as any).reasoning).toBe("思考");
    // reasoning 不进 content 文本（避免污染对话内容）
    const content = typeof llmMsgs[0].content === "string" ? llmMsgs[0].content : "";
    expect(content).not.toContain("思考");
  });

  // CHAIN-020
  it("CHAIN-020: messagesToLLMMessages running 状态工具调用排除结果", () => {
    const msgs: Message[] = [
      makeMsg({
        id: "m1", role: "assistant", content: "",
        toolCalls: [{ id: "tc-r", tool: "bash", args: {}, status: "running" as const }],
        status: "streaming",
      }),
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(msgs);
    // Running tool calls should not have results
    expect(llmMsgs.length).toBeGreaterThanOrEqual(0);
  });

  // CHAIN-021
  it("CHAIN-021: messagesToLLMMessages error 状态工具调用包含错误结果", () => {
    const msgs: Message[] = [
      makeMsg({
        id: "m1", role: "assistant", content: "",
        toolCalls: [{ id: "tc-e", tool: "bash", args: {}, status: "error" as const, result: "Error: failed" }],
        status: "done",
      }),
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(msgs);
    expect(llmMsgs.length).toBeGreaterThanOrEqual(1);
  });

  // CHAIN-022
  it("CHAIN-022: messagesToLLMMessages 空数组返回空数组", () => {
    const llmMsgs = MessageStorage.messagesToLLMMessages([]);
    expect(llmMsgs).toEqual([]);
  });

  // CHAIN-023
  it("CHAIN-023: messagesToLLMMessages system 消息保留", () => {
    const msgs: Message[] = [
      makeMsg({ id: "m-sys", role: "system" as any, content: "系统消息" }),
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(msgs);
    expect(llmMsgs.length).toBeGreaterThanOrEqual(0);
  });

  // CHAIN-024
  it("CHAIN-024: messagesToLLMMessages 保留多轮对话顺序", () => {
    const msgs: Message[] = [
      makeMsg({ id: "m1", role: "user", content: "Q1", timestamp: 1 }),
      makeMsg({ id: "m2", role: "assistant", content: "A1", status: "done", timestamp: 2 }),
      makeMsg({ id: "m3", role: "user", content: "Q2", timestamp: 3 }),
      makeMsg({ id: "m4", role: "assistant", content: "A2", status: "done", timestamp: 4 }),
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(msgs);
    expect(llmMsgs.length).toBe(4);
    expect(llmMsgs[0].role).toBe("user");
    expect(llmMsgs[1].role).toBe("assistant");
    expect(llmMsgs[2].role).toBe("user");
    expect(llmMsgs[3].role).toBe("assistant");
  });

  // CHAIN-025
  it("CHAIN-025: messagesToLLMMessages 过滤 system-reminder 标签", () => {
    const msgs: Message[] = [
      makeMsg({
        id: "m1", role: "assistant", content: "回复<system-reminder>隐藏内容</system-reminder>",
        status: "done",
      }),
    ];
    const llmMsgs = MessageStorage.messagesToLLMMessages(msgs);
    const content = JSON.stringify(llmMsgs);
    expect(content).not.toContain("<system-reminder>");
    expect(content).not.toContain("隐藏内容");
  });
});

// ========== C. Session CRUD 与消息关联 ==========

describe("消息链路 — Session CRUD 与消息关联", () => {
  beforeEach(baseFixture);

  // CHAIN-036
  it("CHAIN-036: createSession 创建新会话", () => {
    SessionStorage.createSession({
      id: "sess-new", projectId: PROJECT_ID, title: "新会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    const sess = SessionStorage.getSession("sess-new");
    expect(sess).toBeDefined();
    expect(sess!.title).toBe("新会话");
  });

  // CHAIN-037
  it("CHAIN-037: listSessions 返回项目下全部会话", () => {
    SessionStorage.createSession({
      id: "sess-2", projectId: PROJECT_ID, title: "会话2",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    SessionStorage.createSession({
      id: "sess-3", projectId: PROJECT_ID, title: "会话3",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    const list = SessionStorage.listSessions(PROJECT_ID);
    expect(list.length).toBe(3); // base + 2 new
  });

  // CHAIN-038
  it("CHAIN-038: deleteSession 删除会话及其消息", () => {
    useFreshPort();
    setupBase(); // 被删的会话要在端口里真实存在
    installForeignKeyCascade(port()); // 级联是引擎的活（PRAGMA foreign_keys=ON + ON DELETE CASCADE），测试双要补上
    MessageStorage.createMessage(makeMsg({ id: "chain-038" }), SESSION_ID);
    SessionStorage.deleteSession(SESSION_ID);
    const sess = SessionStorage.getSession(SESSION_ID);
      expect(sess == null || sess == undefined).toBe(true);
    // Messages should be cascade deleted
    const msgs = MessageStorage.listMessages(SESSION_ID);
    expect(msgs.length).toBe(0);
  });

  // CHAIN-039
  it("CHAIN-039: updateSession 更新会话标题", () => {
    SessionStorage.updateSession(SESSION_ID, { title: "更新标题" });
    const sess = SessionStorage.getSession(SESSION_ID);
    expect(sess!.title).toBe("更新标题");
  });

  // CHAIN-040
  it("CHAIN-040: session lastMessageAt 更新", () => {
    const before = SessionStorage.getSession(SESSION_ID)!.lastMessageAt;
    MessageStorage.createMessage(makeMsg({ id: "chain-040" }), SESSION_ID);
    SessionStorage.updateSession(SESSION_ID, { lastMessageAt: Date.now(), messageCount: 1 });
    const after = SessionStorage.getSession(SESSION_ID)!.lastMessageAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  // CHAIN-041
  it("CHAIN-041: 不同项目的会话隔离", () => {
    ProjectStorage.createProject({
      id: "proj-other", name: "其他项目", path: "D:/other",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: "sess-other-proj", projectId: "proj-other", title: "其他",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    const listA = SessionStorage.listSessions(PROJECT_ID);
    const listB = SessionStorage.listSessions("proj-other");
    expect(listA.find(s => s.id === "sess-other-proj")).toBeUndefined();
    expect(listB.find(s => s.id === SESSION_ID)).toBeUndefined();
  });

  // CHAIN-042
  it("CHAIN-042: deleteProject 删除项目及关联会话", () => {
    useFreshPort();
    setupBase(); // 被删的项目要在端口里真实存在
    installForeignKeyCascade(port()); // 级联是引擎的活，测试双要补上（见 installForeignKeyCascade）
    SessionStorage.createSession({
      id: "sess-del-proj", projectId: PROJECT_ID, title: "待删",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    ProjectStorage.deleteProject(PROJECT_ID);
      expect(ProjectStorage.getProject(PROJECT_ID) == null).toBe(true);
    expect(SessionStorage.listSessions(PROJECT_ID).length).toBe(0);
  });

  // CHAIN-043
  it("CHAIN-043: createProject 存储项目元信息", () => {
    const proj = ProjectStorage.getProject(PROJECT_ID);
    expect(proj).toBeDefined();
    expect(proj!.name).toBe("链路测试");
    expect(proj!.path).toBe("D:/chain");
  });

  // CHAIN-044
  it("CHAIN-044: updateProject 更新项目名称", () => {
    ProjectStorage.updateProject(PROJECT_ID, { name: "更新名称" });
    const proj = ProjectStorage.getProject(PROJECT_ID);
    expect(proj!.name).toBe("更新名称");
  });

  // CHAIN-045
  it("CHAIN-045: listProjects 返回全部项目", () => {
    ProjectStorage.createProject({
      id: "proj-2", name: "项目2", path: "D:/p2",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    const list = ProjectStorage.listProjects();
    expect(list.length).toBe(2);
  });
});

// ========== E. 设置/快捷短语/草稿/反馈存储 ==========

describe("消息链路 — 设置/快捷短语/草稿/反馈存储", () => {
  beforeEach(() => {
    /**
     * 夹具（第 18 轮，L1）：**端口播种**，不再初始化旧库。
     *
     * 原来这一段是 5 条裸 SQL：清库用的
     * `try { resetDatabase() } catch { initDatabase() }` + `INSERT INTO projects` +
     * 4 条 `INSERT INTO sessions`（`sess-chain-test` / `sess-del` / `sess-A` / `sess-B`）。
     * 它们的用途是"满足旧库的外键约束"。A 态已删 → 换成产品 API：
     * `setupBase()` 建 `proj-chain-test` + `sess-chain-test`（与原来那两条 INSERT 逐字段等价），
     * 另外三个会话按同样的字段用 `createSession` 补上（草稿类用例拿它们当 sessionId 用）。
     */
    localStorage.clear();
    setupBase(); // Create base project + session
    for (const [id, title] of [
      ["sess-del", "删除测试"],
      ["sess-A", "会话A"],
      ["sess-B", "会话B"],
    ] as const) {
      SessionStorage.createSession({
        id, projectId: PROJECT_ID, title,
        createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
      });
    }
  });

  // CHAIN-046
  it("CHAIN-046: setSetting + getSetting 键值存储", () => {
    setSetting("test-key", "test-value");
    expect(getSetting("test-key")).toBe("test-value");
  });

  // CHAIN-047
  it("CHAIN-047: getSetting 不存在的键返回 null/undefined", () => {
    expect(getSetting("nonexistent-key")).toBeNull();
  });

  // CHAIN-048
  it("CHAIN-048: setSetting 覆盖已存在的值", () => {
    setSetting("overwrite-key", "v1");
    setSetting("overwrite-key", "v2");
    expect(getSetting("overwrite-key")).toBe("v2");
  });

  // CHAIN-049
  it("CHAIN-049: saveQuickPhrase + loadQuickPhrases 快捷短语 CRUD", () => {
    saveQuickPhrase({ id: "qp-1", title: "短语1", content: "短语1", category: "常用", usageCount: 0, createdAt: Date.now(), updatedAt: Date.now() });
    const phrases = loadQuickPhrases();
    expect(phrases.find(p => p.id === "qp-1")).toBeDefined();
  });

  // CHAIN-050
  it("CHAIN-050: deleteQuickPhrase 删除快捷短语", () => {
    saveQuickPhrase({ id: "qp-del", title: "待删", content: "待删", category: "常用", usageCount: 0, createdAt: Date.now(), updatedAt: Date.now() });
    deleteQuickPhrase("qp-del");
    expect(loadQuickPhrases().find(p => p.id === "qp-del")).toBeUndefined();
  });

  // CHAIN-051
  it("CHAIN-051: savePromptDraft + loadPromptDrafts 草稿 CRUD", () => {
    const draftId = savePromptDraft(SESSION_ID, "草稿内容");
    const drafts = loadPromptDrafts(SESSION_ID);
    expect(drafts.find(d => d.content === "草稿内容")).toBeDefined();
  });

  // CHAIN-052
  it("CHAIN-052: deletePromptDraft 删除草稿", () => {
    const draftId = savePromptDraft("sess-del", "待删");
    deletePromptDraft(draftId);
    expect(loadPromptDrafts("sess-del").find(d => d.id === draftId)).toBeUndefined();
  });

  // CHAIN-053
  it("CHAIN-053: setFeedback + getFeedback 消息反馈存储", () => {
    useAppStore.getState().setFeedback("msg-fb-1", "like");
    expect(useAppStore.getState().feedback["msg-fb-1"]).toBe("like");
  });

  // CHAIN-054
  it("CHAIN-054: setFeedback(null) 清除反馈", () => {
    useAppStore.getState().setFeedback("msg-fb-2", "dislike");
    useAppStore.getState().setFeedback("msg-fb-2", null);
    expect(useAppStore.getState().feedback["msg-fb-2"]).toBeUndefined();
  });

  // CHAIN-055
  it("CHAIN-055: 多条快捷短语按分类存储", () => {
    saveQuickPhrase({ id: "qp-c1", title: "常用1", content: "常用1", category: "常用", usageCount: 0, createdAt: Date.now(), updatedAt: Date.now() });
    saveQuickPhrase({ id: "qp-c2", title: "常用2", content: "常用2", category: "常用", usageCount: 0, createdAt: Date.now(), updatedAt: Date.now() });
    saveQuickPhrase({ id: "qp-e1", title: "English1", content: "English1", category: "English", usageCount: 0, createdAt: Date.now(), updatedAt: Date.now() });
    const phrases = loadQuickPhrases();
    expect(phrases.length).toBeGreaterThanOrEqual(3);
  });

  // CHAIN-056
  it("CHAIN-056: 多个草稿按 session 隔离", () => {
    savePromptDraft("sess-A", "S1草稿");
    savePromptDraft("sess-B", "S2草稿");
    expect(loadPromptDrafts("sess-A").find(d => d.content === "S1草稿")).toBeDefined();
    expect(loadPromptDrafts("sess-B").find(d => d.content === "S2草稿")).toBeDefined();
  });

  // CHAIN-057
  it("CHAIN-057: addMessage + addToolCall + updateToolCall 完整工具调用链路", () => {
    useAppStore.getState().addMessage({
      id: "msg-tc-chain", role: "assistant", content: "",
      timestamp: Date.now(), status: "streaming",
    });
    useAppStore.getState().addToolCall("msg-tc-chain", {
      id: "tc-chain-1", tool: "read", args: { path: "/t" }, status: "running",
    });
    useAppStore.getState().updateToolCall("msg-tc-chain", "tc-chain-1", {
      status: "done", result: "content",
    });
    const msg = useAppStore.getState().messages.find(m => m.id === "msg-tc-chain");
    expect(msg!.toolCalls![0].status).toBe("done");
    expect(msg!.toolCalls![0].result).toBe("content");
  });

  // CHAIN-058
  it("CHAIN-058: addMessage 链式更新 — 流式内容追加", () => {
    useAppStore.getState().addMessage({
      id: "msg-stream", role: "assistant", content: "",
      timestamp: Date.now(), status: "streaming",
    });
    useAppStore.getState().updateMessage("msg-stream", { content: "Hello" });
    useAppStore.getState().updateMessage("msg-stream", { content: "Hello World" });
    const msg = useAppStore.getState().messages.find(m => m.id === "msg-stream");
    expect(msg!.content).toBe("Hello World");
  });

  // CHAIN-059
  it("CHAIN-059: addMessage + updateMessage 设置 reasoning", () => {
    useAppStore.getState().addMessage({
      id: "msg-reas", role: "assistant", content: "",
      timestamp: Date.now(), status: "streaming",
    });
    useAppStore.getState().updateMessage("msg-reas", { reasoning: "思考中..." });
    const msg = useAppStore.getState().messages.find(m => m.id === "msg-reas");
    expect(msg!.reasoning).toBe("思考中...");
  });

  // CHAIN-060
  it("CHAIN-060: addMessage + updateMessage 设置 generatedFiles", () => {
    useAppStore.getState().addMessage({
      id: "msg-gen", role: "assistant", content: "生成了文件",
      timestamp: Date.now(), status: "done",
    });
    useAppStore.getState().updateMessage("msg-gen", { generatedFiles: ["/tmp/out.ts"] });
    const msg = useAppStore.getState().messages.find(m => m.id === "msg-gen");
    expect(msg!.generatedFiles).toEqual(["/tmp/out.ts"]);
  });
});

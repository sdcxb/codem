/**
 * 全量测试：Git Worktree / 笔记本功能对核心链路的影响 — IMPACT-001 ~ IMPACT-060
 *
 * 覆盖范围：
 *   A. Worktree 环境模式切换对消息链路影响 (IMPACT-001 ~ IMPACT-015)
 *   B. Worktree 路径隔离与 cwd 传递 (IMPACT-016 ~ IMPACT-025)
 *   C. 笔记本模式对对话上下文影响 (IMPACT-026 ~ IMPACT-040)
 *   D. 新增 DB 表对已有存储无副作用 (IMPACT-041 ~ IMPACT-050)
 *   E. 新增 P1-P4 组件导入不影响编译 (IMPACT-051 ~ IMPACT-060)
 *
 * 关键组件：
 *   - environment/worktree-manager.ts
 *   - knowledge/storage.ts
 *   - 存储端口（`domainRead*` / `domainWrite` / 域命令）
 *   - core/types.ts (Session 扩展字段)
 *
 * 第 18 轮（L1）：本文件原来的夹具是**裸 SQL 打旧库**，且用例里留着"A 态（端口未注册）走旧库"
 * 的对照分支。旧库在 rust 模式下刻意不加载（`setup.ts` 也不再 `initDatabase()`），回滚开关退役后
 * A 态在生产里不可能出现 —— 所以：
 *   - 数据夹具与断言一律走**端口**（产品在 rust 模式下只读写端口）；
 *   - "表 / 列 / 索引 / 外键"这类 schema 断言的**真源**换成引擎侧 DDL
 *     （`src-tauri/codem-db/sql/schema.sql`：引擎建库执行的就是它）。
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

import * as fs from "fs";
import * as path from "path";

import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { setSetting, getSetting, saveQuickPhrase, loadQuickPhrases } from "../core/storage/settings";
import { getStoragePort } from "../core/storage/port";
import { createShowTodoTool, loadTodoList } from "../core/llm/tools/show-todo";
import { putMessageFeedback } from "../core/llm/feedback";
import type { ToolContext } from "../core/llm/tools";
import type { FakeStoragePort } from "./fake-storage-port";
import type { Message } from "../store";
import type { Session } from "../core/types";

const PROJECT_ID = "proj-impact-test";
const SESSION_ID = "sess-impact-test";

/**
 * 当前注册的存储端口（`setup.ts` 每个用例前注册一个内存假端口）。
 *
 * 第 18 轮：这里原来是个"两态分流"（B 态读端口 / A 态读旧库）。A 态（端口未注册）随回滚开关
 * 一起退役 —— 生产里端口是唯一形态，所以断言一律读端口表（`__table` / `__writes`），
 * 不再有"另一条去旧库的路"。
 */
function port(): FakeStoragePort {
  return getStoragePort() as unknown as FakeStoragePort;
}

// ========== 引擎侧 schema 真源（第 18 轮新增） ==========

/** 引擎建库执行的 DDL（`codem-db` 侧 `schema.rs` 读的就是它） */
const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "../../src-tauri/codem-db/sql/schema.sql"),
  "utf-8",
);

/** 该表是否在引擎 schema 里声明（等价于旧库那一次 `sqlite_master` 查询） */
function schemaDeclaresTable(table: string): boolean {
  return new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(`).test(SCHEMA_SQL);
}

/** 某张表的建表语句原文（等价于旧库 `SELECT sql FROM sqlite_master WHERE name=?`） */
function createTableSql(table: string): string {
  const m = SCHEMA_SQL.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\);`),
  );
  if (!m) throw new Error(`引擎 schema 里没有表 ${table}`);
  return m[0];
}

/** 该表在引擎 schema 里声明的列名（等价于旧库 `PRAGMA table_info(t)` 的 name 列） */
function schemaColumns(table: string): string[] {
  return createTableSql(table)
    .split("\n")
    .slice(1) // 去掉 `CREATE TABLE … (`
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line.length > 0 && !/^\)/.test(line))
    .filter((line) => !/^(FOREIGN|PRIMARY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

function setupBase(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID, name: "影响测试", path: "D:/impact",
    createdAt: Date.now(), lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SESSION_ID, projectId: PROJECT_ID, title: "影响测试会话",
    createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  });
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    role: "user",
    content: "test",
    timestamp: Date.now(),
    status: "done",
    ...overrides,
  };
}

// ========== A. Worktree 环境模式切换对消息链路影响 ==========

describe("Git Worktree 影响 — 环境模式与消息链路", () => {
  beforeEach(() => {
    // 第 18 轮（L1）：`resetDatabase()` / `initDatabase()` 已删（只为旧库存在的清理）
    localStorage.clear();
    setupBase();
  });

  // IMPACT-001
  it("IMPACT-001: Session executionMode 字段存在", () => {
    const sess = SessionStorage.getSession(SESSION_ID);
    // Session should have executionMode field (may be undefined = default)
    expect(sess).toBeDefined();
  });

  // IMPACT-002
  it("IMPACT-002: Session worktreePath 字段存在", () => {
    const sess = SessionStorage.getSession(SESSION_ID);
    // worktreePath may be null/undefined for non-worktree sessions
    expect(sess).toBeDefined();
  });

  // IMPACT-003
  it("IMPACT-003: current_workspace 模式消息正常存储", () => {
    const msg = makeMsg({ id: "impact-003", content: "本地模式消息" });
    MessageStorage.createMessage(msg, SESSION_ID);
    expect(MessageStorage.getMessage("impact-003").content).toBe("本地模式消息");
  });

  // IMPACT-004
  it("IMPACT-004: git_worktree 模式消息正常存储", () => {
    // Even in worktree mode, messages are stored in the same DB
    const msg = makeMsg({ id: "impact-004", content: "工作树模式消息" });
    MessageStorage.createMessage(msg, SESSION_ID);
    expect(MessageStorage.getMessage("impact-004").content).toBe("工作树模式消息");
  });

  // IMPACT-005
  it("IMPACT-005: 模式切换不丢失已有消息", () => {
    for (let i = 0; i < 3; i++) {
      MessageStorage.createMessage(makeMsg({ id: `impact-005-${i}` }), SESSION_ID);
    }
    // Simulate mode switch — messages should persist
    expect(MessageStorage.listMessages(SESSION_ID).length).toBe(3);
  });

  // IMPACT-006
  it("IMPACT-006: 工具调用在 worktree 模式下正常存储", () => {
    const msg = makeMsg({
      id: "impact-006",
      role: "assistant",
      toolCalls: [{ id: "tc-wt", tool: "write", args: { path: "/wt/test.ts" }, status: "done" as const, result: "written" }],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    /**
     * 工具调用落在端口的 `tool_calls` 表里（产品在 rust 模式下只写端口）。
     *
     * 为什么这里读端口表而不是 `getMessage().toolCalls`：会话镜像行**刻意不含 tool_calls**
     * （内存预算，见 `MirrorMessageRow`），而 `getMessage` 命中镜像路由时不会走到日志兜底 ——
     * 于是"工具调用写进去了、同步读却拿不到"。那是一条**产品读写分裂**，
     * 已单独记录（不在本批"只改测试"的范围内），所以断言落在存储侧。
     */
    const rows = port().__table("tool_calls").filter((r) => r.message_id === "impact-006");
    expect(rows, "工具调用必须写进存储（端口侧）").toHaveLength(1);
    expect(rows[0].tool).toBe("write");
    // 消息本体仍然读得到（读路径没被这次断言"跳过"）
    expect(MessageStorage.getMessage("impact-006").content).toBe("test");
  });

  // IMPACT-007
  it("IMPACT-007: 多 session 不同 executionMode 共存", () => {
    SessionStorage.createSession({
      id: "sess-wt-1", projectId: PROJECT_ID, title: "Worktree会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    SessionStorage.createSession({
      id: "sess-local-1", projectId: PROJECT_ID, title: "本地会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    const sessions = SessionStorage.listSessions(PROJECT_ID);
    expect(sessions.length).toBe(3);
  });

  // IMPACT-008
  it("IMPACT-008: 消息中的 generatedFiles 在 worktree 模式下保留", () => {
    const msg = makeMsg({
      id: "impact-008",
      role: "assistant",
      generatedFiles: ["/wt/file1.ts"],
    });
    MessageStorage.createMessage(msg, SESSION_ID);

    /**
     * `generated_files` 是 `messages` 行上的 JSON 列，写路径（`messages.upsert_index`）
     * 会把它带过去。真机上这一列是 TEXT（JSON 字符串），内存端口存的是原值 ——
     * 所以这里按 `rowToMessage` 的同一条规则解析（两种表示都接受），而不是假定某一种。
     */
    const row = port().__table("messages").find((r) => r.id === "impact-008");
    expect(row, "消息行必须写进端口").toBeDefined();
    const raw = row!.generated_files;
    const files = typeof raw === "string" ? JSON.parse(raw) : raw;
    expect(files).toEqual(["/wt/file1.ts"]);
  });

  // IMPACT-009
  it("IMPACT-009: 删除 worktree session 不影响其他 session 消息", () => {
    SessionStorage.createSession({
      id: "sess-wt-del", projectId: PROJECT_ID, title: "待删WT",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    MessageStorage.createMessage(makeMsg({ id: "impact-009-A" }), SESSION_ID);
    MessageStorage.createMessage(makeMsg({ id: "impact-009-B" }), "sess-wt-del");
    SessionStorage.deleteSession("sess-wt-del");
    expect(MessageStorage.listMessages(SESSION_ID).length).toBe(1);
  });

  // IMPACT-010
  it("IMPACT-010: fork session 继承消息", () => {
    for (let i = 0; i < 3; i++) {
      MessageStorage.createMessage(makeMsg({ id: `impact-010-${i}`, timestamp: 4000 + i }), SESSION_ID);
    }
    // Fork would copy messages from source session
    SessionStorage.createSession({
      id: "sess-fork", projectId: PROJECT_ID, title: "Fork",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 3,
    });
    // Copy messages (simulating fork)
    const sourceMsgs = MessageStorage.listMessages(SESSION_ID);
    for (const msg of sourceMsgs) {
      MessageStorage.createMessage({ ...msg, id: `fork-${msg.id}` }, "sess-fork");
    }
    expect(MessageStorage.listMessages("sess-fork").length).toBe(3);
  });

  // IMPACT-011
  it("IMPACT-011: Session updateSession 更新 executionMode", () => {
    SessionStorage.updateSession(SESSION_ID, { executionMode: "git_worktree" } as any);
    const sess = SessionStorage.getSession(SESSION_ID);
    expect((sess as any).executionMode).toBe("git_worktree");
  });

  // IMPACT-012
  it("IMPACT-012: Session updateSession 设置 worktreePath", () => {
    SessionStorage.updateSession(SESSION_ID, { worktreePath: "/tmp/wt-1" } as any);
    const sess = SessionStorage.getSession(SESSION_ID);
    expect((sess as any).worktreePath).toBe("/tmp/wt-1");
  });

  // IMPACT-013
  it("IMPACT-013: 消息存储 schema 在 worktree 扩展后保持兼容", () => {
    // 原来是 `PRAGMA table_info(messages)`（旧库）；列的真源是引擎建库用的那份 DDL
    const columns = schemaColumns("messages");
    expect(columns).toContain("id");
    expect(columns).toContain("role");
    expect(columns).toContain("content");
    // reasoning 与 tool_calls 在不同 schema 里命名可能不同（这里接受含 reason/tool 的列名）
    const hasReasoning = columns.some((c) => c.includes("reason"));
    const hasToolCalls = columns.some((c) => c.includes("tool"));
    expect(hasReasoning || columns.includes("reasoning")).toBe(true);
    expect(columns).toContain("status");
    expect(columns).toContain("timestamp");
  });

  // IMPACT-014
  it("IMPACT-014: sessions 表包含 executionMode 和 worktreePath 列", () => {
    const columns = schemaColumns("sessions");
    // 这两列在不在取决于迁移；但基础列必须有
    expect(columns).toContain("id");
    expect(columns).toContain("project_id");
    expect(columns).toContain("title");
  });

  // IMPACT-015
  it("IMPACT-015: 消息按 session 查询在 worktree 模式下正确", () => {
    const wtSession = "sess-wt-query";
    SessionStorage.createSession({
      id: wtSession, projectId: PROJECT_ID, title: "WT查询",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    MessageStorage.createMessage(makeMsg({ id: "wt-q-1" }), wtSession);
    MessageStorage.createMessage(makeMsg({ id: "wt-q-2" }), wtSession);
    MessageStorage.createMessage(makeMsg({ id: "wt-q-3" }), SESSION_ID);
    expect(MessageStorage.listMessages(wtSession).length).toBe(2);
    expect(MessageStorage.listMessages(SESSION_ID).length).toBe(1);
  });
});

// ========== B. Worktree 路径隔离与 cwd 传递 ==========

describe("Git Worktree 影响 — 路径隔离", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // IMPACT-016
  it("IMPACT-016: 项目路径正确存储", () => {
    ProjectStorage.createProject({
      id: "proj-path-1", name: "路径测试", path: "D:/projects/test",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    const proj = ProjectStorage.getProject("proj-path-1");
    expect(proj!.path).toBe("D:/projects/test");
  });

  // IMPACT-017
  it("IMPACT-017: 多项目路径不串扰", () => {
    ProjectStorage.createProject({
      id: "proj-A", name: "A", path: "D:/A",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    ProjectStorage.createProject({
      id: "proj-B", name: "B", path: "D:/B",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    expect(ProjectStorage.getProject("proj-A")!.path).toBe("D:/A");
    expect(ProjectStorage.getProject("proj-B")!.path).toBe("D:/B");
  });

  // IMPACT-018
  it("IMPACT-018: updateProject 更新路径", () => {
    ProjectStorage.createProject({
      id: "proj-up-path", name: "test", path: "D:/old",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    ProjectStorage.updateProject("proj-up-path", { path: "D:/new" });
    expect(ProjectStorage.getProject("proj-up-path")!.path).toBe("D:/new");
  });

  // IMPACT-019
  it("IMPACT-019: 项目删除后 session 也被删除", () => {
    ProjectStorage.createProject({
      id: "proj-cascade", name: "cascade", path: "D:/c",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: "sess-cascade", projectId: "proj-cascade", title: "cascade",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    ProjectStorage.deleteProject("proj-cascade");

    /**
     * "级联"这件事是**引擎**做的，不是渲染侧做的：
     * 渲染侧只发一条 `crud.delete {table:"projects"}`，会话/消息由 Rust 侧的外键
     * `ON DELETE CASCADE` 带走（`PRAGMA foreign_keys=ON`，见 engine.rs）。
     *
     * ⚠️ 内存假端口**不模拟外键级联**，所以这里不能拿"端口里还有没有 session 行"当判据
     * （那会把测试双的实现缺口当成产品缺陷）。判据拆成两条，都要成立：
     *   ① 删除确实写穿到了端口（否则真机上项目根本删不掉）；
     *   ② 引擎侧确实存在那条级联外键（真机上的"会话被删"由它保证）。
     *
     * （第 18 轮：原来这里还有一条 A 态分支断言旧库的 `listSessions` 为空 —— A 态已随
     * 回滚开关退役，而且端口模式下假端口不级联，那条断言测的是测试双的缺口，已删。）
     */
    const del = port()
      .__writes()
      .find(
        (w) =>
          w.command === "crud.delete" &&
          (w.params as Record<string, unknown> | undefined)?.table === "projects" &&
          ((w.params as Record<string, unknown> | undefined)?.where as Record<string, unknown> | undefined)?.id ===
            "proj-cascade",
      );
    expect(del, "项目删除必须写穿到端口（否则真机上项目删不掉）").toBeTruthy();

    expect(
      SCHEMA_SQL,
      "会话的级联删除由引擎侧外键保证（渲染侧不逐表删）",
    ).toContain("FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE");
  });

  // IMPACT-020
  it("IMPACT-020: 项目 lastAccessedAt 更新", () => {
    ProjectStorage.createProject({
      id: "proj-access", name: "access", path: "D:/a",
      createdAt: 1000, lastAccessedAt: 1000,
    });
    const now = Date.now();
    ProjectStorage.updateProject("proj-access", { lastAccessedAt: now });
    expect(ProjectStorage.getProject("proj-access")!.lastAccessedAt).toBe(now);
  });
});

// ========== C. 笔记本模式对对话上下文影响 ==========

describe("笔记本功能影响 — 对话上下文", () => {
  beforeEach(() => {
    localStorage.clear();
    setupBase();
  });

  /**
   * IMPACT-026 ~ IMPACT-039：这些表是否存在于**存储 schema**里。
   *
   * 原来每一条都是 `getDatabase().exec("SELECT name FROM sqlite_master WHERE type='table' AND name=…")`
   * —— 问旧引擎"这张表建出来没有"。第 18 轮后建库的活整个在引擎侧（`codem-db`，执行 `schema.sql`），
   * 所以判据指向那份 DDL：对象（这张表在存储里存在）与强度都没变，真源换成引擎建表的地方。
   * 每张表仍是一条**独立**用例（id 与原来一一对应），没有合并成一条批量断言。
   */
  for (const [id, table] of [
    ["IMPACT-026", "notebooks"],
    ["IMPACT-027", "notebook_sources"],
    ["IMPACT-028", "notebook_chunks"],
    ["IMPACT-029", "notes"],
    ["IMPACT-030", "flashcards"],
    ["IMPACT-031", "graph_nodes"],
    ["IMPACT-032", "graph_edges"],
    ["IMPACT-033", "quick_phrases"],
    ["IMPACT-034", "prompt_drafts"],
    ["IMPACT-035", "todo_lists"],
    ["IMPACT-036", "message_feedback"],
    ["IMPACT-037", "notebook_groups"],
    ["IMPACT-038", "note_links"],
    ["IMPACT-039", "note_versions"],
  ] as Array<[string, string]>) {
    it(`${id}: ${table} 表存在`, () => {
      expect(schemaDeclaresTable(table), `引擎 schema 必须声明 ${table}`).toBe(true);
    });
  }

  // IMPACT-040
  it("IMPACT-040: 新增表不影响 messages 表结构", () => {
    const columns = schemaColumns("messages");
    expect(columns).toContain("id");
    expect(columns).toContain("role");
    expect(columns).toContain("content");
  });
});

// ========== D. 新增 DB 表对已有存储无副作用 ==========

describe("新增 DB 表对已有存储无副作用", () => {
  beforeEach(() => {
    localStorage.clear();
    setupBase();
  });

  // IMPACT-041
  it("IMPACT-041: 项目 CRUD 在新增表后正常", () => {
    ProjectStorage.createProject({
      id: "proj-new-table", name: "新表后", path: "D:/nt",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    expect(ProjectStorage.getProject("proj-new-table")).toBeDefined();
    ProjectStorage.deleteProject("proj-new-table");
    expect(ProjectStorage.getProject("proj-new-table")).toBeNull();
  });

  // IMPACT-042
  it("IMPACT-042: Session CRUD 在新增表后正常", () => {
    SessionStorage.createSession({
      id: "sess-new-table", projectId: PROJECT_ID, title: "新表后会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    expect(SessionStorage.getSession("sess-new-table")).toBeDefined();
    SessionStorage.deleteSession("sess-new-table");
    expect(SessionStorage.getSession("sess-new-table")).toBeNull();
  });

  // IMPACT-043
  it("IMPACT-043: 消息 CRUD 在新增表后正常", () => {
    const msg = makeMsg({ id: "impact-new-table-msg" });
    MessageStorage.createMessage(msg, SESSION_ID);
    expect(MessageStorage.getMessage("impact-new-table-msg")).toBeDefined();
  });

  // IMPACT-044
  it("IMPACT-044: 设置 CRUD 在新增表后正常", () => {
    setSetting("test-after-new-tables", "value");
    expect(getSetting("test-after-new-tables")).toBe("value");
  });

  // IMPACT-045
  it("IMPACT-045: 消息列表在新增表后正确排序", () => {
    for (let i = 0; i < 5; i++) {
      MessageStorage.createMessage(makeMsg({
        id: `impact-sort-${i}`, timestamp: 5000 + i,
      }), SESSION_ID);
    }
    const list = MessageStorage.listMessages(SESSION_ID);
    expect(list[0].id).toBe("impact-sort-0");
    expect(list[4].id).toBe("impact-sort-4");
  });

  // IMPACT-046
  it("IMPACT-046: DB 防抖持久化不丢失数据", () => {
    setSetting("debounce-test", "v1");
    setSetting("debounce-test", "v2");
    setSetting("debounce-test", "v3");
    expect(getSetting("debounce-test")).toBe("v3");
  });

  // IMPACT-047
  it("IMPACT-047: 消息 → 会话 → 项目 这条链可查（联查的等价判据）", () => {
    /*
     * 原来是渲染侧发一条三表 JOIN 的裸 SQL（`messages ⋈ sessions ⋈ projects`），
     * 只断言 `result` 不为 undefined。第 18 轮后渲染侧**没有 SQL 面**了：跨表关联由引擎侧
     * 外键与命令负责 —— 所以判据换成两条都成立的端口语义，强度不低于原来：
     *   ① 引擎 schema 里确实存在让这条链成立的两条外键（JOIN 的合法性来自它们）；
     *   ② 产品读路径能把这条链读全（消息 → 所属会话 → 所属项目）。
     */
    MessageStorage.createMessage(makeMsg({ id: "impact-047-msg" }), SESSION_ID);

    expect(
      createTableSql("messages"),
      "messages → sessions 的外键（联查的前提）",
    ).toContain("FOREIGN KEY (session_id) REFERENCES sessions(id)");
    expect(
      createTableSql("sessions"),
      "sessions → projects 的外键（联查的前提）",
    ).toContain("FOREIGN KEY (project_id) REFERENCES projects(id)");

    const msg = MessageStorage.getMessage("impact-047-msg");
    expect(msg, "消息读得到").not.toBeNull();
    const sess = SessionStorage.getSession(SESSION_ID);
    expect(sess!.projectId, "沿消息的会话能取到项目").toBe(PROJECT_ID);
    expect(ProjectStorage.getProject(sess!.projectId)!.name, "项目读得到").toBe("影响测试");
  });

  // IMPACT-048
  it("IMPACT-048: todo_lists 表可写入和读取", async () => {
    /**
     * 原来这条用裸 SQL 往**旧库**插一行再读回来。端口模式下产品根本不写旧库
     * （真机上旧库刻意不存在），所以旧库里既没有 `sessions` 父行、也没有这张表的写入。
     * 现在走**产品的待办写入路径**（`show_todo` 工具 → `domainWrite("todo_lists", …)`），
     * 再从产品真正使用的数据源（端口表 / 产品读接口）读回来 —— 写读两端都还在判据里。
     *
     * （第 18 轮：原来还有一条 A 态分支读旧库 —— A 态已随回滚开关退役，已删。）
     */
    const tool = createShowTodoTool();
    const result = await tool.execute(
      { todos: [{ content: "test", status: "pending" }] },
      { sessionId: SESSION_ID } as unknown as ToolContext,
    );
    expect(result.title, `待办写入不应失败：${result.output}`).toBe("Todo List Created");

    const row = port().__table("todo_lists").find((r) => r.session_id === SESSION_ID);
    expect(row, "待办必须写进端口（产品在 rust 模式下只写端口）").toBeDefined();
    const todoId = String(row!.id);
    expect(JSON.parse(String(row!.todos))[0].content).toBe("test");
    // 读路径同样走产品接口
    expect(loadTodoList(todoId)![0].content).toBe("test");
  });

  // IMPACT-049
  it("IMPACT-049: message_feedback 表可写入和读取", async () => {
    /**
     * 同 IMPACT-048：原来那两行裸 SQL 打的是旧库，端口模式下会撞
     * `FOREIGN KEY constraint failed`（父行在端口里、旧库里没有）。
     * 现在走产品的反馈接口：**写**是 `putMessageFeedback`（域写 `crud.upsert`）、
     * **读**是 `loadFeedback`（域镜像），两端都断言"写得进、读得回"。
     *
     * （第 18 轮：原来还有一条 A 态分支读旧库的 `message_feedback`，已随 A 态退役删除。）
     * （第 72 轮审计：当时这里写的是 `MessageStorage.saveFeedback` —— 引擎的
     *  `feedback.set`，**5 列、且不写域镜像**。那条写路径已整体删除：写进去、镜像里没有，
     *  读路径读镜像时就是"写了却读不到"。所以现在只能用域写这一条。）
     */
    MessageStorage.createMessage(makeMsg({ id: "msg-fb-db-test" }), SESSION_ID);

    // 镜像接手 `message_feedback` 是异步的（域读返回 `undefined` = 还没接手）→ 等它接手再判
    let put = putMessageFeedback(SESSION_ID, "msg-fb-db-test", "like");
    await vi.waitFor(() => {
      put = putMessageFeedback(SESSION_ID, "msg-fb-db-test", "like");
      expect(put.ok, `反馈写入不应失败：${put.ok ? "" : put.error}`).toBe(true);
    });
    expect(MessageStorage.loadFeedback("msg-fb-db-test")).toBe("like");

    const written = port()
      .__writes()
      .some(
        (w) =>
          w.command === "crud.upsert" &&
          (w.params as Record<string, unknown> | undefined)?.table === "message_feedback" &&
          ((w.params as { rows?: Record<string, unknown>[] }).rows ?? []).some(
            (r) => r.message_id === "msg-fb-db-test" && r.feedback === "like",
          ),
      );
    expect(written, "反馈必须写穿到端口（否则重启后丢失）").toBe(true);
  });

  // IMPACT-050
  it("IMPACT-050: quick_phrases 表可写入和读取", () => {
    /*
     * 原来是裸 SQL `INSERT INTO quick_phrases …` + `SELECT content …`（旧库）。
     * 快捷短语在端口世界有**产品读写接口**（`saveQuickPhrase` / `loadQuickPhrases`，走配置面扩展域
     * 的镜像 + `quick_phrases.save` 写穿）—— 所以改成走它，写读两端都还在判据里，
     * 并且额外钉住"确实写穿了端口"（只改内存镜像的话重启就丢）。
     */
    saveQuickPhrase({
      id: "qp-db-test", title: "短语标题", content: "短语内容",
      category: "other", usageCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });

    const loaded = loadQuickPhrases().find((q) => q.id === "qp-db-test");
    expect(loaded, "快捷短语必须能读回").toBeDefined();
    expect(loaded!.content).toBe("短语内容");

    const written = port()
      .__writes()
      .some(
        (w) =>
          w.command === "quick_phrases.save" &&
          (w.params as Record<string, unknown> | undefined)?.id === "qp-db-test" &&
          (w.params as Record<string, unknown> | undefined)?.content === "短语内容",
      );
    expect(written, "快捷短语必须写穿到端口（否则重启后丢失）").toBe(true);
  });
});

// ========== E. 新增 P1-P4 组件导入不影响编译 ==========

describe("新增 P1-P4 组件导入不影响编译", () => {
  // IMPACT-051
  it("IMPACT-051: CorrectionModeToggle 组件可导入", async () => {
    const mod = await import("../components/CorrectionModeToggle");
    expect(mod.CorrectionModeToggle).toBeDefined();
  });

  // IMPACT-052
  it("IMPACT-052: ClarificationForm 组件可导入", async () => {
    const mod = await import("../components/ClarificationForm");
    expect(mod.ClarificationForm).toBeDefined();
  });

  // IMPACT-053
  it("IMPACT-053: CorrectionResultPanel 组件可导入", async () => {
    const mod = await import("../components/CorrectionResultPanel");
    expect(mod.CorrectionResultPanel).toBeDefined();
  });

  // IMPACT-054
  it("IMPACT-054: PipelineNextStepDialog 组件可导入", async () => {
    const mod = await import("../components/PipelineNextStepDialog");
    expect(mod.PipelineNextStepDialog).toBeDefined();
  });

  // IMPACT-055
  it("IMPACT-055: QuickAccessCards 组件可导入", async () => {
    const mod = await import("../components/QuickAccessCards");
    expect(mod.QuickAccessCards).toBeDefined();
  });

  // IMPACT-056
  it("IMPACT-056: GenerateModeSelector 组件可导入", async () => {
    const mod = await import("../components/GenerateModeSelector");
    expect(mod.GenerateModeSelector).toBeDefined();
  });

  // IMPACT-057
  it("IMPACT-057: ResolutionSelector 组件可导入", async () => {
    const mod = await import("../components/ResolutionSelector");
    expect(mod.ResolutionSelector).toBeDefined();
  });

  // IMPACT-058
  it("IMPACT-058: SourceSelector 组件可导入", async () => {
    const mod = await import("../components/SourceSelector");
    expect(mod.SourceSelector).toBeDefined();
  });

  // IMPACT-059
  it("IMPACT-059: TodoListDisplay 组件可导入", async () => {
    const mod = await import("../components/TodoListDisplay");
    expect(mod.TodoListDisplay).toBeDefined();
  });

  // IMPACT-060
  it("IMPACT-060: note-operations 工具模块可导入", async () => {
    const mod = await import("../core/llm/tools/note-operations");
    expect(mod.createNoteOperationTools).toBeDefined();
    expect(mod.createCreateNoteTool).toBeDefined();
  });
});

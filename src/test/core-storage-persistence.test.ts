/**
 * 测试：存储/迁移/持久化 — STOR-001 ~ STOR-020
 *
 * 覆盖范围：
 *   1. 存储 schema（表 / 索引 / 外键）与全局项目种子
 *   2. Settings 存储
 *   3. 项目/会话 CRUD
 *   4. delegation_tasks 表
 *   5. 级联删除
 *   6. 编码兼容
 *   7. 并发写入
 *
 * 第 18 轮（L1）：本文件原来用 `getDatabase()` 把旧库（sql.js）当**夹具与 schema 目录**用。
 * 旧库在 rust 模式下刻意不加载（`setup.ts` 也不再 `initDatabase()`），所以：
 *   - 数据夹具一律走**端口**（产品在 rust 模式下只读写端口）；
 *   - schema 类断言（表 / 列 / 索引 / 外键 / 全局项目种子）指向**引擎侧真源**
 *     （`src-tauri/codem-db/sql/schema.sql` + `src/schema.rs`），那才是引擎建库执行的东西。
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { getStoragePort, setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { createRustEngineSemanticsPort } from "./rust-engine-semantics-port";
import type { FakeStoragePort } from "./fake-storage-port";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { getSetting, setSetting, removeSetting, getSettingJSON, setSettingJSON } from "../core/storage/settings";
import {
  createDelegationTask,
  updateDelegationTaskStatus,
  getDelegationTask,
  getActiveDelegations,
  getDelegationsByProject,
  deleteDelegationTask,
  clearCompletedDelegations,
} from "../core/session/delegation-storage";
import type { DelegationTask } from "../core/session/types";
import type { Message } from "../store";

const PROJECT_ID = "proj-stor-test";
const SESSION_ID = "sess-stor-test";

// ========== 引擎侧 schema 真源（第 18 轮新增） ==========

/** 引擎建库执行的 DDL（`codem-db` 侧 `schema.rs` 读的就是它） */
const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "../../src-tauri/codem-db/sql/schema.sql"),
  "utf-8",
);
/** 引擎建库代码（建表之后种下全局项目的那一段） */
const RUST_SCHEMA_RS = fs.readFileSync(
  path.join(__dirname, "../../src-tauri/codem-db/src/schema.rs"),
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

/** 该表上是否有索引（等价于旧库 `sqlite_master WHERE type='index' AND tbl_name=?`） */
function schemaHasIndexOn(table: string): boolean {
  return new RegExp(`CREATE INDEX[^;]*\\bON\\s+${table}\\s*\\(`).test(SCHEMA_SQL);
}

function setupBaseData(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID, name: "存储测试", path: "D:\\stor",
    createdAt: Date.now(), lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SESSION_ID, projectId: PROJECT_ID, title: "存储测试会话",
    createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  });
}

function makeDelegationTask(overrides: Partial<DelegationTask> = {}): DelegationTask {
  return {
    id: `del-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    sourceSessionId: "source-sess",
    targetSessionId: "target-sess",
    task: "测试委派任务",
    status: "pending",
    projectId: PROJECT_ID,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("存储 — 数据库初始化与 Schema", () => {
  beforeEach(() => {
    // 第 18 轮（L1）：`resetDatabase()` / `initDatabase()` 是**只为旧库存在**的清理，已删 ——
    // `setup.ts` 每例注册一个干净的内存端口，端口本身就是空的。
    localStorage.clear();
  });

  // STOR-001
  it("STOR-001: 引擎 schema 声明了所有核心表", () => {
    /*
     * 原来是 `initDatabase()` 之后查旧库的 `sqlite_master`。
     * 建库的活现在整个在引擎侧（`codem-db`），渲染进程不再自己建表 ——
     * 所以判据换成"引擎建库用的那份 DDL 里有没有这些表"，对象与强度不变。
     */
    for (const table of [
      "projects", "sessions", "messages", "tool_calls", "attachments",
      "settings", "delegation_tasks", "memory", "recovery_data", "cost_records",
    ]) {
      expect(schemaDeclaresTable(table), `引擎 schema 必须声明表 ${table}`).toBe(true);
    }
  });

  // STOR-002
  it("STOR-002: 重置存储后数据清空、结构保留", () => {
    ProjectStorage.createProject({
      id: "temp-proj", name: "临时", path: "/tmp",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    expect(ProjectStorage.getProject("temp-proj")).not.toBeNull();

    /*
     * 第 18 轮：原来这段是 `await resetDatabase()` + `SELECT COUNT(*) FROM projects WHERE id='temp-proj'`，
     * 而那个断言在端口模式下是**恒真的假绿** —— 项目行写进的是端口，旧库里从来没有过这一行，
     * 所以"重置后旧库计数为 0"在重置前后都成立（判据守着一条已经没人走的路径）。
     * `resetDatabase()` 本身是旧引擎专用入口（会删掉 codem-db.bin 迁移源，rust 模式下已拒绝），
     * 渲染侧已无重置入口 —— 等价的重置语义是"数据面清零"。判据因此拆成端口语义的两条：
     *   ① 数据确实没了（产品读不到那条项目）；
     *   ② 结构没有跟着消失（引擎 schema 仍然声明这些表）。
     */
    setStoragePort(createFakeStoragePort());

    expect(ProjectStorage.getProject("temp-proj"), "重置后不得再读到旧数据").toBeNull();
    expect(schemaDeclaresTable("projects"), "结构不随数据清空而消失").toBe(true);
    expect(schemaDeclaresTable("messages"), "结构不随数据清空而消失").toBe(true);
  });

  // STOR-003
  it("STOR-003: 全局 project (id='') 由引擎种子", () => {
    /*
     * 原来是 `SELECT id, name FROM projects WHERE id = ''`（旧库）。
     * 种子行现在由引擎在建表后立刻种下（`codem-db/src/schema.rs`：`INSERT OR IGNORE INTO projects`
     * 绑定 id=""），渲染侧不建库也不种这一行 —— 所以判据指向那段真实现。
     * 断言的对象不变：**引擎初始化后必然存在 id='' 的全局项目**（否则全局会话撞外键）。
     */
    expect(
      /INSERT OR IGNORE INTO projects[\s\S]{0,400}?params!\[\s*""\s*,/.test(RUST_SCHEMA_RS),
      "引擎 schema.rs 必须种下 id='' 的全局项目（全局会话的外键依赖它）",
    ).toBe(true);
  });

  // STOR-004
  it("STOR-004: messages 表索引存在", () => {
    expect(schemaHasIndexOn("messages"), "messages 必须有索引（会话消息查询不得全表扫）").toBe(true);
  });

  // STOR-005
  it("STOR-005: tool_calls 表外键关联 messages", () => {
    // 原来是查 `sqlite_master.sql` 里的建表语句；现在读同一份 DDL 的引擎侧真源
    const sql = createTableSql("tool_calls");
    expect(sql).toContain("FOREIGN KEY");
    expect(sql).toContain("message_id");
  });
});

describe("存储 — Settings CRUD", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // STOR-007
  it("STOR-007: getSetting/setSetting 字符串值", () => {
    setSetting("test-key", "test-value");
    expect(getSetting("test-key")).toBe("test-value");
  });

  it("STOR-007b: getSetting 不存在返回 null", () => {
    expect(getSetting("non-existent")).toBeNull();
  });

  // STOR-008
  it("STOR-008: getSettingJSON/setSettingJSON 对象序列化", () => {
    const obj = { name: "测试", nested: { value: 42 }, arr: [1, 2, 3] };
    setSettingJSON("test-json", obj);
    const loaded = getSettingJSON("test-json", null);
    expect(loaded).toEqual(obj);
  });

  it("STOR-008b: getSettingJSON 无效 JSON 返回默认值", () => {
    setSetting("bad-json", "{invalid}");
    const loaded = getSettingJSON("bad-json", { default: true });
    expect(loaded).toEqual({ default: true });
  });

  it("STOR-008c: getSettingJSON 不存在返回默认值", () => {
    const loaded = getSettingJSON("no-key", { default: true });
    expect(loaded).toEqual({ default: true });
  });

  it("STOR-008d: removeSetting 删除设置", () => {
    setSetting("to-remove", "value");
    expect(getSetting("to-remove")).toBe("value");
    removeSetting("to-remove");
    expect(getSetting("to-remove")).toBeNull();
  });

  it("STOR-008e: setSetting 覆盖已有值", () => {
    setSetting("overwrite", "first");
    setSetting("overwrite", "second");
    expect(getSetting("overwrite")).toBe("second");
  });
});

describe("存储 — 项目 CRUD", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // STOR-009
  it("STOR-009: createProject/getProject/listProjects", () => {
    ProjectStorage.createProject({
      id: "p1", name: "项目1", path: "D:\\p1",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    ProjectStorage.createProject({
      id: "p2", name: "项目2", path: "D:\\p2",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });

    expect(ProjectStorage.getProject("p1")).not.toBeNull();
    expect(ProjectStorage.getProject("p1")!.name).toBe("项目1");
    expect(ProjectStorage.listProjects()).toHaveLength(2);
  });

  it("STOR-009b: updateProject 修改名称", () => {
    ProjectStorage.createProject({
      id: "p-upd", name: "原名", path: "D:\\upd",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    ProjectStorage.updateProject("p-upd", { name: "新名" });
    expect(ProjectStorage.getProject("p-upd")!.name).toBe("新名");
  });

  it("STOR-009c: deleteProject 删除项目", () => {
    ProjectStorage.createProject({
      id: "p-del", name: "删除", path: "D:\\del",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    ProjectStorage.deleteProject("p-del");
    expect(ProjectStorage.getProject("p-del")).toBeNull();
  });

  // STOR-015
  it("STOR-015: deleteProject 级联删除会话和消息", () => {
    /*
     * 换用**带真引擎语义**的假端口：`crud.delete` 按 `ON DELETE CASCADE` 带走子行
     * （见 `rust-engine-semantics-port.ts`，出处 `engine.rs:87` + `schema.sql`）。
     *
     * 旧实现里 `DELETE FROM projects WHERE id = ?` 之后的"会话/消息也没了"正是 **SQLite 外键级联**
     * 做的（端口模式下列表由引擎负责），假端口不实现这条 → 用例在端口模式下假红。
     * 端口在这里注册，随后本用例自建的 project/session/message 都落在同一份数据里。
     */
    setStoragePort(createRustEngineSemanticsPort());

    ProjectStorage.createProject({
      id: "p-cascade", name: "级联", path: "D:\\cas",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: "s-cascade", projectId: "p-cascade", title: "级联会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    const msg: Message = {
      id: "m-cascade", role: "user", content: "级联消息",
      timestamp: Date.now(), status: "done",
    };
    MessageStorage.createMessage(msg, "s-cascade");

    ProjectStorage.deleteProject("p-cascade");

    expect(SessionStorage.getSession("s-cascade")).toBeNull();
    expect(MessageStorage.listMessages("s-cascade")).toHaveLength(0);
    // 端口表上同样不该留下子行（"只改了内存镜像"不算数）
    const port = getStoragePort() as unknown as FakeStoragePort;
    expect(port.__table("sessions")).toHaveLength(0);
    expect(port.__table("messages")).toHaveLength(0);
    expect(port.__table("tool_calls")).toHaveLength(0);
  });

  it("STOR-015b: listProjects 不包含全局 project (id='')", () => {
    const projects = ProjectStorage.listProjects();
    expect(projects.some(p => p.id === "")).toBe(false);
  });
});

describe("存储 — delegation_tasks 表", () => {
  beforeEach(() => {
    localStorage.clear();
    setupBaseData();
  });

  // STOR-013
  it("STOR-013: delegation_tasks 表存在且有正确列", () => {
    // 原来是查旧库 `sqlite_master.sql`（`SELECT sql FROM sqlite_master WHERE name='delegation_tasks'`）
    expect(schemaDeclaresTable("delegation_tasks"), "引擎 schema 必须声明 delegation_tasks").toBe(true);
    const columns = schemaColumns("delegation_tasks");
    for (const column of [
      "id", "source_session_id", "target_session_id", "task", "status", "project_id", "created_at",
    ]) {
      expect(columns, `delegation_tasks 必须有列 ${column}`).toContain(column);
    }
  });

  // STOR-014
  it("STOR-014: createDelegationTask 写入", () => {
    const task = makeDelegationTask({ id: "del-create" });
    createDelegationTask(task);

    const loaded = getDelegationTask("del-create");
    expect(loaded).not.toBeNull();
    expect(loaded!.sourceSessionId).toBe("source-sess");
    expect(loaded!.targetSessionId).toBe("target-sess");
    expect(loaded!.status).toBe("pending");
    expect(loaded!.projectId).toBe(PROJECT_ID);
  });

  it("STOR-014b: updateDelegationTaskStatus 更新状态", () => {
    const task = makeDelegationTask({ id: "del-upd" });
    createDelegationTask(task);

    updateDelegationTaskStatus("del-upd", "running", { startedAt: Date.now() });
    expect(getDelegationTask("del-upd")!.status).toBe("running");

    updateDelegationTaskStatus("del-upd", "completed", {
      result: "完成结果",
      completedAt: Date.now(),
    });
    const updated = getDelegationTask("del-upd");
    expect(updated!.status).toBe("completed");
    expect(updated!.result).toBe("完成结果");
    expect(updated!.completedAt).toBeDefined();
  });

  it("STOR-014c: updateDelegationTaskStatus 设置错误", () => {
    const task = makeDelegationTask({ id: "del-err" });
    createDelegationTask(task);

    updateDelegationTaskStatus("del-err", "failed", { error: "执行失败" });
    const loaded = getDelegationTask("del-err");
    expect(loaded!.status).toBe("failed");
    expect(loaded!.error).toBe("执行失败");
  });

  it("STOR-014d: getDelegationsByProject 按项目过滤", () => {
    createDelegationTask(makeDelegationTask({ id: "del-p1" }));
    createDelegationTask(makeDelegationTask({ id: "del-p2" }));

    const tasks = getDelegationsByProject(PROJECT_ID);
    expect(tasks).toHaveLength(2);
  });

  it("STOR-014e: getActiveDelegations 只返回 pending/running", () => {
    createDelegationTask(makeDelegationTask({ id: "del-a1", status: "pending" }));
    createDelegationTask(makeDelegationTask({ id: "del-a2", status: "running" }));
    createDelegationTask(makeDelegationTask({ id: "del-a3", status: "completed" }));
    createDelegationTask(makeDelegationTask({ id: "del-a4", status: "failed" }));

    const active = getActiveDelegations();
    expect(active).toHaveLength(2);
    expect(active.every(t => t.status === "pending" || t.status === "running")).toBe(true);
  });

  it("STOR-014f: deleteDelegationTask 删除", () => {
    createDelegationTask(makeDelegationTask({ id: "del-del" }));
    deleteDelegationTask("del-del");
    expect(getDelegationTask("del-del")).toBeNull();
  });

  it("STOR-014g: clearCompletedDelegations 清理已完成", () => {
    createDelegationTask(makeDelegationTask({ id: "del-c1", status: "completed", completedAt: Date.now() }));
    createDelegationTask(makeDelegationTask({ id: "del-c2", status: "failed", completedAt: Date.now() }));
    createDelegationTask(makeDelegationTask({ id: "del-c3", status: "pending" }));

    clearCompletedDelegations(0); // keep 0 completed
    expect(getDelegationTask("del-c1")).toBeNull();
    expect(getDelegationTask("del-c2")).toBeNull();
    expect(getDelegationTask("del-c3")).not.toBeNull();
  });

  it("STOR-020: getActiveDelegations 性能——不全表扫描（有索引）", () => {
    // 原来是查旧库 `sqlite_master` 里 delegation_tasks 上的索引
    expect(
      schemaHasIndexOn("delegation_tasks"),
      "delegation_tasks 必须有索引（活跃委派查询不得全表扫）",
    ).toBe(true);
  });
});

describe("存储 — 编码兼容", () => {
  beforeEach(() => {
    localStorage.clear();
    setupBaseData();
  });

  // STOR-018
  it("STOR-018: 中文路径项目正确存储", () => {
    ProjectStorage.createProject({
      id: "cn-proj", name: "中文项目", path: "D:\\项目\\测试目录",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    const loaded = ProjectStorage.getProject("cn-proj");
    expect(loaded!.path).toBe("D:\\项目\\测试目录");
    expect(loaded!.name).toBe("中文项目");
  });

  // STOR-019
  it("STOR-019: Emoji 会话标题正确存储", () => {
    SessionStorage.createSession({
      id: "emoji-sess", projectId: PROJECT_ID, title: "会话 🚀🎉测试",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });
    const loaded = SessionStorage.getSession("emoji-sess");
    expect(loaded!.title).toBe("会话 🚀🎉测试");
  });

  it("STOR-019b: 特殊字符在消息内容中", () => {
    const special = `特殊字符: <>"'&\n\t换行制表`;
    MessageStorage.createMessage({
      id: "special-msg", role: "user", content: special,
      timestamp: Date.now(), status: "done",
    }, SESSION_ID);
    expect(MessageStorage.getMessage("special-msg")!.content).toBe(special);
  });
});

describe("存储 — 并发写入", () => {
  beforeEach(() => {
    localStorage.clear();
    setupBaseData();
  });

  // STOR-017
  it("STOR-017: 多会话同时 saveMessages 不互相覆盖", () => {
    const sessionB = "sess-concurrent-b";
    SessionStorage.createSession({
      id: sessionB, projectId: PROJECT_ID, title: "并发B",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    });

    // 交替写入两个会话
    for (let i = 0; i < 5; i++) {
      MessageStorage.createMessage({
        id: `a-${i}`, role: "user", content: `A消息${i}`,
        timestamp: Date.now() + i, status: "done",
      }, SESSION_ID);
      MessageStorage.createMessage({
        id: `b-${i}`, role: "user", content: `B消息${i}`,
        timestamp: Date.now() + i, status: "done",
      }, sessionB);
    }

    expect(MessageStorage.listMessages(SESSION_ID)).toHaveLength(5);
    expect(MessageStorage.listMessages(sessionB)).toHaveLength(5);
    expect(MessageStorage.getMessage("a-3")).not.toBeNull();
    expect(MessageStorage.getMessage("b-3")).not.toBeNull();
  });
});

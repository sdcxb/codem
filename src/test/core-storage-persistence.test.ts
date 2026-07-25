/**
 * 测试：存储/迁移/持久化 — STOR-001 ~ STOR-020
 *
 * 覆盖范围：
 *   1. 数据库初始化与重置
 *   2. 迁移机制
 *   3. Settings 存储
 *   4. 项目/会话 CRUD
 *   5. delegation_tasks 表
 *   6. 级联删除
 *   7. 编码兼容
 *   8. 并发写入
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase, getDatabase } from "../core/storage/database";
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
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  // STOR-001
  it("STOR-001: initDatabase 创建所有核心表", () => {
    const db = getDatabase();
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = tables.length > 0 ? tables[0].values.map((r: any[]) => r[0] as string) : [];

    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("tool_calls");
    expect(tableNames).toContain("attachments");
    expect(tableNames).toContain("settings");
    expect(tableNames).toContain("delegation_tasks");
    expect(tableNames).toContain("memory");
    expect(tableNames).toContain("recovery_data");
    expect(tableNames).toContain("cost_records");
  });

  // STOR-002
  it("STOR-002: resetDatabase 清空数据但保留结构", async () => {
    ProjectStorage.createProject({
      id: "temp-proj", name: "临时", path: "/tmp",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    });
    expect(ProjectStorage.getProject("temp-proj")).not.toBeNull();

    // Reset should clear all data
    await resetDatabase();

    const db = getDatabase();
    const result = db.exec("SELECT COUNT(*) FROM projects WHERE id = 'temp-proj'");
    expect(result[0].values[0][0]).toBe(0);

    // But table structure should still exist
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'");
    expect(tables.length).toBeGreaterThan(0);
  });

  // STOR-003
  it("STOR-003: 全局 project (id='') 自动种子", () => {
    const db = getDatabase();
    const result = db.exec("SELECT id, name FROM projects WHERE id = ''");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values[0][0]).toBe("");
  });

  // STOR-004
  it("STOR-004: messages 表索引存在", () => {
    const db = getDatabase();
    const indexes = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'");
    const indexNames = indexes.length > 0 ? indexes[0].values.map((r: any[]) => r[0] as string) : [];
    expect(indexNames.length).toBeGreaterThan(0);
  });

  // STOR-005
  it("STOR-005: tool_calls 表外键关联 messages", () => {
    const db = getDatabase();
    // Verify FK exists by checking schema SQL
    const schema = db.exec("SELECT sql FROM sqlite_master WHERE name='tool_calls'");
    expect(schema[0].values[0][0]).toContain("FOREIGN KEY");
    expect(schema[0].values[0][0]).toContain("message_id");
  });
});

describe("存储 — Settings CRUD", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
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
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
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
  });

  it("STOR-015b: listProjects 不包含全局 project (id='')", () => {
    const projects = ProjectStorage.listProjects();
    expect(projects.some(p => p.id === "")).toBe(false);
  });
});

describe("存储 — delegation_tasks 表", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupBaseData();
  });

  // STOR-013
  it("STOR-013: delegation_tasks 表存在且有正确列", () => {
    const db = getDatabase();
    const schema = db.exec("SELECT sql FROM sqlite_master WHERE name='delegation_tasks'");
    expect(schema.length).toBeGreaterThan(0);
    const sql = schema[0].values[0][0] as string;
    expect(sql).toContain("id");
    expect(sql).toContain("source_session_id");
    expect(sql).toContain("target_session_id");
    expect(sql).toContain("task");
    expect(sql).toContain("status");
    expect(sql).toContain("project_id");
    expect(sql).toContain("created_at");
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
    const db = getDatabase();
    const indexes = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='delegation_tasks'");
    // delegation_tasks should have at least one index
    expect(indexes.length).toBeGreaterThan(0);
  });
});

describe("存储 — 编码兼容", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
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
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
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

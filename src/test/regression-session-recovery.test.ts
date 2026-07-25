/**
 * 测试：会话恢复与多层恢复回归 — RECV-001 ~ RECV-015
 *
 * 验证 SessionRecoveryService 在新增特性后仍正常工作。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { SessionRecoveryService } from "../core/recovery/recovery";
import type { Session, MessageV2 } from "../core/llm/session";

function makeSession(id: string, projectId: string = "proj-test"): Session {
  return {
    id,
    projectId,
    title: `会话 ${id}`,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: "gpt-4o",
    totalUsage: { promptTokens: 0, completionTokens: 0, cost: 0 },
  };
}

function makeMessage(id: string, role: "user" | "assistant" = "user"): MessageV2 {
  return {
    id,
    role,
    parts: [{ type: "text", content: `消息内容 ${id}` }],
    timestamp: Date.now(),
  };
}

describe("会话恢复与多层恢复回归", () => {
  let service: SessionRecoveryService;

  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
    // Create a fresh instance for each test
    service = new SessionRecoveryService({ autoSave: false });
  });

  // ===== RECV-001 ~ RECV-005: 基本会话恢复操作 =====
  describe("基本会话恢复操作", () => {
    it("RECV-001: 保存会话到恢复数据", () => {
      const session = makeSession("recv-001");
      service.saveSession(session);
      const loaded = service.loadSession("recv-001");
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe("recv-001");
    });

    it("RECV-002: 加载所有会话——按 updatedAt 降序", () => {
      const s1 = makeSession("recv-002-1");
      s1.updatedAt = 1000;
      const s2 = makeSession("recv-002-2");
      s2.updatedAt = 2000;
      const s3 = makeSession("recv-002-3");
      s3.updatedAt = 3000;
      service.saveSession(s1);
      service.saveSession(s2);
      service.saveSession(s3);
      const all = service.getAllSessions();
      expect(all).toHaveLength(3);
      expect(all[0].id).toBe("recv-002-3"); // newest first
      expect(all[2].id).toBe("recv-002-1"); // oldest last
    });

    it("RECV-003: 删除会话恢复数据", () => {
      const session = makeSession("recv-003");
      service.saveSession(session);
      service.deleteSession("recv-003");
      expect(service.loadSession("recv-003")).toBeUndefined();
    });

    it("RECV-004: 添加消息到会话", () => {
      const session = makeSession("recv-004");
      service.saveSession(session);
      service.addMessage("recv-004", makeMessage("msg-004"));
      const loaded = service.loadSession("recv-004");
      expect(loaded!.messages).toHaveLength(1);
      expect(loaded!.messages[0].id).toBe("msg-004");
    });

    it("RECV-005: 更新会话消息", () => {
      const session = makeSession("recv-005");
      service.saveSession(session);
      service.addMessage("recv-005", makeMessage("msg-005"));
      service.updateMessage("recv-005", "msg-005", (msg) => ({
        ...msg,
        parts: [{ type: "text", content: "更新后的内容" }],
      }));
      const loaded = service.loadSession("recv-005");
      expect(loaded!.messages[0].parts[0]).toEqual({ type: "text", content: "更新后的内容" });
    });
  });

  // ===== RECV-006 ~ RECV-010: 状态查询与数据导出导入 =====
  describe("状态查询与数据导出导入", () => {
    it("RECV-006: 获取会话状态", () => {
      const session = makeSession("recv-006");
      service.saveSession(session);
      service.addMessage("recv-006", makeMessage("msg-006-1"));
      service.addMessage("recv-006", makeMessage("msg-006-2"));
      const state = service.getSessionState("recv-006");
      expect(state.exists).toBe(true);
      expect(state.messageCount).toBe(2);
      expect(state.canRecover).toBe(true);
    });

    it("RECV-007: 获取恢复摘要", () => {
      const s1 = makeSession("recv-007-1");
      const s2 = makeSession("recv-007-2");
      service.saveSession(s1);
      service.saveSession(s2);
      service.addMessage("recv-007-1", makeMessage("m1"));
      service.addMessage("recv-007-1", makeMessage("m2"));
      const summary = service.getRecoverySummary();
      expect(summary.totalSessions).toBe(2);
      expect(summary.totalMessages).toBe(2);
      expect(summary.sessionsWithMessages).toBe(1);
    });

    it("RECV-008: 导出数据", () => {
      const session = makeSession("recv-008");
      service.saveSession(session);
      const exported = service.exportData();
      expect(typeof exported).toBe("string");
      const parsed = JSON.parse(exported);
      expect(parsed.version).toBe(1);
      expect(parsed.sessions["recv-008"]).toBeDefined();
    });

    it("RECV-009: 导入数据", () => {
      const data = {
        version: 1,
        lastSaved: Date.now(),
        sessions: {
          "imported-1": makeSession("imported-1"),
        },
        currentSessionId: "imported-1",
        metadata: {
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          totalSessions: 1,
          totalMessages: 0,
        },
      };
      const result = service.importData(JSON.stringify(data));
      expect(result).toBe(true);
      expect(service.loadSession("imported-1")).toBeDefined();
      expect(service.getCurrentSessionId()).toBe("imported-1");
    });

    it("RECV-010: 清除所有数据", () => {
      service.saveSession(makeSession("recv-010-1"));
      service.saveSession(makeSession("recv-010-2"));
      service.clear();
      expect(service.getAllSessions()).toHaveLength(0);
      expect(service.getRecoverySummary().totalSessions).toBe(0);
    });
  });

  // ===== RECV-011 ~ RECV-015: 高级功能 =====
  describe("高级功能", () => {
    it("RECV-011: 消息超限自动裁剪", () => {
      const svc = new SessionRecoveryService({
        autoSave: false,
        maxMessagesPerSession: 5,
      });
      const session = makeSession("recv-011");
      svc.saveSession(session);
      for (let i = 0; i < 6; i++) {
        svc.addMessage("recv-011", makeMessage(`msg-011-${i}`));
      }
      const loaded = svc.loadSession("recv-011");
      expect(loaded!.messages).toHaveLength(5);
      // Should keep the last 5 messages
      expect(loaded!.messages[0].id).toBe("msg-011-1");
      expect(loaded!.messages[4].id).toBe("msg-011-5");
    });

    it("RECV-012: 项目会话过滤", () => {
      service.saveSession(makeSession("recv-012-a", "proj-A"));
      service.saveSession(makeSession("recv-012-b", "proj-B"));
      service.saveSession(makeSession("recv-012-c", "proj-A"));
      const projASessions = service.getProjectSessions("proj-A");
      expect(projASessions).toHaveLength(2);
      expect(projASessions.every(s => s.projectId === "proj-A")).toBe(true);
    });

    it("RECV-013: 设置当前会话", () => {
      service.saveSession(makeSession("recv-013"));
      service.setCurrentSession("recv-013");
      expect(service.getCurrentSessionId()).toBe("recv-013");
    });

    it("RECV-014: trimSessions 裁剪旧会话", () => {
      const svc = new SessionRecoveryService({
        autoSave: false,
        maxSessions: 2,
      });
      const s1 = makeSession("recv-014-1");
      s1.updatedAt = 1000;
      const s2 = makeSession("recv-014-2");
      s2.updatedAt = 2000;
      const s3 = makeSession("recv-014-3");
      s3.updatedAt = 3000;
      svc.saveSession(s1);
      svc.saveSession(s2);
      svc.saveSession(s3);
      svc.trimSessions();
      const all = svc.getAllSessions();
      expect(all).toHaveLength(2);
      // Should keep the 2 newest
      expect(all.find(s => s.id === "recv-014-1")).toBeUndefined();
      expect(all.find(s => s.id === "recv-014-3")).toBeDefined();
    });

    it("RECV-015: forceSave 不崩溃", () => {
      const session = makeSession("recv-015");
      service.saveSession(session);
      // forceSave 应该不崩溃
      expect(() => service.forceSave()).not.toThrow();
      // 验证内存中仍有数据
      const loaded = service.loadSession("recv-015");
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe("recv-015");
    });
  });
});

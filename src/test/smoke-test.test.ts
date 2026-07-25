/**
 * 冒烟测试（Smoke Test）— SMOKE-001 ~ SMOKE-030
 *
 * 每次构建/发布后快速验证最关键的功能链路可用。
 * 任一失败 = 发布阻断（release-blocking）。
 * 执行策略：vitest run smoke（应在 30 秒内全部通过）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { getSettingJSON, setSettingJSON, removeSetting } from "../core/storage/settings";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { getAgentRegistry } from "../core/agent/agent";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { buildSystemPrompt } from "../core/prompt/prompt";
import { ContextManager, getContextManager } from "../core/context/context";
import { getGlobalSecurityMode, setGlobalSecurityMode } from "../core/permission/security-mode";
import { PermissionEvaluator } from "../core/permission/permission";
import { getHeartbeatManager } from "../core/heartbeat/heartbeat";
import { getRetryExecutor } from "../core/retry/retry";
import { getSessionRecoveryService } from "../core/recovery/recovery";
import {
  SessionMessageBus,
  getSessionMessageBus,
} from "../core/session/bus";
import { getDelegationOrchestrator } from "../core/session/orchestrator";
import {
  createDelegationTask,
  getDelegationTask,
} from "../core/session/delegation-storage";
import type { DelegationTask } from "../core/session/types";
import type { Message } from "../store";
import { setLang } from "../core/i18n/lang";

const PROJECT_ID = "proj-smoke";
const SESSION_ID = "sess-smoke";

function setupProjectAndSession(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID,
    name: "冒烟测试项目",
    path: "D:\\smoke-test",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  });
  SessionStorage.createSession({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: "冒烟测试会话",
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    messageCount: 0,
  });
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `smoke-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    role: "user",
    content: "冒烟测试",
    timestamp: Date.now(),
    status: "done",
    ...overrides,
  };
}

describe("冒烟测试（Smoke Test）— SMOKE-001 ~ SMOKE-030", () => {
  beforeEach(async () => {
    try {
      await resetDatabase();
    } catch {
      await initDatabase();
    }
    localStorage.clear();
    setLang("zh");
    setupProjectAndSession();
  });

  // ===== SMOKE-001 ~ SMOKE-005: 应用初始化冒烟 =====
  describe("应用初始化冒烟", () => {
    it("SMOKE-001: 数据库初始化不崩溃", async () => {
      await expect(initDatabase()).resolves.not.toThrow();
    });

    it("SMOKE-002: 数据库重置后可重新初始化", async () => {
      await resetDatabase();
      await expect(initDatabase()).resolves.not.toThrow();
    });

    it("SMOKE-003: 设置键值读写正常", () => {
      setSettingJSON("smoke-test", { ok: true });
      const val = getSettingJSON("smoke-test", null);
      expect(val).toEqual({ ok: true });
    });

    it("SMOKE-004: 设置键删除正常", () => {
      setSettingJSON("smoke-test", { ok: true });
      removeSetting("smoke-test");
      expect(getSettingJSON("smoke-test", null)).toBeNull();
    });

    it("SMOKE-005: 项目存储 CRUD 正常", () => {
      const projects = ProjectStorage.listProjects();
      expect(projects.some((p: any) => p.id === PROJECT_ID)).toBe(true);
    });
  });

  // ===== SMOKE-006 ~ SMOKE-010: 核心消息链路冒烟 =====
  describe("核心消息链路冒烟", () => {
    it("SMOKE-006: 消息创建写入 DB", () => {
      const msg = makeMessage({ id: "smoke-006", content: "创建测试" });
      MessageStorage.createMessage(msg, SESSION_ID);
      const msgs = MessageStorage.listMessages(SESSION_ID);
      const found = msgs.find((m: any) => m.id === "smoke-006")!;
      expect(found).toBeDefined();
      expect(found.role).toBe("user");
      expect(found.content).toBe("创建测试");
    });

    it("SMOKE-007: 消息更新写入 DB", () => {
      const msg = makeMessage({ id: "smoke-007", status: "streaming" });
      MessageStorage.createMessage(msg, SESSION_ID);
      MessageStorage.updateMessage("smoke-007", { status: "done" });
      const msgs = MessageStorage.listMessages(SESSION_ID);
      const found = msgs.find((m: any) => m.id === "smoke-007")!;
      expect(found.status).toBe("done");
    });

    it("SMOKE-008: 工具调用创建关联消息", () => {
      const msg = makeMessage({ id: "smoke-008", role: "assistant" });
      MessageStorage.createMessage(msg, SESSION_ID);
      MessageStorage.addToolCall("smoke-008", {
        id: "tc-smoke-008",
        tool: "bash",
        args: { command: "echo hello" },
        status: "running",
      });
      const msgs = MessageStorage.listMessages(SESSION_ID);
      const found = msgs.find((m: any) => m.id === "smoke-008")!;
      expect(found).toBeDefined();
      expect(found.toolCalls).toBeDefined();
      expect(found.toolCalls!.length).toBeGreaterThan(0);
      expect(found.toolCalls![0].tool).toBe("bash");
    });

    it("SMOKE-009: 工具调用更新状态", () => {
      const msg = makeMessage({ id: "smoke-009", role: "assistant" });
      MessageStorage.createMessage(msg, SESSION_ID);
      MessageStorage.addToolCall("smoke-009", {
        id: "tc-smoke-009",
        tool: "read",
        args: { path: "test.txt" },
        status: "running",
      });
      MessageStorage.updateToolCall("smoke-009", "tc-smoke-009", {
        status: "done",
        result: "file content",
      });
      const msgs = MessageStorage.listMessages(SESSION_ID);
      const found = msgs.find((m: any) => m.id === "smoke-009")!;
      const tc = found.toolCalls!.find((t: any) => t.id === "tc-smoke-009")!;
      expect(tc.status).toBe("done");
      expect(tc.result).toBe("file content");
    });

    it("SMOKE-010: 中文+Emoji 消息不乱码", () => {
      const msg = makeMessage({ id: "smoke-010", content: "你好🌍🎉" });
      MessageStorage.createMessage(msg, SESSION_ID);
      const msgs = MessageStorage.listMessages(SESSION_ID);
      const found = msgs.find((m: any) => m.id === "smoke-010")!;
      expect(found.content).toBe("你好🌍🎉");
    });
  });

  // ===== SMOKE-011 ~ SMOKE-015: 工具与智能体注册冒烟 =====
  describe("工具与智能体注册冒烟", () => {
    it("SMOKE-011: 默认工具注册表包含核心工具", () => {
      const registry = createDefaultToolRegistry();
      const all = registry.getAll();
      const ids = all.map((t: any) => t.id);
      expect(ids).toContain("bash");
      expect(ids).toContain("read");
      expect(ids).toContain("write");
      expect(ids).toContain("edit");
      expect(ids).toContain("glob");
      expect(ids).toContain("grep");
    });

    it("SMOKE-012: load_skill 工具已注册", () => {
      const registry = createDefaultToolRegistry();
      const all = registry.getAll();
      const ids = all.map((t: any) => t.id);
      expect(ids).toContain("load_skill");
    });

    it("SMOKE-013: 内置智能体可获取", () => {
      const registry = getAgentRegistry();
      const all = registry.getAll();
      const ids = all.map((a: any) => a.id);
      expect(ids).toContain("build");
      expect(ids).toContain("plan");
      expect(ids).toContain("explore");
      expect(ids).toContain("general");
      expect(ids).toContain("title");
      expect(ids).toContain("summary");
    });

    it("SMOKE-014: build 智能体权限评估正常", () => {
      const registry = getAgentRegistry();
      const action = registry.evaluatePermission("build", "bash");
      expect(action).toBe("allow");
    });

    it("SMOKE-015: plan 智能体工具限制正常", () => {
      const registry = getAgentRegistry();
      const canUse = registry.canUseTool("plan", "write");
      expect(canUse).toBe(false);
    });
  });

  // ===== SMOKE-016 ~ SMOKE-020: 会话与权限冒烟 =====
  describe("会话与权限冒烟", () => {
    it("SMOKE-016: 会话创建正常", () => {
      SessionStorage.createSession({
        id: "smoke-sess-016",
        projectId: PROJECT_ID,
        title: "冒烟会话016",
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
        messageCount: 0,
      });
      const sessions = SessionStorage.listSessions(PROJECT_ID);
      const found = sessions.find((s: any) => s.id === "smoke-sess-016")!;
      expect(found).toBeDefined();
      expect(found.id).toBe("smoke-sess-016");
    });

    it("SMOKE-017: 会话列表加载正常", () => {
      const sessions = SessionStorage.listSessions(PROJECT_ID);
      expect(sessions.some((s: any) => s.id === SESSION_ID)).toBe(true);
    });

    it("SMOKE-018: 安全模式默认值正确", () => {
      const mode = getGlobalSecurityMode();
      expect(["ask", "auto", "full"]).toContain(mode);
    });

    it("SMOKE-019: 安全模式切换正常", () => {
      setGlobalSecurityMode("auto");
      expect(getGlobalSecurityMode()).toBe("auto");
      // 恢复默认
      setGlobalSecurityMode("ask");
    });

    it("SMOKE-020: 受保护路径检测", () => {
      // 使用全新实例避免 singleton 状态污染
      // 传空 agentId 绕过 agent 级别 allow-all 规则，直接检查自定义 deny 规则
      const evaluator = new PermissionEvaluator();
      const action = evaluator.evaluate("write", "project/.git/config", "");
      expect(action).toBe("deny");
    });
  });

  // ===== SMOKE-021 ~ SMOKE-025: v0.89 新增模块冒烟 =====
  describe("v0.89 新增模块冒烟", () => {
    it("SMOKE-021: SessionMessageBus 可实例化", () => {
      const bus = new SessionMessageBus();
      expect(bus).toBeDefined();
      const singleton = getSessionMessageBus();
      expect(singleton).toBeDefined();
    });

    it("SMOKE-022: DelegationOrchestrator 可获取", () => {
      const orchestrator = getDelegationOrchestrator();
      expect(orchestrator).toBeDefined();
    });

    it("SMOKE-023: 委派任务 DB CRUD 正常", () => {
      const task: DelegationTask = {
        id: "smoke-delegation-023",
        sourceSessionId: "sess-src",
        targetSessionId: "sess-tgt",
        task: "冒烟测试委派任务",
        status: "pending",
        projectId: PROJECT_ID,
        createdAt: Date.now(),
      };
      createDelegationTask(task);
      const loaded = getDelegationTask("smoke-delegation-023");
      expect(loaded).not.toBeNull();
      expect(loaded!.task).toBe("冒烟测试委派任务");
      expect(loaded!.status).toBe("pending");
    });

    it("SMOKE-024: HeartbeatManager 配置可读写", () => {
      const hbm = getHeartbeatManager();
      hbm.setGlobalConfig({ interval: 10000 });
      const config = hbm.getGlobalConfig();
      expect(config.interval).toBe(10000);
    });

    it("SMOKE-025: RetryExecutor 配置可读写", () => {
      const re = getRetryExecutor();
      re.setConfig({ maxAttempts: 5 });
      const config = re.getConfig();
      expect(config.maxAttempts).toBe(5);
    });
  });

  // ===== SMOKE-026 ~ SMOKE-030: 系统提示词与上下文冒烟 =====
  describe("系统提示词与上下文冒烟", () => {
    it("SMOKE-026: buildSystemPrompt 不崩溃", () => {
      const registry = getAgentRegistry();
      const buildAgent = registry.get("build")!;
      expect(() => {
        const prompt = buildSystemPrompt({ agent: buildAgent });
        expect(typeof prompt).toBe("string");
        expect(prompt.length).toBeGreaterThan(0);
      }).not.toThrow();
    });

    it("SMOKE-027: 提示词包含身份段", () => {
      const registry = getAgentRegistry();
      const buildAgent = registry.get("build")!;
      const prompt = buildSystemPrompt({ agent: buildAgent });
      expect(prompt).toMatch(/Identity|身份/i);
    });

    it("SMOKE-028: ContextManager 可实例化", () => {
      const cm = new ContextManager();
      expect(cm).toBeDefined();
      const singleton = getContextManager();
      expect(singleton).toBeDefined();
    });

    it("SMOKE-029: ContextManager token 计数", () => {
      const cm = new ContextManager();
      const tokens = cm.estimateTextTokens("hello world");
      expect(tokens).toBeGreaterThan(0);
    });

    it("SMOKE-030: SessionRecoveryService 可实例化", () => {
      const srs = getSessionRecoveryService();
      expect(srs).toBeDefined();
    });
  });
});

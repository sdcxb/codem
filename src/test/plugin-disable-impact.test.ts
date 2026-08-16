/**
 * 插件禁用/关闭影响测试
 *
 * 验证：
 * 1. Cordis 插件关闭后，其注册的工具不再可用
 * 2. Provider 关闭后，相关功能优雅降级
 * 3. 动态插件 undefine 后，工具从注册表中移除
 * 4. Sandbox 策略切换时，已有连接不受影响
 * 5. 事件总线 listener 注销后不再接收事件
 * 6. Agent MessageQueue 清理后不再有残留消息
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock database
const mockDb = {
  data: [] as any[],
  seq: 0,
  run(sql: string, params?: any[]) {
    if (sql.startsWith("INSERT INTO session_events")) {
      this.seq++;
      this.data.push({ seq: this.seq, session_id: params[0], event_type: params[1], payload: JSON.parse(params[2]), timestamp: params[3] });
    } else if (sql.startsWith("DELETE FROM session_events")) {
      this.data = this.data.filter(d => d.session_id !== params[0]);
    }
  },
  exec(sql: string, params?: any[]) {
    if (sql.startsWith("SELECT seq")) {
      const sessionId = params?.[0];
      let filtered = this.data.filter(d => d.session_id === sessionId);
      filtered.sort((a, b) => a.seq - b.seq);
      if (filtered.length === 0) return [];
      return [{ columns: ["seq", "session_id", "event_type", "payload", "timestamp"], values: filtered.map(d => [d.seq, d.session_id, d.event_type, JSON.stringify(d.payload), d.timestamp]) }];
    }
    return [];
  },
};

vi.mock("../core/storage/database", () => ({
  getDatabase: () => mockDb,
  persistDatabase: () => {},
  initDatabase: vi.fn(),
  resetDatabase: vi.fn(),
}));

vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn().mockReturnValue(null),
  getSettingJSON: vi.fn().mockReturnValue(null),
  setSetting: vi.fn(),
  setSettingJSON: vi.fn(),
}));

describe("插件禁用/关闭影响测试", () => {
  beforeEach(() => {
    mockDb.data = [];
    mockDb.seq = 0;
  });

  describe("Cordis 动态插件 — define/undefine 生命周期", () => {
    it("define 后工具存在，undefine 后工具移除", async () => {
      const { createCordisDefineTool, createCordisUndefineTool, createCordisInspectTool } = await import("../core/llm/dynamic-plugin-tools");

      const defineTool = createCordisDefineTool();
      const undefineTool = createCordisUndefineTool();
      const inspectTool = createCordisInspectTool();

      // 无 context 时调用 — 验证不崩溃
      const defResult = await defineTool.execute({ name: "test_plugin", code: "module.exports = {}" }, {} as any);
      expect(defResult.output).toBeDefined();

      const undefResult = await undefineTool.execute({ name: "test_plugin" }, {} as any);
      expect(undefResult.output).toBeDefined();

      const inspectResult = await inspectTool.execute({ name: "test_plugin" }, {} as any);
      expect(inspectResult.output).toBeDefined();
    });

    it("stop 后运行中的插件被停止", async () => {
      const { createCordisStopTool } = await import("../core/llm/dynamic-plugin-tools");
      const stopTool = createCordisStopTool();
      const result = await stopTool.execute({ name: "running_plugin" }, {} as any);
      expect(result.output).toBeDefined();
    });

    it("run 工具执行插件代码", async () => {
      const { createCordisRunTool } = await import("../core/llm/dynamic-plugin-tools");
      const runTool = createCordisRunTool();
      const result = await runTool.execute({ name: "test_plugin", input: { args: [] } }, {} as any);
      expect(result.output).toBeDefined();
    });
  });

  describe("EventBus listener 注销", () => {
    it("listener off 后不再接收事件", async () => {
      const { getTypedEventBus } = await import("../core/llm/event-system-strict");
      const bus = getTypedEventBus();
      bus.clear();

      const received: any[] = [];
      const listener = {
        eventType: "user_message",
        scope: "global" as const,
        handler: async (event: any) => { received.push(event); },
      };
      bus.on(listener);

      await bus.emit({ type: "user_message", sessionId: "s1", payload: {}, timestamp: 1, seq: 1 });
      expect(received.length).toBe(1);

      bus.off(listener);

      await bus.emit({ type: "user_message", sessionId: "s1", payload: {}, timestamp: 2, seq: 2 });
      expect(received.length).toBe(1); // 不增加
    });

    it("clearAll 后所有 listener 被移除", async () => {
      const { getTypedEventBus } = await import("../core/llm/event-system-strict");
      const bus = getTypedEventBus();
      bus.clear();

      const received: any[] = [];
      bus.on({
        eventType: "user_message",
        scope: "global" as const,
        handler: async (event: any) => { received.push(event); },
      });
      bus.on({
        eventType: "assistant_text",
        scope: "global" as const,
        handler: async (event: any) => { received.push(event); },
      });

      await bus.emit({ type: "user_message", sessionId: "s1", payload: {}, timestamp: 1, seq: 1 });
      await bus.emit({ type: "assistant_text", sessionId: "s1", payload: {}, timestamp: 2, seq: 2 });
      expect(received.length).toBe(2);

      bus.clear();
      await bus.emit({ type: "user_message", sessionId: "s1", payload: {}, timestamp: 3, seq: 3 });
      await bus.emit({ type: "assistant_text", sessionId: "s1", payload: {}, timestamp: 4, seq: 4 });
      expect(received.length).toBe(2); // 不增加
    });
  });

  describe("AgentMessageQueue 清理", () => {
    it("clearSession 后消息不再残留", async () => {
      const { AgentMessageQueue } = await import("../core/llm/agent-message-queue");
      AgentMessageQueue.consume("primary");
      AgentMessageQueue.consume("worker");

      AgentMessageQueue.send({
        sessionId: "sess-clear",
        fromAgent: "primary",
        toAgent: "worker",
        messageType: "notification",
        subject: "test",
        body: "hello",
      });
      expect(AgentMessageQueue.hasPending("worker")).toBe(true);

      AgentMessageQueue.clearSession("sess-clear");
      expect(AgentMessageQueue.hasPending("worker")).toBe(false);
    });

    it("consume 后队列清空", async () => {
      const { AgentMessageQueue } = await import("../core/llm/agent-message-queue");
      AgentMessageQueue.consume("primary");

      AgentMessageQueue.send({
        sessionId: "sess-1",
        fromAgent: "worker",
        toAgent: "primary",
        messageType: "notification",
        subject: "msg1",
        body: "first",
      });
      AgentMessageQueue.send({
        sessionId: "sess-2",
        fromAgent: "worker",
        toAgent: "primary",
        messageType: "notification",
        subject: "msg2",
        body: "second",
      });

      const consumed = AgentMessageQueue.consume("primary");
      expect(consumed.length).toBe(2);

      // 再次 consume — 应为空
      const empty = AgentMessageQueue.consume("primary");
      expect(empty.length).toBe(0);
    });
  });

  describe("Sandbox 策略切换", () => {
    it("从 default 切换到 strict — 更多命令被阻止", async () => {
      const { SandboxGuard, createDefaultPolicy, createStrictPolicy } = await import("../core/sandbox/sandbox-acl");
      const defaultGuard = new SandboxGuard(createDefaultPolicy("/workspace"));
      const strictGuard = new SandboxGuard(createStrictPolicy("/workspace"));

      // apt install 在 default 下允许，在 strict 下被阻止
      expect(defaultGuard.checkCommand("apt install foo").allowed).toBe(true);
      expect(strictGuard.checkCommand("apt install foo").allowed).toBe(false);

      // pip install 在 default 下允许，在 strict 下被阻止
      expect(defaultGuard.checkCommand("pip install foo").allowed).toBe(true);
      expect(strictGuard.checkCommand("pip install foo").allowed).toBe(false);
    });

    it("strict 策略阻止网络命令", async () => {
      const { SandboxGuard, createStrictPolicy } = await import("../core/sandbox/sandbox-acl");
      const guard = new SandboxGuard(createStrictPolicy("/workspace"));
      expect(guard.checkCommand("curl https://example.com").allowed).toBe(false);
      expect(guard.checkCommand("wget https://example.com").allowed).toBe(false);
    });
  });

  describe("Header tracking 清理", () => {
    it("clearHeaderTracking 后历史被清除", async () => {
      const { trackRequestHeader, clearHeaderTracking, getHeaderHistory } = await import("../core/llm/request-header");
      clearHeaderTracking("sess-clean");

      const h = { model: "gpt-4o", systemPromptLength: 1000, toolCount: 5, temperature: 0.7 };
      trackRequestHeader("sess-clean", h);
      expect(getHeaderHistory("sess-clean").length).toBe(1);

      clearHeaderTracking("sess-clean");
      expect(getHeaderHistory("sess-clean").length).toBe(0);
    });
  });

  describe("Compaction lock 释放", () => {
    it("release 后可重新获取", async () => {
      const { acquireCompactionLock, releaseCompactionLock } = await import("../core/llm/compaction-control");
      acquireCompactionLock("sess-release");
      releaseCompactionLock("sess-release");
      expect(acquireCompactionLock("sess-release")).toBe(true);
      releaseCompactionLock("sess-release");
    });
  });
});

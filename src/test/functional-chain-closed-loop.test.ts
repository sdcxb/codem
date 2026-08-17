/**
 * 功能触发→调用→执行闭环测试
 *
 * 验证关键功能链路的端到端通畅性：
 * 1. EventLog append → EventProjection project → LLM messages
 * 2. compaction-control: crash repair → EventLog → projection
 * 3. feedback: record → list → EventLog trace
 * 4. postmortem: events → generate → report includes events
 * 5. sandbox-acl: path check → block → reason
 * 6. instruction-layers: session instructions → buildSystemPrompt → prompt contains
 * 7. dynamic-plugin-tools: define → inspect → run → stop → undefine
 * 8. token-tracker: record actual → projected → shouldMicroCompact
 * 9. event-system-strict: emit → listener → receive
 * 10. agent-message-queue: send → consume → reply
 * 11. request-header: track → change detected → history
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
      if (sql.includes("AND seq >=")) {
        const fromSeq = params?.[1];
        filtered = filtered.filter(d => d.seq >= fromSeq);
      }
      filtered.sort((a, b) => a.seq - b.seq);
      if (filtered.length === 0) return [];
      return [{ columns: ["seq", "session_id", "event_type", "payload", "timestamp"], values: filtered.map(d => [d.seq, d.session_id, d.event_type, JSON.stringify(d.payload), d.timestamp]) }];
    }
    if (sql.startsWith("SELECT MAX(seq)")) {
      const filtered = this.data.filter(d => d.session_id === params?.[0]);
      return [{ columns: ["MAX(seq)"], values: [[filtered.length > 0 ? Math.max(...filtered.map(d => d.seq)) : 0]] }];
    }
    if (sql.startsWith("SELECT COUNT")) {
      return [{ columns: ["COUNT(*)"], values: [[this.data.filter(d => d.session_id === params?.[0]).length]] }];
    }
    if (sql === "SELECT last_insert_rowid()") {
      return [{ columns: ["last_insert_rowid()"], values: [[this.seq]] }];
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

describe("功能触发→调用→执行闭环测试", () => {
  beforeEach(() => {
    mockDb.data = [];
    mockDb.seq = 0;
  });

  // ========== Chain 1: EventLog → Projection → LLM Messages ==========

  describe("Chain 1: EventLog append → EventProjection → LLM Messages", () => {
    it("完整对话链路：user → assistant → tool_call → tool_result → assistant", async () => {
      const { getEventLog } = await import("../core/storage/event-log");
      const { EventProjection } = await import("../core/storage/event-projection");
      const log = getEventLog();

      // 模拟一次完整对话
      log.append("sess-chain1", "user_message", { messageId: "u1", content: "Read the file" });
      log.append("sess-chain1", "assistant_text", { messageId: "a1", content: "I'll read the file." });
      log.append("sess-chain1", "tool_call", { toolCallId: "tc1", tool: "read", messageId: "a1", status: "completed", args: { path: "test.ts" } });
      log.append("sess-chain1", "tool_result", { toolCallId: "tc1", status: "completed", result: "file content here" });
      log.append("sess-chain1", "assistant_text", { messageId: "a2", content: "The file contains test code." });

      const projection = new EventProjection();
      const messages = projection.projectAll("sess-chain1");

      // 应该投影出消息
      expect(messages.length).toBeGreaterThan(0);
      const roles = messages.map(m => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
    });
  });

  // ========== Chain 2: Crash Repair → EventLog → Projection ==========

  describe("Chain 2: Crash Repair → EventLog → Projection", () => {
    it("崩溃修复后，合成的 tool_result 可被投影", async () => {
      const { getEventLog } = await import("../core/storage/event-log");
      const { EventProjection } = await import("../core/storage/event-projection");
      const { repairCrashedSession } = await import("../core/llm/compaction-control");
      const log = getEventLog();

      // 模拟崩溃前的状态 — 有 user_message + tool_call 但无 tool_result
      log.append("sess-crash", "user_message", { messageId: "u1", content: "Read file" });
      log.append("sess-crash", "tool_call", { toolCallId: "tc1", tool: "read", messageId: "a1", status: "running" });

      // 修复崩溃
      const result = repairCrashedSession("sess-crash");
      expect(result.repairedCount).toBe(1);

      // 验证事件日志中有合成的 tool_result
      const events = log.readAll("sess-crash");
      const toolResults = events.filter(e => e.type === "tool_result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].payload.toolCallId).toBe("tc1");

      // 验证投影能处理合成的事件
      const projection = new EventProjection();
      const messages = projection.projectAll("sess-crash");
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  // ========== Chain 3: Feedback → EventLog trace ==========

  describe("Chain 3: Feedback record → list", () => {
    it("反馈记录后可被检索", async () => {
      const { recordSessionFeedback, listSessionFeedback } = await import("../core/llm/feedback");
      recordSessionFeedback("sess-fb", "Great!");
      recordSessionFeedback("sess-fb", "Needs improvement");
      const list = listSessionFeedback("sess-fb");
      expect(list.length).toBe(2);
    });
  });

  // ========== Chain 4: Postmortem → events analysis ==========

  describe("Chain 4: Postmortem — events → report", () => {
    it("完整事件链 → 生成包含统计的 postmortem", async () => {
      const { getEventLog } = await import("../core/storage/event-log");
      const { generatePostmortem } = await import("../core/llm/postmortem");
      const log = getEventLog();

      log.append("sess-pm", "user_message", { messageId: "u1", content: "do task" });
      log.append("sess-pm", "tool_call", { toolCallId: "tc1", tool: "write", messageId: "a1", status: "completed" });
      log.append("sess-pm", "tool_result", { toolCallId: "tc1", status: "error", result: "Permission denied" });
      log.append("sess-pm", "error", { message: "Write failed" });

      const report = await generatePostmortem("sess-pm", "Write failed");
      expect(report.sessionId).toBe("sess-pm");
      expect(report.error).toBe("Write failed");
      expect(report.eventSummary.totalEvents).toBe(4);
      expect(report.toolCallStats.totalCalls).toBe(1);
      expect(report.toolCallStats.failedCalls).toBe(1);
      expect(report.possibleCauses.some(c => c.includes("failed"))).toBe(true);
    });
  });

  // ========== Chain 5: Sandbox ACL → block → reason ==========

  describe("Chain 5: Sandbox ACL path → block → reason", () => {
    it("SSH 路径访问 → 被阻止 → 原因包含 blocked", async () => {
      const { SandboxGuard, createDefaultPolicy } = await import("../core/sandbox/sandbox-acl");
      const guard = new SandboxGuard(createDefaultPolicy("/workspace"));
      const result = guard.checkPath("~/.ssh/id_rsa", "read");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("工作区内文件 → 允许", async () => {
      const { SandboxGuard, createDefaultPolicy } = await import("../core/sandbox/sandbox-acl");
      const guard = new SandboxGuard(createDefaultPolicy("/workspace"));
      const result = guard.checkPath("/workspace/src/file.ts", "read");
      expect(result.allowed).toBe(true);
    });
  });

  // ========== Chain 6: Instruction Layers → SystemPrompt ==========

  describe("Chain 6: instruction-layers → buildSystemPrompt", () => {
    it("session 指令 → layeredInstructions → prompt 包含", async () => {
      const { loadLayeredInstructionsSync } = await import("../core/prompt/instruction-layers");
      const { buildSystemPrompt } = await import("../core/prompt/prompt");
      const layered = loadLayeredInstructionsSync("Always use TypeScript");
      const prompt = buildSystemPrompt({
        agent: { id: "test", name: "Test", description: "test", mode: "primary", prompt: "You are a test agent." },
        layeredInstructions: layered.combined,
      });
      expect(prompt).toContain("TypeScript");
      expect(prompt).toContain("Session Instructions");
    });
  });

  // ========== Chain 7: Dynamic Plugin Tools lifecycle ==========

  describe("Chain 7: dynamic-plugin-tools define → inspect → run → stop → undefine", () => {
    it("完整生命周期工具链存在", async () => {
      const { createDynamicPluginTools } = await import("../core/llm/dynamic-plugin-tools");
      const tools = createDynamicPluginTools();

      // 5 个工具全部存在
      expect(tools.length).toBe(5);
      const ids = tools.map(t => t.id);
      expect(ids).toEqual(expect.arrayContaining([
        "cordis_define", "cordis_inspect", "cordis_run", "cordis_stop", "cordis_undefine",
      ]));

      // 每个工具都有 execute 和 searchHint
      for (const tool of tools) {
        expect(typeof tool.execute).toBe("function");
        expect(tool.searchHint).toBeDefined();
        expect(tool.shouldDefer).toBe(true);
      }
    });
  });

  // ========== Chain 8: Token Tracker → projectedTokens → shouldMicroCompact ==========

  describe("Chain 8: token-tracker record → project → shouldMicroCompact", () => {
    it("记录实际 usage → 投影估算 → 微压缩判断", async () => {
      const { TokenTracker } = await import("../core/llm/token-tracker");
      const tracker = new TokenTracker(8000);

      tracker.recordActualUsage(
        { promptTokens: 500, completionTokens: 200, totalTokens: 700 },
        100,
        "fp-chain8",
      );

      const messages = Array(50).fill({ role: "user", content: "x".repeat(50) });
      const tools = [{ name: "tool1" }, { name: "tool2" }];

      const projected = tracker.projectedTokens(messages, tools);
      expect(projected).toBeGreaterThan(0);

      const should = tracker.shouldMicroCompact(messages, tools, 0.8);
      expect(typeof should).toBe("boolean");
    });
  });

  // ========== Chain 9: Event System Strict — emit → listener → receive ==========

  describe("Chain 9: TypedEventBus emit → listener → receive", () => {
    it("完整事件流：注册监听 → 发射事件 → 接收 → 验证 payload", async () => {
      const { getTypedEventBus } = await import("../core/llm/event-system-strict");
      const bus = getTypedEventBus();
      bus.clear();

      const received: any[] = [];
      bus.on({
        eventType: "tool_call",
        scope: "session" as const,
        sessionId: "sess-evt",
        handler: async (event) => { received.push(event); },
      });

      await bus.emit({
        type: "tool_call",
        sessionId: "sess-evt",
        payload: { toolCallId: "tc1", tool: "read", status: "completed" },
        timestamp: Date.now(),
        seq: 1,
      });

      expect(received.length).toBe(1);
      expect(received[0].payload.tool).toBe("read");
      expect(received[0].payload.status).toBe("completed");
    });
  });

  // ========== Chain 10: Agent Message Queue — send → consume → reply ==========

  describe("Chain 10: AgentMessageQueue send → consume → reply", () => {
    it("完整消息流：send notification → consume → send reply → getReply", async () => {
      const { AgentMessageQueue } = await import("../core/llm/agent-message-queue");
      AgentMessageQueue.consume("primary");
      AgentMessageQueue.consume("worker");

      // 1. primary 向 worker 发送 request
      const msg = AgentMessageQueue.send({
        sessionId: "sess-amq",
        fromAgent: "primary",
        toAgent: "worker",
        messageType: "request",
        subject: "do task",
        body: "Please process this data",
      });
      expect(msg.id).toBeDefined();
      expect(AgentMessageQueue.hasPending("worker")).toBe(true);

      // 2. worker consume 消息
      const consumed = AgentMessageQueue.consume("worker");
      expect(consumed.length).toBe(1);
      expect(consumed[0].subject).toBe("do task");

      // 3. worker 发送 reply
      AgentMessageQueue.send({
        sessionId: "sess-amq",
        fromAgent: "worker",
        toAgent: "primary",
        messageType: "reply",
        subject: "task done",
        body: "Result: 42",
        replyToId: msg.id,
      });

      // 4. primary 通过 getReply 获取回复
      const reply = AgentMessageQueue.getReply(msg.id);
      expect(reply).toBe("Result: 42");
    });
  });

  // ========== Chain 11: Request Header → track → change → history ==========

  describe("Chain 11: RequestHeader track → change → history", () => {
    it("完整变化追踪：首次 → 变化 → 历史", async () => {
      const { trackRequestHeader, getHeaderHistory, clearHeaderTracking } = await import("../core/llm/request-header");
      clearHeaderTracking("sess-chain11");

      // 1. 首次调用 — initial request
      const first = trackRequestHeader("sess-chain11", { model: "gpt-4o", systemPromptLength: 500, toolCount: 3, temperature: 0.7 });
      expect(first).not.toBe(null);
      expect(first!.reason).toBe("initial request");

      // 2. 相同参数 — 无变化
      const same = trackRequestHeader("sess-chain11", { model: "gpt-4o", systemPromptLength: 500, toolCount: 3, temperature: 0.7 });
      expect(same).toBe(null);

      // 3. 模型变化
      const changed = trackRequestHeader("sess-chain11", { model: "gpt-4o-mini", systemPromptLength: 500, toolCount: 3, temperature: 0.7 });
      expect(changed).not.toBe(null);
      expect(changed!.reason).toContain("model changed");

      // 4. 历史记录
      const history = getHeaderHistory("sess-chain11");
      expect(history.length).toBe(2); // initial + model changed
    });
  });

  // ========== Chain 12: Output Contract → register → validate → render ==========

  describe("Chain 12: OutputContract register → validate → render", () => {
    it("完整契约链路：注册 → 验证 → 渲染", async () => {
      const { registerOutputContract, validateToolOutput, renderToolOutput } = await import("../core/llm/output-contract");
      registerOutputContract("chain12_tool", {
        schema: { type: "object", properties: { count: { type: "number" } } },
        render: (args, value: any) => [{ type: "text", text: `Count: ${value.count}` }],
      });

      // 验证通过
      const valid = validateToolOutput("chain12_tool", { count: 5 });
      expect(valid.valid).toBe(true);

      // 验证失败
      const invalid = validateToolOutput("chain12_tool", { count: "five" });
      expect(invalid.valid).toBe(false);

      // 渲染
      const blocks = renderToolOutput("chain12_tool", {}, { count: 5 });
      expect(blocks.length).toBe(1);
      expect(blocks[0].text).toBe("Count: 5");
    });
  });
});

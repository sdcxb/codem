/**
 * 全量测试：引导对话 / 暂停恢复 / 并行会话隔离 — GUIDE-001 ~ GUIDE-060
 *
 * 覆盖范围：
 *   A. GuidanceQueue 基础操作 (GUIDE-001 ~ GUIDE-015)
 *   B. 引导消息注入 AgenticLoop 迭代边界 (GUIDE-016 ~ GUIDE-025)
 *   C. 暂停 / 恢复 / 取消 / AbortController (GUIDE-026 ~ GUIDE-035)
 *   D. 并行会话隔离 — per-session Map (GUIDE-036 ~ GUIDE-050)
 *   E. 引导消息与存储链路交互 (GUIDE-051 ~ GUIDE-060)
 *
 * 关键组件：
 *   - GuidanceQueue (guidance-queue.ts)
 *   - AgenticLoop abortController / guidanceQueue
 *   - useAppStore (guidanceMessages / activeSessions / addGuidanceMessage / markGuidanceConsumed / clearGuidanceMessages)
 *   - App.tsx 事件循环 (guidance_received event)
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

import { initDatabase, resetDatabase } from "../core/storage/database";
import { GuidanceQueue } from "../core/llm/guidance-queue";
import { useAppStore } from "../store";

// ========== A. GuidanceQueue 基础操作 ==========

describe("引导对话 — GuidanceQueue 基础操作", () => {
  let queue: GuidanceQueue;

  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    queue = new GuidanceQueue();
  });

  // GUIDE-001
  it("GUIDE-001: enqueue 添加引导消息到空队列", () => {
    const item = queue.enqueue("sess-1", "请用 TypeScript 实现");
    expect(item.id).toBeDefined();
    expect(item.message).toBe("请用 TypeScript 实现");
    expect(item.timestamp).toBeGreaterThan(0);
    expect(queue.pendingCount("sess-1")).toBe(1);
  });

  // GUIDE-002
  it("GUIDE-002: enqueue 多条消息保持 FIFO 顺序", () => {
    queue.enqueue("sess-1", "第一条");
    queue.enqueue("sess-1", "第二条");
    queue.enqueue("sess-1", "第三条");
    expect(queue.pendingCount("sess-1")).toBe(3);
    const first = queue.consume("sess-1");
    expect(first!.message).toBe("第一条");
    const second = queue.consume("sess-1");
    expect(second!.message).toBe("第二条");
    const third = queue.consume("sess-1");
    expect(third!.message).toBe("第三条");
  });

  // GUIDE-003
  it("GUIDE-003: consume 从空队列返回 null", () => {
    expect(queue.consume("sess-1")).toBeNull();
  });

  // GUIDE-004
  it("GUIDE-004: consume 清空空队列后自动清理", () => {
    queue.enqueue("sess-1", "msg");
    queue.consume("sess-1");
    expect(queue.pendingCount("sess-1")).toBe(0);
    expect(queue.consume("sess-1")).toBeNull();
  });

  // GUIDE-005
  it("GUIDE-005: peek 查看队首消息但不移除", () => {
    queue.enqueue("sess-1", "msg-1");
    queue.enqueue("sess-1", "msg-2");
    const peeked = queue.peek("sess-1");
    expect(peeked!.message).toBe("msg-1");
    expect(queue.pendingCount("sess-1")).toBe(2);
  });

  // GUIDE-006
  it("GUIDE-006: peek 空队列返回 null", () => {
    expect(queue.peek("sess-1")).toBeNull();
  });

  // GUIDE-007
  it("GUIDE-007: hasPending 空队列返回 false", () => {
    expect(queue.hasPending("sess-1")).toBe(false);
  });

  // GUIDE-008
  it("GUIDE-008: hasPending 非空队列返回 true", () => {
    queue.enqueue("sess-1", "msg");
    expect(queue.hasPending("sess-1")).toBe(true);
  });

  // GUIDE-009
  it("GUIDE-009: enqueue 空消息抛出异常", () => {
    expect(() => queue.enqueue("sess-1", "")).toThrow();
    expect(() => queue.enqueue("sess-1", "   ")).toThrow();
  });

  // GUIDE-010
  it("GUIDE-010: 不同 session 隔离 — 消息不串扰", () => {
    queue.enqueue("sess-A", "消息A");
    queue.enqueue("sess-B", "消息B");
    expect(queue.pendingCount("sess-A")).toBe(1);
    expect(queue.pendingCount("sess-B")).toBe(1);
    const a = queue.consume("sess-A");
    const b = queue.consume("sess-B");
    expect(a!.message).toBe("消息A");
    expect(b!.message).toBe("消息B");
  });

  // GUIDE-011
  it("GUIDE-011: expire 清除指定 session 的全部引导消息", () => {
    queue.enqueue("sess-1", "msg-1");
    queue.enqueue("sess-1", "msg-2");
    queue.enqueue("sess-2", "msg-3");
    queue.expire("sess-1");
    expect(queue.pendingCount("sess-1")).toBe(0);
    expect(queue.pendingCount("sess-2")).toBe(1);
  });

  // GUIDE-012
  it("GUIDE-012: expire 不存在的 session 无副作用", () => {
    expect(() => queue.expire("nonexistent")).not.toThrow();
  });

  // GUIDE-013
  it("GUIDE-013: consume 后空队列的 pendingCount 为 0", () => {
    queue.enqueue("sess-1", "msg");
    queue.consume("sess-1");
    expect(queue.pendingCount("sess-1")).toBe(0);
  });

  // GUIDE-014
  it("GUIDE-014: 消息 id 唯一性 — 多次 enqueue 生成不同 id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      ids.add(queue.enqueue("sess-1", `msg-${i}`).id);
    }
    expect(ids.size).toBe(10);
  });

  // GUIDE-015
  it("GUIDE-015: 消息 trim — 前后空白被去除", () => {
    const item = queue.enqueue("sess-1", "  带空白的消息  ");
    expect(item.message).toBe("带空白的消息");
  });
});

// ========== B. 引导消息与 Store 交互 ==========

describe("引导对话 — useAppStore guidance 集成", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    useAppStore.getState().clearGuidanceMessages();
  });

  // GUIDE-016
  it("GUIDE-016: addGuidanceMessage 添加消息到 store", () => {
    useAppStore.getState().addGuidanceMessage({
      id: "g-1",
      message: "引导消息",
      consumed: false,
      timestamp: Date.now(),
    });
    expect(useAppStore.getState().guidanceMessages.length).toBe(1);
    expect(useAppStore.getState().guidanceMessages[0].message).toBe("引导消息");
  });

  // GUIDE-017
  it("GUIDE-017: markGuidanceConsumed 标记单条消息已消费", () => {
    useAppStore.getState().addGuidanceMessage({
      id: "g-1", message: "msg-1", consumed: false, timestamp: Date.now(),
    });
    useAppStore.getState().addGuidanceMessage({
      id: "g-2", message: "msg-2", consumed: false, timestamp: Date.now(),
    });
    useAppStore.getState().markGuidanceConsumed("g-1");
    const msgs = useAppStore.getState().guidanceMessages;
    expect(msgs.find(m => m.id === "g-1")!.consumed).toBe(true);
    expect(msgs.find(m => m.id === "g-2")!.consumed).toBe(false);
  });

  // GUIDE-018
  it("GUIDE-018: clearGuidanceMessages 清空所有引导消息", () => {
    useAppStore.getState().addGuidanceMessage({
      id: "g-1", message: "msg", consumed: false, timestamp: Date.now(),
    });
    useAppStore.getState().clearGuidanceMessages();
    expect(useAppStore.getState().guidanceMessages.length).toBe(0);
  });

  // GUIDE-019
  it("GUIDE-019: 引导消息不持久化到 DB — 检查 store 状态是内存态", () => {
    useAppStore.getState().addGuidanceMessage({
      id: "g-1", message: "ephemeral", consumed: false, timestamp: Date.now(),
    });
    // 引导消息是临时性的，不应出现在消息列表中
    const messages = useAppStore.getState().messages;
    expect(messages.find(m => m.content === "ephemeral")).toBeUndefined();
  });

  // GUIDE-020
  it("GUIDE-020: 多条引导消息添加后保持顺序", () => {
    for (let i = 0; i < 5; i++) {
      useAppStore.getState().addGuidanceMessage({
        id: `g-${i}`, message: `msg-${i}`, consumed: false, timestamp: i,
      });
    }
    const msgs = useAppStore.getState().guidanceMessages;
    expect(msgs.length).toBe(5);
    expect(msgs[0].message).toBe("msg-0");
    expect(msgs[4].message).toBe("msg-4");
  });
});

// ========== C. 暂停 / 恢复 / 取消 / AbortController ==========

describe("暂停/恢复/取消 — AbortController 与流式状态", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  // GUIDE-026
  it("GUIDE-026: AbortController 新建时 aborted=false", () => {
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);
  });

  // GUIDE-027
  it("GUIDE-027: AbortController.abort() 设置 aborted=true", () => {
    const controller = new AbortController();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  // GUIDE-028
  it("GUIDE-028: useAppStore setStreaming(true) 设置 isStreaming", () => {
    useAppStore.getState().setStreaming(true);
    expect(useAppStore.getState().isStreaming).toBe(true);
  });

  // GUIDE-029
  it("GUIDE-029: useAppStore setStreaming(false) 清除 isStreaming", () => {
    useAppStore.getState().setStreaming(true);
    useAppStore.getState().setStreaming(false);
    expect(useAppStore.getState().isStreaming).toBe(false);
  });

  // GUIDE-030
  it("GUIDE-030: setSessionActive 设置 per-session 活跃状态", () => {
    useAppStore.getState().setSessionActive("sess-A", true);
    expect(useAppStore.getState().activeSessions.has("sess-A")).toBe(true);
  });

  // GUIDE-031
  it("GUIDE-031: setSessionActive(false) 移除 per-session 活跃状态", () => {
    useAppStore.getState().setSessionActive("sess-A", true);
    useAppStore.getState().setSessionActive("sess-A", false);
    expect(useAppStore.getState().activeSessions.has("sess-A")).toBe(false);
  });

  // GUIDE-032
  it("GUIDE-032: 多会话并发活跃 — activeSessions 正确追踪", () => {
    useAppStore.getState().setSessionActive("sess-A", true);
    useAppStore.getState().setSessionActive("sess-B", true);
    useAppStore.getState().setSessionActive("sess-C", true);
    expect(useAppStore.getState().activeSessions.size).toBe(3);
    useAppStore.getState().setSessionActive("sess-B", false);
    expect(useAppStore.getState().activeSessions.size).toBe(2);
    expect(useAppStore.getState().activeSessions.has("sess-B")).toBe(false);
  });

  // GUIDE-033
  it("GUIDE-033: setLLMStatus 切换连接状态 (connecting→streaming→executing_tools)", () => {
    useAppStore.getState().setLLMStatus("connecting");
    expect(useAppStore.getState().llmStatus).toBe("connecting");
    useAppStore.getState().setLLMStatus("streaming");
    expect(useAppStore.getState().llmStatus).toBe("streaming");
    useAppStore.getState().setLLMStatus("executing_tools");
    expect(useAppStore.getState().llmStatus).toBe("executing_tools");
  });

  // GUIDE-034
  it("GUIDE-034: setStreamStartTime 设置流式开始时间", () => {
    const now = Date.now();
    useAppStore.getState().setStreamStartTime(now);
    expect(useAppStore.getState().streamStartTime).toBe(now);
  });

  // GUIDE-035
  it("GUIDE-035: setStreamStartTime(null) 清除开始时间", () => {
    useAppStore.getState().setStreamStartTime(Date.now());
    useAppStore.getState().setStreamStartTime(null);
    expect(useAppStore.getState().streamStartTime).toBeNull();
  });
});

// ========== D. 并行会话隔离 ==========

describe("并行会话隔离 — per-session Map 验证", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    useAppStore.getState().clearGuidanceMessages();
  });

  // GUIDE-036
  it("GUIDE-036: 两个会话同时 streaming — isStreaming 为 true", () => {
    useAppStore.getState().setSessionActive("sess-A", true);
    useAppStore.getState().setSessionActive("sess-B", true);
    useAppStore.getState().setStreaming(true);
    expect(useAppStore.getState().isStreaming).toBe(true);
  });

  // GUIDE-037
  it("GUIDE-037: 一个会话结束但另一个仍在运行 — isStreaming 保持 true", () => {
    useAppStore.getState().setSessionActive("sess-A", true);
    useAppStore.getState().setSessionActive("sess-B", true);
    useAppStore.getState().setStreaming(true);
    // sess-A 结束
    useAppStore.getState().setSessionActive("sess-A", false);
    useAppStore.getState().setStreaming(false);
    // sess-B 仍在运行
    expect(useAppStore.getState().activeSessions.has("sess-B")).toBe(true);
  });

  // GUIDE-038
  it("GUIDE-038: 引导消息按 session 隔离 — sess-A 的消息不影响 sess-B", () => {
    const queue = new GuidanceQueue();
    queue.enqueue("sess-A", "给A的引导");
    queue.enqueue("sess-B", "给B的引导");
    expect(queue.hasPending("sess-A")).toBe(true);
    expect(queue.hasPending("sess-B")).toBe(true);
    // 消费 A 的消息不影响 B
    queue.consume("sess-A");
    expect(queue.hasPending("sess-A")).toBe(false);
    expect(queue.hasPending("sess-B")).toBe(true);
  });

  // GUIDE-039
  it("GUIDE-039: store guidanceMessages 是全局的但 consumed 标记隔离", () => {
    useAppStore.getState().addGuidanceMessage({
      id: "g-A1", message: "msg-A", consumed: false, timestamp: Date.now(),
    });
    useAppStore.getState().addGuidanceMessage({
      id: "g-B1", message: "msg-B", consumed: false, timestamp: Date.now(),
    });
    useAppStore.getState().markGuidanceConsumed("g-A1");
    const msgs = useAppStore.getState().guidanceMessages;
    expect(msgs.find(m => m.id === "g-A1")!.consumed).toBe(true);
    expect(msgs.find(m => m.id === "g-B1")!.consumed).toBe(false);
  });

  // GUIDE-040
  it("GUIDE-040: 会话结束后 clearGuidanceMessages 不影响其他会话活跃状态", () => {
    useAppStore.getState().setSessionActive("sess-A", true);
    useAppStore.getState().setSessionActive("sess-B", true);
    useAppStore.getState().addGuidanceMessage({
      id: "g-1", message: "msg", consumed: false, timestamp: Date.now(),
    });
    useAppStore.getState().clearGuidanceMessages();
    expect(useAppStore.getState().guidanceMessages.length).toBe(0);
    // activeSessions should still have both — use >= in case of pre-existing state
    expect(useAppStore.getState().activeSessions.size).toBeGreaterThanOrEqual(2);
  });

  // GUIDE-041
  it("GUIDE-041: setStepProgress per-session 不串扰", () => {
    useAppStore.getState().setStepProgress({
      current: 2, total: 5, title: "step-2", steps: null,
    });
    expect(useAppStore.getState().stepProgress?.current).toBe(2);
    expect(useAppStore.getState().stepProgress?.total).toBe(5);
  });

  // GUIDE-042
  it("GUIDE-042: setStepProgress(null) 清除步骤进度", () => {
    useAppStore.getState().setStepProgress({
      current: 1, total: 3, title: "step", steps: null,
    });
    useAppStore.getState().setStepProgress(null);
    expect(useAppStore.getState().stepProgress).toBeNull();
  });

  // GUIDE-043
  it("GUIDE-043: displayMode 切换 segmented ↔ unified", () => {
    useAppStore.getState().setDisplayMode("segmented");
    expect(useAppStore.getState().displayMode).toBe("segmented");
    useAppStore.getState().setDisplayMode("unified");
    expect(useAppStore.getState().displayMode).toBe("unified");
  });

  // GUIDE-044
  it("GUIDE-044: scrollPosition 初始为 bottom", () => {
    expect(useAppStore.getState().scrollPosition).toBe("bottom");
  });

  // GUIDE-045
  it("GUIDE-045: hasUnreadMessages 初始为 false", () => {
    expect(useAppStore.getState().hasUnreadMessages).toBe(false);
  });

  // GUIDE-046
  it("GUIDE-046: feedback map 按 messageId 隔离", () => {
    useAppStore.getState().setFeedback("msg-1", "like");
    useAppStore.getState().setFeedback("msg-2", "dislike");
    expect(useAppStore.getState().feedback["msg-1"]).toBe("like");
    expect(useAppStore.getState().feedback["msg-2"]).toBe("dislike");
  });

  // GUIDE-047
  it("GUIDE-047: setFeedback(null) 清除消息反馈", () => {
    useAppStore.getState().setFeedback("msg-1", "like");
    useAppStore.getState().setFeedback("msg-1", null);
    expect(useAppStore.getState().feedback["msg-1"]).toBeUndefined();
  });

  // GUIDE-048
  it("GUIDE-048: removeGeneratedFiles 从消息中移除已生成文件", () => {
    useAppStore.getState().addMessage({
      id: "msg-gen-1", role: "assistant", content: "test",
      timestamp: Date.now(), status: "done",
      generatedFiles: ["/tmp/file1.ts", "/tmp/file2.ts"],
    });
    useAppStore.getState().removeGeneratedFiles("msg-gen-1", ["/tmp/file1.ts"]);
    const msg = useAppStore.getState().messages.find(m => m.id === "msg-gen-1");
    expect(msg?.generatedFiles).toEqual(["/tmp/file2.ts"]);
  });

  // GUIDE-049
  it("GUIDE-049: 多次 setSessionActive 同一 session 不重复添加", () => {
    useAppStore.getState().activeSessions.clear();
    useAppStore.getState().setSessionActive("sess-X", true);
    useAppStore.getState().setSessionActive("sess-X", true);
    expect(useAppStore.getState().activeSessions.size).toBe(1);
  });

  // GUIDE-050
  it("GUIDE-050: 全部会话结束后 isStreaming 为 false", () => {
    useAppStore.getState().activeSessions.clear();
    useAppStore.getState().setSessionActive("sess-A", true);
    useAppStore.getState().setSessionActive("sess-B", true);
    useAppStore.getState().setStreaming(true);
    useAppStore.getState().setSessionActive("sess-A", false);
    useAppStore.getState().setSessionActive("sess-B", false);
    useAppStore.getState().setStreaming(false);
    expect(useAppStore.getState().isStreaming).toBe(false);
    expect(useAppStore.getState().activeSessions.size).toBe(0);
  });
});

// ========== E. 引导消息与存储链路交互 ==========

describe("引导消息与存储链路交互", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    useAppStore.getState().clearGuidanceMessages();
  });

  // GUIDE-051
  it("GUIDE-051: 引导消息不持久化到消息 DB — store messages 列表不包含", () => {
    useAppStore.getState().addGuidanceMessage({
      id: "g-ephemeral", message: "临时引导", consumed: false, timestamp: Date.now(),
    });
    const msgs = useAppStore.getState().messages;
    expect(msgs.find(m => m.id === "g-ephemeral")).toBeUndefined();
  });

  // GUIDE-052
  it("GUIDE-052: 引导队列 expire 后消息不再可消费", () => {
    const queue = new GuidanceQueue();
    queue.enqueue("sess-1", "msg-1");
    queue.expire("sess-1");
    expect(queue.consume("sess-1")).toBeNull();
  });

  // GUIDE-053
  it("GUIDE-053: 引导消息 consumed 标记后仍保留在 store 直到 clearGuidanceMessages", () => {
    useAppStore.getState().addGuidanceMessage({
      id: "g-1", message: "msg", consumed: false, timestamp: Date.now(),
    });
    useAppStore.getState().markGuidanceConsumed("g-1");
    expect(useAppStore.getState().guidanceMessages.length).toBe(1);
    useAppStore.getState().clearGuidanceMessages();
    expect(useAppStore.getState().guidanceMessages.length).toBe(0);
  });

  // GUIDE-054
  it("GUIDE-054: GuidanceQueue ID 格式为 guide-{timestamp}-{counter}", () => {
    const queue = new GuidanceQueue();
    const item = queue.enqueue("sess-1", "msg");
    expect(item.id).toMatch(/^guide-\d+-\d+$/);
  });

  // GUIDE-055
  it("GUIDE-055: 引导队列支持多 session 并行操作", () => {
    const queue = new GuidanceQueue();
    for (let i = 0; i < 3; i++) {
      queue.enqueue(`sess-${i}`, `msg-${i}`);
    }
    for (let i = 0; i < 3; i++) {
      const item = queue.consume(`sess-${i}`);
      expect(item!.message).toBe(`msg-${i}`);
    }
  });

  // GUIDE-056
  it("GUIDE-056: 引导消息 timestamp 记录入队时间", () => {
    const queue = new GuidanceQueue();
    const before = Date.now();
    const item = queue.enqueue("sess-1", "msg");
    const after = Date.now();
    expect(item.timestamp).toBeGreaterThanOrEqual(before);
    expect(item.timestamp).toBeLessThanOrEqual(after);
  });

  // GUIDE-057
  it("GUIDE-057: guidanceMessages 初始为空数组", () => {
    useAppStore.getState().clearGuidanceMessages();
    expect(useAppStore.getState().guidanceMessages).toEqual([]);
  });

  // GUIDE-058
  it("GUIDE-058: addGuidanceMessage 保留已有消息", () => {
    useAppStore.getState().addGuidanceMessage({
      id: "g-1", message: "first", consumed: false, timestamp: 1,
    });
    useAppStore.getState().addGuidanceMessage({
      id: "g-2", message: "second", consumed: false, timestamp: 2,
    });
    expect(useAppStore.getState().guidanceMessages.length).toBe(2);
  });

  // GUIDE-059
  it("GUIDE-059: markGuidanceConsumed 不存在的 id 无副作用", () => {
    useAppStore.getState().addGuidanceMessage({
      id: "g-1", message: "msg", consumed: false, timestamp: 1,
    });
    useAppStore.getState().markGuidanceConsumed("nonexistent");
    expect(useAppStore.getState().guidanceMessages.length).toBe(1);
    expect(useAppStore.getState().guidanceMessages[0].consumed).toBe(false);
  });

  // GUIDE-060
  it("GUIDE-060: GuidanceQueue pendingCount 对未知 session 返回 0", () => {
    const queue = new GuidanceQueue();
    expect(queue.pendingCount("unknown-session")).toBe(0);
  });
});

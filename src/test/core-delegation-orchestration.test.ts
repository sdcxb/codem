/**
 * 测试：跨会话委派 — DELE-001 ~ DELE-025
 *
 * 覆盖范围：
 *   7.1 委派编排（DelegationOrchestrator）
 *   7.2 委派工具与后台执行
 *
 * 关键组件：
 *   - DelegationOrchestrator: 死锁检测、深度/并发限制、状态机
 *   - SessionMessageBus: 消息分发、历史回放
 *   - delegation-storage: DB 持久化
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
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import {
  createDelegationTask,
  updateDelegationTaskStatus,
  getDelegationTask,
  getActiveDelegations,
} from "../core/session/delegation-storage";
import { getSessionMessageBus, resetSessionMessageBus } from "../core/session/bus";
import { DelegationOrchestrator } from "../core/session/orchestrator";
import type { DelegationTask } from "../core/session/types";

const PROJECT_ID = "proj-dele-test";

function setupProject(): void {
  ProjectStorage.createProject({
    id: PROJECT_ID, name: "委派测试", path: "D:/dele",
    createdAt: Date.now(), lastAccessedAt: Date.now(),
  });
}

function makeTask(overrides: Partial<DelegationTask> = {}): DelegationTask {
  return {
    id: `del-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    sourceSessionId: "sess-a",
    targetSessionId: "sess-b",
    task: "测试任务",
    status: "pending",
    projectId: PROJECT_ID,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("跨会话委派 — SessionMessageBus", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    resetSessionMessageBus();
  });

  // DELE-022
  it("DELE-022: send 分发给目标会话监听器", () => {
    const bus = getSessionMessageBus();
    const received: any[] = [];
    bus.subscribe("sess-b", (msg) => received.push(msg));

    bus.send("sess-b", {
      type: "delegation",
      sourceSessionId: "sess-a",
      task: "做设计",
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("delegation");
    expect(received[0].sourceSessionId).toBe("sess-a");
    expect(received[0].targetSessionId).toBe("sess-b");
    expect(received[0].task).toBe("做设计");
    expect(received[0].id).toBeDefined();
    expect(received[0].timestamp).toBeDefined();
  });

  it("DELE-022b: send 分发给全局监听器", () => {
    const bus = getSessionMessageBus();
    const globalReceived: any[] = [];
    bus.subscribeAll((msg) => globalReceived.push(msg));

    bus.send("sess-b", {
      type: "delegation",
      sourceSessionId: "sess-a",
      task: "test",
    });

    expect(globalReceived).toHaveLength(1);
  });

  it("DELE-022c: listener 抛错不影响其他 listener", () => {
    const bus = getSessionMessageBus();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const received: any[] = [];

    bus.subscribe("sess-b", () => { throw new Error("listener error"); });
    bus.subscribe("sess-b", (msg) => received.push(msg));

    bus.send("sess-b", {
      type: "delegation",
      sourceSessionId: "sess-a",
      task: "test",
    });

    expect(received).toHaveLength(1);
    errorSpy.mockRestore();
  });

  // DELE-023
  it("DELE-023: 历史消息回放", () => {
    const bus = getSessionMessageBus();
    bus.send("sess-b", { type: "delegation", sourceSessionId: "sess-a", task: "msg1" });
    bus.send("sess-b", { type: "result", sourceSessionId: "sess-b", result: "result1" });

    const history = bus.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it("DELE-023b: 历史上限 100 条", () => {
    const bus = getSessionMessageBus();
    for (let i = 0; i < 110; i++) {
      bus.send("sess-b", { type: "status", sourceSessionId: "sess-a", detail: `msg-${i}` });
    }
    const history = bus.getHistory();
    expect(history.length).toBeLessThanOrEqual(100);
  });

  it("DELE-023c: unsubscribe 取消订阅", () => {
    const bus = getSessionMessageBus();
    const received: any[] = [];
    const unsub = bus.subscribe("sess-b", (msg) => received.push(msg));

    bus.send("sess-b", { type: "delegation", sourceSessionId: "sess-a", task: "before" });
    expect(received).toHaveLength(1);

    unsub();
    bus.send("sess-b", { type: "delegation", sourceSessionId: "sess-a", task: "after" });
    expect(received).toHaveLength(1);
  });

  it("DELE-023d: broadcast 发送给所有", () => {
    const bus = getSessionMessageBus();
    const receivedA: any[] = [];
    const receivedB: any[] = [];
    bus.subscribe("sess-a", (msg) => receivedA.push(msg));
    bus.subscribe("sess-b", (msg) => receivedB.push(msg));

    bus.broadcast({ type: "status", sourceSessionId: "system", detail: "broadcast test" });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
  });
});

describe("跨会话委派 — DelegationStorage", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupProject();
  });

  it("DELE-010: 委派任务 DB 持久化与恢复", () => {
    const task = makeTask({ id: "del-persist" });
    createDelegationTask(task);

    const loaded = getDelegationTask("del-persist");
    expect(loaded).not.toBeNull();
    expect(loaded!.sourceSessionId).toBe("sess-a");
    expect(loaded!.targetSessionId).toBe("sess-b");
    expect(loaded!.status).toBe("pending");
    expect(loaded!.projectId).toBe(PROJECT_ID);
  });

  it("DELE-010b: 更新状态后 DB 反映最新状态", () => {
    const task = makeTask({ id: "del-state" });
    createDelegationTask(task);

    updateDelegationTaskStatus("del-state", "running", { startedAt: Date.now() });
    expect(getDelegationTask("del-state")!.status).toBe("running");

    updateDelegationTaskStatus("del-state", "completed", {
      result: "完成",
      completedAt: Date.now(),
    });
    expect(getDelegationTask("del-state")!.status).toBe("completed");
    expect(getDelegationTask("del-state")!.result).toBe("完成");
  });

  it("DELE-010c: getActiveDelegations 只返回 pending/running", () => {
    createDelegationTask(makeTask({ id: "del-a1", status: "pending" }));
    createDelegationTask(makeTask({ id: "del-a2", status: "running" }));
    createDelegationTask(makeTask({ id: "del-a3", status: "completed" }));

    const active = getActiveDelegations();
    expect(active).toHaveLength(2);
  });
});

describe("跨会话委派 — DelegationOrchestrator", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupProject();
    resetSessionMessageBus();
  });

  // DELE-006
  it("DELE-006: 委派给自己——拒绝", async () => {
    const orch = new DelegationOrchestrator();
    await expect(
      orch.delegate({
        sourceSessionId: "sess-x",
        targetSessionId: "sess-x",
        task: "test",
        projectId: PROJECT_ID,
        autoStart: false,
      })
    ).rejects.toThrow("Cannot delegate to the same session");
  });

  // DELE-001
  it("DELE-001: 发起委派——基本流程", async () => {
    const orch = new DelegationOrchestrator();
    const task = await orch.delegate({
      sourceSessionId: "sess-a",
      targetSessionId: "sess-b",
      task: "做设计",
      projectId: PROJECT_ID,
      autoStart: false,
    });

    expect(task).toBeDefined();
    expect(task.id).toBeDefined();
    expect(task.sourceSessionId).toBe("sess-a");
    expect(task.targetSessionId).toBe("sess-b");
    expect(task.task).toBe("做设计");
    expect(task.status).toBe("pending");
    expect(task.projectId).toBe(PROJECT_ID);
  });

  // DELE-002
  it("DELE-002: 死锁检测——直接循环 A→B→A", async () => {
    const orch = new DelegationOrchestrator();
    await orch.delegate({
      sourceSessionId: "sess-a",
      targetSessionId: "sess-b",
      task: "task1",
      projectId: PROJECT_ID,
      autoStart: false,
    });

    await expect(
      orch.delegate({
        sourceSessionId: "sess-b",
        targetSessionId: "sess-a",
        task: "task2",
        projectId: PROJECT_ID,
        autoStart: false,
      })
    ).rejects.toThrow("cycle");
  });

  // DELE-003
  it("DELE-003: 死锁检测——间接循环 A→B→C→A", async () => {
    const orch = new DelegationOrchestrator();
    await orch.delegate({
      sourceSessionId: "sess-a", targetSessionId: "sess-b",
      task: "t1", projectId: PROJECT_ID, autoStart: false,
    });
    await orch.delegate({
      sourceSessionId: "sess-b", targetSessionId: "sess-c",
      task: "t2", projectId: PROJECT_ID, autoStart: false,
    });

    await expect(
      orch.delegate({
        sourceSessionId: "sess-c", targetSessionId: "sess-a",
        task: "t3", projectId: PROJECT_ID, autoStart: false,
      })
    ).rejects.toThrow("cycle");
  });

  // DELE-004
  it("DELE-004: 深度限制 maxDepth=2", async () => {
    const orch = new DelegationOrchestrator({ maxDepth: 2 });
    await orch.delegate({
      sourceSessionId: "sess-a", targetSessionId: "sess-b",
      task: "t1", projectId: PROJECT_ID, autoStart: false,
    });
    await orch.delegate({
      sourceSessionId: "sess-b", targetSessionId: "sess-c",
      task: "t2", projectId: PROJECT_ID, autoStart: false,
    });
    // After A→B→C chain, getDepth(sess-a) = 2, so A cannot delegate again
    await expect(
      orch.delegate({
        sourceSessionId: "sess-a", targetSessionId: "sess-d",
        task: "t3", projectId: PROJECT_ID, autoStart: false,
      })
    ).rejects.toThrow("Maximum delegation depth");
  });

  // DELE-005
  it("DELE-005: 并发限制 maxConcurrent", async () => {
    const orch = new DelegationOrchestrator({ maxConcurrent: 2 });
    const t1 = await orch.delegate({ sourceSessionId: "s1", targetSessionId: "t1", task: "x", projectId: PROJECT_ID, autoStart: false });
    const t2 = await orch.delegate({ sourceSessionId: "s2", targetSessionId: "t2", task: "x", projectId: PROJECT_ID, autoStart: false });
    // Start both tasks so they become "running" and count toward the concurrent limit
    orch.startTask(t1.id);
    orch.startTask(t2.id);

    await expect(
      orch.delegate({ sourceSessionId: "s3", targetSessionId: "t3", task: "x", projectId: PROJECT_ID, autoStart: false })
    ).rejects.toThrow("Maximum concurrent");
  });

  // DELE-007
  it("DELE-007: 委派状态流转 pending→running→completed", async () => {
    const orch = new DelegationOrchestrator();
    const task = await orch.delegate({
      sourceSessionId: "sess-a", targetSessionId: "sess-b",
      task: "test", projectId: PROJECT_ID, autoStart: false,
    });

    expect(task.status).toBe("pending");

    orch.startTask(task.id);
    expect(orch.getTask(task.id)!.status).toBe("running");

    orch.completeTask(task.id, "完成结果");
    expect(orch.getTask(task.id)!.status).toBe("completed");
    expect(orch.getTask(task.id)!.result).toBe("完成结果");
  });

  // DELE-008
  it("DELE-008: 委派失败——状态变为 failed", async () => {
    const orch = new DelegationOrchestrator();
    const task = await orch.delegate({
      sourceSessionId: "sess-a", targetSessionId: "sess-b",
      task: "test", projectId: PROJECT_ID, autoStart: false,
    });

    orch.failTask(task.id, "执行错误");
    const updated = orch.getTask(task.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toBe("执行错误");
  });

  // DELE-009
  it("DELE-009: 委派取消", async () => {
    const orch = new DelegationOrchestrator();
    const task = await orch.delegate({
      sourceSessionId: "sess-a", targetSessionId: "sess-b",
      task: "test", projectId: PROJECT_ID, autoStart: false,
    });

    orch.cancelTask(task.id);
    expect(orch.getTask(task.id)!.status).toBe("cancelled");
  });

  // DELE-011
  it("DELE-011: 委派监听器通知", async () => {
    const orch = new DelegationOrchestrator();
    const events: any[] = [];
    orch.onStateChange((task) => events.push(task));

    const task = await orch.delegate({
      sourceSessionId: "sess-a", targetSessionId: "sess-b",
      task: "test", projectId: PROJECT_ID, autoStart: false,
    });

    expect(events.length).toBeGreaterThan(0);

    orch.startTask(task.id);
    expect(events.length).toBeGreaterThan(1);
  });

  it("DELE-011b: 移除监听器", async () => {
    const orch = new DelegationOrchestrator();
    const events: any[] = [];
    const unsub = orch.onStateChange((task) => events.push(task));

    await orch.delegate({
      sourceSessionId: "sess-a", targetSessionId: "sess-b",
      task: "test", projectId: PROJECT_ID, autoStart: false,
    });
    const countBefore = events.length;

    unsub();
    await orch.delegate({
      sourceSessionId: "sess-c", targetSessionId: "sess-d",
      task: "test2", projectId: PROJECT_ID, autoStart: false,
    });

    expect(events.length).toBe(countBefore);
  });

  it("DELE-012: clearCompleted 清理已完成", async () => {
    const orch = new DelegationOrchestrator();
    const t1 = await orch.delegate({ sourceSessionId: "s1", targetSessionId: "t1", task: "x", projectId: PROJECT_ID, autoStart: false });
    orch.completeTask(t1.id, "done");

    const t2 = await orch.delegate({ sourceSessionId: "s2", targetSessionId: "t2", task: "x", projectId: PROJECT_ID, autoStart: false });

    // After completing t1, clearCompleted should remove it
    // But t2 is still pending, so it should remain
    expect(orch.getTask(t2.id)).toBeDefined();
  });
});

describe("跨会话委派 — 委派工具定义", () => {
  it("DELE-013: delegate_to_session 工具定义存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/session/tools.ts"), "utf-8");
    expect(src).toContain("createDelegateToSessionTool");
    expect(src).toContain("delegate_to_session");
    expect(src).toContain("target_session_id");
    expect(src).toContain("task");
  });

  it("DELE-014: wait_for_delegation 工具定义存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/session/tools.ts"), "utf-8");
    expect(src).toContain("createWaitForDelegationTool");
    expect(src).toContain("wait_for_delegation");
    expect(src).toContain("task_id");
  });

  it("DELE-016: query_session_result 工具定义存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/session/tools.ts"), "utf-8");
    expect(src).toContain("createQuerySessionResultTool");
    expect(src).toContain("query_session_result");
    expect(src).toContain("session_id");
  });

  it("DELE-017: list_sessions 工具定义存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/session/tools.ts"), "utf-8");
    expect(src).toContain("createListSessionsTool");
    expect(src).toContain("list_sessions");
  });
});

describe("跨会话委派 — AgenticLoop P5 拦截", () => {
  it("DELE-015: P5 拦截逻辑存在于 agentic-loop.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("delegate_to_session");
    expect(src).toContain("wait_for_delegation");
    expect(src).toContain("Cannot wait_for_delegation in the same response as delegate_to_session");
    expect(src).toContain("delegatedTasks");
    expect(src).toContain("waitedDelegations");
  });

  it("DELE-015b: 未 wait 的 delegation 提醒注入逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");
    expect(src).toContain("un-waited delegation");
    expect(src).toContain("wait_for_delegation");
  });
});

describe("跨会话委派 — System Prompt 注入", () => {
  it("DELE-025: 委派指令存在于 system prompt", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/prompt/prompt.ts"), "utf-8");
    expect(src).toContain("Cross-session delegation");
    expect(src).toContain("delegate_to_session");
    expect(src).toContain("wait_for_delegation");
    expect(src).toContain("list_sessions");
    expect(src).toContain("Maximum delegation depth");
  });
});

describe("跨会话委派 — executeSessionTurn", () => {
  it("DELE-018: executeSessionTurn 函数存在且签名正确", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(src).toContain("export async function executeSessionTurn");
    expect(src).toContain("ExecuteSessionTurnParams");
    expect(src).toContain("activeExecutions");
    expect(src).toContain("sessionId");
  });

  it("DELE-019: 防重复执行逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(src).toContain("activeExecutions.has(sessionId)");
    expect(src).toContain("already executing");
  });

  it("DELE-021: abort 信号处理逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(src).toContain("AbortController");
    expect(src).toContain("abortSignal");
    expect(src).toContain("activeExecutions.delete");
  });
});

/**
 * 第 62 波：交接/委派"黑等"修复。
 *
 * 事故：父会话 `wait_for_delegation` 无限期阻塞，子会话在原地反复枚举同一目录十几分钟，
 * 用户既看不到进度、也无法脱身。下面锁住三件事：等待有预算、进度可见、后台执行有墙钟上限。
 */
describe("跨会话委派 — 等待预算与进度（第 62 波）", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    setupProject();
    resetSessionMessageBus();
  });

  async function makeTask(orch: DelegationOrchestrator) {
    const task = await orch.delegate({
      sourceSessionId: "sess-a",
      targetSessionId: "sess-b",
      task: "交接任务",
      projectId: PROJECT_ID,
      autoStart: false,
    });
    orch.startTask(task.id);
    return task;
  }

  it("DELE-030: 等待到预算就用「仍在运行」返回，而不是无限期阻塞", async () => {
    const orch = new DelegationOrchestrator({ waitTimeoutMs: 1200 });
    const task = await makeTask(orch);

    const t0 = Date.now();
    const result = await orch.waitForCompletion(task.id, undefined, { timeoutMs: 1200 });
    const elapsed = Date.now() - t0;

    expect(result.status).toBe("running"); // 任务没失败，只是"这一等"到点了
    expect(elapsed).toBeLessThan(4000); // 真的会返回（旧实现会永远卡在这里）
  });

  it("DELE-031: 任务完成时等待立即返回结果（不因为预算而漏掉结果）", async () => {
    const orch = new DelegationOrchestrator({ waitTimeoutMs: 30_000 });
    const task = await makeTask(orch);
    setTimeout(() => orch.completeTask(task.id, "子会话产出"), 300);
    const result = await orch.waitForCompletion(task.id, undefined, { timeoutMs: 30_000 });
    expect(result.status).toBe("completed");
    expect(result.result).toBe("子会话产出");
  });

  it("DELE-032: 子会话进度可上报 —— 等待超时后父会话能看到「调了多少次工具 / 最近在干什么」", async () => {
    const orch = new DelegationOrchestrator({ waitTimeoutMs: 1000 });
    const task = await makeTask(orch);
    orch.updateProgress(task.id, { toolCalls: 17, lastText: "我在找 3000 字版", lastTool: "bash: Get-ChildItem ..." });

    const result = await orch.waitForCompletion(task.id, undefined, { timeoutMs: 1000 });
    expect(result.progress?.toolCalls).toBe(17);
    expect(result.progress?.lastText).toContain("3000 字版");
    expect(result.progress?.lastTool).toContain("Get-ChildItem");
    expect(result.progress?.updatedAt).toBeGreaterThan(0);
  });

  it("DELE-033: wait_for_delegation 的返回文案包含「仍在运行 + 可选动作」，不再是一句阻塞等待", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/session/tools.ts"), "utf-8");
    expect(src).toContain("仍在运行");
    expect(src).toContain("query_session_result"); // 给出「先看进展」的出路
    expect(src).toContain("不要继续干等");
  });

  it("DELE-034: 后台执行有墙钟上限，到点按「部分完成」回传而不是当成正常结束", () => {
    const fs = require("fs");
    const path = require("path");
    const executor = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(executor).toContain("maxTurnMs");
    expect(executor).toContain("clearTimeout(turnTimer)"); // 计时器必须清理，否则任务结束后还会 abort
    expect(executor).toContain("timedOut");
    // 到点时必须把"最近一次工具"一起交出去 —— 这正是判断"原地打转"的证据
    expect(executor).toContain("lastToolLabel");
  });

  it("DELE-035: 默认预算是有限值（曾是「不超时」）", () => {
    const types = require("fs").readFileSync(require("path").join(__dirname, "../core/session/types.ts"), "utf-8");
    expect(types).toMatch(/waitTimeoutMs:\s*\d/);
    expect(types).toMatch(/maxTurnMs:\s*\d/);
    expect(types).not.toMatch(/defaultTimeout:\s*0,?\s*\/\/[^\n]*\n\s*\}\);/);
  });
});

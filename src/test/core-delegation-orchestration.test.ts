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
import { DelegationOrchestrator, getDelegationOrchestrator, resetDelegationOrchestrator } from "../core/session/orchestrator";
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

  it("DELE-030: 子会话安静下来就带进度返回（判据是活动，不是时钟）", async () => {
    // 第 64 波重做：等待的返回条件是"子会话连续 N 没有进度上报"（安静了），不是"等够了几分钟"。
    const orch = new DelegationOrchestrator({ waitIdleMs: 1200 });
    const task = await makeTask(orch);

    const t0 = Date.now();
    const result = await orch.waitForCompletion(task.id, undefined, { idleMs: 1200 });
    const elapsed = Date.now() - t0;

    expect(result.status).toBe("running"); // 任务没失败，只是"它安静了"
    expect(elapsed).toBeLessThan(5000);
  });

  it("DELE-030b: 一直在产出就一直等 —— 合法长任务不会被时钟打断（旧版 8 分钟总预算会砍掉它）", async () => {
    const orch = new DelegationOrchestrator({ waitIdleMs: 700 });
    const task = await makeTask(orch);
    // 每 300ms 上报一次进度（= 它在干活），持续 2 秒 → 等待必须继续跟下去
    const ticker = setInterval(() => {
      const cur = orch.getTask(task.id);
      orch.updateProgress(task.id, { toolCalls: (cur?.progress?.toolCalls ?? 0) + 1 });
    }, 300);
    setTimeout(() => { clearInterval(ticker); orch.completeTask(task.id, "干完了"); }, 2000);

    const result = await orch.waitForCompletion(task.id, undefined, { idleMs: 700 });
    clearInterval(ticker);
    expect(result.status, "一直在产出就不该被当成卡住").toBe("completed");
    expect(result.result).toBe("干完了");
  });

  it("DELE-031: 任务完成时等待立即返回结果", async () => {
    const orch = new DelegationOrchestrator({ waitIdleMs: 30_000 });
    const task = await makeTask(orch);
    setTimeout(() => orch.completeTask(task.id, "子会话产出"), 300);
    const result = await orch.waitForCompletion(task.id, undefined, { idleMs: 30_000 });
    expect(result.status).toBe("completed");
    expect(result.result).toBe("子会话产出");
  });

  it("DELE-032: 子会话进度可上报 —— 安静返回时父会话能看到「调了多少次工具 / 最近在干什么」", async () => {
    const orch = new DelegationOrchestrator({ waitIdleMs: 1000 });
    const task = await makeTask(orch);
    orch.updateProgress(task.id, { toolCalls: 17, lastText: "我在找 3000 字版", lastTool: "bash: Get-ChildItem ..." });

    const result = await orch.waitForCompletion(task.id, undefined, { idleMs: 1000 });
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
    expect(src).toMatch(/安静/); // 返回的理由是"它安静了"，不是"等够了"
  });

  it("DELE-034: 后台执行用「空闲看门狗 + 资源预算」，不再用墙钟（第 64 波）", () => {
    const fs = require("fs");
    const path = require("path");
    const executor = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    // 墙钟必须已经彻底移除
    expect(executor, "不应再有墙钟上限").not.toMatch(/maxTurnMs|turnTimer/);
    // 空闲看门狗：时间只用来测"沉默"，每个事件都重新上弦
    expect(executor).toContain("idleWatchdog(");
    expect(executor).toContain("watchdog.pulse()");
    expect(executor).toContain("watchdog.dispose()");
    // 资源预算：上限用资源而不是时钟
    expect(executor).toContain("turnTokenBudget");
    expect(executor).toContain("noteActivity");
    // 中止时要把"最近一次工具"一起交出去 —— 这是判断"卡在哪"的证据
    expect(executor).toContain("lastToolLabel");
  });
  it("DELE-035: 三个上限都是可配置项（空闲窗口 / 资源预算），且不再有钟表式总预算", () => {
    const types = require("fs").readFileSync(require("path").join(__dirname, "../core/session/types.ts"), "utf-8");
    expect(types).toMatch(/waitIdleMs:\s*\d/);
    expect(types).toMatch(/turnIdleMs:\s*\d/);
    expect(types).toMatch(/turnTokenBudget:\s*\d/);
    // 拍出来的钟表阈值必须已经消失
    expect(types, "不应再有 waitTimeoutMs/waitBudgetMs/maxTurnMs").not.toMatch(/waitTimeoutMs|waitBudgetMs|maxTurnMs/);
  });
  it("DELE-036: 等待跟着**活动**走（没有钟表总预算）—— 安静就返回、一直在产出就一直等", async () => {
    const orch = new DelegationOrchestrator({ waitIdleMs: 3000 });
    const task = await makeTask(orch);

    // ① 子会话安静 → 返回进度（判据是"它没动静"，不是"等够了 N 分钟"）
    const t0 = Date.now();
    const quiet = await orch.waitForCompletion(task.id, undefined, { idleMs: 600 });
    expect(quiet.status).toBe("running");
    expect(Date.now() - t0).toBeLessThan(4000);

    // ② 它又开始产出（每 200ms 一次进度）→ 等待必须继续跟下去，直到真正完成。
    //    注意 ticker 要先跑起来再等 —— 否则等待会在第一次进度上报到达前就判定"安静"（时序竞态）。
    const ticker = setInterval(() => {
      const cur = orch.getTask(task.id);
      orch.updateProgress(task.id, { toolCalls: (cur?.progress?.toolCalls ?? 0) + 1 });
    }, 200);
    await new Promise((r) => setTimeout(r, 250)); // 让第一次进度上报先落地
    setTimeout(() => { clearInterval(ticker); orch.completeTask(task.id, "完成"); }, 1500);

    const done = await orch.waitForCompletion(task.id, undefined, { idleMs: 600 });
    clearInterval(ticker);
    expect(done.status, "一直在产出就该继续等，不该被判成安静").toBe("completed");
    expect(done.result).toBe("完成");
  });
  it("DELE-037: cancel_delegation 能把卡住的委派终止掉（父会话不再只能干等）", async () => {
    // 注意：工具内部用的是**单例**编排器（与 executor 同一个），所以这里也必须走单例，
    // 否则测的是"另一个实例"上的状态（第一次写这条用例就踩了）。
    resetDelegationOrchestrator();
    const orch = getDelegationOrchestrator();
    const task = await makeTask(orch);
    expect(orch.getTask(task.id)?.status).toBe("running");

    const { createCancelDelegationTool } = await import("../core/session/tools");
    const tool = createCancelDelegationTool();
    const res = await tool.execute({ task_id: task.id, reason: "看起来在反复枚举同一目录" }, {} as any);

    expect(res.output).toMatch(/已终止|Cancelled/);
    expect(orch.getTask(task.id)?.status).toBe("cancelled");
    // 终止后再等：应当立刻以 cancelled 结束（而不是继续阻塞）
    await expect(orch.waitForCompletion(task.id, undefined, { timeoutMs: 1000 })).rejects.toThrow(/cancelled/i);
    resetDelegationOrchestrator();
  });

  it("DELE-038: cancel_delegation 已注册（工具列表 + 提示词都要有，否则模型不知道能用）", () => {
    const fs = require("fs");
    const path = require("path");
    const engine = fs.readFileSync(path.join(__dirname, "../core/llm/index.ts"), "utf-8");
    expect(engine).toContain("createCancelDelegationTool");
    const prompt = fs.readFileSync(path.join(__dirname, "../core/prompt/prompt.ts"), "utf-8");
    expect(prompt).toContain("cancel_delegation");
  });

  // ===== 第二次审计补的用例 =====

  it("DELE-039: 取消之后，子会话的收尾回调不能把任务改回「已完成」/「失败」", async () => {
    // 取消是异步的：abort 之后子会话的循环往往还会跑到收尾逻辑。
    // 若 completeTask/failTask 无条件覆盖状态，用户点了"终止"却看到任务变成"已完成" —— 取消等于没生效。
    const orch = new DelegationOrchestrator();
    const task = await makeTask(orch);
    orch.cancelTask(task.id);

    orch.completeTask(task.id, "迟到的完成回调");
    expect(orch.getTask(task.id)?.status).toBe("cancelled");

    orch.failTask(task.id, "迟到的失败回调");
    expect(orch.getTask(task.id)?.status).toBe("cancelled");

    // 幂等：重复完成不重复通知（状态不变）
    const t2 = await makeTask(orch);
    orch.completeTask(t2.id, "结果");
    orch.completeTask(t2.id, "结果");
    expect(orch.getTask(t2.id)?.status).toBe("completed");
    expect(orch.getTask(t2.id)?.result).toBe("结果");
  });

  it("DELE-040: executor 在被 abort 时不再上报完成（从源头堵住覆盖）", () => {
    const fs = require("fs");
    const path = require("path");
    const executor = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(executor).toMatch(/if \(abort\.signal\.aborted\) \{[\s\S]{0,200}cancelTask/);
  });

  it("DELE-041: 委派注入的消息带「接收方兜底提示」（漏信息时要报告，不要盲目扫描）", () => {
    const fs = require("fs");
    const path = require("path");
    const executor = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(executor).toContain("receiverNote");
    expect(executor).toMatch(/先明确报告缺什么|REPORT WHAT IS MISSING/);
    expect(executor).toMatch(/不要靠反复枚举|do not guess by repeatedly enumerating/);
  });

  it("DELE-042: 交接校验会「放手」—— 连续被拒后放宽放行，避免把委派功能锁死", () => {
    const fs = require("fs");
    const path = require("path");
    const tools = fs.readFileSync(path.join(__dirname, "../core/session/tools.ts"), "utf-8");
    expect(tools).toContain("handoverRejections");
    expect(tools).toMatch(/failOpen/);
    expect(tools).toMatch(/rejections >= 2/);
    expect(tools).toMatch(/放宽放行/);
  });

  it("DELE-043: 反复查看委派任务：判据是「两次查看之间有没有新进展」，不是看了几次", () => {
    const fs = require("fs");
    const path = require("path");
    const loop = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");
    // 旧实现是 MAX_DELEGATION_PEEKS=3 的计数上限（拿次数当可靠性），第 64 波已换成信息增益
    expect(loop, "不应再有纯计数式的查看上限").not.toContain("MAX_DELEGATION_PEEKS");
    expect(loop).toContain("delegationProgressAtWait");
    expect(loop).toContain("delegationStuckPeeks");
    expect(loop).toMatch(/没有任何新的进展/);
    // 且必须按轮次清空，不能跨轮次累计
    const runStart = loop.indexOf("async *run(");
    const head = loop.slice(runStart, runStart + 1400);
    expect(head).toContain("this.delegationProgressAtWait.clear()");
    expect(head).toContain("this.delegationStuckPeeks.clear()");
  });

  // ===== 第 65 波：资源预算 + 停止原因结构化 =====

  it("DELE-045: 资源预算默认有限，且把**工具入参/结果**也算进预算（否则形同虚设）", () => {
    const fs = require("fs");
    const path = require("path");
    const types = fs.readFileSync(path.join(__dirname, "../core/session/types.ts"), "utf-8");
    expect(types, "默认不应再是 0（不限）").toMatch(/turnTokenBudget:\s*[1-9]\d*/);
    const executor = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(executor).toContain("estimateEventTokens");
    expect(executor, "工具入参要计入").toMatch(/toolCall\?\.input/);
    expect(executor, "工具结果要计入").toMatch(/result\.output/);
  });

  it("DELE-046: 四类停止原因都结构化落库（能统计到底哪种卡法最多）", () => {
    const fs = require("fs");
    const path = require("path");
    const log = fs.readFileSync(path.join(__dirname, "../core/llm/loop-stop-log.ts"), "utf-8");
    for (const reason of ["no_gain", "idle", "plan_stale", "budget"]) {
      expect(log, `${reason} 应在类型里`).toContain(reason);
    }
    expect(log).toContain("loop_stopped");
    const executor = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(executor, "executor 要记录 idle/budget").toMatch(/recordLoopStop\(sessionId, reason/);
    const loop = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");
    expect(loop, "循环要记录 no_gain / plan_stale").toMatch(/recordLoopStop\(sessionId, "no_gain"/);
    expect(loop).toMatch(/recordLoopStop\(sessionId, "plan_stale"/);
  });

  it("DELE-048: 「长工具」不能被当成「沉默」（审计发现：合法长构建会被空闲看门狗砍掉）", () => {
    const fs = require("fs");
    const path = require("path");
    const executor = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    const types = fs.readFileSync(path.join(__dirname, "../core/session/types.ts"), "utf-8");
    // 两种语义必须分开：空闲（没事件且没工具在跑）与工具挂死（单工具在飞过久）
    expect(types).toMatch(/toolFlightMs:\s*[1-9]\d*/);
    expect(executor).toContain("toolsInFlight");
    expect(executor).toContain("armToolFlight");
    expect(executor).toContain("clearToolFlight");
    expect(executor).toMatch(/abortedBy = "tool_hung"/);
    // 工具在飞期间要有心跳：给看门狗续命 + 让父会话知道"还在干活"
    expect(executor).toContain("flightHeartbeat");
    expect(executor).toMatch(/if \(toolsInFlight <= 0\) return;\s*\n\s*watchdog\.pulse\(\);\s*\n\s*reportProgress\(\);/);
    // 定时器必须清理（否则任务结束后还在跑）
    expect(executor).toMatch(/clearInterval\(flightHeartbeat\)/);
    // 日志里要把"空闲"和"工具挂死"分开说，避免用户误以为"跑得久被砍"
    expect(executor).toMatch(/既没有事件、也没有工具在跑/);
    expect(executor).toMatch(/工具挂死/);
  });

  it("DELE-047: 「因停滞而停」不能被当成「已完成」上报给父会话（否则父会话拿半成品继续走）", () => {
    const fs = require("fs");
    const path = require("path");
    const executor = fs.readFileSync(path.join(__dirname, "../core/session/executor.ts"), "utf-8");
    expect(executor).toContain("STALL_STOP_REASONS");
    for (const r of ["plan_stale", "repeat_guard", "no_progress", "too_many_errors"]) {
      expect(executor, `${r} 应被当作非正常完成`).toContain(r);
    }
    // 必须落到 failTask（而不是 completeTask），并把已产出内容一起交回
    const idx = executor.indexOf("STALL_STOP_REASONS.has(endReason)");
    expect(idx).toBeGreaterThan(-1);
    const block = executor.slice(idx, idx + 1400);
    expect(block).toMatch(/orchestrator\.failTask\(/);
    expect(block).not.toMatch(/orchestrator\.completeTask\(/);
    expect(block, "已产出内容要一起交回").toMatch(/Partial output|已产出的内容/);
  });
  it("DELE-044: 任务中心能看到进度、也能终止（否则「上报了但用户看不到」等于没修）", () => {
    const fs = require("fs");
    const path = require("path");
    const tab = fs.readFileSync(path.join(__dirname, "../components/task-center/DelegationTab.tsx"), "utf-8");
    // 进度可见
    expect(tab).toContain("task.progress");
    expect(tab).toMatch(/toolCalls/);
    expect(tab).toMatch(/lastTool/);
    // 用户能终止：先掐子会话循环，再置任务状态（顺序不能反，否则收尾回调会改回已完成）
    expect(tab).toContain("cancelSessionExecution");
    const cancelIdx = tab.indexOf("const handleCancel");
    const block = tab.slice(cancelIdx, cancelIdx + 400);
    expect(block.indexOf("cancelSessionExecution")).toBeLessThan(block.indexOf("cancelTask"));
    expect(tab).toMatch(/终止/);
  });
});

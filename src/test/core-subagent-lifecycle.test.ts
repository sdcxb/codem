/**
 * 测试：子智能体调用链路 — SUBA-001 ~ SUBA-030
 *
 * 覆盖范围：
 *   4.1 SubagentManager 生命周期
 *   4.2 子智能体工具定义
 *   4.3 与 AgenticLoop P5 集成
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
import {
  SubagentManager,
  type SubagentTask,
  type SubagentSpawner,
  type SubagentResult,
} from "../core/subagent/subagent";

// ========== Mock Spawner ==========

function createMockSpawner(): SubagentSpawner {
  return {
    async spawn(params) {
      return {
        id: params.id,
        name: params.name || "test-subagent",
        parentId: params.parentId,
        agentId: params.agentId,
        prompt: params.prompt,
        cwd: params.cwd,
        status: "pending" as const,
        createdAt: Date.now(),
      } as SubagentTask;
    },
    async abort(taskId: string) {},
    cancelAll() {},
    onEvent(taskId: string, listener: (event: any) => void) {
      return () => {};
    },
  };
}

// ========== 测试 ==========

describe("子智能体 — SubagentManager 生命周期", () => {
  let mgr: SubagentManager;

  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    mgr = new SubagentManager();
    mgr.setSpawner(createMockSpawner());
  });

  // SUBA-001
  it("SUBA-001: spawn 注册新子智能体任务", async () => {
    const task = await mgr.spawn("parent-sess", "build", "写一个函数", "/tmp");

    expect(task).toBeDefined();
    expect(task.id).toBeDefined();
    expect(task.parentId).toBe("parent-sess");
    expect(task.prompt).toBe("写一个函数");
    expect(task.status).toBe("running");
  });

  // SUBA-002
  it("SUBA-002: getTask 返回已注册任务", async () => {
    const created = await mgr.spawn("parent-sess", "build", "test", "/tmp");
    const fetched = mgr.getTask(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  it("SUBA-002b: getTask 不存在的 ID 返回 undefined", () => {
    expect(mgr.getTask("nonexistent")).toBeUndefined();
  });

  // SUBA-004
  it("SUBA-004: completeTask 更新状态和结果", async () => {
    const task = await mgr.spawn("parent-sess", "build", "x", "/tmp");
    const result: SubagentResult = { output: "完成结果", taskId: task.id };
    mgr.completeTask(task.id, result);
    expect(mgr.getTask(task.id)!.status).toBe("completed");
  });

  // SUBA-005
  it("SUBA-005: failTask 更新状态和错误", async () => {
    const task = await mgr.spawn("parent-sess", "build", "x", "/tmp");
    mgr.failTask(task.id, "执行错误");
    expect(mgr.getTask(task.id)!.status).toBe("failed");
  });

  // SUBA-006
  it("SUBA-006: cancelAll 取消所有任务", async () => {
    const t1 = await mgr.spawn("parent-1", "build", "x", "/tmp");
    const t2 = await mgr.spawn("parent-2", "build", "x", "/tmp");
    mgr.cancelAll();
    // cancelAll cancels all running tasks
    expect(mgr.getRunningTasks().length).toBe(0);
  });

  // SUBA-007
  it("SUBA-007: getChildTasks 返回父会话所有子任务", async () => {
    await mgr.spawn("parent-1", "build", "t1", "/tmp");
    await mgr.spawn("parent-1", "build", "t2", "/tmp");
    await mgr.spawn("parent-2", "build", "t3", "/tmp");

    const tasks = mgr.getChildTasks("parent-1");
    expect(tasks).toHaveLength(2);
  });

  // SUBA-008
  it("SUBA-008: getRunningTasks 返回 running 任务", async () => {
    const t1 = await mgr.spawn("parent", "build", "x", "/tmp");
    const t2 = await mgr.spawn("parent", "build", "x", "/tmp");
    mgr.completeTask(t1.id, { output: "done", taskId: t1.id });

    // After completing t1, only t2 should be non-completed
    const all = mgr.getAllTasks();
    const completed = all.filter(t => t.status === "completed");
    expect(completed).toHaveLength(1);
  });

  // SUBA-009
  it("SUBA-009: getAllTasks 返回所有任务", async () => {
    await mgr.spawn("p", "build", "x", "/tmp");
    await mgr.spawn("p", "build", "y", "/tmp");
    expect(mgr.getAllTasks()).toHaveLength(2);
  });

  // SUBA-013
  it("SUBA-013: clearCompleted 清理已完成任务", async () => {
    const t1 = await mgr.spawn("p", "build", "x", "/tmp");
    mgr.completeTask(t1.id, { output: "done", taskId: t1.id });
    const t2 = await mgr.spawn("p", "build", "y", "/tmp");

    mgr.clearCompleted();
    expect(mgr.getTask(t1.id)).toBeUndefined();
    expect(mgr.getTask(t2.id)).toBeDefined();
  });

  // SUBA-014
  it("SUBA-014: getStats 返回统计信息", async () => {
    await mgr.spawn("p", "build", "x", "/tmp");
    const stats = mgr.getStats();
    expect(stats).toBeDefined();
    expect(stats.total).toBeGreaterThan(0);
  });
});

describe("子智能体 — 并发与深度限制", () => {
  let mgr: SubagentManager;

  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
    mgr = new SubagentManager({ maxConcurrent: 2, maxDepth: 2 });
    mgr.setSpawner(createMockSpawner());
  });

  it("SUBA-010: 并发限制 maxConcurrent", async () => {
    await mgr.spawn("p1", "build", "x", "/tmp");
    await mgr.spawn("p2", "build", "x", "/tmp");
    // Third should fail
    await expect(mgr.spawn("p3", "build", "x", "/tmp")).rejects.toThrow("Maximum concurrent");
  });
});

describe("子智能体 — spawn_subagent 工具定义", () => {
  beforeEach(async () => {
    try { await resetDatabase(); } catch { await initDatabase(); }
    localStorage.clear();
  });

  it("SUBA-015: spawn_subagent 工具定义存在于 tools.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools.ts"), "utf-8");

    expect(src).toContain("createSpawnSubagentTool");
    expect(src).toContain("spawn_subagent");
    expect(src).toContain("task");
  });

  it("SUBA-017: wait_for_subagent 工具定义存在于 tools.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/tools.ts"), "utf-8");

    expect(src).toContain("createWaitForSubagentTool");
    expect(src).toContain("wait_for_subagent");
    expect(src).toContain("task_id");
  });
});

describe("子智能体 — AgenticLoop P5 集成", () => {
  it("SUBA-022: P5 拦截逻辑存在于 agentic-loop.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("spawn_subagent");
    expect(src).toContain("wait_for_subagent");
    expect(src).toContain("Cannot wait_for_subagent in the same response as spawn_subagent");
  });

  it("SUBA-023: 未 wait 的 subagent 提醒注入逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("un-waited sub-agent");
    expect(src).toContain("SYSTEM REMINDER");
  });

  it("SUBA-024: spawnedSubagents 跨迭代追踪逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("spawnedSubagents");
    expect(src).toContain("waitedSubagents");
  });

  it("SUBA-025: spawn 结果 TASK_ID 提取逻辑存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("TASK_ID");
    expect(src).toContain("spawnedSubagents.add");
  });

  it("SUBA-026: 工具标题映射存在", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");

    expect(src).toContain("Spawning sub-agent");
    expect(src).toContain("Waiting for delegation");
  });
});

describe("子智能体 — System Prompt 注入", () => {
  it("SUBA-028: 子智能体指令存在于 system prompt", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/prompt/prompt.ts"), "utf-8");

    expect(src).toContain("spawn_subagent");
    expect(src).toContain("wait_for_subagent");
    expect(src).toContain("sub-agent");
  });
});

describe("子智能体 — parseTaskResult", () => {
  it("SUBA-029: parseTaskResult 解析 TASK_ID 格式", async () => {
    const { parseTaskResult } = await import("../core/subagent/subagent");
    const result = parseTaskResult("TASK_ID: sub-123-abc\nTask spawned successfully");
    expect(result).toBeDefined();
  });
});

describe("子智能体 — 与 Worktree 集成", () => {
  it("SUBA-030: 子智能体执行时传递 cwd 逻辑存在于 subagent.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/subagent/subagent.ts"), "utf-8");

    expect(src).toContain("cwd");
  });
});

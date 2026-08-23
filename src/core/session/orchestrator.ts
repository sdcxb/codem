/**
 * DelegationOrchestrator — 跨会话委派编排器
 *
 * 核心职责：
 * 1. 管理委派任务的生命周期（pending → running → completed/failed/cancelled）
 * 2. 死锁检测：防止 A→B→A 循环委派（DFS 遍历依赖图）
 * 3. 深度限制：控制委派链最大深度
 * 4. 并发控制：限制同时运行的委派任务数
 *
 * 与 SubagentManager 的关系：
 * - SubagentManager 管理内部临时会话（sub-xxx）的子智能体
 * - DelegationOrchestrator 管理用户可见会话之间的委派
 * 两者分层独立，互不干扰
 *
 * 使用模式（参考 subagent.ts 的 SubagentManager）：
 *   const orch = getDelegationOrchestrator();
 *   const task = await orch.delegate({ sourceSessionId, targetSessionId, task, projectId });
 *   const result = await orch.waitForCompletion(task.id);
 */

import {
  type DelegationTask,
  type DelegationState,
  type DelegationConfig,
  DEFAULT_DELEGATION_CONFIG,
} from "./types";
import { getInboxManager } from "../inbox/inbox";
import {
  createDelegationTask,
  updateDelegationTaskStatus,
  getDelegationTask,
  getActiveDelegations,
  clearCompletedDelegations,
} from "./delegation-storage";
import { getSessionMessageBus } from "./bus";

// ========== 类型 ==========

export interface DelegateParams {
  sourceSessionId: string;
  targetSessionId: string;
  task: string;
  projectId: string;
  /** 立即开始执行（默认 true）。false 时只创建 pending 任务，由外部触发执行 */
  autoStart?: boolean;
}

export type DelegationListener = (task: DelegationTask) => void;

// ========== Orchestrator ==========

export class DelegationOrchestrator {
  private config: DelegationConfig;
  /** 内存中的任务缓存（与 DB 同步），用于快速查询和状态机操作 */
  private tasks: Map<string, DelegationTask> = new Map();
  /** 状态变更监听器 */
  private listeners: Set<DelegationListener> = new Set();
  /** 依赖图：sessionId → 它正在等待的 targetSessionIds */
  private dependencyGraph: Map<string, Set<string>> = new Map();

  constructor(config?: Partial<DelegationConfig>) {
    this.config = { ...DEFAULT_DELEGATION_CONFIG, ...config };
    // 从 DB 恢复未完成的任务到内存
    this.restoreFromDB();
  }

  // ========== 核心方法 ==========

  /**
   * 发起委派任务。
   * 会先进行死锁检测和深度/并发检查，然后创建任务并通过消息总线通知目标会话。
   */
  async delegate(params: DelegateParams): Promise<DelegationTask> {
    const { sourceSessionId, targetSessionId, task, projectId, autoStart = true } = params;

    // 1. 不允许委派给自己
    if (sourceSessionId === targetSessionId) {
      throw new Error("Cannot delegate to the same session");
    }

    // 2. 死锁检测：检查 target → ... → source 的路径是否存在
    if (this.wouldCreateCycle(sourceSessionId, targetSessionId)) {
      throw new Error(
        `Delegation cycle detected: ${sourceSessionId} → ${targetSessionId} would create a circular dependency. ` +
          "The target session is already waiting (directly or transitively) on the source session.",
      );
    }

    // 3. 深度检查
    const depth = this.getDepth(sourceSessionId);
    if (depth >= this.config.maxDepth) {
      throw new Error(`Maximum delegation depth (${this.config.maxDepth}) reached for session ${sourceSessionId}`);
    }

    // 4. 并发检查
    const running = this.getRunningTasks();
    if (running.length >= this.config.maxConcurrent) {
      throw new Error(`Maximum concurrent delegations (${this.config.maxConcurrent}) reached`);
    }

    // 5. 创建任务
    const taskId = `del-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newTask: DelegationTask = {
      id: taskId,
      sourceSessionId,
      targetSessionId,
      task,
      status: "pending",
      projectId,
      createdAt: Date.now(),
    };

    // 写 DB + 内存缓存
    createDelegationTask(newTask);
    this.tasks.set(taskId, newTask);

    // 更新依赖图：source 依赖 target
    this.addDependency(sourceSessionId, targetSessionId);

    console.log(`[DelegationOrchestrator] Delegation created: ${taskId} (${sourceSessionId} → ${targetSessionId})`);

    // 6. 通过消息总线通知目标会话
    const bus = getSessionMessageBus();
    bus.send(targetSessionId, {
      type: "delegation",
      sourceSessionId,
      targetSessionId,
      task,
      taskId,
    });

    // 7. 自动启动（由外部 executor 接管）
    if (autoStart) {
      this.startTask(taskId);
    }

    this.notifyListeners(newTask);
    return newTask;
  }

  /**
   * 将任务标记为 running。
   * 由 executor 在开始执行目标会话的 agent loop 时调用。
   */
  startTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[DelegationOrchestrator] startTask: task not found: ${taskId}`);
      return;
    }
    if (task.status !== "pending") {
      console.warn(`[DelegationOrchestrator] startTask: task ${taskId} is already ${task.status}`);
      return;
    }

    task.status = "running";
    task.startedAt = Date.now();
    this.tasks.set(taskId, task);
    updateDelegationTaskStatus(taskId, "running", { startedAt: task.startedAt });
    this.notifyListeners(task);
    console.log(`[DelegationOrchestrator] Task ${taskId} started`);
  }

  /**
   * 完成任务，回传结果。
   * 由 executor 在目标会话的 agent loop 结束后调用。
   */
  completeTask(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[DelegationOrchestrator] completeTask: task not found: ${taskId}`);
      return;
    }

    task.status = "completed";
    task.result = result;
    task.completedAt = Date.now();
    this.tasks.set(taskId, task);
    updateDelegationTaskStatus(taskId, "completed", { result, completedAt: task.completedAt });

    // 移除依赖图中的边
    this.removeDependency(task.sourceSessionId, task.targetSessionId);

    // 通过消息总线回传结果给源会话
    const bus = getSessionMessageBus();
    bus.send(task.sourceSessionId, {
      type: "result",
      sourceSessionId: task.targetSessionId,
      targetSessionId: task.sourceSessionId,
      result,
      taskId,
    });

    this.notifyListeners(task);
    console.log(`[DelegationOrchestrator] Task ${taskId} completed, result length: ${result.length}`);

    // Write to Inbox
    try {
      getInboxManager().add({
        category: "delegation",
        title: `委派任务完成: ${task.task.substring(0, 60)}`,
        body: result.substring(0, 200),
        sourceType: "delegation",
        sourceId: taskId,
        projectId: task.projectId || undefined,
        priority: "normal",
      });
    } catch (e) { console.warn('[orchestrator.ts]', e) }
  }

  /** 标记任务失败 */
  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = "failed";
    task.error = error;
    task.completedAt = Date.now();
    this.tasks.set(taskId, task);
    updateDelegationTaskStatus(taskId, "failed", { error, completedAt: task.completedAt });

    this.removeDependency(task.sourceSessionId, task.targetSessionId);

    // 通知源会话
    const bus = getSessionMessageBus();
    bus.send(task.sourceSessionId, {
      type: "result",
      sourceSessionId: task.targetSessionId,
      targetSessionId: task.sourceSessionId,
      result: `[DELEGATION FAILED] ${error}`,
      taskId,
    });

    this.notifyListeners(task);
    console.log(`[DelegationOrchestrator] Task ${taskId} failed: ${error}`);

    // Write to Inbox
    try {
      getInboxManager().add({
        category: "delegation",
        title: `委派任务失败: ${task.task.substring(0, 60)}`,
        body: error,
        sourceType: "delegation",
        sourceId: taskId,
        projectId: task.projectId || undefined,
        priority: "high",
      });
    } catch (e) { console.warn('[orchestrator.ts]', e) }
  }

  /** 取消任务 */
  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = "cancelled";
    task.completedAt = Date.now();
    this.tasks.set(taskId, task);
    updateDelegationTaskStatus(taskId, "cancelled", { completedAt: task.completedAt });

    this.removeDependency(task.sourceSessionId, task.targetSessionId);

    // 通知双方
    const bus = getSessionMessageBus();
    bus.send(task.sourceSessionId, {
      type: "cancel",
      sourceSessionId: task.sourceSessionId,
      targetSessionId: task.targetSessionId,
      taskId,
    });
    bus.send(task.targetSessionId, {
      type: "cancel",
      sourceSessionId: task.sourceSessionId,
      targetSessionId: task.targetSessionId,
      taskId,
    });

    this.notifyListeners(task);
    console.log(`[DelegationOrchestrator] Task ${taskId} cancelled`);
  }

  // ========== 查询方法 ==========

  getTask(taskId: string): DelegationTask | undefined {
    return this.tasks.get(taskId) || getDelegationTask(taskId) || undefined;
  }

  /** 获取源会话发起的所有委派 */
  getDelegationsBySource(sourceSessionId: string): DelegationTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.sourceSessionId === sourceSessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 获取目标会话接收的所有委派 */
  getDelegationsByTarget(targetSessionId: string): DelegationTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.targetSessionId === targetSessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 获取目标会话待处理的委派（pending 状态） */
  getPendingDelegationsForTarget(targetSessionId: string): DelegationTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.targetSessionId === targetSessionId && t.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 获取所有运行中的任务 */
  getRunningTasks(): DelegationTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === "running");
  }

  /** 获取统计信息 */
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      running: tasks.filter((t) => t.status === "running").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      cancelled: tasks.filter((t) => t.status === "cancelled").length,
    };
  }

  // ========== 等待完成 ==========

  /**
   * 轮询等待任务完成。参考 SubagentManager.waitForCompletion 模式。
   * 不设超时——委派任务可以运行很长时间（分钟、小时）。
   * 取消由 abort 信号处理。
   */
  async waitForCompletion(taskId: string, abortSignal?: AbortSignal): Promise<DelegationTask> {
    const checkInterval = 1000;

    while (true) {
      if (abortSignal?.aborted) {
        throw new Error("Wait cancelled (abort signal)");
      }

      const task = this.tasks.get(taskId);
      if (!task) {
        throw new Error(`Delegation task not found: ${taskId}`);
      }

      if (task.status === "completed") {
        return task;
      }

      if (task.status === "failed") {
        throw new Error(task.error || "Delegation task failed");
      }

      if (task.status === "cancelled") {
        throw new Error("Delegation task cancelled");
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
  }

  // ========== 监听器 ==========

  onStateChange(listener: DelegationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(task: DelegationTask): void {
    for (const listener of this.listeners) {
      try {
        listener(task);
      } catch (e) {
        console.error("[DelegationOrchestrator] Listener error:", e);
      }
    }
  }

  // ========== 死锁检测 ==========

  /**
   * 检查从 targetSessionId 出发，是否可以到达 sourceSessionId。
   * 如果能到达，说明 source → target 会形成环。
   * 使用 DFS 遍历依赖图。
   */
  private wouldCreateCycle(sourceSessionId: string, targetSessionId: string): boolean {
    // 如果 source 和 target 相同，直接返回 true（不允许自委派）
    if (sourceSessionId === targetSessionId) return true;

    // 从 target 出发，看能否到达 source
    const visited = new Set<string>();
    const stack: string[] = [targetSessionId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === sourceSessionId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      // current 依赖的会话
      const deps = this.dependencyGraph.get(current);
      if (deps) {
        for (const dep of deps) {
          if (!visited.has(dep)) {
            stack.push(dep);
          }
        }
      }
    }

    return false;
  }

  /**
   * 计算当前会话的委派深度。
   * 深度 = 从该会话出发的最长委派链长度。
   */
  private getDepth(sessionId: string): number {
    const deps = this.dependencyGraph.get(sessionId);
    if (!deps || deps.size === 0) return 0;

    let maxChildDepth = 0;
    for (const dep of deps) {
      const childDepth = this.getDepth(dep);
      if (childDepth > maxChildDepth) {
        maxChildDepth = childDepth;
      }
    }
    return 1 + maxChildDepth;
  }

  // ========== 依赖图操作 ==========

  private addDependency(source: string, target: string): void {
    if (!this.dependencyGraph.has(source)) {
      this.dependencyGraph.set(source, new Set());
    }
    this.dependencyGraph.get(source)!.add(target);
  }

  private removeDependency(source: string, target: string): void {
    const deps = this.dependencyGraph.get(source);
    if (deps) {
      deps.delete(target);
      if (deps.size === 0) {
        this.dependencyGraph.delete(source);
      }
    }
  }

  // ========== DB 恢复 ==========

  /**
   * 从 DB 恢复未完成的任务到内存。
   * 在构造函数中调用，确保应用重启后能继续追踪 pending/running 的委派。
   */
  private restoreFromDB(): void {
    try {
      const active = getActiveDelegations();
      for (const task of active) {
        this.tasks.set(task.id, task);
        this.addDependency(task.sourceSessionId, task.targetSessionId);

        // running 状态的任务在重启后标记为 interrupted（由调用方处理）
        if (task.status === "running") {
          console.warn(
            `[DelegationOrchestrator] Task ${task.id} was running during shutdown, marking as interrupted`,
          );
          // 不自动失败——让 executor 决定是否重试
        }
      }

      // 也加载已完成的任务（用于历史查询），但不重建依赖图
      for (const task of active) {
        // already loaded
      }

      if (active.length > 0) {
        console.log(`[DelegationOrchestrator] Restored ${active.length} active delegation(s) from DB`);
      }
    } catch (e) {
      console.error("[DelegationOrchestrator] restoreFromDB failed:", e);
    }
  }

  /** 清理已完成的任务（从内存和 DB） */
  clearCompleted(keepInDB: number = 50): void {
    for (const [id, task] of this.tasks) {
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        this.tasks.delete(id);
      }
    }
    // DB 保留最近 N 条历史
    try {
      clearCompletedDelegations(keepInDB);
    } catch (e) {
      console.error("[DelegationOrchestrator] clearCompleted failed:", e);
    }
  }
}

// ========== 单例 ==========

let orchestratorInstance: DelegationOrchestrator | null = null;

export function getDelegationOrchestrator(): DelegationOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new DelegationOrchestrator();
  }
  return orchestratorInstance;
}

/** 重置单例（仅用于测试） */
export function resetDelegationOrchestrator(): void {
  orchestratorInstance = null;
}

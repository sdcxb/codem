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
import { debugLog } from "../debug";
import {
  createDelegationTask,
  updateDelegationTaskStatus,
  getDelegationTask,
  getActiveDelegations,
  getRecentDelegations,
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

/**
 * 还没补到过历史时的重试间隔。
 *
 * 取 250ms 而不是 1s：镜像加载是**异步**的，而"第一次读"往往就发生在加载窗口里 ——
 * 重试间隔越短，用户越不容易看到"页签空着"的中间态；同时它也只是个**下限**，
 * 高频调用方（页签 1s 轮询、遥测适配器）不会被放大成风暴。
 */
const HYDRATE_RETRY_INTERVAL_MS = 250;
/** 已经补到过之后降到低频（每 30 秒兜一次，抓"别处新建的历史"） */
const HYDRATE_IDLE_INTERVAL_MS = 30_000;

// ========== Orchestrator ==========

export class DelegationOrchestrator {
  private config: DelegationConfig;
  /** 内存中的任务缓存（与 DB 同步），用于快速查询和状态机操作 */
  private tasks: Map<string, DelegationTask> = new Map();
  /** 状态变更监听器 */
  private listeners: Set<DelegationListener> = new Set();
  /** 依赖图：sessionId → 它正在等待的 targetSessionIds */
  private dependencyGraph: Map<string, Set<string>> = new Map();
  /** 上一次向存储补历史的时刻（0 = 还没补过） */
  private lastHydrateAt = 0;
  /** 是否已经成功补到过历史（决定重试频率，见 `maybeHydrateFromStorage`） */
  private hydratedOnce = false;
  /** 已上报过"被中断"的任务（避免每次补齐都往库里再写一遍失败） */
  private interruptedReported: Set<string> = new Set();

  constructor(config?: Partial<DelegationConfig>) {
    this.config = { ...DEFAULT_DELEGATION_CONFIG, ...config };
    // 从 DB 恢复未完成的任务到内存（**只是第一次尝试**；端口可能还没就绪，
    // 所以读路径上还有一层可重试的补齐，见 getAllDelegations/maybeHydrateFromStorage）
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
      /**
       * ## 第 71 轮：`running` 是**正常路径**，不该 warn
       *
       * 真机日志（用户做跨会话委派时）：
       * ```text
       * [DelegationOrchestrator] Delegation created: del-…
       * [DelegationOrchestrator] Task del-… started          ← delegate() 里的 autoStart
       * [DelegationOrchestrator] startTask: task del-… is already running   ← executor 接手时再标一次
       * ```
       * 也就是说**每次委派都会打一条**"already running"，看着像异常，其实是同一条任务
       * 被两处按设计各标记一次（`delegate()` 的 autoStart + 目标会话 executor 接手）。
       * 现在只有**终态**（completed / failed / cancelled）再标记才算异常 —— 那意味着
       * "一个已经结束的任务又被启动"，值得一条告警；`running` 走 debug 通道。
       */
      if (task.status === "running") {
        debugLog("delegation", `startTask: task ${taskId} 已在运行（重复标记，正常路径）`);
        return;
      }
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

    // 第 63 波（审计补）：已取消的任务不能又被"完成"覆盖掉。
    // 取消是异步的（abort 信号 + 事件循环），子会话的循环往往还会跑到收尾逻辑，
    // 若这里无条件改成 completed，用户点了"终止"却看到任务变成"已完成" —— 取消等于没生效。
    if (task.status === "cancelled") {
      console.warn(`[DelegationOrchestrator] completeTask: task ${taskId} 已被取消，忽略完成回调`);
      return;
    }
    if (task.status === "completed") return; // 幂等：重复完成不重复通知

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

    // 同 completeTask：已取消的任务不再被"失败"覆盖（取消是用户的明确意图，优先于收尾回调）
    if (task.status === "cancelled") {
      console.warn(`[DelegationOrchestrator] failTask: task ${taskId} 已被取消，忽略失败回调`);
      return;
    }

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

  /**
   * 获取全部委派任务（按创建时间倒序）。
   * 供「委派」页签按项目过滤展示：原先页签只能靠 source/target 会话反查，
   * 会漏掉源会话已删除的委派任务（P1-6）。
   *
   * ## 第 72 轮：读之前先**补齐历史**（这就是"重启后委派页签空着"的病根）
   *
   * 真机实测：库里 `delegation_tasks` 有 5 条（4 条今天的交接 + 1 条历史），
   * 而「委派」页签显示 `0 总计 / 0 已完成` —— 页签读的是**内存**里的 `this.tasks`，
   * 而内存里那份只在**构造函数里补过一次**（`restoreFromDB`）。
   *
   * 那一次为什么什么都没补到？`delegation_tasks` 的域镜像**不在预取清单里**
   * （`HOT_DOMAIN_TABLES`，已一并补上），而 `domainReadMany` 对"镜像没就绪"的表
   * 返回 `undefined` → `getRecentDelegations()` 吞成 `[]` → 构造函数开在端口就绪之前，
   * 于是历史**一条都没恢复**，而且**没有任何人会再试一次**（页签 1 秒轮询的也是内存）。
   *
   * 现在把补齐做成**可重试、幂等**的：每次读之前按节流窗口试着补一次，
   * 镜像一就绪（哪怕晚几秒）历史就会自己出现，不再依赖"构造函数那一刻恰好就绪"。
   */
  getAllDelegations(): DelegationTask[] {
    this.maybeHydrateFromStorage();
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 当前的委派限制（深度 / 并发 / 并发上限来源），供宿主 UI 展示真实配置而不是写死文案 */
  getLimits(): { maxDepth: number; maxConcurrent: number } {
    return { maxDepth: this.config.maxDepth, maxConcurrent: this.config.maxConcurrent };
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
   * 等待任务结束 —— **按活动而不是按时钟**（第 64 波重做）。
   *
   * 旧实现在两个极端之间摇摆：最早"不设超时"（子会话打转时父会话黑等十几分钟），
   * 后来改成"单次 3 分钟 / 累计 8 分钟"（**拍出来的钟表阈值**：合法的长任务会被打断，
   * 而阈值本身说不出"为什么是 8 分钟"）。现在改成看**子会话有没有在动**：
   *   · 任务结束 → 立刻返回结果；
   *   · 子会话连续 `waitIdleMs` 没有**任何进度上报** → 说明它安静了（卡死或停摆），
   *     带着当前进度返回，让父会话去报告/终止/继续干别的；
   *   · 一直在产出 → 就一直等，**等多久都行**（这与"它跑了 20 分钟所以要杀它"是完全不同的判据）。
   */
  async waitForCompletion(
    taskId: string,
    abortSignal?: AbortSignal,
    opts: { idleMs?: number } = {},
  ): Promise<DelegationTask> {
    const checkInterval = 1000;
    const idleMs = opts.idleMs ?? this.config.waitIdleMs ?? DEFAULT_DELEGATION_CONFIG.waitIdleMs;

    while (true) {
      if (abortSignal?.aborted) {
        throw new Error("Wait cancelled (abort signal)");
      }

      const task = this.tasks.get(taskId);
      if (!task) {
        throw new Error(`Delegation task not found: ${taskId}`);
      }

      if (task.status === "completed") return task;
      if (task.status === "failed") throw new Error(task.error || "Delegation task failed");
      if (task.status === "cancelled") throw new Error("Delegation task cancelled");

      // 活动判据：最后一次进度上报距今多久
      const lastActivity = task.progress?.updatedAt ?? task.startedAt ?? task.createdAt;
      const quietFor = Date.now() - lastActivity;
      if (idleMs > 0 && quietFor >= idleMs) {
        console.warn(
          `[DelegationOrchestrator] waitForCompletion(${taskId}) 子会话已安静 ${Math.round(quietFor / 1000)}s（无进度上报），带进度返回`,
        );
        return task;
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
  }

  /** 第 64 波：只读配置（executor 需要 turnIdleMs / turnTokenBudget） */
  getConfig(): Readonly<DelegationConfig> {
    return this.config;
  }

  /**
   * 第 62 波：子会话上报执行进度（executor 周期性调用）。
   * 用于「等待超时后父会话能知道子会话在干什么」—— 尤其是"它在反复做同一件事"。
   */
  updateProgress(
    taskId: string,
    patch: { toolCalls?: number; lastText?: string; lastTool?: string },
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const prev = task.progress;
    task.progress = {
      toolCalls: patch.toolCalls ?? prev?.toolCalls ?? 0,
      lastText: (patch.lastText ?? prev?.lastText ?? "").slice(-500),
      lastTool: patch.lastTool ?? prev?.lastTool,
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, task);
    this.notifyListeners(task);
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
    this.hydrateFromStorage();
  }

  /**
   * 从存储补齐内存里的委派任务（**幂等、可重试**）。
   *
   * @returns 这次新补进来多少条（供日志与测试断言）
   */
  hydrateFromStorage(): { activeRestored: number; historyRestored: number; interrupted: number } {
    const out = { activeRestored: 0, historyRestored: 0, interrupted: 0 };
    try {
      const active = getActiveDelegations();
      for (const task of active) {
        if (!this.tasks.has(task.id)) {
          this.tasks.set(task.id, task);
          this.addDependency(task.sourceSessionId, task.targetSessionId);
          out.activeRestored++;
        }

        /**
         * 第 83 波（审计修正）：重启后**曾经在跑**的任务不能只打一行 warn 就放着。
         *
         * 原代码写着"标记为 interrupted"，但 `DelegationState` 里根本没有这个状态，
         * 也没有任何代码写回 —— 于是任务**永远停在 running**：
         *   · 委派页签永远显示"执行中"，父会话 `wait_for_delegation` 永远等一个不会来的结果；
         *   · `getRunningTasks()` 继续把它算进并发额度（maxConcurrent=5），攒够 5 条之后
         *     **任何新委派都会被拒绝**（"Maximum concurrent delegations reached"）。
         *
         * 进程重启 ⇒ 那个后台回合不可能还在跑，事实就是"被中断"。这里如实落库为失败，
         * 并把原因写清楚，让父会话立刻拿到结论（而不是干等）。
         *
         * ⚠️ 本进程里创建的任务一定在内存里，所以"**在库里 running/pending、却不在内存里**"
         * 只可能是上一个进程留下的 —— 判据成立。`interruptedReported` 保证只落库一次。
         */
        if (
          (task.status === "running" || task.status === "pending") &&
          !this.interruptedReported.has(task.id)
        ) {
          this.interruptedReported.add(task.id);
          const reason = `委派任务在应用重启时被中断（原状态：${task.status}）—— 目标会话 ${task.targetSessionId} 的这一轮已经不可能继续。请重新发起委派，或改为直接在该会话里继续。`;
          console.warn(`[DelegationOrchestrator] ${task.id} was ${task.status} during shutdown → 标记为失败（重启后不会自己继续）`);
          try {
            this.failTask(task.id, reason);
            out.interrupted++;
          } catch (e) {
            console.warn(`[DelegationOrchestrator] 标记中断任务失败（${task.id}）:`, e);
          }
        }
      }

      // 历史记录（completed/failed/cancelled）也恢复到内存：只重建未完成任务的依赖图，
      // 但「委派」页签与概览需要看到历史与统计（原先这里是个空循环 → 重启后历史全丢）。
      for (const task of getRecentDelegations(200)) {
        if (!this.tasks.has(task.id)) {
          this.tasks.set(task.id, task);
          out.historyRestored++;
        }
      }

      if (out.activeRestored > 0) {
        console.log(`[DelegationOrchestrator] Restored ${out.activeRestored} active delegation(s) from DB`);
      }
      // 只有真的读到东西才算"补过了" —— 端口没就绪时这里全是 0，下一轮还要再试（见 maybeHydrateFromStorage）
      if (out.activeRestored > 0 || out.historyRestored > 0 || active.length > 0) {
        this.hydratedOnce = true;
      }
    } catch (e) {
      console.error("[DelegationOrchestrator] hydrateFromStorage failed:", e);
    }
    return out;
  }

  /**
   * 读路径上的**节流补齐**。
   *
   * 为什么需要"可重试"而不是"构造时补一次"：构造函数可能与存储端口就绪**赛跑**
   * （真机实测：`delegation_tasks` 5 条历史，页签显示 0 总计）。
   * 端口还没就绪时 `domainReadMany` 返回 `undefined`，存储层按契约吞成 `[]` ——
   * 后果是"空"与"没读到"在调用方看起来一模一样，而**没有任何人会再试一次**。
   *
   * 于是：读之前按窗口（默认 1 秒，与页签轮询同频）试着补一次；一旦补到东西就置
   * `hydratedOnce` 并**降到低频**（30 秒），避免每次读都去扫一遍 200 行。
   */
  private maybeHydrateFromStorage(): void {
    const now = Date.now();
    const interval = this.hydratedOnce ? HYDRATE_IDLE_INTERVAL_MS : HYDRATE_RETRY_INTERVAL_MS;
    if (now - this.lastHydrateAt < interval) return;
    this.lastHydrateAt = now;
    this.hydrateFromStorage();
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

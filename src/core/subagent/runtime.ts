/**
 * SubagentRuntime — 对标 DSH SubagentRuntime + SubagentContinuationManager
 *
 * 这是子智能体系统的核心服务，提供：
 * 1. `start()` — 一次性子智能体（foreground，等待结果后 dispose）
 * 2. `startContinuable()` — 可持续子智能体（background，返回 ID 后自动运行）
 * 3. `followup()` — 向可持续子智能体发送后续消息
 * 4. `reportFrom()` — 子智能体向父智能体汇报内容
 * 5. `interrupt()` — 中断子智能体的当前轮次
 * 6. `listChildren()` — 列出子智能体
 *
 * 核心机制 — 事件驱动 settlement 通知（对标 DSH notifySettlement）：
 * - watchSettlement 监听子智能体空闲状态
 * - 子智能体空闲且无子任务时 → 自动 dispose → notifySettlement
 * - notifySettlement 构造通知消息，通过 inbox 注入父智能体
 * - 父智能体在下一轮 LLM 调用中自然看到通知，无需轮询
 */

import type {
  SubagentProvider,
  SubagentRun,
  SubagentResult,
  SubagentStopReason,
  ContinuableStartSpec,
  ContinuableStart,
  SubagentStartRequest,
  SubagentReportOptions,
  SubagentFollowupOptions,
  SubagentInterruptAuthority,
  SubagentListEntry,
} from './runtime-types';

import type { LLMEngine } from '../llm';
import * as MessageStorage from '../storage/message';
import { getLang } from '../i18n/lang';
import { parseTaskResult, type SubagentTask, type SubagentActivity } from './subagent';

// ========== 活化状态 ==========

type ActivationState = 'running' | 'waiting' | 'settled';

interface Activation {
  /** 持久子智能体 ID */
  readonly childId: string;
  /** 父会话 ID */
  readonly parentSession: string;
  /** provider 名 */
  readonly provider: string;
  /** 子智能体的 AbortController */
  readonly abort: AbortController;
  /** 子智能体任务数据（兼容旧 SubagentTask） */
  task: SubagentTask;
  /** 子智能体的 owned children — 非空时不 settle */
  readonly ownedChildren: Set<string>;
  /** 是否已通知父智能体 */
  announced: boolean;
  /** 是否已处置 */
  disposed: boolean;
  /** settlement watcher 的 poke Promise */
  poke: PromiseWithResolvers<void>;
  /**
   * DSH-style whenIdle() — 当前轮次执行完成的 Promise
   * 对标 DSH agent.whenIdle()：executeContinuable/executeContinuableTurn
   * 完成时 resolve，无需 setTimeout 轮询。
   */
  executionDone: Promise<void>;
  /** executionDone 的 resolver */
  executionResolver: () => void;
  /** 最终结果 */
  result?: SubagentResult;
  /** 汇报回调列表 */
  reportCallbacks: Array<(content: string, delivery: 'quiet' | 'wakeup') => void>;
}

function generateId(): string {
  return `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
}

/**
 * 生成 settlement 通知摘要 — 对标 DSH settlementSummary()
 */
function settlementSummary(childId: string, stopReason: SubagentStopReason): string {
  const zh = getLang() === 'zh';
  const subject = zh ? `后台子智能体 ${childId}` : `Background subagent ${childId}`;
  switch (stopReason) {
    case 'completed':
      return zh
        ? `${subject} 已完成，除非你再发送新消息，否则它不会再工作。`
        : `${subject} finished and will do no further work unless you send it more.`;
    case 'aborted':
      return zh ? `${subject} 在完成前被停止。` : `${subject} was stopped before it finished.`;
    case 'max-tokens':
      return zh ? `${subject} 在完成前耗尽了 token 限制。` : `${subject} ran out of room before it finished.`;
    case 'refusal':
      return zh ? `${subject} 拒绝了任务。` : `${subject} declined the task.`;
    case 'error':
      return zh ? `${subject} 在完成前发生错误。` : `${subject} failed before it finished.`;
    default:
      return zh ? `${subject} 异常结束 (${String(stopReason)})。` : `${subject} ended abnormally (${String(stopReason)}) before it finished.`;
  }
}

/**
 * SubagentRuntime — 子智能体运行时服务
 *
 * 对标 DSH 的 SubagentRuntime + SubagentContinuationManager 合体。
 * 因为我们的项目不需要 Cordis 框架的 DI 体系，所以将 DSH 的两层合为一层。
 */
type SubagentChangeListener = () => void;

export class SubagentRuntime {
  private providers = new Map<string, SubagentProvider>();
  private activations = new Map<string, Activation>();
  private draining = false;
  private listeners = new Set<SubagentChangeListener>();

  constructor(private engine: LLMEngine) {}

  // ========== Event Emitter — DSH-style 事件驱动 ==========

  /** 订阅子智能体状态变更 — UI 组件通过此方法替代 setInterval 轮询 */
  subscribe(listener: SubagentChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 通知所有订阅者状态已变更 */
  private notifyChanged(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (e) { /* ignore */ }
    }
  }

  // ========== Provider 注册 ==========

  registerProvider(provider: SubagentProvider): () => void {
    this.providers.set(provider.name, provider);
    return () => {
      this.providers.delete(provider.name);
    };
  }

  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  // ========== 一次性子智能体 (foreground) ==========

  /**
   * 建立一个一次性子智能体 — 对标 DSH SubagentRuntime.start()
   * 调用方获得 run 句柄，await run.result 获取结果后 dispose。
   */
  async start(providerName: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.expectProvider(providerName);
    return provider.start(request);
  }

  // ========== 内部状态变更通知 ==========

  /** 标记 task 状态已变更，通知 UI 订阅者 */
  private touchTask(activation: Activation): void {
    this.syncTask(activation);
    this.notifyChanged();
  }

  // ========== 可持续子智能体 (background/continuable) ==========

  /**
   * 建立一个可持续后台子智能体 — 对标 DSH startContinuable()
   *
   * 立即返回 childId（不等子智能体完成）。
   * 子智能体的生命周期完全由 runtime 管理：
   * - watchSettlement 监听空闲
   * - 空闲后自动 dispose
   * - notifySettlement 向父智能体 inbox 注入通知
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    const provider = this.expectProvider(spec.provider);
    if (provider.prepareContinuable === undefined) {
      throw new Error(`Provider "${spec.provider}" does not support continuable children`);
    }

    const childId = generateId();
    const messageId = generateMessageId();

    // 准备子智能体
    await provider.prepareContinuable({
      sessionId: childId,
      parentSessionId: spec.request.parentSessionId,
      signal: spec.signal,
    });

    // 创建 Activation
    const abort = new AbortController();
    const task: SubagentTask = {
      id: childId,
      name: spec.label,
      parentId: spec.request.parentSessionId,
      agentId: spec.request.agentId || 'general',
      prompt: spec.request.prompt,
      cwd: spec.request.cwd,
      status: 'pending',
      persistent: true,
      createdAt: Date.now(),
      activities: [],
      profile_id: spec.request.profileId,
    };

    const execResolvers = Promise.withResolvers<void>();
    const activation: Activation = {
      childId,
      parentSession: spec.request.parentSessionId,
      provider: spec.provider,
      abort,
      task,
      ownedChildren: new Set(),
      announced: true, // settlement 通知在 dispose 时自动发送
      disposed: false,
      poke: Promise.withResolvers<void>(),
      executionDone: execResolvers.promise,
      executionResolver: execResolvers.resolve,
      reportCallbacks: [],
    };

    this.activations.set(childId, activation);

    // UI 通过 getSubagentRuntime().getTask() 直接读取
    this.touchTask(activation);

    // 异步执行子智能体 — 不阻塞返回
    this.executeContinuable(activation, spec.request).catch(err => {
      console.error(`[SubagentRuntime] Continuable child ${childId} failed:`, err);
    });

    // 启动 settlement watcher — 对标 DSH watchSettlement
    this.watchSettlement(activation);

    return { childId, messageId };
  }

  /**
   * 向可持续子智能体发送后续消息 — 对标 DSH followup()
   */
  async followup(
    parentSessionId: string,
    childId: string,
    message: string,
    options: SubagentFollowupOptions,
  ): Promise<string> {
    const activation = this.activations.get(childId);
    if (activation === undefined) {
      throw new Error(`Subagent "${childId}" is not live or has settled`);
    }
    if (activation.parentSession !== parentSessionId) {
      throw new Error(`Subagent "${childId}" belongs to another parent session`);
    }
    // 如果已 disposed（settlement watcher 已标记），re-activate
    // 对标 DSH 的可恢复子智能体 — settled 后仍可通过 followup 重启
    if (activation.disposed) {
      activation.disposed = false;
      const reResolvers = Promise.withResolvers<void>();
      activation.executionDone = reResolvers.promise;
      activation.executionResolver = reResolvers.resolve;
      activation.announced = true; // settlement 通知在下次 dispose 时再发
      this.activations.set(activation.childId, activation);
      this.watchSettlement(activation);
      console.log(`[SubagentRuntime] Re-activated disposed child ${activation.childId} for followup`);
    }

    // 生成确认 ID — 实际的 DB 消息 ID 由 processSubagent 内部生成
    const messageId = `followup-${activation.childId}-${Date.now()}`;

    // 注意：不再在此处写入 user message — processSubagent 内部已经处理了
    // 用户消息的持久化（MessageStorage.createMessage），此处重复写入会导致
    // 同一 session 中出现两条重复的 user message。

    // 唤醒 settlement watcher
    activation.poke.resolve();
    activation.poke = Promise.withResolvers<void>();

    // 重新执行子智能体的下一轮
    this.executeContinuableTurn(activation, message, options.signal).catch(err => {
      console.error(`[SubagentRuntime] Followup to ${childId} failed:`, err);
    });

    this.notifyChanged();
    return messageId;
  }

  /**
   * 中断子智能体的当前轮次 — 对标 DSH interrupt()
   */
  interrupt(targetSessionId: string, authority: SubagentInterruptAuthority): void {
    if (authority.kind === 'ancestor' && authority.callerSessionId === targetSessionId) {
      throw new Error('Agent cannot interrupt itself');
    }
    const activation = this.activations.get(targetSessionId);
    if (activation === undefined) return; // 不存在的 target 是 no-op
    if (activation.disposed) return;

    if (authority.kind === 'user') {
      if (activation.parentSession !== authority.parentSessionId) {
        throw new Error(`Subagent "${targetSessionId}" belongs to another parent session`);
      }
    } else {
      // ancestor 权限检查 — 在简化版中只检查 caller 是 parent
      if (activation.parentSession !== authority.callerSessionId) {
        throw new Error(`Subagent "${targetSessionId}" is not a descendant of "${authority.callerSessionId}"`);
      }
    }

    activation.abort.abort({ kind: 'parent' } as any);
  }

  /**
   * 子智能体向父智能体汇报 — 对标 DSH reportFrom()
   *
   * 这是 DSH 的核心机制：子智能体通过 report 工具主动向父推送内容。
   * 父智能体在下一轮 LLM 调用中自然看到汇报内容。
   */
  async reportFrom(
    childId: string,
    content: string,
    options: SubagentReportOptions,
  ): Promise<string> {
    const activation = this.activations.get(childId);
    if (activation === undefined) {
      throw new Error(`Agent "${childId}" is not a live continuable subagent and cannot report`);
    }
    if (activation.disposed) {
      throw new Error(`Subagent "${childId}" is being disposed; the report was not delivered`);
    }

    return this.deliverReport(activation, content, options.delivery);
  }

  /**
   * 列出子智能体 — 对标 DSH listChildren()
   */
  listChildren(parentSessionId: string): SubagentListEntry[] {
    const entries: SubagentListEntry[] = [];
    for (const activation of this.activations.values()) {
      if (activation.parentSession === parentSessionId) {
        entries.push({
          id: activation.childId,
          label: activation.task.name,
          status: activation.disposed ? 'ready' : (activation.task.status === 'running' ? 'running' : 'idle'),
          agentId: activation.task.agentId,
        });
      }
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 获取子智能体任务数据（兼容旧接口）
   */
  getTask(childId: string): SubagentTask | undefined {
    return this.activations.get(childId)?.task;
  }

  /**
   * DSH-style: 等待子智能体完成当前执行 — 对标 agent.whenIdle()
   * 公开接口，供 workflow 和 UI 使用。
   */
  async waitForTask(childId: string): Promise<void> {
    const activation = this.activations.get(childId);
    if (!activation) return;
    await activation.executionDone;
  }

  /**
   * 获取所有子智能体任务（兼容旧接口）
   */
  getAllTasks(): SubagentTask[] {
    return Array.from(this.activations.values()).map(a => a.task);
  }

  // ========== 内部实现 — Activity 追踪 (P3) ==========

  /** 添加活动到 task */
  private addActivity(activation: Activation, activity: SubagentActivity): void {
    if (!activation.task.activities) activation.task.activities = [];
    activation.task.activities.push(activity);
  }

  /** 标记所有运行中的活动为完成 */
  private completeRunningActivities(activation: Activation): void {
    if (!activation.task.activities) return;
    for (const a of activation.task.activities) {
      if (a.status === 'running') {
        a.status = 'done';
        a.completedAt = Date.now();
      }
    }
  }

  /** 标记最近的运行中工具活动为完成 */
  private completeLastToolActivity(activation: Activation): void {
    if (!activation.task.activities) return;
    const lastTool = [...activation.task.activities].reverse().find(a => a.type === 'tool' && a.status === 'running');
    if (lastTool) {
      lastTool.status = 'done';
      lastTool.completedAt = Date.now();
    }
  }

  /** 工具名 → 友好标签 */
  private getToolLabel(toolName: string): string {
    const zh = getLang() === 'zh';
    const titleMap: Record<string, string> = {
      read_file: zh ? '读取文件' : 'read_file',
      write_file: zh ? '写入文件' : 'write_file',
      edit_file: zh ? '编辑文件' : 'edit_file',
      multi_edit_file: zh ? '编辑文件' : 'multi_edit_file',
      list_directory: zh ? '列出目录' : 'list_directory',
      list_dir: zh ? '列出目录' : 'list_dir',
      search_code: zh ? '搜索代码' : 'search_code',
      grep_search: zh ? '搜索代码' : 'grep_search',
      codebase_search: zh ? '搜索代码库' : 'codebase_search',
      run_terminal_command: zh ? '运行命令' : 'run_command',
      run_test: zh ? '运行测试' : 'run_test',
      web_fetch: zh ? '获取网页' : 'web_fetch',
      bash: zh ? '执行命令' : 'bash',
      read: zh ? '读取文件' : 'read',
      write: zh ? '写入文件' : 'write',
      edit: zh ? '编辑文件' : 'edit',
      multiedit: zh ? '编辑文件' : 'multiedit',
      glob: zh ? '搜索文件' : 'glob',
      grep: zh ? '搜索内容' : 'grep',
      subagent: zh ? '委派子智能体' : 'subagent',
      report: zh ? '汇报' : 'report',
      send_message: zh ? '发送消息' : 'send_message',
      interrupt_agent: zh ? '中断智能体' : 'interrupt_agent',
      list_agents: zh ? '列出智能体' : 'list_agents',
    };
    return titleMap[toolName] || toolName;
  }

  /**
   * @deprecated 旧桥接方法 — UI 已迁移到 getSubagentRuntime() 直接读取。
   * 保留为空操作以避免大量调用点修改，后续可批量移除。
   */
  private syncTask(_activation: Activation): void {
    // No-op — UI 组件通过 getSubagentRuntime().getAllTasks() 直接读取状态
  }

  // ========== 内部实现 ==========

  /**
   * 执行可持续子智能体 — 第一轮
   */
  private async executeContinuable(
    activation: Activation,
    request: { prompt: string; cwd: string; agentId?: string; profileId?: string },
  ): Promise<void> {
    activation.task.status = 'running';
    activation.task.startedAt = Date.now();
    this.touchTask(activation);

    try {
      // sessionId 直接使用 childId — childId 已含 sub- 前缀且全局唯一
      let output = '';
      let toolResults: string[] = [];
      let hasRunningThinking = false;

      for await (const event of this.engine.processSubagent(
        activation.childId,
        request.prompt,
        request.cwd,
        activation.task.agentId,
        activation.task.profile_id,
      )) {
        if (activation.abort.signal.aborted) {
          activation.task.status = 'cancelled';
          activation.task.completedAt = Date.now();
          this.completeRunningActivities(activation);
          this.touchTask(activation);
          return;
        }
        // 捕获事件
        if (event.type === 'text_delta') {
          output += event.text;
          if (hasRunningThinking) {
            this.completeRunningActivities(activation);
            hasRunningThinking = false;
          }
        }
        // 追踪推理活动
        if (event.type === 'reasoning_delta') {
          if (!hasRunningThinking) {
            this.addActivity(activation, {
              id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
              type: 'thinking',
              label: getLang() === 'zh' ? '思考' : 'Thinking',
              status: 'running',
              startedAt: Date.now(),
            });
            hasRunningThinking = true;
          }
        }
        // 追踪工具活动
        if (event.type === 'tool_start') {
          if (hasRunningThinking) {
            this.completeRunningActivities(activation);
            hasRunningThinking = false;
          }
          this.addActivity(activation, {
            id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            type: 'tool',
            label: this.getToolLabel(event.toolCall.name),
            status: 'running',
            startedAt: Date.now(),
          });
          this.touchTask(activation);
        }
        if (event.type === 'tool_complete' && event.result) {
          const toolOutput = typeof event.result === 'string' ? event.result : (event.result as any).output || '';
          // 防注入：使用 sanitizeSubagentOutput 净化工具结果
          const cleanToolOutput = sanitizeSubagentOutput(toolOutput);
          if (cleanToolOutput) {
            toolResults.push(cleanToolOutput);
          }
          // 标记最近的运行中工具活动为完成
          this.completeLastToolActivity(activation);
          this.touchTask(activation);
        }
        if (event.type === 'tool_error') {
          this.completeLastToolActivity(activation);
          this.touchTask(activation);
        }
        // 新迭代开始时完成所有运行中的活动
        if (event.type === 'start' && (event as any).iteration > 1) {
          this.completeRunningActivities(activation);
          hasRunningThinking = false;
        }
        if (event.type === 'end') {
          this.completeRunningActivities(activation);
          hasRunningThinking = false;
        }
      }

      // 防注入：使用 sanitizeSubagentOutput 净化子智能体输出
      output = sanitizeSubagentOutput(output);

      // 构建结果
      const fullOutput = toolResults.length > 0
        ? output + '\n\n' + (getLang() === 'zh' ? '[工具结果]' : '[Tool Results]') + '\n' + toolResults.join('\n---\n')
        : output;

      const result = parseTaskResult(fullOutput);
      activation.result = {
        output: result.output,
        stopReason: 'completed',
        filesTouched: result.filesTouched,
        summary: result.summary,
      };
      activation.task.status = 'completed';
      activation.task.completedAt = Date.now();
      activation.task.result = result;
      this.completeRunningActivities(activation);
    } catch (err: any) {
      activation.task.status = 'failed';
      activation.task.error = err.message;
      activation.task.completedAt = Date.now();
      activation.result = {
        output: '',
        stopReason: 'error',
        filesTouched: [],
        summary: err.message,
      };
      this.completeRunningActivities(activation);
    }

    this.touchTask(activation);

    // DSH-style: resolve whenIdle() Promise，通知 settlement watcher 轮次完成
    activation.executionResolver();

    // 唤醒 settlement watcher
    activation.poke.resolve();
    activation.poke = Promise.withResolvers<void>();
  }

  /**
   * 执行可持续子智能体的后续轮次
   */
  private async executeContinuableTurn(
    activation: Activation,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    // followup() 已处理 re-activation 逻辑，此处只需执行
    activation.task.status = 'running';
    this.touchTask(activation);

    try {
      // sessionId 直接使用 childId — 不再叠加额外前缀
      let output = '';
      let toolResults: string[] = [];
      let hasRunningThinking = false;

for await (const event of this.engine.processSubagent(
activation.childId,
message,
activation.task.cwd,
activation.task.agentId,
activation.task.profile_id,
)) {
        if (activation.abort.signal.aborted || signal.aborted) {
          activation.task.status = 'cancelled';
          activation.task.completedAt = Date.now();
          this.completeRunningActivities(activation);
          this.touchTask(activation);
          return;
        }
        if (event.type === 'text_delta') {
          output += event.text;
          if (hasRunningThinking) {
            this.completeRunningActivities(activation);
            hasRunningThinking = false;
          }
        }
        if (event.type === 'reasoning_delta') {
          if (!hasRunningThinking) {
            this.addActivity(activation, {
              id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
              type: 'thinking',
              label: getLang() === 'zh' ? '思考' : 'Thinking',
              status: 'running',
              startedAt: Date.now(),
            });
            hasRunningThinking = true;
          }
        }
        if (event.type === 'tool_start') {
          if (hasRunningThinking) {
            this.completeRunningActivities(activation);
            hasRunningThinking = false;
          }
          this.addActivity(activation, {
            id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            type: 'tool',
            label: this.getToolLabel(event.toolCall.name),
            status: 'running',
            startedAt: Date.now(),
          });
          this.touchTask(activation);
        }
        if (event.type === 'tool_complete' && event.result) {
          const toolOutput = typeof event.result === 'string' ? event.result : (event.result as any).output || '';
          // 防注入：过滤 <system-reminder> 标签
          const cleanToolOutput = sanitizeSubagentOutput(toolOutput);
          if (cleanToolOutput) {
            toolResults.push(cleanToolOutput);
          }
          this.completeLastToolActivity(activation);
          this.touchTask(activation);
        }
        if (event.type === 'tool_error') {
          this.completeLastToolActivity(activation);
          this.touchTask(activation);
        }
        if (event.type === 'start' && (event as any).iteration > 1) {
          this.completeRunningActivities(activation);
          hasRunningThinking = false;
        }
        if (event.type === 'end') {
          this.completeRunningActivities(activation);
          hasRunningThinking = false;
        }
      }

      // 防注入：从子智能体文本输出中过滤 <system-reminder> 标签
      output = sanitizeSubagentOutput(output);

      const fullOutput = toolResults.length > 0
        ? output + '\n\n' + (getLang() === 'zh' ? '[工具结果]' : '[Tool Results]') + '\n' + toolResults.join('\n---\n')
        : output;

      const result = parseTaskResult(fullOutput);
      activation.result = {
        output: result.output,
        stopReason: 'completed',
        filesTouched: result.filesTouched,
        summary: result.summary,
      };
      activation.task.status = 'completed';
      activation.task.completedAt = Date.now();
      activation.task.result = result;
      this.completeRunningActivities(activation);
    } catch (err: any) {
      activation.task.status = 'failed';
      activation.task.error = err.message;
      activation.task.completedAt = Date.now();
      activation.result = {
        output: '',
        stopReason: 'error',
        filesTouched: [],
        summary: err.message,
      };
      this.completeRunningActivities(activation);
    }

    this.touchTask(activation);

    // DSH-style: resolve whenIdle() Promise，通知 settlement watcher 轮次完成
    // 创建新的 executionDone 供后续轮次使用
    const prevResolver = activation.executionResolver;
    const newResolvers = Promise.withResolvers<void>();
    activation.executionDone = newResolvers.promise;
    activation.executionResolver = newResolvers.resolve;
    prevResolver();

    // 唤醒 settlement watcher
    activation.poke.resolve();
    activation.poke = Promise.withResolvers<void>();
  }

  /**
   * settlement watcher — 对标 DSH watchSettlement()
   *
   * 持续监听子智能体状态：
   * - running → 等待
   * - waiting（idle 但有 owned children） → 等待
   * - settled（idle 且无 owned children） → dispose + notifySettlement
   */
  private watchSettlement(activation: Activation): void {
    void (async () => {
      while (!activation.disposed) {
        // 等待子智能体空闲或 poke
        await Promise.race([
          this.waitForTaskIdle(activation),
          activation.poke.promise,
        ]);

        if (activation.disposed) return;

        // 检查 settlement 状态
        const state = this.stateOf(activation);
        if (state !== 'settled') {
          // 仍然在运行或等待 — 重新观察
          continue;
        }

        // settled — 开始处置
        await this.dispose(activation);
        return;
      }
    })().catch(err => {
      console.error(`[SubagentRuntime] Settlement watcher for ${activation.childId} failed:`, err);
    });
  }

  /**
   * DSH-style: 等待子智能体空闲 — 对标 agent.whenIdle()
   * 不再使用 setTimeout 轮询，直接 await executionDone Promise
   */
  private waitForTaskIdle(activation: Activation): Promise<void> {
    return activation.executionDone;
  }

  /**
   * 推导活化状态 — 对标 DSH stateOf()
   * 注意：'pending' 状态（尚未开始执行）应视为 'running'，
   * 否则 settlement watcher 会在子智能体启动前就认为它已 settled。
   */
  private stateOf(activation: Activation): ActivationState {
    if (activation.task.status === 'running' || activation.task.status === 'pending') return 'running';
    if (activation.ownedChildren.size > 0) return 'waiting';
    return 'settled';
  }

  /**
   * 处置一个 Activation — 对标 DSH dispose()
   */
  private async dispose(activation: Activation): Promise<void> {
    if (activation.disposed) return;
    activation.disposed = true;

    // 取消子智能体
    if (activation.task.status === 'running') {
      activation.abort.abort({ kind: 'parent' } as any);
    }

    // 向父智能体发送 settlement 通知 — 对标 DSH notifySettlement()
    // 通知写入 DB 后，下一轮 buildMessages 自然看到
    this.notifySettlement(activation);

    // DSH-style: resolve settlement Promise，唤醒正在 await 的父 agentic-loop
    // 替代旧的轮询检查 + 消息注入机制
    this.resolveSettlementGate(activation);

    // UI 通过 getSubagentRuntime() 直接读取最终状态
    this.touchTask(activation);

    // 注意：不从 activations 中删除 — 保留 disposed activation 以供
    // followup() re-activate（对标 DSH 的可恢复子智能体）。
    // 只有 drain() 或定期清理才会真正移除。
  }

  /**
   * DSH-style: resolve 父 agentic-loop 的 settlement gate
   * 对标 DSH 的 parent.followup(message) / parent.steer(message) —
   * DSH 通过 inbox 注入唤醒父 driver；我们通过 resolve Promise 唤醒父循环。
   */
  private resolveSettlementGate(activation: Activation): void {
    try {
      // 通过 engine 获取父会话的 agentic-loop
      // agentId 传 undefined — 如果 loop 已存在于 pool 中（正常情况）会直接返回，
      // 不会创建新 loop；仅在父 loop 已被清理时才使用默认 agent 创建新的
      const parentSession = activation.parentSession;
      const loop = (this.engine as any).getAgenticLoop?.(undefined, parentSession) as any;
      if (loop?.resolveSubagentSettlement) {
        loop.resolveSubagentSettlement(activation.childId);
      }
    } catch (e) {
      // 非致命 — 父循环可能已结束
    }
  }

  /**
   * 向父智能体发送 settlement 通知 — 对标 DSH notifySettlement()
   *
   * 这是核心机制：子智能体完成后，runtime 自动构造通知消息，
   * 注入父智能体的 inbox（作为 user message），父智能体在下一轮
   * LLM 调用中自然看到通知。无需轮询，无需 wait_for。
   */
  private notifySettlement(activation: Activation): void {
    if (!activation.announced) return;

    try {
      const stopReason = activation.result?.stopReason ?? (activation.task.status === 'failed' ? 'error' : 'completed');
      const summary = settlementSummary(activation.childId, stopReason);

      const zh = getLang() === 'zh';
      // 防注入：对子智能体输出做二次净化 — 即使 executeContinuable 已过滤，
      // settlement 通知注入父上下文前再次确保无 <system-reminder> 标签
      const rawOutput = activation.result
        ? activation.result.output
        : (zh ? '没有留下结束消息。' : 'It left no closing message.');
      const closingMessage = sanitizeSubagentOutput(rawOutput);

      const prefix = zh ? '[子智能体完成通知]' : '[SUBAGENT SETTLEMENT NOTICE]';
      const notification = `${prefix}\n${summary}\n${zh ? '结束消息:' : 'Its closing message:'}\n${closingMessage}`;

      // 将通知注入父会话的 inbox（作为 user message）
      const parentSessionId = activation.parentSession;
      const messageId = `settlement-${activation.childId}-${Date.now()}`;

      MessageStorage.createMessage({
        id: messageId,
        role: 'user',
        content: notification,
        timestamp: Date.now(),
        status: 'done',
      }, parentSessionId);

      console.log(`[SubagentRuntime] Settlement notice delivered to parent ${parentSessionId} for child ${activation.childId}`);
    } catch (err) {
      console.error(`[SubagentRuntime] Failed to deliver settlement notice for ${activation.childId}:`, err);
    }
  }

  /**
   * 投递子智能体汇报 — 对标 DSH deliverReport()
   */
  private deliverReport(
    activation: Activation,
    content: string,
    delivery: 'quiet' | 'wakeup',
  ): string {
    const zh = getLang() === 'zh';
    const messageId = `report-${activation.childId}-${Date.now()}`;
    const prefix = zh ? '[子智能体汇报]' : '[SUBAGENT REPORT]';
    // 防注入：对子智能体汇报内容做净化 — 防止通过 report 工具注入伪造系统提示词
    const sanitizedContent = sanitizeSubagentOutput(content);
    const notification = `${prefix}\n${zh ? '后台子智能体' : 'Background subagent'} ${activation.childId} ${zh ? '汇报:' : 'reported:'}\n${sanitizedContent}`;

    // 将汇报注入父会话的 inbox
    MessageStorage.createMessage({
      id: messageId,
      role: 'user',
      content: notification,
      timestamp: Date.now(),
      status: 'done',
    }, activation.parentSession);

    if (delivery === 'wakeup') {
      // wakeup: 尝试触发父智能体的下一轮
      // 在我们的架构中，inbox 注入本身就是足够的唤醒机制，
      // 因为 agentic-loop 在下一轮迭代时会读取所有未处理的 user messages
      console.log(`[SubagentRuntime] Report (wakeup) delivered to parent ${activation.parentSession} from child ${activation.childId}`);
    } else {
      console.log(`[SubagentRuntime] Report (quiet) delivered to parent ${activation.parentSession} from child ${activation.childId}`);
    }

    return messageId;
  }

  /** 查找 provider 或抛出 */
  private expectProvider(name: string): SubagentProvider {
    const provider = this.providers.get(name);
    if (provider === undefined) {
      throw new Error(`No subagent provider registered for "${name}"`);
    }
    return provider;
  }

  /**
   * 排空所有子智能体 — 对标 DSH drain()
   */
  async drain(): Promise<void> {
    this.draining = true;
    const activations = [...this.activations.values()];
    await Promise.all(activations.map(a => this.dispose(a)));
    // drain 后真正清理所有 activations — 对标 DSH host teardown
    this.activations.clear();
    this.draining = false;
  }

  get isDraining(): boolean {
    return this.draining;
  }
}

// ========== 防注入工具函数 ==========

/**
 * 子智能体输出净化 — 对标旧 spawner.ts 的多层过滤策略
 *
 * 1. <system-reminder> 标签剥离：
 *    子智能体可能读取到包含伪造系统提示词的文件内容，
 *    这些标签不能原样传递到父智能体上下文。
 *
 * 2. BOM 字符清理：
 *    UTF-8 BOM (\\uFEFF) 可能导致 LLM 解析异常。
 *
 * 3. 零宽字符清理：
 *    零宽空格 (\\u200B)、零宽连接符 (\\u200D) 等不可见字符
 *    可能被用于注入攻击或导致编码混乱。
 *
 * 4. 控制字符清理：
 *    除 \\n \\r \\t 外的控制字符可能导致解析异常。
 */
export function sanitizeSubagentOutput(text: string): string {
  if (!text) return '';

  return text
    // 1. 剥离 <system-reminder> 标签 — 防止注入伪造系统提示词
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    // 2. 剥离 BOM 字符
    .replace(/\uFEFF/g, '')
    // 3. 剥离零宽字符 — 不可见但可能影响解析
    .replace(/[\u200B\u200C\u200D\u200E\u200F\u2028\u2029]/g, '')
    // 4. 剥离其他控制字符（保留 \n \r \t）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

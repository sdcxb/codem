/**
 * Subagent Runtime Types — 对标 DSH @deepseek-ai/dsh-subagent/types.ts
 *
 * 定义子智能体运行时的所有接口契约：请求、结果、能力、Provider、Run。
 * 这是整个子智能体系统的「发布面」。
 */

// ========== 基础类型 ==========

/** 子智能体的停止原因 */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal';

/** 子智能体的最终结果 */
export interface SubagentResult {
  /** 子智能体最终输出内容 */
  readonly output: string;
  /** 为什么结束 */
  readonly stopReason: SubagentStopReason;
  /** 子智能体触碰的文件列表 */
  readonly filesTouched: string[];
  /** 子智能体的发现/摘要 */
  readonly summary: string;
}

/** Provider 支持的启动时能力 */
export interface SubagentCapabilities {
  readonly depthLimit: boolean;
  readonly toolFilter: boolean;
  readonly persona: boolean;
}

/** 子智能体启动请求 */
export interface SubagentStartRequest {
  /** 短描述标签 */
  readonly label?: string;
  /** 子智能体的任务 prompt */
  readonly prompt: string;
  /** 父会话 ID */
  readonly parentSessionId: string;
  /** 工作目录 */
  readonly cwd: string;
  /** 取消信号 */
  readonly signal: AbortSignal;
  /** agent 类型 (explore/general/build) */
  readonly agentId?: string;
  /** AgentProfile ID — links to agent_profiles table for persistent identity (optional) */
  readonly profileId?: string;
  /** 最大递归深度 */
  readonly maxDepth?: number;
}

/** 可持续子智能体的启动规格 */
export interface ContinuableStartSpec {
  /** provider 名称 */
  readonly provider: string;
  /** 短描述标签 */
  readonly label: string;
  /** 委派请求 */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>;
  /** 调用方取消信号 */
  readonly signal: AbortSignal;
}

/** 可持续子智能体启动后返回的身份 */
export interface ContinuableStart {
  /** 持久子智能体 ID */
  readonly childId: string;
  /** 接受的初始 prompt 的消息 ID */
  readonly messageId: string;
}

/** 一次性子智能体 Run 句柄 */
export interface SubagentRun {
  /** run ID */
  readonly id: string;
  /** 子智能体最终结果的 Promise */
  readonly result: Promise<SubagentResult>;
  /** 取消并释放资源 */
  dispose(): Promise<void>;
}

/** 子智能体汇报选项 */
export interface SubagentReportOptions {
  /** 调度策略 */
  readonly delivery: 'quiet' | 'wakeup';
  /** 取消信号 */
  readonly signal: AbortSignal;
}

/** 后续消息发送选项 */
export interface SubagentFollowupOptions {
  /** 取消信号 */
  readonly signal: AbortSignal;
}

/** 中断权限 */
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: string }
  | { readonly kind: 'ancestor'; readonly callerSessionId: string };

// ========== Provider 接口 ==========

/**
 * 子智能体传输层 Provider — 对标 DSH SubagentProvider。
 * 可信的同进程实现。
 */
export interface SubagentProvider {
  /** 唯一注册名 */
  readonly name: string;
  /** 支持的能力 */
  readonly capabilities: SubagentCapabilities;
  /** 子智能体是否继承父对话上下文 */
  readonly inheritsParentContext: boolean;
  /** 启动一次性子智能体 */
  start(request: SubagentStartRequest): Promise<SubagentRun>;
  /** 准备可持续子智能体（可选能力） */
  prepareContinuable?(request: { sessionId: string; parentSessionId: string; signal: AbortSignal }): Promise<{ seed?: unknown[] }>;
}

// ========== 子智能体列表条目 ==========

export interface SubagentListEntry {
  readonly id: string;
  readonly label: string;
  readonly status: 'running' | 'idle' | 'ready';
  readonly agentId?: string;
}

// @ts-nocheck
/**
 * dsh 标准类型定义 — 从 DeepSeek Harness 提取的核心类型。
 *
 * 这些类型用于 dsh 兼容适配层，使 Codem 可以理解 dsh 的接口签名。
 */

/** dsh 标准消息 */
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentBlock[]
}

/** dsh 内容块 */
export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  toolUse?: { id: string; name: string; input: any }
  toolResult?: { toolUseId: string; content: string }
}

/** dsh 工具 schema */
export interface ToolSchema {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, any>
    required?: string[]
  }
}

/** dsh 生成选项 */
export interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: string
  purpose?: 'compaction' | 'session-title'
}

/** dsh 流式块 */
export interface StreamChunk {
  type: 'content' | 'tool_use' | 'tool_result' | 'stop' | 'error'
  delta?: string
  toolUse?: { id: string; name: string; input: any }
  toolResult?: { toolUseId: string; content: string }
  error?: { message: string; code: string }
}

/** dsh LLM 失败 */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}

/** dsh Provider 信息 */
export interface LlmProviderInfo {
  id: string
  label: string
}

/** dsh 模型信息 */
export interface LlmModelInfo {
  id: string
  provider: string
  label?: string
}

/** dsh Shell 执行结果 */
export interface ShellExecResult {
  stdout: string
  stderr: string
  exitCode: number
  ok: boolean
}

/** dsh Shell 执行规格 */
export interface ShellExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  env?: Record<string, string>
}

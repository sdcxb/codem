// @ts-nocheck
/**
 * P2-2/F3: 消除架构级重复声明
 *
 * 本文件包含多个能力族的接口实现类，这些类被 provider/ 中的对应 Provider 包装后注册到 ctx。
 * 新代码应直接使用 src/core/provider/ 中的 Provider，而非直接实例化这些类。
 *
 * 对应 Provider:
 * - AnonymousIdentity → provider/identity-provider.ts
 * - DefaultGuard → provider/guard-provider.ts
 * - StdioLSP → provider/lsp-stdio-provider.ts
 * - WorkerCodeRuntime → provider/code-runtime-worker-thread-provider.ts
 * - WorkerWorkflow → provider/workflow-worker-thread-provider.ts
 * - DefaultContext → provider/context-info-provider.ts
 * - DefaultCommands → provider/commands-provider.ts
 * - DefaultUserQuestions → provider/user-questions-provider.ts
 * - DefaultNotebook → provider/notebook-provider.ts
 * - DefaultSquad → provider/squad-provider.ts
 *
 * @deprecated 新代码请直接从 provider/ 导入。
 */
import type { Context, Plugin } from '../../cordis/src/index.ts'
import type { DynamicCordisRunner, PluginInfo } from './index.ts'

export class AnonymousIdentity {
  constructor(private ctx: Context) {}
  getId(): string { return 'anon-' + Math.random().toString(36).slice(2, 10) }
  getDisplayName(): string { return 'Anonymous User' }
}

export class DefaultGuard {
  constructor(private ctx: Context) {}
  check(rule: string, ctx: any): boolean { return true }
  enforce(rule: string, action: () => any): any { return action() }
}

export class StdioLSP {
  constructor(private ctx: Context) {}
  async start(config: any): Promise<void> {}
  async stop(): Promise<void> {}
}

export class WorkerCodeRuntime {
  constructor(private ctx: Context) {}
  async run(code: string, opts?: any): Promise<any> { return undefined }
}

export class WorkerWorkflow {
  constructor(private ctx: Context) {}
  async execute(steps: any[]): Promise<any[]> { return [] }
}

export class DefaultContext {
  constructor(private ctx: Context) {}
  build(config: any): string { return '' }
  async compact(messages: any[]): Promise<any[]> { return messages }
  getHistory(sessionId: string): any[] { return [] }
}

export class DefaultCommands {
  constructor(private ctx: Context) {}
  register(cmd: any): void {}
  execute(name: string, args?: any): Promise<any> { return Promise.resolve() }
  list(): any[] { return [] }
}

export class DefaultUserQuestions {
  constructor(private ctx: Context) {}
  async ask(question: string, opts?: any): Promise<string> { return '' }
}

export class DefaultNotebook {
  constructor(private ctx: Context) {}
  async create(name: string): Promise<string> { return '' }
  async list(): Promise<any[]> { return [] }
}

export class DefaultSquad {
  constructor(private ctx: Context) {}
  async create(config: any): Promise<string> { return '' }
  async list(): Promise<any[]> { return [] }
}

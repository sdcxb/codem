// @ts-nocheck
/**
 * @codem/tool-todo — Todo 工具 Consumer
 * @codem/tool-ask-user — 用户问题工具 Consumer
 * @codem/tool-lsp — LSP 工具 Consumer
 * @codem/tool-run-code — 代码执行工具 Consumer
 * @codem/tool-workflow — 工作流工具 Consumer
 * @codem/tool-goal — 目标工具 Consumer
 * @codem/tool-schedule — 调度工具 Consumer
 * @codem/tool-knowledge — 知识工具 Consumer
 *
 * 遗漏补齐：P4.4 和 P6.2 中缺失的 Consumer 包。
 */
import { defineTool, useCtx } from '../../consumer/index.ts'

// ========== tool-todo ==========
export function applyTodo() {
  defineTool({
    name: 'todo_write',
    description: 'Update the todo list for the current session',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
          },
        },
      },
      required: ['todos'],
    },
    async execute({ todos }: { todos: any[] }) {
      // 存储到 ctx.storage
      const ctx = useCtx()
      ctx.storage.set('todos', todos)
      return `Updated ${todos.length} todo items`
    },
  })
}

// ========== tool-ask-user ==========
export function applyAskUser() {
  defineTool({
    name: 'ask_user',
    description: 'Ask the user a question',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask' },
        options: { type: 'array', items: { type: 'string' }, description: 'Multiple choice options' },
      },
      required: ['question'],
    },
    async execute({ question, options }: { question: string; options?: string[] }) {
      const ctx = useCtx()
      if (ctx.userQuestions) {
        return await ctx.userQuestions.ask(question, options)
      }
      return 'User interaction not available'
    },
  })
}

// ========== tool-lsp ==========
export function applyLSP() {
  defineTool({
    name: 'lsp_diagnostics',
    description: 'Get LSP diagnostics for a file',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'File path' } },
      required: ['file'],
    },
    async execute({ file }: { file: string }) {
      const ctx = useCtx()
      if (!ctx.lsp) return 'LSP not available'
      const diags = await ctx.lsp.getDiagnostics(file)
      return diags.map(d => `${d.line}:${d.col} [${d.severity}] ${d.message}`).join('\n') || 'No diagnostics'
    },
  })

  defineTool({
    name: 'lsp_hover',
    description: 'Get hover information at a position',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        col: { type: 'number' },
      },
      required: ['file', 'line', 'col'],
    },
    async execute({ file, line, col }: { file: string; line: number; col: number }) {
      const ctx = useCtx()
      if (!ctx.lsp) return 'LSP not available'
      return await ctx.lsp.hover(file, line, col) || 'No hover info'
    },
  })

  defineTool({
    name: 'lsp_completions',
    description: 'Get code completions at a position',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        col: { type: 'number' },
      },
      required: ['file', 'line', 'col'],
    },
    async execute({ file, line, col }: { file: string; line: number; col: number }) {
      const ctx = useCtx()
      if (!ctx.lsp) return 'LSP not available'
      const completions = await ctx.lsp.completions(file, line, col)
      return completions.map(c => c.label || c.name).join('\n') || 'No completions'
    },
  })
}

// ========== tool-run-code ==========
export function applyRunCode() {
  defineTool({
    name: 'run_code',
    description: 'Execute code in a sandboxed environment',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to execute' },
        language: { type: 'string', description: 'Programming language' },
        cwd: { type: 'string', description: 'Working directory' },
      },
      required: ['code', 'language'],
    },
    requirePermission: true,
    async execute({ code, language, cwd }: { code: string; language: string; cwd?: string }) {
      const ctx = useCtx()
      if (!ctx.codeRuntime) return 'Code runtime not available'
      const result = await ctx.codeRuntime.execute(code, language, cwd)
      return result.stdout || result.stderr || '(no output)'
    },
  })
}

// ========== tool-workflow ==========
export function applyWorkflow() {
  defineTool({
    name: 'workflow_create',
    description: 'Create a workflow with multiple steps',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              action: { type: 'string' },
            },
          },
        },
      },
      required: ['steps'],
    },
    async execute({ steps }: { steps: any[] }) {
      const ctx = useCtx()
      if (!ctx.workflow) return 'Workflow not available'
      const id = ctx.workflow.create(steps.map(s => ({
        name: s.name,
        fn: async () => s.action,
      })))
      return `Workflow created: ${id}`
    },
  })

  defineTool({
    name: 'workflow_run',
    description: 'Run a previously created workflow',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string' } },
      required: ['workflowId'],
    },
    async execute({ workflowId }: { workflowId: string }) {
      const ctx = useCtx()
      if (!ctx.workflow) return 'Workflow not available'
      const result = await ctx.workflow.run(workflowId)
      return result.success ? 'Workflow completed' : 'Workflow failed'
    },
  })
}

// ========== tool-goal ==========
export function applyGoal() {
  defineTool({
    name: 'goal_set',
    description: 'Set a goal for the current session',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        criteria: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
    async execute({ title, description, criteria }: { title: string; description?: string; criteria?: string[] }) {
      const ctx = useCtx()
      if (!ctx.goals) return 'Goals not available'
      const id = ctx.goals.set({ title, description, criteria })
      return `Goal set: ${id}`
    },
  })

  defineTool({
    name: 'goal_list',
    description: 'List all goals',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const ctx = useCtx()
      if (!ctx.goals) return 'Goals not available'
      return ctx.goals.list().map(g => `[${g.status}] ${g.id}: ${g.title}`).join('\n') || 'No goals'
    },
  })
}

// ========== tool-schedule ==========
export function applySchedule() {
  defineTool({
    name: 'schedule_reminder',
    description: 'Schedule a reminder',
    inputSchema: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'ISO datetime' },
        message: { type: 'string' },
      },
      required: ['time', 'message'],
    },
    async execute({ time, message }: { time: string; message: string }) {
      const ctx = useCtx()
      if (!ctx.schedule) return 'Schedule not available'
      const id = ctx.schedule.addReminder(new Date(time), message)
      return `Reminder scheduled: ${id}`
    },
  })
}

// ========== tool-knowledge ==========
export function applyKnowledge() {
  defineTool({
    name: 'knowledge_add',
    description: 'Add knowledge to the knowledge base',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['text'],
    },
    async execute({ text, metadata }: { text: string; metadata?: any }) {
      const ctx = useCtx()
      if (!ctx.knowledge) return 'Knowledge not available'
      const id = await ctx.knowledge.add(text, metadata)
      return `Knowledge added: ${id}`
    },
  })

  defineTool({
    name: 'knowledge_search',
    description: 'Search the knowledge base',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    async execute({ query, limit }: { query: string; limit?: number }) {
      const ctx = useCtx()
      if (!ctx.knowledge) return 'Knowledge not available'
      const results = await ctx.knowledge.search(query, limit)
      return results.map(r => `${r.id}: ${r.text}`).join('\n') || 'No results'
    },
  })
}

// ========== 统一入口 ==========
export const inject = ['tools'] as const

export function apply() {
  applyTodo()
  applyAskUser()
  applyLSP()
  applyRunCode()
  applyWorkflow()
  applyGoal()
  applySchedule()
  applyKnowledge()
  console.log('[tool-extra] All extra tools registered')
}

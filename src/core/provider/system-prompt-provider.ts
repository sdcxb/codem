// @ts-nocheck
/**
 * @codem/system-prompt — 系统提示词插件化组装，支持多段拼接、动态注入和变量插值。
 *
 * 参考自 DSH (DeepSeek Harness) packages/core/system-prompt/src/index.ts:
 *   - SystemPrompt extends Service with section/context/variable/tools registration
 *   - assemble(context) → PromptAssembly with sections, contexts, tools, variables
 *   - renderPrompt(assembly) → interpolated string
 *   - {{variable}} interpolation with strict validation
 *
 * 本 Provider 实现了 DSH 的核心模式：
 * 1. section(name, order, text) — 有序段注册
 * 2. context(name, order, text) — 动态上下文注册
 * 3. variable(name, provider) — 变量注册
 * 4. assemble(scope?) — 组装完整提示词
 * 5. renderPrompt(assembly) — 渲染为字符串，支持 {{variable}} 插值
 */
import type { Plugin } from '../cordis/src/index.ts'

/** 变量名验证规则 — 参考 DSH system-prompt/index.ts:134 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
/** 完整的 {{...}} 引用 — 参考 DSH system-prompt/index.ts:137 */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** 一段提示词 */
export interface PromptSection {
  name: string
  order: number
  text: string | ((ctx: any) => string)
  complete?: boolean
}

/** 动态上下文 */
export interface PromptContext {
  name: string
  order: number
  text: string | ((ctx: any) => string)
}

/** 组装结果 */
export interface PromptAssembly {
  sections: { name: string; text: string }[]
  contexts: { name: string; text: string }[]
  variables: Record<string, string | undefined>
}

/**
 * 渲染组装结果为字符串 — 参考 DSH renderPrompt()
 * 支持 {{variable}} 插值，严格校验。
 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => interpolate(section, assembly.variables, 'section'))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/** 插值 — 参考 DSH system-prompt/index.ts:258 */
function interpolate(
  input: { name: string; text: string },
  variables: Record<string, string | undefined>,
  kind: string,
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}"`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}"`)
    }
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`)
    }
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

export const systemPromptProvider: Plugin = (ctx: any) => {
  /** 段注册表 — 参考 DSH PromptLayer.sections */
  const sections = new Map<string, PromptSection>()
  /** 动态上下文注册表 — 参考 DSH PromptLayer.contexts */
  const contexts = new Map<string, PromptContext>()
  /** 变量提供器 — 参考 DSH PromptLayer.variables */
  const variableProviders = new Map<string, (ctx: any) => string | undefined>()

  const service = {
    /**
     * 注册有序段 — 参考 DSH SystemPrompt.section()
     * @param section - 段定义
     */
    addSection(section: PromptSection): () => void {
      if (!Number.isFinite(section.order)) {
        throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
      }
      if (sections.has(section.name)) {
        throw new Error(`prompt section "${section.name}" is already registered`)
      }
      sections.set(section.name, section)
      return () => sections.delete(section.name)
    },

    /** 兼容旧接口 */
    addSegment(key: string, content: string, priority = 0) {
      this.addSection({ name: key, order: -priority, text: content })
    },

    /** 移除段 */
    removeSegment(key: string) {
      sections.delete(key)
    },

    getSegment(key: string) {
      const s = sections.get(key)
      return s ? (typeof s.text === 'function' ? s.text({}) : s.text) : undefined
    },

    /**
     * 注册动态上下文 — 参考 DSH SystemPrompt.context()
     */
    addContext(context: PromptContext): () => void {
      if (!Number.isFinite(context.order)) {
        throw new TypeError(`prompt context "${context.name}" order must be a finite number`)
      }
      contexts.set(context.name, context)
      return () => contexts.delete(context.name)
    },

    /**
     * 注册变量提供器 — 参考 DSH SystemPrompt.variable()
     */
    addVariable(name: string, provider: (ctx: any) => string | undefined): () => void {
      if (!VARIABLE_NAME.test(name)) {
        throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
      }
      variableProviders.set(name, provider)
      return () => variableProviders.delete(name)
    },

    /** 简写：注册静态变量 */
    setVariable(name: string, value: string) {
      this.addVariable(name, () => value)
    },

    /**
     * 组装提示词 — 参考 DSH SystemPrompt.assemble()
     * 将所有段、上下文、变量组装为 PromptAssembly
     */
    async assemble(scope?: string): Promise<PromptAssembly> {
      // 解析变量
      const variables: Record<string, string | undefined> = {}
      for (const [name, provider] of variableProviders) {
        variables[name] = provider({ scope })
      }

      // 解析段（按 order 排序）
      const sectionDefs = [...sections.values()].sort((a, b) => a.order - b.order)
      const assembledSections = sectionDefs.map(s => ({
        name: s.name,
        text: typeof s.text === 'function' ? s.text({ scope }) : s.text,
      }))

      // 解析上下文（按 order 排序）
      const contextDefs = [...contexts.values()].sort((a, b) => a.order - b.order)
      const assembledContexts = contextDefs.map(c => ({
        name: c.name,
        text: typeof c.text === 'function' ? c.text({ scope }) : c.text,
      }))

      return {
        sections: assembledSections,
        contexts: assembledContexts,
        variables,
      }
    },

    /**
     * 构建完整提示词字符串 — 内部调用 assemble + renderPrompt
     * 兼容旧 build() 接口
     */
    async build(): Promise<string> {
      const assembly = await this.assemble()
      const promptText = renderPrompt(assembly)

      // 兼容：如果 agentInstructions 服务存在，追加其系统提示
      const instr = ctx.get('agentInstructions')
      if (instr) {
        const t = instr.buildSystemPrompt()
        if (t) return promptText + '\n\n' + t
      }

      return promptText
    },

    /** 同步构建（不调用 async 变量提供器，仅用缓存值） */
    buildSync(): string {
      const sectionDefs = [...sections.values()].sort((a, b) => a.order - b.order)
      const parts = sectionDefs.map(s =>
        typeof s.text === 'function' ? s.text({}) : s.text
      ).filter(Boolean)

      const instr = ctx.get('agentInstructions')
      if (instr) {
        const t = instr.buildSystemPrompt()
        if (t) parts.push(t)
      }

      return parts.join('\n\n')
    },
  }

  // 注册默认段 — 参考 DSH constructor 中的 harness:identity
  service.addSection({
    name: 'codem:identity',
    order: -100,
    text: 'You are an AI agent powered by Codem.',
  })

  // 注册默认变量 — 参考 DSH agent-loop/index.ts:351-353
  const agentEngine = ctx.get('agentEngine')
  if (agentEngine) {
    service.addVariable('provider', () => agentEngine.getEngine?.()?.config?.providerId || 'unknown')
    service.addVariable('model', () => agentEngine.getEngine?.()?.config?.model || 'unknown')
  }
  service.addVariable('cwd', () => process.cwd?.() || '/')

  return ctx.provide('systemPrompt', service)
}

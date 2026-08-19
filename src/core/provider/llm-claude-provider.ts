// @ts-nocheck
/**
 * @codem/llm-claude — Claude LLM Provider 插件
 *
 * Anthropic Claude 模型适配器，支持 Claude 3.5 Sonnet / Opus / Haiku。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链）：
 * - 启动时：注册 claude provider 到 llm 服务
 * - 停止时：claude provider 注销，AgenticLoop 可回退到其他 Provider
 */
import type { Plugin } from '../cordis/src/index.ts'
import { OpenAICompatibleProvider } from '../llm/provider'

export const llmClaudeProvider: Plugin = (ctx: any) => {
  const claudeProvider = new OpenAICompatibleProvider({
    id: 'claude',
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: '',
    models: [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextWindow: 200000 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000 },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', contextWindow: 200000 },
    ],
  })

  const llm = ctx.get('llm')
  let disposeProvider: (() => void) | null = null

  if (llm && llm.registerProvider) {
    disposeProvider = llm.registerProvider('claude', claudeProvider)
  } else {
    ctx.provide('llmClaude', claudeProvider)
  }

  return () => { if (disposeProvider) disposeProvider() }
}

// @ts-nocheck
/**
 * @codem/llm-ollama — Ollama 本地 LLM Provider 插件
 *
 * Ollama 本地模型适配器，支持本地运行的 Llama / Qwen / DeepSeek 等模型。
 * 无需 API Key，通过本地 Ollama 服务（默认 localhost:11434）调用。
 *
 * 功能链路融入（文档 6.2 链路 A: LLM 调用链）：
 * - 启动时：注册 ollama provider 到 llm 服务
 * - 停止时：ollama provider 注销
 * - 特点：完全本地运行，无网络依赖，隐私安全
 */
import type { Plugin } from '../cordis/src/index.ts'
import { OllamaProvider } from '../llm/ollama-provider'

export const llmOllamaProvider: Plugin = (ctx: any) => {
  // OllamaProvider 已有完整实现，直接复用
  const ollamaProvider = new OllamaProvider({
    id: 'ollama',
    name: 'Ollama (Local)',
    baseUrl: 'http://localhost:11434',
    apiKey: '', // 本地模型无需 API Key
    models: [
      { id: 'llama3.1:8b', name: 'Llama 3.1 8B', contextWindow: 128000 },
      { id: 'llama3.1:70b', name: 'Llama 3.1 70B', contextWindow: 128000 },
      { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', contextWindow: 32000 },
      { id: 'qwen2.5:14b', name: 'Qwen 2.5 14B', contextWindow: 32000 },
      { id: 'deepseek-r1:7b', name: 'DeepSeek R1 7B', contextWindow: 64000 },
      { id: 'deepseek-r1:14b', name: 'DeepSeek R1 14B', contextWindow: 64000 },
    ],
  } as any)

  const llm = ctx.get('llm')
  let disposeProvider: (() => void) | null = null

  if (llm && llm.registerProvider) {
    disposeProvider = llm.registerProvider('ollama', ollamaProvider)
  } else {
    ctx.provide('llmOllama', ollamaProvider)
  }

  return () => { if (disposeProvider) disposeProvider() }
}

/**
 * 笔记本功能模型解析助手
 *
 * 统一所有笔记本 LLM 调用的模型解析逻辑:
 * 1. 优先使用用户场景模板（ModelProfile）中配置的 slot 模型
 * 2. 回退到 codem-settings 中的默认模型
 * 3. 确保使用正确的 provider（场景模板可配置不同 provider）
 *
 * 架构修复: 原实现 createDefaultProviders() 创建了全新的 ProviderRegistry,
 * 这些 provider 没有经过 App.tsx 的 setProviderConfig 配置，导致 API Key 丢失。
 * 现在使用 LLMEngine 的统一 getConfiguredProvider 方法。
 */

import { getModelProfileManager, type TaskSlot } from './model-profile';
import type { LLMProvider } from './types';

export interface ResolvedModel {
  provider: LLMProvider;
  model: string;
  /** 模型来源 */
  source: 'slot' | 'default';
  /** provider 名称 */
  providerName: string;
}

/**
 * 解析用于特定任务的模型
 * @param slot 任务类型（如 'chat', 'subagent', 'memory', 'compaction' 等）
 * @returns 解析后的模型信息，如果没有任何可用 provider 则返回 null
 */
export async function resolveModelForTask(slot: TaskSlot = 'chat'): Promise<ResolvedModel | null> {
  try {
    const { getLLMEngine } = await import('./index');
    const engine = getLLMEngine();
    const pm = getModelProfileManager();
    const slotConfig = pm.resolveSlot(slot);

    try {
      const { provider, model } = engine.getConfiguredProvider(slot);

      // 判断来源：如果 slotConfig 的 provider/model 与返回的匹配则为 slot，否则 default
      const source = (slotConfig && slotConfig.provider === provider.id && slotConfig.model === model)
        ? 'slot' : 'default';

      return {
        provider,
        model,
        source: source as 'slot' | 'default',
        providerName: provider.name || provider.id,
      };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

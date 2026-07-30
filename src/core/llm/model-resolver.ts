/**
 * 笔记本功能模型解析助手
 *
 * 统一所有笔记本 LLM 调用的模型解析逻辑:
 * 1. 优先使用用户场景模板（ModelProfile）中配置的 slot 模型
 * 2. 回退到 codem-settings 中的默认模型
 * 3. 确保使用正确的 provider（场景模板可配置不同 provider）
 *
 * 这样用户在设置中配置的 TTS、视觉、子任务等专用模型会被正确使用，
 * 而不是所有功能都用同一个默认模型。
 */

import { getModelProfileManager, type TaskSlot } from './model-profile';
import { getSettingJSON } from '../storage/settings';
import { createDefaultProviders } from './provider';
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
  const pm = getModelProfileManager();
  const slotConfig = pm.resolveSlot(slot);

  // 获取全局设置中的默认 provider 和 model
  const settings = getSettingJSON<any>('codem-settings', {});
  const defaultModel = settings.model || 'gpt-4o-mini';

  // 获取所有已配置的 provider
  const registry = createDefaultProviders();
  const providers = registry.getConfigured();

  if (providers.length === 0) return null;

  if (slotConfig) {
    // 用户配置了场景模板 — 尝试使用对应的 provider
    const matchedProvider = providers.find(
      (p) => p.name === slotConfig.provider || p.id === slotConfig.provider
    );

    if (matchedProvider) {
      return {
        provider: matchedProvider,
        model: slotConfig.model,
        source: 'slot',
        providerName: slotConfig.provider,
      };
    }

    // Provider 不匹配 — 回退到第一个可用 provider，但使用 slot 的模型
    // 这允许用户只配置模型名而不切换 provider
    return {
      provider: providers[0],
      model: slotConfig.model,
      source: 'slot',
      providerName: providers[0].name || providers[0].id,
    };
  }

  // 没有配置场景模板 — 使用默认
  return {
    provider: providers[0],
    model: defaultModel,
    source: 'default',
    providerName: providers[0].name || providers[0].id,
  };
}

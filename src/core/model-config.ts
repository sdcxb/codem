/**
 * 模型配置公共模块
 *
 * 统一管理 MiMo CLI 模型和 API 模型的列表，
 * 供 ChatPanel、RegenerateModelPopover 等组件共享使用。
 */

import { getSettingJSON } from "./storage/settings";

export interface ModelOption {
  id: string;
  name: string;
}

/** MiMo CLI 模式可用的模型列表 */
export const MIMO_MODELS: ModelOption[] = [
  { id: "mimo-v2.5-pro", name: "MiMo v2.5 Pro" },
  { id: "mimo-v2.5", name: "MiMo v2.5" },
  { id: "mimo-v2-pro", name: "MiMo v2 Pro" },
  { id: "mimo-v2-flash", name: "MiMo v2 Flash" },
];

/** 各 API provider 支持的模型列表 */
export const API_MODELS: Record<string, ModelOption[]> = {
  openai: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "o3", name: "o3" },
  ],
  anthropic: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
  ],
  deepseek: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  ],
  moonshot: [
    { id: "moonshot-v1-8k", name: "Moonshot v1 8K" },
    { id: "moonshot-v1-32k", name: "Moonshot v1 32K" },
    { id: "moonshot-v1-128k", name: "Moonshot v1 128K" },
  ],
  gemini: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  ],
};

/** 从 codem-settings 读取已配置 API Key 的 provider 列表，生成可选模型列表。
 * 聊天头部用模型 ID 显示（如 deepseek-v4-pro），不用设置页的 provider-name 格式。
 */
export function getConfiguredApiModels(): ModelOption[] {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    const providers = settings.providers || [];
    const result: ModelOption[] = [];
    for (const p of providers) {
      if (p.apiKey && p.id !== "mimo" && API_MODELS[p.id]) {
        for (const m of API_MODELS[p.id]) {
          result.push({ id: m.id, name: m.id });
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** 根据模式（cli / api）获取可选模型列表 */
export function getModelsForMode(mode: "cli" | "api"): ModelOption[] {
  return mode === "cli" ? MIMO_MODELS : getConfiguredApiModels();
}

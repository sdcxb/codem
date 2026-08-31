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
 *
 * 模型列表优先从 codem-dynamic-models 存储读取（设置页面刷新时写入），
 * 回退到 API_MODELS 静态列表。
 */
export function getConfiguredApiModels(): ModelOption[] {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    const providers = settings.providers || [];

    // 读取设置页面从 API 服务器获取并持久化的动态模型列表
    type DynamicModelMap = { [providerId: string]: Array<{ id: string; name: string }> };
    const dynamicModels = getSettingJSON<DynamicModelMap>("codem-dynamic-models", {});

    const result: ModelOption[] = [];
    for (const p of providers) {
      if (!p.apiKey || p.id === "mimo") continue;

      // 优先使用动态模型列表（从 API 服务器获取并存储的）
      const dynModels = dynamicModels[p.id];
      if (dynModels && dynModels.length > 0) {
        for (const m of dynModels) {
          result.push({ id: m.id, name: m.name });
        }
      }
      // 回退到静态列表
      else if (API_MODELS[p.id]) {
        for (const m of API_MODELS[p.id]) {
          result.push({ id: m.id, name: m.name });
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

/**
 * Resolve which provider serves a given model id.
 * First tries known prefixes (deepseek/claude/gpt/...), then falls back to
 * scanning configured providers' dynamic model lists — this supports custom
 * OpenAI-compatible providers (通用协议配置) whose model ids don't match
 * any built-in prefix. Returns "" if no provider matches.
 */
export function resolveProviderForModel(model: string): string {
  if (model.startsWith("deepseek")) return "deepseek";
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("moonshot")) return "moonshot";
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("gpt") || model.startsWith("o3")) return "openai";

  // Custom providers: match against their dynamically fetched model lists
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    const providers = settings.providers || [];
    type DynamicModelMap = { [providerId: string]: Array<{ id: string; name: string }> };
    const dynamicModels = getSettingJSON<DynamicModelMap>("codem-dynamic-models", {});
    for (const p of providers) {
      if (!p.apiKey || p.id === "mimo") continue;
      const dyn = dynamicModels[p.id];
      if (dyn && dyn.some((m) => m.id === model)) return p.id;
    }
  } catch {
    // ignore — fall through to ""
  }
  return "";
}

/**
 * 查找第一个已配置 API Key 的 provider（含自定义 provider）并返回其默认模型。
 * 自定义 provider 从 codem-dynamic-models 取第一个动态模型；
 * 内置 provider 用静态映射表。找不到时返回 mimo 兜底。
 */
export function getFirstConfiguredModel(): { model: string; provider: string } {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    const providers = settings.providers || [];
    type DynamicModelMap = { [providerId: string]: Array<{ id: string; name: string }> };
    const dynamicModels = getSettingJSON<DynamicModelMap>("codem-dynamic-models", {});
    const defaultModels: Record<string, string> = {
      openai: "gpt-4o",
      anthropic: "claude-sonnet-4-20250514",
      deepseek: "deepseek-v4-flash",
      moonshot: "moonshot-v1-8k",
      gemini: "gemini-2.5-flash",
    };
    for (const p of providers) {
      if (!p.apiKey || p.id === "mimo") continue;
      // 自定义 provider：优先取动态模型列表第一个
      const dyn = dynamicModels[p.id];
      if (dyn && dyn.length > 0) {
        return { model: dyn[0].id, provider: p.id };
      }
      // 内置 provider：静态映射
      if (defaultModels[p.id]) {
        return { model: defaultModels[p.id], provider: p.id };
      }
    }
  } catch {
    // ignore — fall through to mimo
  }
  return { model: "mimo-v2.5-pro", provider: "mimo" };
}

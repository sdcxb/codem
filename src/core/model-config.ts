/**
 * 模型配置公共模块
 *
 * 统一管理 MiMo CLI 模型和 API 模型的列表，
 * 供 ChatPanel、RegenerateModelPopover 等组件共享使用。
 */

import { getSettingJSON } from "./storage/settings";
import { getMergedDynamicModels } from "./llm/model-catalog";
// 第 201 波：免费模型插件的清单（同步读缓存；取不到就返回空 ⇒ 原样回退）
import { freeModelPlugin } from "./free-model-plugin/service";

export interface ModelOption {
  id: string;
  name: string;
  /** 来源 provider（同一模型 id 可能同时来自 DeepSeek 原生与 AICodeWith，选择时必须带来源） */
  providerId?: string;
  providerName?: string;
  /** 输入模态（AICodeWith 等动态目录用；用于选择器标注） */
  inputModalities?: Array<"text" | "image">;
}

/** MiMo CLI 模式可用的模型列表 */
export const MIMO_MODELS: ModelOption[] = [
  { id: "mimo-v2.5-pro", name: "MiMo v2.5 Pro" },
  { id: "mimo-v2.5", name: "MiMo v2.5" },
  { id: "mimo-v2-pro", name: "MiMo v2 Pro" },
  { id: "mimo-v2-flash", name: "MiMo v2 Flash" },
];

/** 各 API provider 支持的模型列表 */
const API_MODELS: Record<string, ModelOption[]> = {
  openai: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "o3", name: "o3" },
  ],
  aicodewith: [
    { id: "gpt-5.4", name: "GPT-5.4 (AI Code With)" },
    { id: "gpt-5.5", name: "GPT-5.5 (AI Code With)" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (AI Code With)" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (AI Code With)" },
    { id: "glm-5.3", name: "GLM-5.3 (AI Code With)" },
    { id: "kimi-k3", name: "Kimi K3 (AI Code With)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (AI Code With)" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6 (AI Code With)" },
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro (AI Code With)" },
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
    // （合并手动添加的自定义模型 + 内置目录兜底：服务器 /models 不是可调用模型的完整真相，
    //   例如旧 vision-exp 已 retired，现在由 deepseek-flash 覆盖）
    const dynamicModels = getMergedDynamicModels();

    const result: ModelOption[] = [];
    /**
     * 第 201 波（用户要求「开启后对话优先从这个插件里获取模型列表服务」）：
     * **免费模型插件**的清单排在最前 —— 它是"本机现在就可用、不需要 key"的那批，
     * 用户最可能想先看到它们。
     *
     * 取不到（没启用 / 没起来 / 没装 Node / 缓存过期）⇒ `cachedPluginModels()` 返回空数组
     * ⇒ **列表原样回退**，绝不让模型选择器空掉（这是这条集成最要紧的一条纪律）。
     */
    /*
     * ★ 第 225 波（用户实报的延伸问题）：模型列表**只剩 12 个**，而插件接口当时返回 **26 个** ✗。
     *
     * 根因：这里原来只用 `cached()`（**内存缓存**，TTL 内不刷新）。缓存是在某次较早的刷新里建的
     * （那次服务器只列出了一部分）⇒ 只要没到 TTL，界面就一直显示那份**短列表**，
     * 连"插件实际提供的模型"都看不到 ✗ —— 这比"刷得出来不能用"更误导。
     *
     * 修法：**并集** —— 内存缓存 ∪ 落盘动态列表（`codem-dynamic-models`，刷新时写的服务器事实）。
     * 两者都是"服务器曾经列出来的真实模型"，取并集不会凭空造模型 ✓，却能防止任何一侧偏短时藏掉模型 ✓。
     * 顺序保持"插件缓存优先"（它最新），落盘里多出来的补在后面。
     */
    /*
     * 用户暂停插件后，缓存/落盘动态列表里仍可能留着上次的免费模型（缓存 TTL、动态列表是历史事实），
     * 所以必须用当前开关做闸门：关闭时一个都不进选择器；开启时才参与并集。
     */
    const freeModelsEnabled = freeModelPlugin.readSetting().enabled;
    const freeModelOptions: Array<{ id: string; name: string }> = [];
    const seenFreeIds = new Set<string>();
    if (freeModelsEnabled) {
      for (const m of freeModelPlugin.models.cached()) {
        if (seenFreeIds.has(m.id)) continue;
        seenFreeIds.add(m.id);
        freeModelOptions.push({ id: m.id, name: m.name });
      }
      for (const m of getMergedDynamicModels()["free-model"] ?? []) {
        if (seenFreeIds.has(m.id)) continue;
        seenFreeIds.add(m.id);
        freeModelOptions.push({ id: m.id, name: m.name });
      }
    }
    for (const m of freeModelOptions) {
      result.push({ id: m.id, name: m.name, providerId: "free-model", providerName: "Our Free Model" });
    }

    for (const p of providers) {
      if (!p.apiKey || p.id === "mimo") continue;

      // 优先使用动态模型列表（从 API 服务器获取并存储的）
      const dynModels = dynamicModels[p.id];
      if (dynModels && dynModels.length > 0) {
        for (const m of dynModels) {
          result.push({ id: m.id, name: m.name, providerId: p.id, providerName: p.name, ...(m.inputModalities ? { inputModalities: m.inputModalities } : {}) });
        }
      }
      // 回退到静态列表
      else if (API_MODELS[p.id]) {
        for (const m of API_MODELS[p.id]) {
          result.push({ id: m.id, name: m.name, providerId: p.id, providerName: p.name });
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
 *
 * 顺序很重要：**聚合/自定义 provider 的目录优先于内置前缀**。
 * AICodeWith 这类一把 key 的聚合入口会提供 `gpt-5.4`、`deepseek-v4-flash` 等 id；
 * 若先按 `gpt`/`deepseek` 前缀判断，请求会被错误地发给原生 OpenAI/DeepSeek
 * （用户只配了 AICodeWith key 时直接报 not configured）。先认目录，再退回前缀，
 * 最后才扫其它 provider 的动态列表。Returns "" if no provider matches.
 */
export function resolveProviderForModel(model: string): string {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    const providers = settings.providers || [];
    const dynamicModels = getMergedDynamicModels();

    // 1) 聚合/自定义 provider：它们目录里的 id 归它们，不能被前缀抢走
    for (const p of providers) {
      if (!p.apiKey || p.id === "mimo") continue;
      if (!(p.custom || p.id === "aicodewith")) continue;
      const dyn = dynamicModels[p.id];
      if (dyn && dyn.some((m) => m.id === model)) return p.id;
      // 刷新前也可能显示静态目录（Claude/Gemini/GPT 文档 id）；配了 AICodeWith key 就归它
      if (p.id === "aicodewith" && (API_MODELS.aicodewith || []).some((m) => m.id === model)) return p.id;
    }

    // 2) 内置 provider 的稳定前缀
    if (model.startsWith("deepseek")) return "deepseek";
    if (model.startsWith("claude")) return "anthropic";
    if (model.startsWith("moonshot")) return "moonshot";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt") || model.startsWith("o3")) return "openai";

    // 3) 其它 provider 的动态目录
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
    // 走合并后的动态列表（服务器 + 手动 + 内置目录），自定义 provider 才能拿到兜底模型
    const dynamicModels = getMergedDynamicModels();
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

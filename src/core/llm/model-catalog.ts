/**
 * 内置模型目录 + 合并规则（第 74 波）
 *
 * 背景（用户提问）：为什么 Codem 的模型下拉里 DeepSeek 只有两个模型、没有
 * `deepseek-v4-flash-vision-exp`，而 DSH 有？
 *
 * 实测（2026-09-13，用同一把 key 直连官方接口）：
 *
 *   GET https://api.deepseek.com/v1/models  →  2 个：deepseek-flash, deepseek-v4-pro
 *   POST chat/completions model=deepseek-v4-flash-vision-exp  →  HTTP 200 ✅ 可调用
 *   POST chat/completions model=DeepSeek-V4-Flash-Vision-Exp  →  HTTP 400 ❌
 *        "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed …"
 *
 * 两条结论：
 *   ① **服务器 /models 不是"可调用模型"的完整真相** —— 视觉实验模型不在列表里，但能正常调用；
 *      而且列表还会变（`deepseek-v4-flash` 已改名 `deepseek-flash`，旧名仍可调用）。
 *   ② **模型 id 大小写敏感** —— DSH 的目录里 `id: "deepseek-v4-flash-vision-exp"` /
 *      `name: "DeepSeek-V4-Flash-Vision-Exp"` 是分开的两个字段，而 Codem 的 model-profile
 *      把**显示名当 id** 用了，视觉代理调过去必然 400。
 *
 * DSH 之所以"能获取到"，是因为它的 DeepSeek 模型是**静态目录**
 * （`dsh-llm-deepseek` 的 `DEFAULT_MODELS`，`listModels()` 根本不请求服务器）。
 * Codem 之前只信服务器列表，于是这类"能调用但不在列表"的模型就消失了。
 *
 * 本模块的规则（两层都要，缺一不可）：
 *   - 服务器列表仍然是**事实来源**：它给出的模型全部保留（含未来新模型、改名后的新 id）；
 *   - 内置目录做**兜底并集**：补上"服务器不列但确实可用"的模型，并标记 `catalogOnly`，
 *     让界面能如实说明"这个来自内置目录"；
 *   - 读取处统一走 `normalizeModelId`，把历史上写错大小写的 id（显示名当 id）纠正回来。
 */

import { getSettingJSON } from "../storage/settings";
import { mergeCustomModels, type LightModel } from "./custom-models";

/** 目录条目：与运行时 ModelConfig 兼容（多出来的字段供界面解释来源） */
export interface CatalogModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  /** 该模型支持的输入模态（视觉模型含 "image"） */
  inputModalities?: Array<"text" | "image">;
  /** true = 服务器 /models 未列出，由内置目录补充 */
  catalogOnly?: boolean;
}

/**
 * 内置模型目录。**只放"实测确认可用、但服务器可能不列"的模型** ——
 * 服务器列出的模型不需要在这里重复（并集会自动保留服务器条目）。
 *
 * deepseek：与 DSH `dsh-llm-deepseek` 的 DEFAULT_MODELS 对齐
 * （v4-flash / v4-pro / v4-flash-vision-exp），其中视觉实验模型是服务器不列的那个。
 */
export const BUILTIN_MODEL_CATALOG: Record<string, CatalogModel[]> = {
  deepseek: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1000000 },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000 },
    {
      id: "deepseek-v4-flash-vision-exp",
      name: "DeepSeek V4 Flash Vision (实验)",
      contextWindow: 1000000,
      inputModalities: ["text", "image"],
    },
  ],
};

/** 某 provider 的内置目录（没有则空数组） */
export function catalogFor(providerId: string): CatalogModel[] {
  return BUILTIN_MODEL_CATALOG[providerId] || [];
}

/**
 * 服务器列表 ∪ 内置目录。
 *
 * 规则：以 id（小写比较）去重；**服务器条目优先**（它的元数据更新鲜），
 * 目录独有的条目追加并标记 `catalogOnly: true`。
 */
export function mergeModelsWithCatalog<T extends LightModel>(
  providerId: string,
  serverModels: T[] | undefined | null,
): Array<T & CatalogModel> {
  const out: Array<T & CatalogModel> = Array.isArray(serverModels) ? [...(serverModels as Array<T & CatalogModel>)] : [];
  const seen = new Set(out.map((m) => String(m.id || m.name).toLowerCase()));
  for (const entry of catalogFor(providerId)) {
    if (seen.has(entry.id.toLowerCase())) continue;
    seen.add(entry.id.toLowerCase());
    out.push({ ...(entry as unknown as T & CatalogModel), catalogOnly: true });
  }
  return out;
}

/**
 * 把模型 id 规范化成目录里的正确写法（大小写）。
 *
 * 为什么必须做：API 对模型名**大小写敏感** —— 实测 `DeepSeek-V4-Flash-Vision-Exp`
 * 直接 400，而 `deepseek-v4-flash-vision-exp` 正常 200。历史版本把它当 id 存进了
 * 内置 profile 与用户方案里，必须在读取处纠正，否则用户会看到"模型不可用"的 400。
 */
export function normalizeModelId(providerId: string, modelId: string): string {
  if (!modelId) return modelId;
  const catalog = catalogFor(providerId);
  if (catalog.some((m) => m.id === modelId)) return modelId;
  const lower = modelId.toLowerCase();
  const hit = catalog.find((m) => m.id.toLowerCase() === lower);
  return hit ? hit.id : modelId;
}

/** 缓存 + 手动添加 + 内置目录，三路合并后的动态模型表（界面与引擎统一走这里） */
export function getMergedDynamicModels(): Record<string, CatalogModel[]> {
  let stored: Record<string, CatalogModel[]> = {};
  try {
    stored = getSettingJSON<Record<string, CatalogModel[]>>("codem-dynamic-models", {});
  } catch {
    stored = {};
  }
  const withCustom = mergeCustomModels(stored as Record<string, LightModel[]>) as Record<string, CatalogModel[]>;
  const out: Record<string, CatalogModel[]> = {};
  for (const [pid, models] of Object.entries(withCustom)) {
    out[pid] = mergeModelsWithCatalog(pid, models);
  }
  // 只登记了手动模型 / 目录里有、缓存里没有的 provider 也要出现
  for (const pid of Object.keys(BUILTIN_MODEL_CATALOG)) {
    if (!out[pid]) out[pid] = mergeModelsWithCatalog(pid, []);
  }
  return out;
}

/**
 * 自定义模型（手动添加）—— 服务器模型列表之外的内测/测试模型。
 *
 * 背景：模型下拉从服务商 /models 拉取（codem-dynamic-models），内测模型
 * （如 deepseek-v4.1-flash-expires-on-0910）不在列表内、无法选择。
 * 本模块允许按 provider 手动登记模型名，并在动态模型列表加载/展示时合并，
 * 使其与服务器模型同路径进入模型选择器（运行时窗口由 loadDynamicModels 的
 * 迁移逻辑按模型 id 前缀推断）。
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";

export interface CustomModel {
  /** 归属 provider id（与 settings.providers / engine providers 一致，如 'deepseek'） */
  provider: string;
  /** 模型名（如 deepseek-v4.1-flash-expires-on-0910） */
  name: string;
  addedAt: number;
}

const KEY = "codem-custom-models";

export function getCustomModels(): CustomModel[] {
  try {
    const raw = getSettingJSON<unknown>(KEY, []);
    if (!Array.isArray(raw)) return [];
    return (raw as CustomModel[]).filter(
      (c) => c && typeof c.provider === "string" && c.provider && typeof c.name === "string" && c.name,
    );
  } catch {
    return [];
  }
}

function saveCustomModels(list: CustomModel[]): void {
  try {
    setSettingJSON(KEY, list);
  } catch { /* 忽略写入失败 */ }
}

/** 添加自定义模型；同名同 provider 已存在返回 false */
export function addCustomModel(provider: string, name: string): boolean {
  const n = (name || "").trim();
  if (!provider || !n) return false;
  const list = getCustomModels();
  if (list.some((c) => c.provider === provider && c.name === n)) return false;
  list.push({ provider, name: n, addedAt: Date.now() });
  saveCustomModels(list);
  return true;
}

export function removeCustomModel(provider: string, name: string): void {
  const list = getCustomModels().filter((c) => !(c.provider === provider && c.name === name));
  saveCustomModels(list);
}

/** 某 provider 已登记的自定义模型名 */
export function customNamesFor(providerId: string): string[] {
  return getCustomModels()
    .filter((c) => c.provider === providerId)
    .map((c) => c.name);
}

/** 轻量模型形态（与动态模型列表兼容） */
export interface LightModel {
  id?: string;
  name: string;
  contextWindow?: number;
}

/**
 * 把自定义模型合并进按 provider 分组的动态模型列表。
 * 返回新对象，不修改入参。同名(id 或 name)跳过。
 */
export function mergeCustomModels<T extends LightModel>(stored: Record<string, T[]>): Record<string, T[]> {
  const customs = getCustomModels();
  if (customs.length === 0) return stored;
  const out: Record<string, T[]> = {};
  for (const [pid, list] of Object.entries(stored || {})) {
    out[pid] = Array.isArray(list) ? [...list] : [];
  }
  for (const c of customs) {
    const list = out[c.provider] || [];
    const hit = list.some((m) => m.id === c.name || m.name === c.name);
    if (!hit) {
      list.push({ id: c.name, name: c.name } as T);
    }
    out[c.provider] = list;
  }
  return out;
}

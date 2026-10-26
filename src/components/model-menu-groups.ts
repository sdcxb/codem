/**
 * 模型菜单的**来源分组**（P1-2）。
 *
 * 为什么不按计划里的 Default/Fast/Thinking/Vision 分：
 * Codem 的 `ModelOption` 只有 `id/name`，没有权威的 role 字段；按模型名猜角色
 * 会把 `gpt-4o`、`o3`、`deepseek-v4-pro` 这类模型贴错标签，属于**伪造元数据**。
 * 这里只按可证明的来源分（免费插件 / DeepSeek / Anthropic / OpenAI / Gemini / Moonshot / MiMo），
 * 选中态用 check，未知模型折叠到「更多模型」。
 */

import type { ModelProfile, TaskSlot } from "../core/llm/model-profile";

export type ModelFamily = "free" | "deepseek" | "anthropic" | "openai" | "gemini" | "moonshot" | "mimo" | "other";

/** 槽位的展示顺序：主对话永远排第一，用户一眼知道“当前聊天用的是哪个”。 */
export const MODEL_ROLE_ORDER: TaskSlot[] = ["chat", "subagent", "memory", "compaction", "vision"];

/**
 * 当前档案里这个模型承担了哪些槽位。
 * 这是**档案的分配关系**，不是模型固有属性；同一模型可以拿多个角色。
 */
export function modelRoleSlots(profile: Pick<ModelProfile, "slots">, modelId: string): TaskSlot[] {
  return MODEL_ROLE_ORDER.filter((slot) => profile.slots[slot]?.model === modelId);
}

export interface ModelLike {
  id: string;
  name: string;
}

export interface ModelGroup<T extends ModelLike> {
  family: ModelFamily;
  models: T[];
}

/** 从 id 推断来源；只用于**分组展示**，不改变模型身份/请求参数。 */
export function modelFamily(id: string): ModelFamily {
  const lower = id.toLowerCase();
  if (lower.startsWith("deepseek")) return "deepseek";
  if (lower.startsWith("claude") || lower.startsWith("anthropic")) return "anthropic";
  if (lower.startsWith("gpt") || /^o[134](?:-|$)/.test(lower)) return "openai";
  if (lower.startsWith("gemini")) return "gemini";
  if (lower.startsWith("moonshot")) return "moonshot";
  if (lower.startsWith("mimo")) return "mimo";
  return "other";
}

const ORDER: ModelFamily[] = ["free", "deepseek", "anthropic", "openai", "gemini", "moonshot", "mimo", "other"];

/**
 * 按来源分组，保持组内原顺序。
 * 免费插件模型优先；来源未知的归入 other，不丢模型。
 */
export function groupModelsByFamily<T extends ModelLike>(
  models: T[],
  isFree: (id: string) => boolean,
): Array<ModelGroup<T>> {
  const buckets = new Map<ModelFamily, T[]>();
  for (const model of models) {
    const family = isFree(model.id) ? "free" : modelFamily(model.id);
    const bucket = buckets.get(family);
    if (bucket) bucket.push(model);
    else buckets.set(family, [model]);
  }
  return ORDER
    .filter((family) => (buckets.get(family)?.length ?? 0) > 0)
    .map((family) => ({ family, models: buckets.get(family)! }));
}

/** 服务器没给名字/名字被标记未知时，归入「更多模型」而不是首屏铺满。 */
export function isUnknownModelName(name: string): boolean {
  return name.includes("【未知】") || name.trim() === "" || name.trim().toLowerCase() === "unknown";
}

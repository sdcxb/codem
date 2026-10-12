/**
 * 「哪些模型 id 由内置免费模型插件提供」的**唯一索引**（第 206 波）。
 *
 * ## 为什么单独一个模块（而不是放进 service.ts）
 *
 * 引擎（`core/llm/index.ts`）在**同步**路径上要回答"这个模型是不是插件的"，而
 * `free-model-plugin/service.ts` 已经会（动态）依赖引擎 ⇒ 让引擎静态 import service 会绕成环。
 * 这里只存一个 id 集合，谁都能安全地 import；service 每次刷新清单时同步它。
 *
 * ## 它解决什么（用户实报）
 *
 * > 选择其中一个 free 模型，对话，提示：执行出错 [Error] openai not configured.
 *
 * 原因：档案槽位里记的供应商还是 `openai`，用户选的却是插件给的免费模型 ⇒ 请求发去了 openai。
 * 有了这张索引，引擎就能**按模型归属**把 provider 覆盖成 `free-model`（密钥由插件在启动时
 * 运行时注册，用户不需要配任何 Key）。
 */
/** 托管供应商的 id（引擎与插件共用同一份，避免两处写死字符串） */
export const MANAGED_FREE_MODEL_PROVIDER_ID = "free-model";

const freeModelIds = new Set<string>();

/** 插件刷新清单时同步一次（清空 + 重建，保证不残留已下线的模型） */
export function setFreeModelIds(ids: readonly string[]): void {
  freeModelIds.clear();
  for (const id of ids) if (typeof id === "string" && id) freeModelIds.add(id);
}

/** 这个模型是不是内置插件提供的（引擎同步路径上用它决定 provider） */
export function isFreeModelId(modelId: string | null | undefined): boolean {
  if (typeof modelId !== "string" || !modelId) return false;
  return freeModelIds.has(modelId);
}

/**
 * **按模型归属覆盖 provider**（纯函数，引擎的 resolveSlot 就调它）。
 *
 * 抽成纯函数的理由：原来这段判断长在引擎的同步路径里，判据只能"扫源码里有没有这段字"——
 * 而扫源码是**抓不住行为退化的**（第 206 波的 MUT-1 就是这么漏网的：给条件加个 `false &&`，
 * 字符串仍在、判据照样绿）。抽出来之后判据能直接断言"这个输入必须得到那个输出"。
 */
export function routeProviderForModel<T extends { providerId: string; modelId: string }>(resolved: T): T {
  if (isFreeModelId(resolved.modelId) && resolved.providerId !== MANAGED_FREE_MODEL_PROVIDER_ID) {
    return { ...resolved, providerId: MANAGED_FREE_MODEL_PROVIDER_ID };
  }
  return resolved;
}

/**
 * **从"当前设置 + 已登记的供应商"算出这次该用哪个模型 / 哪个供应商**（纯函数，第 208 波）。
 *
 * 为什么要有它：用户选了免费模型却发去 deepseek/openai —— 因为引擎手里那份 `config.defaultModel`
 * 是**启动时抄下来的副本**，设置里改了它并不知道（真机日志：`slot=chat → fallback:
 * provider=deepseek, model=deepseek-flash`，而设置里已经被改成免费模型）。设置是**唯一真相**，
 * 引擎每次兜底都该现读现算，而不是信自己的旧副本。
 *
 * @param model 设置里的模型 id（用户在模型管理 / 选择器里选的）
 * @param providers 已登记的供应商 id 列表（用于判断"这个模型属于哪家"）
 * @param fallback 设置里没有模型时的兜底（保持原行为）
 */
export function resolveModelSelection(
  model: string | null | undefined,
  providers: readonly string[],
  fallback: { providerId: string; modelId: string },
): { providerId: string; modelId: string } {
  if (typeof model !== "string" || !model) return fallback;
  /* ① 插件提供的免费模型 ⇒ 走插件（不需要任何 Key） */
  if (isFreeModelId(model)) return { providerId: MANAGED_FREE_MODEL_PROVIDER_ID, modelId: model };
  /* ② 否则按"哪个供应商认得这个模型"来定；认不出就沿用兜底的供应商（模型仍然要听设置的） */
  const owned = providers.find((p) => model.startsWith(`${p}-`) || model.includes(p));
  return { providerId: owned ?? fallback.providerId, modelId: model };
}

/** 判据用：读当前索引（只读快照） */
export function freeModelIdSnapshot(): string[] {
  return [...freeModelIds];
}

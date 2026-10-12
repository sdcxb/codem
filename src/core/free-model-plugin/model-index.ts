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

/* ==========================================================================
 * 第 215 波：**模型可用性**（用户实报）
 *
 * > 我刷新了【Our Free Model（免费模型插件）】模型列表选择 ling-3.1-flash-free 并对话，提示执行出错…
 * > 如果失败，为什么刷新还能从列表里刷出来？刷新不应该测一下能否通，是不是真的存在？
 *
 * 事实：`catalog.json`（刷新的数据源）只有目录，**没有任何"能不能通"的字段**；插件自己的
 * `stats.json` 只记**事后**的 calls/failed。所以"刷出来"从来只等于"上游目录里有它"，不等于"它能用"。
 *
 * 这一节提供**可用性事实的来源**（都在这里、都可判据）：
 * ① 主动探测的结果（用户点「检测可用性」）；
 * ② 真实调用撞到"上游模型不可用"时的回写（零成本，越用越准）。
 *
 * ## 为什么必须带时间戳（这条是设计约束，不是细节）
 *
 * "能不能通"**随时间变**（上游端点会挂、也会恢复）。把某次结果当成**永久属性**就会出现
 * "明明恢复了却永远标着不可用" ✗。所以每条记录都带 `at`，并且只有 **N 分钟内的**结论才作数
 * （`HEALTH_TTL_MS`），过期一律视为"未知"（不标注、不劝退）。
 * ========================================================================== */

/** 可用性结论的新鲜期：超过它就视为"未知"（上游会恢复，旧结论不该继续劝退用户） */
export const HEALTH_TTL_MS = 30 * 60 * 1000;

export interface FreeModelHealth {
  /** true=最近一次探测/调用成功；false=最近一次失败 */
  ok: boolean;
  /** 结论时间（毫秒时间戳）—— 过期即"未知" */
  at: number;
  /** 失败原因（截断保存，便于界面告知） */
  error?: string;
}

const health = new Map<string, FreeModelHealth>();

/** 记一条结论（探测与真实调用都走这里；同时用于持久化回灌） */
export function recordFreeModelHealth(modelId: string, entry: FreeModelHealth): void {
  if (typeof modelId !== "string" || !modelId) return;
  health.set(modelId, { ok: !!entry.ok, at: Number(entry.at) || Date.now(), ...(entry.error ? { error: String(entry.error).slice(0, 200) } : {}) });
}

/**
 * 从**错误文案**记一条"不可用"（真实调用失败时调用，零成本）。
 *
 * 只在文案命中"上游模型级失败"时才记 —— 否则用户自己的网络抖动、Key 配错都会被记成
 * "这个模型不可用"，那是**把别人的问题算到模型头上** ✗。
 */
export function markFreeModelUnavailableFromError(modelId: string, message: string): boolean {
  if (!isFreeModelId(modelId)) return false;
  if (!isUpstreamModelFailure(message)) return false;
  recordFreeModelHealth(modelId, { ok: false, at: Date.now(), error: message.slice(0, 200) });
  return true;
}

/** 记一条"可用"（探测成功时调用） */
export function markFreeModelAvailable(modelId: string): void {
  recordFreeModelHealth(modelId, { ok: true, at: Date.now() });
}

/** 上游**模型级**失败的原话特征（探测与真实调用共用同一套判据，避免两处口径分叉） */
const UPSTREAM_MODEL_FAILURE_MARKERS = [
  /endpoint is unavailable/i,
  /access has been restricted due to repeated policy violations/i,
  /model does not support this protocol/i,
  /upstream request failed/i,
];

/** 这段文案是不是"上游那个模型此刻不可用"（纯函数） */
export function isUpstreamModelFailure(message: string): boolean {
  if (typeof message !== "string" || !message) return false;
  return UPSTREAM_MODEL_FAILURE_MARKERS.some((re) => re.test(message));
}

/** 读某模型**此刻有效**的结论（过期 ⇒ null=未知，界面就不标注、不劝退） */
export function freeModelHealthOf(modelId: string, now = Date.now()): FreeModelHealth | null {
  const entry = health.get(modelId);
  if (!entry) return null;
  if (!Number.isFinite(entry.at) || now - entry.at > HEALTH_TTL_MS) return null;
  return entry;
}

/** 界面用：这个模型此刻是否**已知不可用**（过期或没结论都返回 false） */
export function isFreeModelKnownUnavailable(modelId: string, now = Date.now()): boolean {
  const entry = freeModelHealthOf(modelId, now);
  return !!entry && entry.ok === false;
}

/**
 * 界面用：给模型名加"当前不可用"后缀（没有结论或结论过期 ⇒ 返回空串，**不标注也不劝退**）。
 *
 * 抽成一个函数是为了让**设置里的模型列表**与**对话里的模型选择器**用同一口径 ——
 * 两处各写一份判断，迟早会出现"一个说不可用、一个说可用" ✗。
 */
export function freeModelUnavailableSuffix(modelId: string, lang: "zh" | "en" = "zh", now = Date.now()): string {
  if (!isFreeModelKnownUnavailable(modelId, now)) return "";
  const entry = freeModelHealthOf(modelId, now);
  const minutes = entry ? Math.max(0, Math.round((now - entry.at) / 60000)) : 0;
  return lang === "zh" ? `（当前不可用 · ${minutes} 分钟前检测）` : ` (unavailable · checked ${minutes}m ago)`;
}

/** 判据/持久化用：读全部记录（含过期的，便于原样存盘） */
export function freeModelHealthSnapshot(): Record<string, FreeModelHealth> {
  return Object.fromEntries(health.entries());
}

/** 判据/AI 主机用：清空（用例之间不许串味） */
export function clearFreeModelHealth(): void {
  health.clear();
}

export interface ProbeResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** 把一批探测结果汇总成一句人读的话（纯函数：界面与判据共用同一口径） */
export function summarizeProbe(results: readonly ProbeResult[]): {
  total: number;
  ok: number;
  failed: number;
  unavailable: string[];
  text: { zh: string; en: string };
} {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const unavailable = results.filter((r) => !r.ok).map((r) => r.id);
  return {
    total: results.length,
    ok,
    failed,
    unavailable,
    text: {
      zh: failed === 0 ? `检测完成：${ok} 个模型全部可用` : `检测完成：${ok}/${results.length} 个可用，${failed} 个当前不可用`,
      en: failed === 0 ? `Checked: all ${ok} models are available` : `Checked: ${ok}/${results.length} available, ${failed} unavailable`,
    },
  };
}


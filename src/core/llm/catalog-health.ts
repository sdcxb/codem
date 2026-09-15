/**
 * 内置目录条目的**实证健康状态**（第 81 波）
 *
 * ## 为什么需要（用户提问）
 *
 * 「内置的话如果供应商改名了怎么办？」—— 问得对。内置目录是我们**写死**的名单，
 * 它有两种失效方式：
 *
 *   ① **别名失效**：供应商改名（`deepseek-v4-flash` → `deepseek-flash`），目录里还留着旧名
 *      → 界面出现重复/多余条目。这一层已用 `aliases` 去重解决（见 model-catalog.ts）。
 *   ② **真失效**：供应商把这个模型下线，或又改了一次名，而新名字我们根本没写进目录
 *      → 下拉里留着一个**永远调不通的死选项**，用户点了才发现，且看不出原因。
 *
 * 本模块解决第 ② 种：**不信推测，只记实证** —— 用户真正调用过、而服务器明确回
 * "不认识这个模型名"（`isUnknownModelError`）时，把这条**落盘记下来**；之后：
 *
 *   · 下拉里如实标注「服务器已不接受此名字（时间 + 服务器原话）」；
 *   · 列表排序把失效的条目沉到末尾（不删除 —— 供应商可能改回来）；
 *   · 一旦某次调用成功，标记**自动清除**（证据翻转，结论翻转）。
 *
 * 反面参照：DSH 的模型表是纯静态目录（`dsh-llm-deepseek` 的 `DEFAULT_MODELS`，
 * `listModels()` 根本不请求服务器），它对"目录过期"的处理是**不处理** ——
 * 好处是未知 id 照样放行（目录只是建议，见其 `modelInfoFor` 用中性默认值兜底），
 * 代价是目录里的死条目会一直挂着。Codem 的取舍：服务器列表是事实来源 + 目录兜底 + 实证标记。
 *
 * 只记"模型名不对"这一类错误。网络失败、401、429、上下文超限一律不记 —— 那些与名字无关，
 * 记了会冤枉一个能用的模型。
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { isUnknownModelError } from "./provider-errors";

const HEALTH_KEY = "codem-catalog-health";
/** 单个 provider 最多保留多少条记录（防止无限增长） */
const MAX_ENTRIES_PER_PROVIDER = 80;
/** 记录的有效期：过期即作废（供应商可能早已改回来，旧结论不该永远有效） */
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 落盘的服务器原话最长保留多少字符 */
const DETAIL_MAX = 240;

/** 变更广播（设置面板据此重绘标注；与 codem:db-save-failed 等同一套 window 事件风格） */
export const CATALOG_HEALTH_EVENT = "codem:catalog-health-changed";

export interface CatalogHealthEntry {
  /** ok = 最近一次调用成功；rejected = 服务器明确拒绝了这个模型名 */
  status: "ok" | "rejected";
  /** 该结论的时间戳（ms） */
  at: number;
  /** 服务器原话（截断），仅 rejected 有 */
  detail?: string;
}

export type CatalogHealthMap = Record<string, Record<string, CatalogHealthEntry>>;

let cache: CatalogHealthMap | null = null;

/** 把任意来源的数据收拾成合法结构（坏数据丢弃，绝不让它把界面带崩） */
function sanitize(raw: unknown): CatalogHealthMap {
  const out: CatalogHealthMap = {};
  if (!raw || typeof raw !== "object") return out;
  const now = Date.now();
  for (const [pid, models] of Object.entries(raw as Record<string, unknown>)) {
    if (!pid || !models || typeof models !== "object") continue;
    const kept: Record<string, CatalogHealthEntry> = {};
    for (const [mid, entry] of Object.entries(models as Record<string, unknown>)) {
      if (!mid) continue;
      const e = entry as Partial<CatalogHealthEntry> | null;
      if (!e || typeof e !== "object") continue;
      if (e.status !== "ok" && e.status !== "rejected") continue;
      if (typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
      if (now - e.at > ENTRY_TTL_MS) continue;
      kept[mid.toLowerCase()] = {
        status: e.status,
        at: e.at,
        ...(typeof e.detail === "string" && e.detail ? { detail: e.detail.slice(0, DETAIL_MAX) } : {}),
      };
    }
    if (Object.keys(kept).length > 0) out[pid] = kept;
  }
  return out;
}

function readStore(): CatalogHealthMap {
  if (cache) return cache;
  let raw: unknown = {};
  try {
    raw = getSettingJSON<unknown>(HEALTH_KEY, {});
  } catch {
    raw = {};
  }
  cache = sanitize(raw);
  return cache;
}

function persist(next: CatalogHealthMap): void {
  cache = next;
  try {
    setSettingJSON(HEALTH_KEY, next);
  } catch {
    // 存不下也不影响本轮运行：下一次请求照样会重新记录
  }
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(CATALOG_HEALTH_EVENT));
    }
  } catch {
    /* 无 window（测试/SSR）时静默 */
  }
}

/**
 * 保留最近的 N 条，避免无上限增长。
 *
 * 坑（全量跑用例时暴露）：`at` 的精度是毫秒，**同一毫秒内写入的多条时间戳完全相同**，
 * 只按 `at` 排序时谁被丢掉就看排序实现的心情了（稳定排序 → 丢掉的反而是最新的几条）。
 * 所以：先按**写入顺序反转**（新的在后 → 反转后新的在前），再按 `at` 降序稳定排序 ——
 * 时间戳打平时保留的就是"最近写入的那些"，与调用方语义一致。
 */
function capBucket(bucket: Record<string, CatalogHealthEntry>): Record<string, CatalogHealthEntry> {
  const entries = Object.entries(bucket);
  if (entries.length <= MAX_ENTRIES_PER_PROVIDER) return bucket;
  const newestFirst = entries.reverse();
  newestFirst.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(newestFirst.slice(0, MAX_ENTRIES_PER_PROVIDER).reverse());
}

/** 读取某条模型的健康记录（没有则 undefined = 尚无可信证据） */
export function getCatalogHealth(providerId: string, modelId: string): CatalogHealthEntry | undefined {
  if (!providerId || !modelId) return undefined;
  return readStore()[providerId]?.[modelId.toLowerCase()];
}

/** 服务器是否明确拒绝过这个模型名 */
export function isCatalogModelRejected(providerId: string, modelId: string): boolean {
  return getCatalogHealth(providerId, modelId)?.status === "rejected";
}

/** 一个 provider 的全部记录（界面批量标注用） */
export function getCatalogHealthFor(providerId: string): Record<string, CatalogHealthEntry> {
  if (!providerId) return {};
  return readStore()[providerId] || {};
}

/** 一次调用成功 → 若之前有过拒绝标记，现在撤销（证据翻转，结论翻转） */
export function recordCatalogSuccess(providerId: string, modelId: string): void {
  if (!providerId || !modelId) return;
  const key = modelId.toLowerCase();
  const store = readStore();
  // 常态（本来就已经是 ok）不写盘 —— 每次请求都动 localStorage 是纯浪费
  if (store[providerId]?.[key]?.status === "ok") return;
  persistRecord(store, providerId, key, { status: "ok", at: Date.now() });
}

function persistRecord(
  store: CatalogHealthMap,
  providerId: string,
  key: string,
  entry: CatalogHealthEntry,
): void {
  const bucket = capBucket({ ...(store[providerId] || {}), [key]: entry });
  persist({ ...store, [providerId]: bucket });
}

/**
 * 记一次"服务器拒绝了这个模型名"。
 * @returns 是否真的记下了（非模型名类错误返回 false，调用方可据此做别的处理）
 */
export function recordCatalogRejection(
  providerId: string,
  modelId: string,
  detail: string | undefined,
  status?: number,
): boolean {
  if (!providerId || !modelId) return false;
  if (!isUnknownModelError(detail, status)) return false;
  const store = readStore();
  persistRecord(store, providerId, modelId.toLowerCase(), {
    status: "rejected",
    at: Date.now(),
    ...(extractServerMessage(detail) ? { detail: extractServerMessage(detail) } : {}),
  });
  return true;
}

/** 从 `API error 400: {"error":{"message":"…"}}` 里抽出服务器那句人话 */
export function extractServerMessage(raw: string | undefined): string {
  if (!raw) return "";
  let text = raw.trim();
  // 去掉我们自己加的前缀
  text = text.replace(/^API\s+error\s+\d{3}\s*:\s*/i, "");
  // 尽量取 JSON 里的 message 字段（拿不到就原样用）
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
      if (typeof msg === "string" && msg.trim()) text = msg;
    } catch {
      /* 不是完整 JSON，保留原文 */
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX);
}

/** 给界面用的一句话说明（rejected 时给出时间与服务器原话） */
export function describeCatalogHealth(entry: CatalogHealthEntry | undefined): string {
  if (!entry) return "";
  const when = formatWhen(entry.at);
  if (entry.status === "rejected") {
    return `上次调用（${when}）被服务器拒绝该模型名${entry.detail ? `：${entry.detail}` : ""}`;
  }
  return `上次调用（${when}）成功`;
}

function formatWhen(at: number): string {
  try {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "未知时间";
  }
}

/**
 * 下拉里的**来源后缀**（用户看到的结论，必须分得清来源）。
 *
 * 铁律：**服务器自己列出来的模型被拒时，不许说"内置目录"** —— 那是另一回事
 * （服务器列表与真实可调用集合不一致，或只是这次请求别的问题），
 * 措辞错了用户会拿着错结论去查错地方。
 */
export function catalogModelLabelSuffix(opts: { catalogOnly?: boolean; rejected?: boolean }): string {
  const { catalogOnly, rejected } = opts;
  if (rejected) return catalogOnly ? "（内置目录，服务器已拒绝此名字）" : "（服务器已拒绝此名字）";
  return catalogOnly ? "（内置目录，服务器未列出）" : "";
}

/**
 * 给界面用的排序：**被服务器拒绝过的条目沉到末尾**（其它保持服务器给的顺序）。
 *
 * 为什么不直接删掉：供应商可能改回名字、可能只是临时灰度；删了用户就再也看不到它，
 * 而"沉底 + 标注"既不会误导（默认选不到），也留着恢复的路。
 */
export function orderModelsByHealth<T extends { id: string }>(providerId: string, models: T[]): T[] {
  if (!Array.isArray(models) || models.length < 2) return Array.isArray(models) ? models : [];
  const health = getCatalogHealthFor(providerId);
  const rank = (m: T) => (health[m.id.toLowerCase()]?.status === "rejected" ? 1 : 0);
  // Array.sort 在现代 V8 里是稳定排序 → 非失效条目相对顺序不变
  return [...models].sort((a, b) => rank(a) - rank(b));
}

/** 订阅变更（返回取消订阅函数） */export function subscribeCatalogHealth(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(CATALOG_HEALTH_EVENT, handler);
  return () => window.removeEventListener(CATALOG_HEALTH_EVENT, handler);
}

/** 清空（测试与"重置诊断数据"用） */
export function clearCatalogHealth(): void {
  persist({});
}

/** 丢弃内存缓存，下次读取重新从存储加载（测试用） */
export function __resetCatalogHealthCache(): void {
  cache = null;
}

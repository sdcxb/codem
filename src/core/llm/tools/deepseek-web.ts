/**
 * DeepSeek Search / Fetch —— 官方「联网工具」接口的接入层。
 *
 * ## 为什么要单独一个模块
 *
 * `web-search.ts` 原先的三条后端（Gemini grounding / MiMo / 通用 LLM 检索）
 * **没有一条是真的搜索 API**：最后一条实际上就是"让模型凭记忆回答"，却被当成
 * 搜索结果交给模型 —— 判据与真机都见过它把过时信息当"检索到的事实"。
 * DeepSeek 新开放的 `POST /v1/tools/search`（真实检索）与 `POST /v1/tools/fetch`
 * （把页面正文取回成 Markdown）正好补上这一层。
 *
 * 这里只做两件事：**按官方字段逐字段映射**、**把错误翻成人话**。
 * 开关（是否启用、条数）也放在这里，因为它是"这个能力怎么用"的唯一真相；
 * 设置面板只负责写，工具只负责读，两边不各留一份解析逻辑。
 *
 * ## 官方接口事实（取自 api-docs.deepseek.com/zh-cn/guides/search/）
 *
 * - Base：`https://api.deepseek.com`；鉴权：`Authorization: Bearer <DeepSeek API Key>`
 *   —— **与聊天用的是同一个 Key**，所以这里复用设置里 `providers[id=deepseek]` 那一份，
 *   不新开一个密钥输入框（多一份密钥 = 多一处轮换遗漏）。
 * - Search 请求 `{ query, count?, ori_question?, localization?, need_content? }`；
 *   响应 `{ results: [{ rerank_score, title, url, snippet, summary, content, site_name,
 *   site_icon, date, authority }] }`，**无结果是空数组**（不是错误）。
 * - Fetch 请求 `{ url }`；响应 `{ title, content }`（title 缺失时为空串）。
 * - 错误是 OpenAI 兼容体 `{ error: { message, type, param, code } }`；状态码语义见
 *   `DEEPSEEK_STATUS_HINTS`。**408 / 429 / 5xx 值得等一会儿重试**（有限次），
 *   其它 4xx 重试只是白烧 QPS（402 尤其：重试永远不会变成"有钱"）。
 * - 计费口径：Search / Fetch **各自** 5 元 / 1000 次**成功**请求（Search 结果非空、
 *   Fetch 有正文才计费）；每个账号 Search 与 Fetch **各自独立** QPS 5。
 *   所以失败不重试到底、关闭时不发请求，都是在替用户省钱。
 *
 * ## 关于密钥的三条硬约束
 *
 * 1. 密钥只出现在 `Authorization` 头里，**绝不进日志/错误文案**（判据
 *    `DSWEB-3-4` 用 spy 断言错误信息里不含它）；
 * 2. 错误文案里只放**状态码 + 官方 message**，不放请求头、不放 body；
 * 3. 401 的提示直接指向"去哪改"，否则用户只会看到一句"失败"。
 */

import type { ToolDef, ToolExecuteResult } from "../tools";
import { getSetting, getSettingJSON, setSetting } from "../../storage/settings";
import { fetchWithTimeout } from "../../utils/fetch-with-timeout";

// ========== 设置键（读写两侧都只认这里） ==========

/** 「网页搜索（DeepSeek Search）」开关；`"1"` 开 / 其它一律按关（缺省=关） */
const DEEPSEEK_SEARCH_ENABLED_KEY = "codem-deepseek-web-search";
/** 「网页抓取（DeepSeek Fetch）」开关；同上 */
const DEEPSEEK_FETCH_ENABLED_KEY = "codem-deepseek-web-fetch";
/** 每次搜索要几条结果（1..50，缺省 10） */
const DEEPSEEK_SEARCH_COUNT_KEY = "codem-deepseek-web-search-count";

/**
 * 默认条数取 10 —— 不是拍的：官方默认值就是 10，而 `summary` 每条 600~800 字，
 * 10 条已经是"给模型看"的合理上界（再多会把上下文占满、且单次请求更慢）。
 */
export const DEEPSEEK_DEFAULT_SEARCH_COUNT = 10;
/** 官方上限：count ∈ 1..50 */
export const DEEPSEEK_MAX_SEARCH_COUNT = 50;
/** 官方上限：query 1..128 字 */
const DEEPSEEK_MAX_QUERY_CHARS = 128;
/** 官方上限：url ≤ 8192 */
const DEEPSEEK_MAX_URL_CHARS = 8192;
/**
 * Fetch 正文截断上限（按**字符**计，不是字节）。
 *
 * 为什么要有：Fetch 返回的是整页 Markdown，实测几万字的长文会直接吃掉上下文；
 * 而"截断"必须**明确告诉模型**（见 `DEEPSEEK_FETCH_TRUNCATION_NOTE`），
 * 否则模型会把"只看到前 20 KB"当成"这页就这么多内容"，据此写出错误结论。
 */
const DEEPSEEK_FETCH_MAX_CONTENT_CHARS = 20000;

/** 缺省 Base URL（设置里 provider 没配时兜底，与 SettingsPanel 的内置默认值一致） */
const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/** 有限重试：1 次首试 + 2 次重试 = 最多 3 次请求 */
const MAX_RETRIES = 2;
/** 退避基数（第 n 次重试等 n × 该值）—— 测试可覆盖成 0 秒 */
const RETRY_BASE_DELAY_MS = 500;
/** 单次请求超时：Search 要等服务端检索 + 生成 summary，20 秒偏紧 */
const REQUEST_TIMEOUT_MS = 30_000;

// ========== 类型定义 ==========

/** Search 的一条结果（官方字段的 camelCase 映射，`null` 原样保留） */
export interface DeepSeekSearchHit {
  title: string;
  url: string;
  snippet: string;
  /**
   * 官方 summary：600~800 字，**明确"适合给模型"** —— 所以它进 `web_search` 的输出，
   * 与 snippet（100~200 字，给人看）并存。
   */
  summary: string;
  /** 正文；`need_content=false` 时官方恒返回空串 */
  content: string;
  /** `null` = 官方没给（不是空串：空串会被误读成"该站点没有名字"） */
  siteName: string | null;
  siteIcon: string | null;
  /** RFC3339 UTC；`null` = 未知 */
  date: string | null;
  /** 0..4，`-1` = 未知，≥3 = 极权威 */
  authority: number;
  /** 0..3，≥1.5 视为优质（官方口径） */
  rerankScore: number;
}

interface DeepSeekSearchOptions {
  /** 条数；缺省用设置里的 count（再缺省 10） */
  count?: number;
  /** 原始问题（≤128 字）；用于帮助检索理解上下文 */
  oriQuestion?: string;
  /** 地域/语言倾向，原样透传（官方未给出枚举，别自己编） */
  localization?: string;
  /** 是否要正文；缺省 false（此时官方 content 恒为空） */
  needContent?: boolean;
  /** 重试退避基数（毫秒）；测试传 0 以免拖慢 */
  retryBaseDelayMs?: number;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
}

interface DeepSeekFetchResult {
  /** 实际请求的 URL（回显给模型，便于它核对抓的是哪一页） */
  url: string;
  title: string;
  /** 已截断的正文（截断时带明确注记） */
  content: string;
  truncated: boolean;
  /** 官方返回的正文总字数（截断前） */
  totalChars: number;
}

export interface DeepSeekWebConfig {
  apiKey: string;
  baseUrl: string;
  searchEnabled: boolean;
  fetchEnabled: boolean;
  searchCount: number;
}

// ========== 设置读写 ==========

interface ProviderLike {
  id?: string;
  apiKey?: string;
  baseUrl?: string;
}

function readDeepSeekProvider(): { apiKey: string; baseUrl: string } {
  let providers: ProviderLike[] = [];
  try {
    const stored = getSettingJSON<{ providers?: ProviderLike[] } | null>("codem-settings", null);
    if (stored && Array.isArray(stored.providers)) providers = stored.providers;
  } catch (e) {
    // 读不到就是"没配"：后面的报错会明确说"未配置 Key"，不会拿一个空 Key 去请求
    console.warn("[deepseek-web] 读取 codem-settings 失败：", e);
  }
  const deepseek = providers.find((p) => p && p.id === "deepseek");
  const apiKey = typeof deepseek?.apiKey === "string" ? deepseek.apiKey.trim() : "";
  const baseUrl =
    typeof deepseek?.baseUrl === "string" && deepseek.baseUrl.trim()
      ? deepseek.baseUrl.trim()
      : DEEPSEEK_DEFAULT_BASE_URL;
  return { apiKey, baseUrl };
}

function clampSearchCount(value: number): number {
  if (!Number.isFinite(value)) return DEEPSEEK_DEFAULT_SEARCH_COUNT;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > DEEPSEEK_MAX_SEARCH_COUNT) return DEEPSEEK_MAX_SEARCH_COUNT;
  return n;
}

/**
 * 读当前配置（四个开关值 + 复用的 DeepSeek 凭证）。
 *
 * 工具侧与设置面板都走这一个入口：面板要显示"实际使用的 base URL"，
 * 而"实际使用"必须与工具真正请求的**同一条解析链**（`resolveDeepSeekToolEndpoint`），
 * 否则面板上写的地址和真正打出去的地址可以不一样 —— 那种不一致没人能查。
 */
export function readDeepSeekWebConfig(): DeepSeekWebConfig {
  const provider = readDeepSeekProvider();
  let searchEnabled = false;
  let fetchEnabled = false;
  let searchCount = DEEPSEEK_DEFAULT_SEARCH_COUNT;
  try {
    searchEnabled = getSetting(DEEPSEEK_SEARCH_ENABLED_KEY) === "1";
    fetchEnabled = getSetting(DEEPSEEK_FETCH_ENABLED_KEY) === "1";
    const rawCount = getSetting(DEEPSEEK_SEARCH_COUNT_KEY);
    const parsedCount = rawCount === null ? Number.NaN : Number.parseInt(rawCount, 10);
    searchCount = Number.isFinite(parsedCount) ? clampSearchCount(parsedCount) : DEEPSEEK_DEFAULT_SEARCH_COUNT;
  } catch (e) {
    console.warn("[deepseek-web] 读取开关失败（按默认值：两个开关关闭、条数 10）：", e);
  }
  return { apiKey: provider.apiKey, baseUrl: provider.baseUrl, searchEnabled, fetchEnabled, searchCount };
}

/** 写「网页搜索」开关（设置面板用；立即落库，不等「保存」） */
export function setDeepSeekSearchEnabled(enabled: boolean): void {
  setSetting(DEEPSEEK_SEARCH_ENABLED_KEY, enabled ? "1" : "0");
}

/** 写「网页抓取」开关 */
export function setDeepSeekFetchEnabled(enabled: boolean): void {
  setSetting(DEEPSEEK_FETCH_ENABLED_KEY, enabled ? "1" : "0");
}

/** 写搜索条数（1..50，越界自动夹紧） */
export function setDeepSeekSearchCount(count: number): void {
  setSetting(DEEPSEEK_SEARCH_COUNT_KEY, String(clampSearchCount(count)));
}

/**
 * Base URL → 工具接口的**根**（`…/v1`）。
 *
 * 设置里的 provider baseUrl 是 **聊天** 用的形态（`https://api.deepseek.com/v1`），
 * 而工具接口是 `/v1/tools/search`。直接拼 `/tools/search` 在 baseUrl 带 `/v1` 时正确，
 * 但用户把 baseUrl 改成 `https://api.deepseek.com` 就会打到 `/tools/search`（404）。
 * 所以按"去掉尾部斜杠，缺 `/v1` 就补上"归一 —— 两个形态都正确。
 */
function resolveDeepSeekToolRoot(baseUrl: string): string {
  const trimmed = (baseUrl || DEEPSEEK_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function resolveDeepSeekToolEndpoint(baseUrl: string, tool: "search" | "fetch"): string {
  return `${resolveDeepSeekToolRoot(baseUrl)}/tools/${tool}`;
}

/** 面板上展示"实际使用的 base URL"用的同一份解析（只读展示，不参与请求） */
export function deepseekToolBaseUrl(baseUrl: string): string {
  return resolveDeepSeekToolRoot(baseUrl);
}

// ========== 错误映射 ==========

/** 官方状态码语义（中文；含"下一步该做什么"） */
const DEEPSEEK_STATUS_HINTS: Record<number, string> = {
  400: "请求不合法（参数越界或格式不对）",
  401: "API Key 无效或已失效，请在「设置 → DeepSeek」里更新 API Key",
  402: "账户余额不足，请先充值（Search / Fetch 各 5 元/1000 次成功调用）",
  403: "被 DeepSeek 安全策略拒绝（目标站点不允许抓取，或内容受访问策略限制）",
  404: "没有取到可用内容（页面不存在，或该页没有可提取的正文）",
  408: "DeepSeek 读取请求体超时",
  413: "请求体过大，DeepSeek 拒绝接收",
  429: "超过 QPS 限制（Search 与 Fetch 各自独立 5 QPS），请稍后再试",
  500: "DeepSeek 服务器内部错误",
  502: "DeepSeek 网关错误",
  503: "DeepSeek 服务暂不可用",
  504: "DeepSeek 下游（检索 / 抓取后端）超时",
};

/** 408 / 429 / 5xx 值得等一会儿重试；其余 4xx（含 402）重试没有意义 */
function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

/** 从 OpenAI 兼容错误体里取官方 message（拿不到就返回空串，绝不合成一句假的） */
function extractOfficialMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

/**
 * 把已知 API Key（以及 `Bearer <key>` 形态）从一段文本里抹掉。
 *
 * 只做**已知值的精确替换**，不做"猜 sk- 前缀"：后者会把正文里本来是示例的
 * `sk-xxx` 也改掉（本仓在凭据普查上踩过同一类误伤，见 AGENTS §4）。
 */
function redactApiKey(text: string, apiKey: string): string {
  if (!text) return text;
  if (!apiKey || apiKey.length < 8) return text;
  const escaped = apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?:Bearer\\s+)?${escaped}`, "g"), "sk-***（已隐藏）");
}

function describeDeepSeekFailure(
  op: "Search" | "Fetch",
  status: number,
  payload: unknown,
  attempts: number,
  apiKey: string,
): string {
  const hint = DEEPSEEK_STATUS_HINTS[status] ?? "接口返回了未登记的失败状态";
  /**
   * 官方 message 是**服务端文本**，我们无法保证里面不回显请求头里的 Key
   * （见过把 `Authorization: Bearer …` 原样回显的网关）。所以这一段落一律先抹掉
   * 已知 Key 再拼进来 —— 我们自己不写 Key，也**不让别人的文本把它带出去**；
   * 而"我们自己拼的那几句"由判据 `DSWEB-3-6` 逐字钉住（不含 Key）。
   */
  const official = redactApiKey(extractOfficialMessage(payload), apiKey);
  /**
   * 重试次数**写进文案**：用户看到 429 时最想知道的是"等一会儿有没有用"，
   * 只写"失败"会让他以为客户端根本没等。次数也不假装更多/更少。
   */
  const retried = attempts > 1 ? `（已重试 ${attempts - 1} 次）` : "";
  return `DeepSeek ${op} 失败（HTTP ${status}）：${hint}${official ? `；官方说明：${official}` : ""}${retried}`;
}

/** 读 body 失败不能把原始响应体塞进错误里（可能有站点回显的敏感内容） */
async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一串不可读的 JSON 说明接口不是我们以为的那个东西 —— 明确报错，不猜 */
function parseSuccessBody<T>(op: "Search" | "Fetch", text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`DeepSeek ${op} 返回了无法解析的 JSON（HTTP 200）—— 请检查 Base URL 是否指向官方接口`);
  }
}

/**
 * 统一 POST（Search / Fetch 共用）。
 *
 * 重试只覆盖"等一会儿可能好"的情况：408 / 429 / 5xx，以及**网络层异常**（连接被掐、
 * 客户端超时）。且次数有限（`MAX_RETRIES`），退避递增。
 *
 * 为什么网络异常也重试：Search 一次要等服务端检索，偶发断连在这类长请求上很常见；
 * 但**不无限重试** —— 每次成功调用都要计费，无限重试等于替用户无限刷钱。
 */
async function postDeepSeekTool<T>(params: {
  op: "Search" | "Fetch";
  endpoint: string;
  apiKey: string;
  body: Record<string, unknown>;
  retryBaseDelayMs: number;
  timeoutMs: number;
}): Promise<T> {
  const { op, endpoint, apiKey, body, retryBaseDelayMs, timeoutMs } = params;
  let attempts = 0;
  let lastStatus = 0;
  let lastPayload: unknown = null;
  let lastNetworkError: unknown = null;

  for (;;) {
    attempts += 1;
    let response: Response | null = null;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Key 只在这一行出现，任何日志/错误都不带它
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
    } catch (e) {
      lastNetworkError = e;
      lastStatus = 0;
      lastPayload = null;
    }

    if (response && response.ok) {
      const text = await response.text();
      return parseSuccessBody<T>(op, text);
    }

    if (response) {
      lastStatus = response.status;
      lastPayload = await readJsonSafe(response);
      lastNetworkError = null;
      if (!isRetryableStatus(lastStatus)) {
        // 其它 4xx：重试只会再烧一次 QPS（402 再试一百次也还是没钱）
        throw new Error(describeDeepSeekFailure(op, lastStatus, lastPayload, attempts, apiKey));
      }
    }

    if (attempts > MAX_RETRIES) {
      if (lastStatus === 0) {
        const reason = lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError ?? "");
        throw new Error(
          `DeepSeek ${op} 网络请求失败（重试 ${MAX_RETRIES} 次后仍失败）：${reason}`,
        );
      }
      throw new Error(describeDeepSeekFailure(op, lastStatus, lastPayload, attempts, apiKey));
    }
    await sleep(retryBaseDelayMs * attempts);
  }
}

// ========== Search ==========

interface DeepSeekSearchResponse {
  results?: unknown;
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** 逐字段映射（缺字段不乱猜：字符串缺→空串，可空字段缺→null，数值缺→官方"未知"值） */
function mapSearchHit(raw: unknown): DeepSeekSearchHit {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    title: toStr(r.title),
    url: toStr(r.url),
    snippet: toStr(r.snippet),
    summary: toStr(r.summary),
    content: toStr(r.content),
    siteName: toNullableStr(r.site_name),
    siteIcon: toNullableStr(r.site_icon),
    date: toNullableStr(r.date),
    authority: typeof r.authority === "number" && Number.isFinite(r.authority) ? r.authority : -1,
    rerankScore: typeof r.rerank_score === "number" && Number.isFinite(r.rerank_score) ? r.rerank_score : 0,
  };
}

/**
 * 调 DeepSeek Search。默认条数 = 设置里的 count（缺省 10），默认不要正文。
 *
 * 空数组是**正常结果**（官方："无结果返回空数组"，不计费），不抛错。
 */
export async function deepseekSearch(
  query: string,
  options: DeepSeekSearchOptions = {},
): Promise<DeepSeekSearchHit[]> {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) {
    throw new Error("DeepSeek Search：query 不能为空");
  }
  if (q.length > DEEPSEEK_MAX_QUERY_CHARS) {
    // 不静默截断：截断会改掉用户的搜索意图，而模型会以为搜的就是它写的那些字
    throw new Error(
      `DeepSeek Search：query 共 ${q.length} 字，超过官方上限 ${DEEPSEEK_MAX_QUERY_CHARS} 字；请缩短后重试`,
    );
  }

  const config = readDeepSeekWebConfig();
  if (!config.apiKey) {
    throw new Error("DeepSeek Search：未配置 DeepSeek API Key（请在「设置 → DeepSeek」里填写并保存）");
  }

  const count = clampSearchCount(options.count ?? config.searchCount);
  const body: Record<string, unknown> = {
    query: q,
    count,
    // 显式写出来（而不是靠服务端默认）：默认值是我们承诺的行为，必须可被判据钉住
    need_content: options.needContent === true,
  };
  if (options.oriQuestion) body.ori_question = options.oriQuestion.slice(0, DEEPSEEK_MAX_QUERY_CHARS);
  if (options.localization) body.localization = options.localization;

  const payload = await postDeepSeekTool<DeepSeekSearchResponse>({
    op: "Search",
    endpoint: resolveDeepSeekToolEndpoint(config.baseUrl, "search"),
    apiKey: config.apiKey,
    body,
    retryBaseDelayMs: options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  });

  const results = payload && Array.isArray(payload.results) ? payload.results : [];
  return results.map(mapSearchHit);
}

// ========== Fetch ==========

interface DeepSeekFetchResponse {
  title?: unknown;
  content?: unknown;
}

/** 抓取正文被截断时追加的注记（模型必须看得见"后面的内容不在"） */
function deepseekFetchTruncationNote(totalChars: number): string {
  return (
    `\n\n---\n` +
    `[正文已截断] 官方返回 ${totalChars} 字，这里只保留前 ${DEEPSEEK_FETCH_MAX_CONTENT_CHARS} 字。` +
    `后续内容没有取到，请不要当作「页面就这么多」。需要更多内容时，请抓取更具体的子页面或分段获取。`
  );
}

/**
 * 校对 URL：必须是 http/https、必须含 host、不得带用户名密码。
 *
 * 为什么在本地先判：官方 400 只会说"请求不合法"，而不合法的 URL 有明确的三种，
 * 在这里说清楚比让模型去猜 400 的原因便宜得多。
 */
function assertFetchableUrl(rawUrl: string): string {
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!url) throw new Error("DeepSeek Fetch：url 不能为空");
  if (url.length > DEEPSEEK_MAX_URL_CHARS) {
    throw new Error(`DeepSeek Fetch：url 共 ${url.length} 字符，超过官方上限 ${DEEPSEEK_MAX_URL_CHARS}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`DeepSeek Fetch：不是合法的绝对 URL（需要 http/https 且含主机名）：${url.slice(0, 120)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`DeepSeek Fetch：只支持 http/https（当前是 ${parsed.protocol.replace(":", "")}）`);
  }
  if (!parsed.hostname) {
    throw new Error("DeepSeek Fetch：URL 缺少主机名");
  }
  if (parsed.username || parsed.password) {
    // 带凭据的 URL 会被写进日志/工单，且官方明确不接受
    throw new Error("DeepSeek Fetch：URL 不能带用户名/密码（凭据会泄漏）");
  }
  return url;
}

/**
 * 调 DeepSeek Fetch，取回 Markdown 正文（超出上限会截断并注记）。
 *
 * 404（无可用内容）走错误映射；200 但 `content` 为空**不抛错** ——
 * 那是"接口说成功、但这页没有可提取正文"，由调用方决定怎么呈现
 * （`web_fetch` 工具会明确告诉模型"正文为空"）。
 */
async function deepseekFetch(
  url: string,
  options: { retryBaseDelayMs?: number; timeoutMs?: number } = {},
): Promise<DeepSeekFetchResult> {
  const safeUrl = assertFetchableUrl(url);
  const config = readDeepSeekWebConfig();
  if (!config.apiKey) {
    throw new Error("DeepSeek Fetch：未配置 DeepSeek API Key（请在「设置 → DeepSeek」里填写并保存）");
  }

  const payload = await postDeepSeekTool<DeepSeekFetchResponse>({
    op: "Fetch",
    endpoint: resolveDeepSeekToolEndpoint(config.baseUrl, "fetch"),
    apiKey: config.apiKey,
    body: { url: safeUrl },
    retryBaseDelayMs: options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  });

  const title = toStr(payload?.title);
  const body = toStr(payload?.content);
  const totalChars = body.length;
  const truncated = totalChars > DEEPSEEK_FETCH_MAX_CONTENT_CHARS;
  const content = truncated
    ? body.slice(0, DEEPSEEK_FETCH_MAX_CONTENT_CHARS) + deepseekFetchTruncationNote(totalChars)
    : body;

  return { url: safeUrl, title, content, truncated, totalChars };
}

// ========== web_fetch 工具 ==========

/**
 * `web_fetch` —— 抓取指定网页的正文（Markdown）。
 *
 * 双重门控（缺一不可）：
 * 1. **本工具的开关**（设置里的「网页抓取（DeepSeek Fetch）」）—— 关着就在执行层直接拒绝，
 *    一个网络请求都不发（关闭状态下的请求是判据 `DSWEB-6-2` 用 spy 钉住的）；
 * 2. **「工具管理」的禁用列表**（`DISABLED_TOOLS_KEY`）—— 那条由 `ToolRegistry`
 *    在**定义层与执行层**各拦一次（见 `tools.ts` 的 `isToolDisabled`），本工具无需重复实现，
 *    但也**不能绕过**：它是普通注册工具，走的是同一条 `getAll` / `execute` 通路。
 *
 * 为什么开关不在定义层过滤：定义层过滤要改 `ToolRegistry.getCoreDefinitions()` 的通用契约，
 * 代价是所有工具一起受影响；而"看得见但调用时明确告诉你为什么不能用"对模型同样清楚
 * （它会读到一句可执行的指引），且不会让工具表在会话中途变化。
 */
/** `web_fetch` 的结构化结果（`outputSchema` 与渲染器共用这一个形状） */
interface WebFetchOutputValue {
  url: string;
  title: string;
  content: string;
  contentChars: number;
  totalChars: number;
  truncated: boolean;
}

/**
 * `web_fetch` 的模型可见输出 —— **唯一来源**（`execute` 与 `contract.renderOutput` 都走它）。
 *
 * 为什么不让两处各拼一遍：只改一处就会让"模型看到的文本"和"契约校验通过的形状"漂移，
 * 而这类漂移在真机上的表现是"截断标注有时在、有时不在"—— 很难被发现。
 * `glob` / `grep` 在第 121 轮定下的规矩就是这一条。
 */
function renderWebFetchOutput(v: WebFetchOutputValue): string {
  const head = [
    "[Fetch source: DeepSeek Fetch]",
    `URL: ${v.url}`,
    `Title: ${v.title || "(无标题)"}`,
    `Length: ${v.totalChars} 字${v.truncated ? `（已截断到 ${DEEPSEEK_FETCH_MAX_CONTENT_CHARS} 字）` : ""}`,
    "",
  ];
  return head.join("\n") + v.content;
}

/** `web_fetch` 的结果契约 —— 声明"成功时结果长什么样"，形状不符会被契约层拦下 */
const WEB_FETCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string" },
    title: { type: "string" },
    content: { type: "string" },
    contentChars: { type: "number" },
    totalChars: { type: "number" },
    truncated: { type: "boolean" },
  },
  required: ["url", "title", "content", "contentChars", "totalChars", "truncated"],
  additionalProperties: false,
};

export function createWebFetchTool(): ToolDef {
  return {
    id: "web_fetch",
    contract: {
      readOnly: true,
      accessScope: "network",
      outputSchema: WEB_FETCH_OUTPUT_SCHEMA,
      renderOutput: (v) => renderWebFetchOutput(v as WebFetchOutputValue),
    },
    guidance:
      "Use web_fetch when you have a specific URL and need its full text (e.g. a docs page or an article). " +
      "It returns Markdown. Requires 设置 → DeepSeek → 网页抓取（DeepSeek Fetch）to be enabled; " +
      "when it is disabled the call is refused without any network request.",
    description:
      "抓取网页正文（Markdown）。用 DeepSeek Fetch 把指定 URL 的页面正文取回为 Markdown；" +
      "正文超过上限会被截断并明确标注。需要先在「设置 → DeepSeek」打开「网页抓取（DeepSeek Fetch）」。" +
      "只支持 http/https、必须含主机名、不得带用户名密码。",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要抓取的网页 URL（http/https，必须含主机名，不能带用户名密码）",
        },
      },
      required: ["url"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolExecuteResult> {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) {
        return { title: "web_fetch", output: "Error: url 必填（要抓取的网页地址）", isError: true };
      }

      const config = readDeepSeekWebConfig();
      if (!config.fetchEnabled) {
        return {
          title: `web_fetch: ${url}`,
          output:
            "Error: 网页抓取（DeepSeek Fetch）当前是关闭状态 —— 请在「设置 → DeepSeek」里打开" +
            "「网页抓取（DeepSeek Fetch）」后重试。关闭状态下不会发出任何网络请求（该能力按成功次数计费）。",
          isError: true,
          metadata: { url, source: "DeepSeek Fetch", disabled: true },
        };
      }
      if (!config.apiKey) {
        return {
          title: `web_fetch: ${url}`,
          output: "Error: 未配置 DeepSeek API Key —— 请在「设置 → DeepSeek」里填写 API Key 并保存，再抓取网页。",
          isError: true,
          metadata: { url, source: "DeepSeek Fetch", missingApiKey: true },
        };
      }

      try {
        const result = await deepseekFetch(url);
        if (!result.content) {
          /**
           * 200 但没有正文：**必须显式判失败**。`web_fetch` 在
           * `tool-result-status.ts` 的 `CONTENT_TOOLS` 里（内容型工具不按首行推断成败），
           * 所以这里不给 `isError: true` 的话，一次"什么都没抓到"会被记成 completed。
           */
          return {
            title: `web_fetch: ${url}`,
            output:
              "Error: DeepSeek Fetch 接口成功返回（HTTP 200），但正文为空 —— " +
              "该页面可能需要 JS 渲染，或受目标站点访问策略限制（此时不计费）。",
            isError: true,
            metadata: { url, source: "DeepSeek Fetch", empty: true },
          };
        }
        const value: WebFetchOutputValue = {
          url: result.url,
          title: result.title,
          content: result.content,
          contentChars: result.content.length,
          totalChars: result.totalChars,
          truncated: result.truncated,
        };
        return {
          title: `web_fetch: ${result.title || result.url}`,
          // 与 contract.renderOutput 走**同一个**渲染函数 ⇒ 文本与契约不会漂移
          output: renderWebFetchOutput(value),
          value,
          isError: false,
          metadata: {
            url: result.url,
            title: result.title,
            truncated: result.truncated,
            totalChars: result.totalChars,
            contentChars: result.content.length,
            source: "DeepSeek Fetch",
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          title: `web_fetch: ${url}`,
          output: `网页抓取失败：${message}`,
          isError: true,
          metadata: { url, source: "DeepSeek Fetch" },
        };
      }
    },
  };
}

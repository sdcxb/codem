/**
 * web_search 工具 — LLM 搜索网页获取信息。
 *
 * 设计原则：**零配置，纯粹跟随用户的 mode 设置。**
 *
 * - CLI 模式 → 用已登录的 MiMo auth token 调 MiMo API
 * - API 模式 + Gemini → 用 Gemini grounding（Google 搜索）
 * - API 模式 + 其他 provider → 用已配的 LLM API 做知识检索
 *
 * 不需要任何独立的 web search 配置项，完全复用设置里已有的 API/CLI 凭证。
 *
 * ## 2026-10-17：DeepSeek Search 是第一优先后端（**显式开启才走**）
 *
 * 上面那三条后端**没有一条是真的搜索 API**：最后一条实际上是"让模型凭记忆回答"，
 * 却被当成检索结果交给模型。DeepSeek 新开放的 `POST /v1/tools/search` 是真检索，
 * 所以在「设置 → DeepSeek」里打开开关后**优先走它**（返回里 `source: "DeepSeek Search"`）。
 *
 * 三种边界行为（都是刻意的，别"优化"掉）：
 * 1. **开关关闭** ⇒ 完全走原来的三条后端，行为与今天逐字一致（零网络请求变化）；
 * 2. **开启但失败** ⇒ 直接报失败，**不回退**。静默回退会把 402（没钱）/401（Key 失效）
 *    掩盖成"搜到了东西"，用户既看不到计费问题、也看不到权限问题；
 * 3. **开启但没配 Key** ⇒ 明确报"未配置 Key"，同样不回退。
 */

import type { ToolDef, ToolExecuteResult } from "../tools";
import { getSettingJSON } from "../../storage/settings";
import { fetchWithTimeout } from "../../utils/fetch-with-timeout";
import {
  deepseekSearch,
  readDeepSeekWebConfig,
  type DeepSeekSearchHit,
} from "./deepseek-web";

// ========== 类型定义 ==========

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  /**
   * 以下字段**只有 DeepSeek Search 后端会填**（全部可选 ⇒ 不破坏既有消费者：
   * 它们只读 title/url/snippet/content，多出来的字段对它们是透明的）。
   *
   * 为什么要透出来：`summary` 是官方"适合给模型"的 600~800 字摘要，
   * `authority`（≥3 极权威）与 `rerank_score`（≥1.5 优质）是**模型判断可信度**的依据 ——
   * 只留 snippet（100~200 字）会让模型拿"摘要的一句"当全文。
   */
  summary?: string;
  siteName?: string | null;
  siteIcon?: string | null;
  date?: string | null;
  authority?: number;
  rerankScore?: number;
}

interface AppSettings {
  mode: "cli" | "api";
  model?: string;
  providers?: Array<{
    id: string;
    name: string;
    apiKey: string;
    baseUrl: string;
  }>;
}

// ========== 搜索后端实现 ==========

/** Gemini grounding — 用 Google 搜索做真实网页搜索（API 模式 + Gemini provider） */
async function searchWithGemini(
  query: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<SearchResult[]> {
  const geminiModel = model || "gemini-2.0-flash";
  const url = `${baseUrl.replace(/\/$/, "")}/${geminiModel}:generateContent?key=${apiKey}`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ google_search_retrieval: {} }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini search error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate) return [];

  const grounding = candidate.groundingMetadata;
  const textParts = candidate.content?.parts?.filter((p: any) => p.text) || [];
  const answerText = textParts.map((p: any) => p.text).join("\n");

  const results: SearchResult[] = [];

  if (answerText) {
    results.push({
      title: "Gemini Answer (with Google Search grounding)",
      url: "",
      snippet: answerText.substring(0, 500),
      content: answerText,
    });
  }

  if (grounding?.groundingChunks) {
    for (const chunk of grounding.groundingChunks.slice(0, 5)) {
      const web = chunk.web;
      if (web) {
        results.push({
          title: web.title || "",
          url: web.uri || "",
          snippet: "",
        });
      }
    }
  }

  return results;
}

/** LLM 知识检索 — 用已配置的 LLM API 回答（非实时搜索，但永远可用） */
async function searchWithLLM(
  query: string,
  apiKey: string,
  baseUrl: string,
  model: string,
  providerId: string,
): Promise<SearchResult[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a search assistant. Answer the user's query concisely with factual information. " +
            "If you are unsure or the information may be outdated, say so. " +
            "Format your response as a brief summary followed by key points.",
        },
        { role: "user", content: query },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    throw new Error(`${providerId} API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";

  return [
    {
      title: `${providerId} Knowledge Response`,
      url: "",
      snippet: content.substring(0, 200),
      content,
    },
  ];
}

// ========== 凭证获取（复用已有设置） ==========

/** 读取应用设置，判断当前是 CLI 还是 API 模式 */
function getAppSettings(): AppSettings {
  try {
    return getSettingJSON<AppSettings>("codem-settings", { mode: "api" });
  } catch {
    return { mode: "api" };
  }
}

/** CLI 模式下从 Account 表读取 MiMo auth token */
async function getMiMoApiKey(): Promise<{ apiKey: string; baseUrl: string } | null> {
  try {
    const { getMiMoAuth } = await import("../../auth");
    const auth = getMiMoAuth();
    const account = auth.getActiveAccount() || (await auth.loadFromAuthJson());
    if (account && account.accessToken) {
      return {
        apiKey: account.accessToken,
        baseUrl: account.url || "https://api.xiaomimimo.com/v1",
      };
    }
  } catch (e) {
    console.warn("[web_search] Failed to get MiMo auth:", e);
  }
  return null;
}

/**
 * API 模式下找到用户当前实际选中的 provider。
 * 推断逻辑与 App.tsx 的 configureEngine 完全一致：
 * 根据 settings.model 名称前缀推断 provider，再找对应配置。
 */
function getConfiguredProvider(settings: AppSettings): {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
} | null {
  if (!settings.providers || settings.providers.length === 0) return null;

  const model = settings.model || "";

  // 根据 model 名称推断当前 provider（和 App.tsx configureEngine 一致）
  let providerId = "";
  if (model.startsWith("deepseek")) providerId = "deepseek";
  else if (model.startsWith("claude")) providerId = "anthropic";
  else if (model.startsWith("moonshot")) providerId = "moonshot";
  else if (model.startsWith("gemini")) providerId = "gemini";
  else if (model.startsWith("gpt") || model.startsWith("o3")) providerId = "openai";
  else if (model.startsWith("mimo")) providerId = "mimo";

  // 找到对应 provider 的配置
  let provider = settings.providers.find(p => p.id === providerId && p.apiKey);

  // 如果推断的 provider 没配 key，回退到第一个有 key 的 provider
  if (!provider) {
    provider = settings.providers.find(p => p.apiKey);
  }

  if (!provider) return null;

  // 确定要用的 model
  let useModel = model;
  if (!useModel || useModel.startsWith("mimo")) {
    const defaults: Record<string, string> = {
      gemini: "gemini-2.0-flash",
      openai: "gpt-4o-mini",
      anthropic: "claude-sonnet-4-20250514",
      deepseek: "deepseek-chat",
      moonshot: "moonshot-v1-8k",
    };
    useModel = defaults[provider.id] || "gpt-4o-mini";
  }

  return { providerId: provider.id, apiKey: provider.apiKey, baseUrl: provider.baseUrl, model: useModel };
}

// ========== 主搜索调度 ==========

/**
 * DeepSeek Search 结果 → 本工具的结果结构（逐字段搬运，`null` 原样保留）。
 *
 * 不在这里做"过滤低分结果"之类的加工：`rerank_score` / `authority` 的判断权交给模型，
 * 我们只负责把官方给的数字**如实**送上去（自己截断会让模型失去"这条到底多可信"的依据）。
 */
function deepseekHitsToResults(hits: DeepSeekSearchHit[]): SearchResult[] {
  return hits.map((hit) => ({
    title: hit.title,
    url: hit.url,
    snippet: hit.snippet,
    content: hit.content,
    summary: hit.summary,
    siteName: hit.siteName,
    siteIcon: hit.siteIcon,
    date: hit.date,
    authority: hit.authority,
    rerankScore: hit.rerankScore,
  }));
}

/**
 * 纯粹跟随 mode 设置，零独立配置：
 * - CLI 模式 → MiMo API
 * - API 模式 + Gemini → Gemini grounding
 * - API 模式 + 其他 → LLM 知识检索
 *
 * DeepSeek Search 开关打开时**先走它**，且失败**不回退**（见文件头的三条边界行为）。
 */
async function executeSearch(
  query: string,
  options: { count?: number } = {},
): Promise<{ results: SearchResult[]; source: string }> {
  const deepseek = readDeepSeekWebConfig();
  if (deepseek.searchEnabled) {
    if (!deepseek.apiKey) {
      throw new Error(
        "已在「设置 → DeepSeek」开启「网页搜索（DeepSeek Search）」，但没有配置 DeepSeek API Key —— " +
          "请先填写并保存 Key。此次不回退到其它后端（静默回退会掩盖权限/计费问题）。",
      );
    }
    /**
     * 条数优先级：模型显式传 `num_results` > 设置里的 count（缺省 10）。
     * 为什么让模型优先：它知道"这次只要看前三条"；而设置里的 count 是**默认意图**。
     */
    const hits = await deepseekSearch(query, {
      count: options.count ?? deepseek.searchCount,
    });
    return { results: deepseekHitsToResults(hits), source: "DeepSeek Search" };
  }

  const settings = getAppSettings();

  if (settings.mode === "cli") {
    const mimo = await getMiMoApiKey();
    if (mimo) {
      const results = await searchWithLLM(query, mimo.apiKey, mimo.baseUrl, "mimo-v2.5-pro", "MiMo");
      return { results, source: "MiMo (CLI mode)" };
    }
    throw new Error("CLI mode: not logged in to MiMo. Please login first.");
  }

  // API 模式
  const provider = getConfiguredProvider(settings);
  if (!provider) {
    throw new Error("API mode: no provider API key configured. Please configure a provider in Settings.");
  }

  if (provider.providerId === "gemini") {
    const results = await searchWithGemini(query, provider.apiKey, provider.baseUrl, provider.model);
    return { results, source: "Gemini grounding (Google Search)" };
  }

  const results = await searchWithLLM(query, provider.apiKey, provider.baseUrl, provider.model, provider.providerId);
  return { results, source: `${provider.providerId} (LLM knowledge)` };
}

// ========== 工具定义 ==========

export function createWebSearchTool(): ToolDef {
  return {
    id: "web_search",
    contract: { readOnly: true, accessScope: "network" },
    guidance: "Use web_search when the user asks about current information, recent events, or when you need to look up something you don't know. Returns search results with titles, URLs, and snippets. When DeepSeek Search is enabled in settings, results also carry summary / site / date / authority / rerank score. Use web_fetch when you need the full text of one specific URL.",
    description:
      "Search the web for information. Automatically uses the configured provider (CLI/API mode) — no separate API key needed. " +
      "In CLI mode, uses the MiMo API. In API mode with Gemini, uses Google Search grounding. " +
      "For other API providers, uses LLM knowledge (may not be real-time). " +
      "When 「设置 → DeepSeek → 网页搜索（DeepSeek Search）」is enabled, real web search via DeepSeek is used first.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search query. DeepSeek Search supports raw search syntax: site:/-site:, -word, \"exact phrase\", lang:zh,en, after:2025, before:2025-06.",
        },
        num_results: {
          type: "integer",
          description:
            "Number of results to return (default: 5, max: 10; DeepSeek Search accepts 1..50 and falls back to the count in settings).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolExecuteResult> {
      const query = args.query as string;
      if (!query) {
        return { title: "web_search", output: "Error: query is required.", isError: true };
      }

      const numResults = typeof args.num_results === "number" ? args.num_results : undefined;

      try {
        const { results, source } = await executeSearch(query, { count: numResults });

        if (results.length === 0) {
          return {
            title: `web_search: ${query}`,
            output: `No results found for "${query}".`, isError: false,
            metadata: { query, resultCount: 0, source },
          };
        }

        const formatted = results.map((r, i) => {
          const parts = [`### ${i + 1}. ${r.title}`];
          if (r.url) parts.push(`URL: ${r.url}`);
          parts.push(`Snippet: ${r.snippet}`);
          /**
           * 以下四行**只在后端给了才出现**（目前只有 DeepSeek Search 会给），
           * 所以老后端的输出逐字不变 —— 既有断言与 UI 卡片都不受影响。
           */
          if (r.summary) parts.push(`Summary: ${r.summary}`);
          const extras: string[] = [];
          if (r.siteName) extras.push(`站点: ${r.siteName}`);
          if (r.date) extras.push(`日期: ${r.date}`);
          if (typeof r.authority === "number") {
            const level =
              r.authority < 0 ? "未知" : r.authority >= 3 ? "极权威" : r.authority >= 1 ? "一般" : "低";
            extras.push(`权威度: ${r.authority < 0 ? "-1" : r.authority}/4（${level}）`);
          }
          if (typeof r.rerankScore === "number") {
            extras.push(`相关度: ${r.rerankScore.toFixed(2)}${r.rerankScore >= 1.5 ? "（优质）" : ""}`);
          }
          if (extras.length > 0) parts.push(extras.join(" · "));
          if (r.content && r.content.length > 200) {
            parts.push(`Content: ${r.content.substring(0, 500)}...`);
          }
          return parts.join("\n");
        }).join("\n\n");

        return {
          title: `web_search: ${query}`,
          output: `[Search source: ${source}]\n\nFound ${results.length} results for "${query}":\n\n${formatted}`, isError: false,
          metadata: {
            query,
            resultCount: results.length,
            source,
            // P1: 结构化搜索结果，对标 DSH WebSearchMeta — UI 可据此渲染搜索卡片
            sources: results.map(r => ({
              url: r.url || '',
              title: r.title || '',
              snippet: r.snippet || '',
            })),
          },
        };
      } catch (err: any) {
        /**
         * 失败**不改道**：DeepSeek 开启时这里就是最终结论（不回退）。
         * `source` 一并写进 metadata，UI/日志能看出"这次是哪个后端失败的"——
         * 否则一条 402 会被误读成"网络不好"。
         */
        const deepseekOn = readDeepSeekWebConfig().searchEnabled;
        return {
          title: `web_search: ${query}`,
          output: `Search failed: ${err?.message ?? String(err)}`, isError: true,
          metadata: { query, source: deepseekOn ? "DeepSeek Search" : "unknown", failed: true },
        };
      }
    },
  };
}


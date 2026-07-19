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
 */

import type { ToolDef, ToolExecuteResult } from "../tools";
import { getSettingJSON } from "../../storage/settings";

// ========== 类型定义 ==========

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
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

  const response = await fetch(url, {
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

  const response = await fetch(url, {
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
 * 纯粹跟随 mode 设置，零独立配置：
 * - CLI 模式 → MiMo API
 * - API 模式 + Gemini → Gemini grounding
 * - API 模式 + 其他 → LLM 知识检索
 */
async function executeSearch(query: string): Promise<{ results: SearchResult[]; source: string }> {
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
    description:
      "Search the web for information. Automatically uses the configured provider (CLI/API mode) — no separate API key needed. " +
      "In CLI mode, uses the MiMo API. In API mode with Gemini, uses Google Search grounding. " +
      "For other API providers, uses LLM knowledge (may not be real-time).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query.",
        },
        num_results: {
          type: "integer",
          description: "Number of results to return (default: 5, max: 10).",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolExecuteResult> {
      const query = args.query as string;
      if (!query) {
        return { title: "web_search", output: "Error: query is required." };
      }

      try {
        const { results, source } = await executeSearch(query);

        if (results.length === 0) {
          return {
            title: `web_search: ${query}`,
            output: `No results found for "${query}".`,
          };
        }

        const formatted = results.map((r, i) => {
          const parts = [`### ${i + 1}. ${r.title}`];
          if (r.url) parts.push(`URL: ${r.url}`);
          parts.push(`Snippet: ${r.snippet}`);
          if (r.content && r.content.length > 200) {
            parts.push(`Content: ${r.content.substring(0, 500)}...`);
          }
          return parts.join("\n");
        }).join("\n\n");

        return {
          title: `web_search: ${query}`,
          output: `[Search source: ${source}]\n\nFound ${results.length} results for "${query}":\n\n${formatted}`,
          metadata: { query, resultCount: results.length, source },
        };
      } catch (err: any) {
        return {
          title: `web_search: ${query}`,
          output: `Search failed: ${err.message}`,
        };
      }
    },
  };
}

/**
 * fact_check 工具 — 对 AI 回复进行事实核查，返回修正建议。
 *
 * 用途：Correction 模式下核查 AI 回复（也可由 LLM 在对话中主动调用）。
 *
 * 模型决策（真实可配置、真实生效）：
 * 1. 优先读取持久化设置 `codem-correction-model`（JSON: { provider, model, apiKey, baseUrl }，
 *    由「设置 → 高级 → 纠偏模型」面板写入）。配置存在且 provider/model 完整 → 调用该
 *    专属纠偏模型发起真实 LLM 请求；apiKey / baseUrl 留空时自动复用该 provider 在全局
 *    设置（codem-settings.providers）或 LLMEngine 中的 API Key / 地址。
 * 2. 未配置 → 回退到当前主对话模型执行核查，并在结果中诚实附注
 *    「未配置专属纠偏模型，本次使用主模型核查」。
 *
 * 说明：不再读取 ctx 上从未被 App 注入的纠偏 provider/model 假字段（全局搜不到赋值），
 * 此前只会静默使用假默认 openai/gpt-4-turbo，永远不生效。
 */

import type { ToolDef, ToolExecuteResult, ToolContext } from "../tools";
import { getSettingJSON } from "../../storage/settings";
import { fetchWithTimeout } from "../../utils/fetch-with-timeout";
import { redactSecrets } from "../../utils/redact";
import { resolveProviderForModel } from "../../model-config";

/** 纠偏模型配置的持久化 key（面板与工具共用） */
export const CORRECTION_MODEL_SETTING_KEY = "codem-correction-model";
/** 回退主模型时的诚实标注（附加在核查结果中） */
export const MAIN_MODEL_FALLBACK_NOTE = "未配置专属纠偏模型，本次使用主模型核查";

/** 面板/工具共用的纠偏模型配置结构 */
export interface CorrectionModelConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** 模型来源：dedicated=用户配置的专属纠偏模型；main=回退主模型 */
export type ModelSource = "dedicated" | "main";

/** 一次核查请求实际使用的模型目标（含解析后的凭证/地址） */
export interface ModelTarget {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  source: ModelSource;
}

export interface FactCheckResult {
  original: string;
  corrected: string;
  changes: string[];
}

interface FactCheckInput {
  content: string;
}

/** 内置 provider 的默认 OpenAI 兼容 baseUrl（与 provider.ts 注册表一致；未列出的 provider 必须显式提供 baseUrl） */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  moonshot: "https://api.moonshot.cn/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  google: "https://generativelanguage.googleapis.com/v1beta/openai", // 旧命名兼容
  mimo: "https://api.xiaomimimo.com/v1",
  ollama: "http://localhost:11434",
};

/**
 * 模型决策纯函数（单测目标）：
 * - 配置存在且 provider/model 均非空 → 返回专属纠偏模型（source: "dedicated"）；
 * - 配置缺失或字段不完整 → 返回 null，调用方据此回退主模型。
 */
export function decideCorrectionModel(
  cfg: CorrectionModelConfig | null | undefined,
): Pick<ModelTarget, "provider" | "model" | "source"> | null {
  if (!cfg || typeof cfg !== "object") return null;
  const provider = (cfg.provider || "").trim();
  const model = (cfg.model || "").trim();
  if (!provider || !model) return null;
  return { provider, model, source: "dedicated" };
}

/** 读取持久化的专属纠偏模型配置（读取失败视为未配置） */
function readStoredConfig(): CorrectionModelConfig | null {
  try {
    return getSettingJSON<CorrectionModelConfig | null>(CORRECTION_MODEL_SETTING_KEY, null);
  } catch (e) {
    console.warn("[fact_check] 读取纠偏模型配置失败:", e);
    return null;
  }
}

/**
 * 解析请求凭证/地址（优先级从高到低）：
 * 1. 纠偏面板配置中的 apiKey / baseUrl（面板允许留空）；
 * 2. 全局 codem-settings.providers 中同 id provider 的 apiKey / baseUrl（App configureEngine 的配置来源）；
 * 3. LLMEngine 中实际运行的 provider 配置（覆盖 CLI MiMo 运行时 token 等仅存内存的凭证）；
 * 4. 内置默认 baseUrl（仅限已知内置 provider）。
 */
async function resolveCredentials(
  provider: string,
  cfg: CorrectionModelConfig | null,
): Promise<{ apiKey: string; baseUrl: string }> {
  const localApiKey = (cfg?.apiKey || "").trim();
  const localBaseUrl = (cfg?.baseUrl || "").trim();

  let global: { apiKey?: string; baseUrl?: string } | null = null;
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    const providers = Array.isArray(settings?.providers) ? settings.providers : [];
    global = providers.find((p: any) => p && p.id === provider) || null;
  } catch {
    // ignore — 继续尝试 engine / 默认值
  }

  let engineCfg: { apiKey: string; baseUrl?: string } | null = null;
  try {
    const { getLLMEngine } = await import("../index");
    engineCfg = getLLMEngine().getProviderConfig(provider);
  } catch {
    // engine 未初始化（如测试/启动早期）— 跳过
  }

  const apiKey = localApiKey || global?.apiKey || engineCfg?.apiKey || "";
  const baseUrl = localBaseUrl || global?.baseUrl || engineCfg?.baseUrl || DEFAULT_BASE_URLS[provider] || "";
  return { apiKey, baseUrl };
}

/**
 * 决定本次核查使用的模型目标：
 * 配置存在 → 专属纠偏模型；否则解析主对话模型（LLMEngine chat 槽位 → codem-settings.model）。
 */
async function buildModelTarget(): Promise<ModelTarget> {
  const cfg = readStoredConfig();
  const decided = decideCorrectionModel(cfg);
  if (decided) {
    const creds = await resolveCredentials(decided.provider, cfg);
    return { provider: decided.provider, model: decided.model, ...creds, source: "dedicated" };
  }

  // 回退主模型
  let provider = "";
  let model = "";
  try {
    const { getLLMEngine } = await import("../index");
    const r = getLLMEngine().getConfiguredProvider("chat");
    provider = (r?.provider as any)?.id || "";
    model = (r?.model || "").trim();
  } catch {
    // engine 不可用 — 落到 codem-settings
  }
  if (!model) {
    try {
      const settings = getSettingJSON<any>("codem-settings", {});
      model = ((settings && settings.model) || "").trim();
      if (model) {
        provider = resolveProviderForModel(model);
        if (!provider) {
          const first = (settings.providers || []).find((p: any) => p && p.apiKey);
          provider = first?.id || "";
        }
      }
    } catch {
      // ignore
    }
  }
  if (!model) {
    throw new Error(
      "未配置专属纠偏模型，且无法确定当前主模型（请先在主设置中配置模型与 API Key，或在纠偏模型面板配置专属纠偏模型）",
    );
  }
  const creds = await resolveCredentials(provider, null);
  return { provider: provider || "unknown", model, ...creds, source: "main" };
}

/** 去掉 ```json ... ``` 围栏 */
function stripJsonFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : text.trim();
}

/**
 * 解析纠偏模型回复中的结构化结果。模型偶尔会用围栏/前后缀包裹 JSON，
 * 或干脆不按约定输出 JSON —— 全部兜底处理，绝不假装「无需修正」。
 */
export function parseCorrectionOutput(
  raw: string,
): { corrected: string; changes: string[]; parseWarning?: string } {
  const cleaned = stripJsonFence(raw);
  let obj: any = null;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // fall through — 尝试提取 JSON 块
  }
  if (!obj) {
    const block = cleaned.match(/\{[\s\S]*\}/);
    if (block) {
      try {
        obj = JSON.parse(block[0]);
      } catch {
        obj = null;
      }
    }
  }
  if (obj && typeof obj === "object") {
    const corrected = typeof obj.corrected === "string" ? obj.corrected : "";
    const changes = Array.isArray(obj.changes)
      ? obj.changes.filter((c: unknown) => typeof c === "string")
      : [];
    return { corrected, changes };
  }
  // 模型未按约定返回 JSON：原样保留其文本，避免假装"无需修正"
  return {
    corrected: raw.trim(),
    changes: [],
    parseWarning: "纠偏模型未返回合法 JSON，以下 corrected 为其原始回复文本（未经结构化解析）",
  };
}

/** 构造核查 prompt */
function buildCorrectionPrompt(content: string): string {
  return [
    `Review the following AI response for:`,
    `1. Factual errors`,
    `2. Inaccuracies`,
    `3. Misleading statements`,
    ``,
    `Original AI response:`,
    `"""`,
    content,
    `"""`,
    ``,
    `Return a JSON response with this structure:`,
    `{`,
    `  "corrected": "Corrected version of the content (fix all errors)",`,
    `  "changes": ["Change 1 description", "Change 2 description", ...]`,
    `}`,
    ``,
    `If the content is accurate and no corrections are needed, return:`,
    `{`,
    `  "corrected": "[No corrections needed]",`,
    `  "changes": []`,
    `}`,
  ].join("\n");
}

/**
 * 调用纠偏/核查模型（OpenAI 兼容 /chat/completions 协议，与 provider.ts、web_search
 * 的既有请求方式一致），返回结构化核查结果。
 */
async function callCorrectionModel(
  content: string,
  target: ModelTarget,
): Promise<{ result: FactCheckResult; parseWarning?: string }> {
  if (!target.baseUrl) {
    throw new Error(
      `provider "${target.provider}" 未配置 baseUrl —— 请在纠偏模型面板填写 Base URL，或在全局设置中为该 provider 配置地址`,
    );
  }
  const url = `${target.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.apiKey) {
    headers["Authorization"] = `Bearer ${target.apiKey}`;
  }

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: target.model,
      messages: [
        {
          role: "system",
          content:
            "You are a fact-checking expert. Review the given AI response for factual errors, " +
            "inaccuracies, and misleading statements. Respond ONLY with a JSON object of the form " +
            '{"corrected": "corrected full content", "changes": ["change description"]}. ' +
            'If nothing needs correcting return {"corrected": "[No corrections needed]", "changes": []}. ' +
            "Keep the original language and style of the content unless fixing an error.",
        },
        { role: "user", content: buildCorrectionPrompt(content) },
      ],
      temperature: 0.2,
      max_tokens: 2000,
      stream: false,
    }),
  });

  if (!response.ok) {
    // 服务器错误体可能回显密钥 — 脱敏后再进 Error（对齐 provider.ts 的安全约定）
    const text = redactSecrets((await response.text()).substring(0, 2000));
    throw new Error(`${target.provider} 纠偏请求失败 HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();
  const raw = (data?.choices?.[0]?.message?.content || "").trim();
  if (!raw) {
    throw new Error("纠偏模型返回了空内容");
  }
  const parsed = parseCorrectionOutput(raw);
  return { result: { original: content, ...parsed }, parseWarning: parsed.parseWarning };
}

/**
 * Fact check tool — 使用（配置的专属纠偏模型 | 主模型）对内容做真实事实核查
 */
export function createFactCheckTool(): ToolDef {
  return {
    id: "fact_check",
    guidance:
      "Use fact_check to verify an AI response for factual errors, inaccuracies, or misleading statements. " +
      "It calls the configured correction model (or the main model when none is configured) and returns a corrected version plus a list of changes.",
    description: "对 AI 回复进行事实核查，返回修正建议。需要提供待核查的内容。",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "需要核查的内容（AI 的原始回复）",
        },
      },
      required: ["content"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolExecuteResult> {
      const input = args as unknown as FactCheckInput;
      const content = (input.content || "").trim();

      if (!content) {
        return {
          title: "Error",
          output: "内容不能为空",
        };
      }

      try {
        const target = await buildModelTarget();
        const { result, parseWarning } = await callCorrectionModel(content, target);

        const payload: Record<string, unknown> = {
          model: `${target.provider}/${target.model}`,
          modelSource: target.source === "dedicated" ? "dedicated" : "main (fallback)",
          result,
        };
        // 诚实标注：使用主模型核查时明确告知
        if (target.source === "main") {
          payload.note = MAIN_MODEL_FALLBACK_NOTE;
        }
        if (parseWarning) {
          payload.parseWarning = parseWarning;
        }

        return {
          title: "Fact Check Result",
          output: JSON.stringify(payload, null, 2),
        };
      } catch (error) {
        return {
          title: "Error",
          output: `事实核查失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

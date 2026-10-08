/**
 * P3-31: Ollama Provider — 离线本地 LLM
 *
 * 功能：
 * 1. 通过 Ollama REST API (http://localhost:11434) 连接本地模型
 * 2. 动态列出已安装的模型 (GET /api/tags)
 * 3. 使用 OpenAI 兼容端点 (POST /v1/chat/completions) 进行推理
 * 4. 支持 streaming 和 non-streaming
 * 5. 不需要 API Key — 纯本地运行
 * 6. 支持健康检查和连接状态监控
 *
 * Ollama API 文档: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import type {
  LLMProvider,
  ModelConfig,
  LLMRequest,
  LLMResponse,
  StreamEvent,
  LLMMessage,
  ToolDefinition,
} from "./types";
import { getSetting } from "../storage/settings";
import { redactSecrets } from "../utils/redact";
// 第 185 波（复审 R1-3/I-6）：`finish_reason` 的归一必须走**唯一实现** —— 两条路径（与非流式）
// 都不许各写一份三元表达式，否则同一次截断在 Ollama 上是 `stop`、在 OpenAI 上是 `length`。
import { mapFinishReason } from "./finish-reason";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

// ========== Types ==========

export interface OllamaModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  modifiedAt: string;
  details?: {
    family: string;
    parameterSize: string;
    quantizationLevel: string;
  };
}

export interface OllamaConnectionStatus {
  connected: boolean;
  url: string;
  modelCount: number;
  error?: string;
}

// ========== Ollama Provider ==========

export class OllamaProvider implements LLMProvider {
  id = "ollama";
  name = "Ollama (Local)";

  /** 获取配置的 Ollama URL */
  getBaseUrl(): string {
    return getSetting("ollama-base-url") || DEFAULT_OLLAMA_URL;
  }

  isConfigured(): boolean {
    // Ollama is always "configured" — it just needs to be running locally
    return true;
  }

  /** 健康检查 — 测试 Ollama 服务是否在线 */
  async checkConnection(): Promise<OllamaConnectionStatus> {
    const url = this.getBaseUrl();
    try {
      const resp = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) {
        return { connected: false, url, modelCount: 0, error: `HTTP ${resp.status}` };
      }
      const data = await resp.json();
      const models = data.models || [];
      return { connected: true, url, modelCount: models.length };
    } catch (err: any) {
      return {
        connected: false,
        url,
        modelCount: 0,
        error: err.message || String(err),
      };
    }
  }

  /** 列出已安装的本地模型 */
  async listModels(): Promise<ModelConfig[]> {
    const url = this.getBaseUrl();
    try {
      const resp = await fetch(`${url}/api/tags`);
      if (!resp.ok) return [];
      const data = await resp.json();
      const ollamaModels: OllamaModel[] = data.models || [];
      return ollamaModels.map(m => this.toModelConfig(m));
    } catch (err) {
      console.warn("[Ollama] listModels failed:", err);
      return [];
    }
  }

  /** Ollama's listModels already fetches from the server — just delegate */
  async fetchModelsFromServer(): Promise<ModelConfig[]> {
    return this.listModels();
  }

  /** 将 Ollama 模型信息转换为 ModelConfig */
  private toModelConfig(m: OllamaModel): ModelConfig {
    // 估算 context window — Ollama 默认 2048，但很多模型支持更大
    // 常见模型 context 映射
    const name = m.model || m.name;
    let contextWindow = 4096;
    let maxOutputTokens = 2048;

    // 常见模型 context window 估算
    const lower = name.toLowerCase();
    if (lower.includes("llama3") || lower.includes("llama-3")) {
      contextWindow = 128000;
      maxOutputTokens = 4096;
    } else if (lower.includes("qwen2.5") || lower.includes("qwen2")) {
      contextWindow = 32768;
      maxOutputTokens = 8192;
    } else if (lower.includes("mistral") || lower.includes("mixtral")) {
      contextWindow = 32768;
      maxOutputTokens = 8192;
    } else if (lower.includes("phi3") || lower.includes("phi-3")) {
      contextWindow = 128000;
      maxOutputTokens = 4096;
    } else if (lower.includes("codellama")) {
      contextWindow = 16384;
      maxOutputTokens = 4096;
    } else if (lower.includes("deepseek")) {
      contextWindow = 65536;
      maxOutputTokens = 8192;
    } else if (lower.includes("gemma")) {
      contextWindow = 8192;
      maxOutputTokens = 4096;
    }

    // Ollama 模型通常支持 tools（取决于模型，保守起见标记为 true）
    const supportsTools = lower.includes("llama3") || lower.includes("qwen") || lower.includes("mistral");

    return {
      id: name,
      name: `${name} (${m.details?.parameterSize || "?"})`,
      contextWindow,
      maxOutputTokens,
      supportsTools,
      supportsStreaming: true,
      costPer1kInput: 0, // 本地运行免费
      costPer1kOutput: 0,
    };
  }

  /** Non-streaming completion — 使用 OpenAI 兼容端点 */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const baseUrl = this.getBaseUrl();
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(m => this.toAPIMessage(m)),
        tools: request.tools?.length ? request.tools.map(t => this.toAPITool(t)) : undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 4096,
        stream: false,
      }),
      signal: request.abortSignal,
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Ollama API error ${resp.status}: ${redactSecrets(error.substring(0, 2000))}`);
    }

    const data = await resp.json();
    const choice = data.choices?.[0];

    return {
      id: data.id || `ollama-${Date.now()}`,
      content: choice?.message?.content || "",
      toolCalls: choice?.message?.tool_calls?.map((tc: any) => ({
        id: tc.id || `call-${Date.now()}`,
        name: tc.function?.name,
        input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
        status: "completed" as const,
      })),
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
        cost: 0,
      },
      /**
       * ★ 第 185 波（复审 R1-3）：**非流式也要走 `mapFinishReason`**。
       *
       * 改前这里是 `… === "tool_calls" ? "tool_use" : choice?.finish_reason || "stop"`：
       * 未知取值被压成 `"stop"`（"不知道它为什么结束"说成"正常结束"），且与
       * `provider.ts:354` 的唯一实现 `mapFinishReason` 是两份真相 —— 同一次 `length`
       * 截断，OpenAI 路径报 `length`（循环据此触发续写）、Ollama 路径报 `stop`
       * （半截压缩摘要被当成完整摘要写回）。
       */
      finishReason: mapFinishReason(choice?.finish_reason),
      model: request.model,
    };
  }

  /** Streaming completion — 使用 OpenAI 兼容 SSE 端点 */
  async *stream(request: LLMRequest): AsyncGenerator<StreamEvent, void, unknown> {
    const baseUrl = this.getBaseUrl();
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(m => this.toAPIMessage(m)),
        tools: request.tools?.length ? request.tools.map(t => this.toAPITool(t)) : undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 4096,
        stream: true,
      }),
      signal: request.abortSignal,
    });

    if (!resp.ok) {
      const error = await resp.text();
      throw new Error(`Ollama API error ${resp.status}: ${redactSecrets(error.substring(0, 2000))}`);
    }

    const responseId = `ollama-${Date.now()}`;
    yield { type: "start", id: responseId, model: request.model };

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    /**
     * ★ 第 185 波（复审 R1-3/I-6）：**原始词先存着，最后一律过 `mapFinishReason`**。
     * 改前这里直接透传（只把 `tool_calls` 换成 `tool_use`），陌生词原样进主循环。
     */
    let finishReasonRaw: unknown = undefined;
    /**
     * ★ 第 185 波（复审 R1-3）：**工具调用必须落地，不许永远 pending**。
     *
     * 改前本文件**从不发 `tool_use_end`**（7 处 yield 里没有它）：主循环的
     * `tool_use_end` 分支（`agentic-loop.ts:3857`）因此永远不执行 —— `currentToolCalls`
     * 里那几条 `status: "pending"`、`input: {}` 就是全部下场，参数永远解析不出来。
     *
     * 现在与 `provider.ts` **同形**：按 `index` 累积增量，在 `finish_reason` 到达时
     * （或流在没有 `finish_reason` 的情况下结束时的兜底）逐条发 `tool_use_end`，
     * 带上解析结果与 `argsParseError`/`rawLength`（由循环"拒绝执行 + 引导重试"）。
     */
    const currentToolCalls: Record<number, { id: string; name: string; arguments: string }> = {};
    let streamEnded = false;
    let toolEndsEmitted = false;
    /**
     * ★ 第 185 波（复审 R1-3）：**丢行计数** —— 与 `provider.ts` 同形。
     * 丢行意味着 tool arguments 的增量可能残缺；下游必须能看到这件事
     * （改前这里只 `console.warn`，`argsParseError`/`rawLength` **没有任何消费方** ——
     *  注释宣称"与 provider.ts 同形"，而实现里根本没有那段，注释比没有更糟）。
     */
    let droppedStreamLines = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") continue;

          try {
            const chunk = JSON.parse(jsonStr);
            const delta = chunk.choices?.[0]?.delta;

            if (delta?.content) {
              yield { type: "text_delta", text: delta.content };
            }

            if (delta?.tool_calls) {
              /**
               * 按 `index` 累积（与 `provider.ts:667-681` 同形）。
               * 改前是「每片直接透传 `tc.id || ""`」：后续增量片常常**不带 id**，
               * 于是 `tool_use_delta` 的 id 是空串，主循环按 id 找不到那条调用
               * （`agentic-loop.ts:3851`）⇒ 参数其实一片都没接上。
               */
              for (const tc of delta.tool_calls) {
                const idx = tc.index || 0;
                if (!currentToolCalls[idx]) {
                  currentToolCalls[idx] = {
                    id: tc.id || `tc-${Date.now()}`,
                    name: tc.function?.name || "",
                    arguments: "",
                  };
                  if (tc.function?.name) {
                    yield { type: "tool_use_start", id: currentToolCalls[idx].id, name: tc.function.name };
                  }
                }
                if (tc.function?.arguments) {
                  currentToolCalls[idx].arguments += tc.function.arguments;
                  yield { type: "tool_use_delta", id: currentToolCalls[idx].id, input: tc.function.arguments };
                }
              }
            }

            if (chunk.choices?.[0]?.finish_reason) {
              finishReasonRaw = chunk.choices[0].finish_reason;
              if (!streamEnded) {
                streamEnded = true;
                // 与 provider.ts 同形：`finish_reason` 到达 = 参数已收全 ⇒ 逐条补发 `tool_use_end`
                for (const ev of this.buildToolEndEvents(currentToolCalls, droppedStreamLines)) {
                  toolEndsEmitted = true;
                  yield ev;
                }
              }
            }

            // Track usage (some providers include it in final chunk)
            if (chunk.usage) {
              totalPromptTokens = chunk.usage.prompt_tokens || totalPromptTokens;
              totalCompletionTokens = chunk.usage.completion_tokens || totalCompletionTokens;
            }
          } catch (e) {
            /**
             * ★ 第 185 波（复审 R1-3）：**丢弃的行要计数，且必须在 `tool_use_end` 上被消费**。
             *
             * 被丢的那一行如果正好是 tool arguments 的增量，累积出来的 JSON 就是残缺的；
             * 现在这个计数在 `buildToolEndEvents` 里变成 `argsParseError`（"参数可能不完整"），
             * 由主循环走"拒绝执行 + 引导重试"，而不是拿着残缺 JSON 继续跑。
             * （改前这里只 `console.warn` —— 没有任何消费方，等于把缺陷降级成一行日志。）
             */
            droppedStreamLines++;
            console.warn(`[ollama-provider] 丢弃了 1 行无法解析的流数据（累计 ${droppedStreamLines} 行）:`, e);
          }
        }
      }
    } finally {
      reader?.cancel();
    }

    /**
     * 兜底：流结束时**没有** `finish_reason`（对端直接关连接）。
     * 此时 `tool_use_end` 一条都没发过 ⇒ 必须在这里补 —— 否则工具调用永远 pending
     * （`provider.ts:794-856` 的同类兜底，同一事实同一处置）。
     */
    if (!streamEnded && !toolEndsEmitted) {
      for (const ev of this.buildToolEndEvents(currentToolCalls, droppedStreamLines)) {
        yield ev;
      }
    }

    // Emit usage event
    yield {
      type: "usage",
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        cost: 0,
      },
    };

    yield {
      type: "end",
      // 唯一实现；未收到 `finish_reason` ⇒ `mapFinishReason(undefined) === "stop"`（与改前一致）
      finishReason: mapFinishReason(finishReasonRaw),
    };
  }

  /**
   * ★ 第 185 波（复审 R1-3）：把累积到的工具调用变成 `tool_use_end` 事件（**唯一实现**）。
   *
   * 与 `provider.ts:685-721` / `:826-856` 同形：JSON 解析失败 ⇒ 带上失败原因与原始长度，
   * 由主循环**拒绝执行**并给模型可操作的指引（绝不猜参数、绝不降级成空参数）。
   * 流里丢过行 ⇒ 即便 JSON 恰好还能解析，也要标出"参数可能不完整"。
   */
  private buildToolEndEvents(
    currentToolCalls: Record<number, { id: string; name: string; arguments: string }>,
    droppedStreamLines: number,
  ): StreamEvent[] {
    const events: StreamEvent[] = [];
    for (const key of Object.keys(currentToolCalls)) {
      const tc = currentToolCalls[Number(key)];
      if (!tc) continue;
      let parsedArgs: Record<string, unknown> = {};
      let argsParseError: string | undefined;
      if (tc.arguments) {
        try {
          parsedArgs = JSON.parse(tc.arguments);
        } catch (e: any) {
          argsParseError = e?.message || String(e);
          console.error(
            `[Ollama] Failed to parse tool args for ${tc.name} (${tc.arguments.length} chars):`,
            argsParseError,
            "…tail:",
            tc.arguments.slice(-120),
          );
        }
      }
      if (droppedStreamLines > 0 && !argsParseError) {
        argsParseError = `stream had ${droppedStreamLines} unparsable SSE line(s); arguments may be incomplete`;
      }
      events.push({
        type: "tool_use_end",
        id: tc.id,
        name: tc.name,
        input: parsedArgs,
        ...(argsParseError ? { argsParseError, rawLength: tc.arguments.length } : {}),
      });
    }
    return events;
  }

  /** 转换 LLMMessage 为 OpenAI 格式 */
  private toAPIMessage(msg: LLMMessage): any {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content };
    }

    // ContentBlock[] — 简化处理
    const blocks = msg.content as any[];
    const textParts = blocks.filter(b => b.type === "text").map(b => b.text);
    const toolUseParts = blocks.filter(b => b.type === "tool_use");
    const toolResultParts = blocks.filter(b => b.type === "tool_result");

    const result: any = { role: msg.role };

    if (textParts.length > 0) {
      result.content = textParts.join("\n");
    } else {
      result.content = "";
    }

    if (toolUseParts.length > 0) {
      result.tool_calls = toolUseParts.map(tu => ({
        id: tu.id,
        type: "function",
        function: {
          name: tu.name,
          arguments: JSON.stringify(tu.input),
        },
      }));
    }

    if (toolResultParts.length > 0) {
      result.role = "tool";
      result.tool_call_id = toolResultParts[0].toolCallId;
      result.content = toolResultParts[0].content;
    }

    return result;
  }

  /** 转换 ToolDefinition 为 OpenAI 格式 */
  private toAPITool(tool: ToolDefinition): any {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }
}

// ========== Singleton ==========

let ollamaProvider: OllamaProvider | null = null;

export function getOllamaProvider(): OllamaProvider {
  if (!ollamaProvider) {
    ollamaProvider = new OllamaProvider();
  }
  return ollamaProvider;
}

// ========== Settings Helper ==========

/** 获取 Ollama 配置信息 */
function getOllamaConfig(): {
  baseUrl: string;
  autoDetect: boolean;
} {
  return {
    baseUrl: getSetting("ollama-base-url") || DEFAULT_OLLAMA_URL,
    autoDetect: getSetting("ollama-auto-detect") !== "false",
  };
}



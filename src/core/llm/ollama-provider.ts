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
      throw new Error(`Ollama API error ${resp.status}: ${error}`);
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
      finishReason: choice?.finish_reason === "tool_calls" ? "tool_use" : choice?.finish_reason || "stop",
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
      throw new Error(`Ollama API error ${resp.status}: ${error}`);
    }

    const responseId = `ollama-${Date.now()}`;
    yield { type: "start", id: responseId, model: request.model };

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let finishReason = "stop";

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
              for (const tc of delta.tool_calls) {
                if (tc.id && tc.function?.name) {
                  yield { type: "tool_use_start", id: tc.id, name: tc.function.name };
                }
                if (tc.function?.arguments) {
                  yield { type: "tool_use_delta", id: tc.id || "", input: tc.function.arguments };
                }
              }
            }

            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }

            // Track usage (some providers include it in final chunk)
            if (chunk.usage) {
              totalPromptTokens = chunk.usage.prompt_tokens || totalPromptTokens;
              totalCompletionTokens = chunk.usage.completion_tokens || totalCompletionTokens;
            }
          } catch (e) {
            // Incomplete JSON chunk — skip
          }
        }
      }
    } finally {
      reader?.cancel();
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
      finishReason: finishReason === "tool_calls" ? "tool_use" : finishReason,
    };
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
export function getOllamaConfig(): {
  baseUrl: string;
  autoDetect: boolean;
} {
  return {
    baseUrl: getSetting("ollama-base-url") || DEFAULT_OLLAMA_URL,
    autoDetect: getSetting("ollama-auto-detect") !== "false",
  };
}

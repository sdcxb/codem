import type {
  LLMProvider,
  ProviderConfig,
  ModelConfig,
  LLMRequest,
  LLMResponse,
  StreamEvent,
} from "./types";

// ========== OpenAI-Compatible Provider ==========
export class OpenAICompatibleProvider implements LLMProvider {
  id: string;
  name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  isConfigured(): boolean {
    // MiMo provider allows empty API key for free model (mimo-auto)
    if (this.id === "mimo") return true;
    return !!this.config.apiKey;
  }

  async listModels(): Promise<ModelConfig[]> {
    return this.config.models;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const baseUrl = this.config.baseUrl || "https://api.openai.com/v1";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(this.toAPIMessage),
        tools: request.tools?.length ? request.tools.map(this.toAPITool) : undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 4096,
        stream: false,
      }),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error ${response.status}: ${error}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    return {
      id: data.id,
      content: choice?.message?.content || "",
      toolCalls: choice?.message?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
        status: "completed" as const,
      })),
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
      finishReason: choice?.finish_reason === "tool_calls" ? "tool_use" : "stop",
      model: request.model,
    };
  }

  async *stream(request: LLMRequest): AsyncGenerator<StreamEvent, void, unknown> {
    const baseUrl = this.config.baseUrl || "https://api.openai.com/v1";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    const url = `${baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages.map(this.toAPIMessage),
      tools: request.tools?.length ? request.tools.map(this.toAPITool) : undefined,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    });
    console.log("[Provider] stream:", url, "body size:", body.length, "bytes");
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: request.abortSignal,
    });
    console.log("[Provider] response status:", response.status);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error ${response.status}: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let msgId = "";
    let currentToolCalls: Record<string, { id: string; name: string; arguments: string }> = {};

    yield { type: "start", id: msgId, model: request.model };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          msgId = parsed.id || msgId;

          const delta = parsed.choices?.[0]?.delta;
          const finishReason = parsed.choices?.[0]?.finish_reason;

          if (delta?.content) {
            yield { type: "text_delta", text: delta.content };
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index || 0;
              if (!currentToolCalls[idx]) {
                currentToolCalls[idx] = { id: tc.id || `tc-${Date.now()}`, name: tc.function?.name || "", arguments: "" };
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

          if (finishReason) {
            for (const [, tc] of Object.entries(currentToolCalls)) {
              yield { type: "tool_use_end", id: tc.id };
            }

            const usage = parsed.usage || {};
            yield {
              type: "usage",
              usage: {
                promptTokens: usage.prompt_tokens || 0,
                completionTokens: usage.completion_tokens || 0,
                totalTokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
              },
            };

            yield { type: "end", finishReason: finishReason === "tool_calls" ? "tool_use" : finishReason };
          }
        } catch {}
      }
    }
  }

  private toAPIMessage(msg: { role: string; content: string | any[]; toolCallId?: string; name?: string }) {
    const role = msg.role === "tool" ? "tool" : msg.role;
    const content = typeof msg.content === "string" ? msg.content : this.serializeContent(msg.content);

    if (role === "tool") {
      return { role: "tool", content, tool_call_id: msg.toolCallId };
    }
    return { role, content, name: msg.name };
  }

  private serializeContent(blocks: any[]): string {
    return blocks.map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") return `[Tool: ${b.name}]`;
      if (b.type === "tool_result") return b.content;
      return "";
    }).join("\n");
  }

  private toAPITool(tool: { name: string; description: string; parameters: any }) {
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

// ========== Provider Registry ==========
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();

  register(provider: LLMProvider) {
    this.providers.set(provider.id, provider);
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  getConfigured(): LLMProvider[] {
    return this.getAll().filter((p) => p.isConfigured());
  }
}

// ========== Create Default Providers ==========
export function createDefaultProviders(): ProviderRegistry {
  const registry = new ProviderRegistry();

  // OpenAI
  registry.register(new OpenAICompatibleProvider({
    id: "openai",
    name: "OpenAI",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, maxOutputTokens: 16384, supportsTools: true, supportsStreaming: true },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000, maxOutputTokens: 16384, supportsTools: true, supportsStreaming: true },
      { id: "o3", name: "o3", contextWindow: 200000, maxOutputTokens: 100000, supportsTools: true, supportsStreaming: true },
    ],
  }));

  // Anthropic
  registry.register(new OpenAICompatibleProvider({
    id: "anthropic",
    name: "Anthropic",
    apiKey: "",
    baseUrl: "https://api.anthropic.com/v1",
    models: [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200000, maxOutputTokens: 64000, supportsTools: true, supportsStreaming: true },
      { id: "claude-opus-4-20250514", name: "Claude Opus 4", contextWindow: 200000, maxOutputTokens: 32000, supportsTools: true, supportsStreaming: true },
    ],
  }));

  // MiMo (Xiaomi)
  registry.register(new OpenAICompatibleProvider({
    id: "mimo",
    name: "MiMo",
    apiKey: "",
    baseUrl: "https://api.xiaomimimo.com/v1",
    models: [
      { id: "mimo-v2.5-pro", name: "MiMo v2.5 Pro", contextWindow: 1000000, maxOutputTokens: 64000, supportsTools: true, supportsStreaming: true },
      { id: "mimo-v2.5", name: "MiMo v2.5", contextWindow: 1000000, maxOutputTokens: 64000, supportsTools: true, supportsStreaming: true },
      { id: "mimo-v2-pro", name: "MiMo v2 Pro", contextWindow: 1000000, maxOutputTokens: 64000, supportsTools: true, supportsStreaming: true },
      { id: "mimo-v2-flash", name: "MiMo v2 Flash", contextWindow: 1000000, maxOutputTokens: 64000, supportsTools: true, supportsStreaming: true },
    ],
  }));

  return registry;
}

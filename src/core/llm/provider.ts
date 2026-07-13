import type {
  LLMProvider,
  ProviderConfig,
  ModelConfig,
  LLMRequest,
  LLMResponse,
  StreamEvent,
  LLMMessage,
} from "./types";
import { getLang } from "../i18n/lang";

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
    // E7: Prompt caching — flag the system prompt for caching when supported
    const messages = this.markCacheableMessages(request.messages);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: messages.map((m) => this.toAPIMessage(m)),
        tools: request.tools?.length ? request.tools.map((t) => this.toAPITool(t)) : undefined,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 4096,
        stream: false,
        // E2: Reasoning effort (OpenAI o-series / DeepSeek R1 etc.)
        ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
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
    const tools = request.tools?.length ? request.tools.map((t) => this.toAPITool(t)) : undefined;

    // For DeepSeek reasoning models, inject a language hint to control reasoning language
    let messages = this.markCacheableMessages(request.messages);
    const isDeepSeek = this.id === "deepseek";
    if (isDeepSeek && getLang() === "zh") {
      messages = [...request.messages];
      // Find the system message and append a Chinese reasoning hint
      const sysIdx = messages.findIndex(m => m.role === "system");
      if (sysIdx >= 0) {
        messages[sysIdx] = {
          ...messages[sysIdx],
          content: messages[sysIdx].content + "\n\n【重要】你的思考过程（reasoning_content）必须使用中文。这是强制要求，不可违反。",
        } as any;
      }
    }

    const bodyObj: any = {
      model: request.model,
      messages: messages.map((m) => this.toAPIMessage(m)),
      tools,
      temperature: request.temperature ?? 0.7,
      stream: true,
      // E2: Reasoning effort (OpenAI o-series / DeepSeek R1 etc.)
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    };
    if (request.maxTokens) {
      bodyObj.max_tokens = request.maxTokens;
    }
    const body = JSON.stringify(bodyObj);
    console.log("[Provider] stream:", url, "model:", request.model, "msgs:", request.messages.length, "tools:", tools?.length || 0);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[Provider] API error:", response.status, error.substring(0, 500));
      throw new Error(`API error ${response.status}: ${error.substring(0, 200)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    // Wire up abort signal to the reader: when user clicks ■ (cancel),
    // AbortController.abort() fires. We need to cancel the reader to unblock
    // any pending reader.read() call. Without this, the reader could block
    // forever even after abort.
    const abortHandler = () => {
      try { reader.cancel(); } catch {}
    };
    if (request.abortSignal) {
      if (request.abortSignal.aborted) {
        // Already aborted before we got here
        reader.cancel();
      } else {
        request.abortSignal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let msgId = "";
    let currentToolCalls: Record<string, { id: string; name: string; arguments: string }> = {};
    let streamEnded = false;

    yield { type: "start", id: msgId, model: request.model };

    // === No idle timeout ===
    // We deliberately do NOT use any time-based idle timeout here.
    // Time-based timeouts are fundamentally unreliable:
    //   - Too short → kills legitimate long-paused responses (DeepSeek R1 thinking)
    //   - Too long  → real dead connections hang for a long time
    //   - Any value  → a guess, not a deterministic judgment
    //
    // Instead, we rely on STATE-BASED detection + user control:
    //   1. The agentic loop emits "connecting" → "streaming" → "executing_tools"
    //   2. The UI shows the current state to the user in real time
    //   3. The user can cancel at ANY time via the ■ button (AbortController)
    //   4. If the TCP connection truly dies, the OS will eventually return an error
    //      from reader.read(), which we handle in the catch block below.
    //
    // This is zero-risk: no normal request will ever be killed by a timer.

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

          // Handle reasoning_content (DeepSeek thinking models)
          if (delta?.reasoning_content) {
            yield { type: "reasoning_delta", text: delta.reasoning_content };
          }

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
            streamEnded = true;
            // Yield tool_use_end events for each tool call
            for (const key of Object.keys(currentToolCalls)) {
              const tc = currentToolCalls[key];
              if (tc) {
                // Parse args if available
                let parsedArgs: Record<string, unknown> = {};
                if (tc.arguments) {
                  try {
                    parsedArgs = JSON.parse(tc.arguments);
                  } catch (e) {
                    console.error("[Provider] Failed to parse tool args:", tc.arguments.substring(0, 200));
                  }
                }
                console.log("[Provider] Tool call end:", tc.name, "args:", JSON.stringify(parsedArgs).substring(0, 200));
                yield { 
                  type: "tool_use_end" as const, 
                  id: tc.id,
                  name: tc.name,
                  input: parsedArgs,
                };
              }
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

    // Fallback: if stream ended without finish_reason, yield tool_use_end + end
    // This handles APIs that close the connection without an explicit finish_reason
    if (!streamEnded) {
      console.warn("[Provider] Stream ended without finish_reason, yielding fallback events");
      for (const key of Object.keys(currentToolCalls)) {
        const tc = currentToolCalls[key];
        if (tc) {
          let parsedArgs: Record<string, unknown> = {};
          if (tc.arguments) {
            try {
              parsedArgs = JSON.parse(tc.arguments);
            } catch (e) {
              console.error("[Provider] Fallback: failed to parse tool args:", tc.arguments.substring(0, 200));
            }
          }
          console.log("[Provider] Fallback tool_use_end:", tc.name, "args:", JSON.stringify(parsedArgs).substring(0, 200));
          yield {
            type: "tool_use_end" as const,
            id: tc.id,
            name: tc.name,
            input: parsedArgs,
          };
        }
      }
      yield { type: "usage", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      yield { type: "end", finishReason: Object.keys(currentToolCalls).length > 0 ? "tool_use" : "stop" };
    }

    // Clean up abort listener
    if (request.abortSignal) {
      request.abortSignal.removeEventListener("abort", abortHandler);
    }
  }

  /**
   * E7: Mark system prompt and early messages as cacheable.
   * For Anthropic-compatible APIs, adds cache_control markers.
   * For OpenAI-compatible APIs, this is a no-op (caching is automatic).
   */
  private markCacheableMessages(messages: LLMMessage[]): LLMMessage[] {
    // Only apply cache markers for Anthropic provider
    if (this.id !== "anthropic") return messages;

    return messages.map((msg, i) => {
      // Mark the system message and the first user message as cacheable
      if (i === 0 || (i === 1 && msg.role === "user")) {
        return {
          ...msg,
          // Anthropic cache_control marker — the API will cache this prefix
          content: typeof msg.content === "string"
            ? msg.content
            : msg.content,
          // Add cache_control as a sidecar property (Anthropic API supports this)
          ...(typeof msg.content === "string" ? {
            content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }],
          } : {}),
        } as any;
      }
      return msg;
    });
  }

  private toAPIMessage(msg: any) {
    const role = msg.role === "tool" ? "tool" : msg.role;
    let content = typeof msg.content === "string" ? msg.content : (msg.content ? this.serializeContent(msg.content) : "");
    // Strip <system-reminder> tags injected by external CLI tools
    content = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    // Truncate individual message content if too large (>200KB)
    if (content.length > 200000) {
      content = content.substring(0, 200000) + "\n... (truncated)";
    }

    if (role === "tool") {
      return { role: "tool", content, tool_call_id: msg.toolCallId || msg.tool_call_id };
    }
    const result: any = { role, content };
    if (msg.name) result.name = msg.name;
    if (msg.tool_calls) result.tool_calls = msg.tool_calls;
    // NOTE: Do NOT send reasoning_content from previous assistant messages back to the API.
    // reasoning_content is an OUTPUT field (DeepSeek thinking mode), not a standard INPUT field.
    // Sending old reasoning back causes the LLM to treat previous thinking patterns as
    // implicit instructions (e.g., old reasoning about "append not overwrite" gets carried
    // forward to new requests where the user didn't ask for append).
    // Only the current turn's reasoning is meaningful — past reasoning informed past responses
    // and should not influence future turns.
    return result;
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

  // DeepSeek
  registry.register(new OpenAICompatibleProvider({
    id: "deepseek",
    name: "DeepSeek",
    apiKey: "",
    baseUrl: "https://api.deepseek.com",
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1000000, maxOutputTokens: 384000, supportsTools: true, supportsStreaming: true },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000, maxOutputTokens: 384000, supportsTools: true, supportsStreaming: true },
    ],
  }));

  // Moonshot (Kimi)
  registry.register(new OpenAICompatibleProvider({
    id: "moonshot",
    name: "Moonshot",
    apiKey: "",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      { id: "moonshot-v1-8k", name: "Moonshot v1 8K", contextWindow: 8192, maxOutputTokens: 4096, supportsTools: true, supportsStreaming: true },
      { id: "moonshot-v1-32k", name: "Moonshot v1 32K", contextWindow: 32768, maxOutputTokens: 8192, supportsTools: true, supportsStreaming: true },
      { id: "moonshot-v1-128k", name: "Moonshot v1 128K", contextWindow: 131072, maxOutputTokens: 8192, supportsTools: true, supportsStreaming: true },
    ],
  }));

  // Google Gemini (via OpenAI-compatible endpoint)
  registry.register(new OpenAICompatibleProvider({
    id: "gemini",
    name: "Google Gemini",
    apiKey: "",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1000000, maxOutputTokens: 65536, supportsTools: true, supportsStreaming: true },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1000000, maxOutputTokens: 65536, supportsTools: true, supportsStreaming: true },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextWindow: 1000000, maxOutputTokens: 65536, supportsTools: true, supportsStreaming: true },
    ],
  }));

  return registry;
}

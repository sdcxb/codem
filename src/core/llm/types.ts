// ========== Provider Types ==========
export interface ProviderConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl?: string;
  models: ModelConfig[];
  /** API protocol type — controls endpoint path. Defaults to "chat-completions". */
  protocol?: ApiProtocol;
}

/** Supported API protocol types */
export type ApiProtocol = "chat-completions" | "responses" | "custom";

/** Dynamic model info returned by the server's /v1/models or /models endpoint */
export interface ServerModelInfo {
  id: string;
  owned_by?: string;
  object?: string;
  created?: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  costPer1kInput?: number;
  costPer1kOutput?: number;
  /** Whether this model was discovered dynamically from the server */
  dynamic?: boolean;
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  abortSignal?: AbortSignal;
  /** Reasoning effort level (E2): controls how much the model "thinks" before responding */
  reasoningEffort?: "low" | "medium" | "high";
  /** P-OPT5: Request purpose — used to add provider-specific headers (e.g. compaction) */
  purpose?: "conversation" | "compaction" | "session-title";
}

export interface LLMResponse {
  id: string;
  content: string;
  toolCalls?: ToolCallResult[];
  usage: TokenUsage;
  finishReason: "stop" | "tool_use" | "length" | "error";
  model: string;
}

export interface TokenUsage {
  /** 提示词 token（provider 全量口径；DeepSeek prompt_tokens 含缓存命中） */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  /** 提示词中命中缓存的 token（DeepSeek prompt_cache_hit_tokens / OpenAI cache_read_input_tokens） */
  cacheHitTokens?: number;
  /** 未命中缓存的输入 token = promptTokens - cacheHitTokens（命中率分母） */
  uncachedInputTokens?: number;
}

// ========== Message Types ==========
export type LLMMessageRole = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  id: string;
  role: LLMMessageRole;
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
  /**
   * DeepSeek thinking mode: the reasoning_content of a historical assistant
   * message. DeepSeek V4 (thinking mode) REQUIRES the API caller to pass back
   * the reasoning_content of every previous assistant message on multi-turn
   * conversations — omitting it returns HTTP 400:
   *   "The `reasoning_content` in the thinking mode must be passed back to the API."
   * Stored in DB `messages.reasoning` for UI display, and now also round-tripped
   * to the API as `reasoning_content` on assistant messages.
   */
  reasoning?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
  | { type: "image"; mediaType: string; data: string }
  | { type: "audio"; mediaType: string; data: string };

// ========== Tool Types ==========
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCallResult {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: "pending" | "running" | "completed" | "error";
  error?: string;
  /** 工具执行元数据（如 subagentId 等）— 从 ToolExecuteResult 透传 */
  metadata?: Record<string, any>;
}

// ========== Streaming Types ==========
export type StreamEvent =
  | { type: "start"; id: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; input: string }
  | {
      type: "tool_use_end";
      id: string;
      name?: string;
      input?: Record<string, unknown>;
      /**
       * 工具参数 JSON 解析失败的原因（第 66 波）。
       *
       * 真实事故：模型一次 `write` 一个 6–10KB 的 Python 脚本，参数 JSON 在**输出上限处被截断**
       * （`Unterminated string in JSON at position 6648`），而当时的处理是"只打日志 + 降级成空参数"，
       * 于是 `write` 拿着 `content: ""` 继续执行 —— 轻则写出空文件、重则**把已有文件清空**。
       * 现在把失败原因带出来，由循环**拒绝执行**并给模型一句可操作的指引：绝不猜参数。
       */
      argsParseError?: string;
      /** 原始参数文本长度（用来判断"是不是被截断"） */
      rawLength?: number;
    }
  | { type: "usage"; usage: TokenUsage }
  | { type: "end"; finishReason: string }
  | { type: "error"; error: string }
  | { type: "heartbeat" };

// ========== Provider Interface ==========
export interface LLMProvider {
  id: string;
  name: string;

  /** List available models (from cache or static) */
  listModels(): Promise<ModelConfig[]>;

  /** Fetch models from the server's /models endpoint and cache them */
  fetchModelsFromServer(): Promise<ModelConfig[]>;

  /** Non-streaming completion */
  complete(request: LLMRequest): Promise<LLMResponse>;

  /** Streaming completion */
  stream(request: LLMRequest): AsyncGenerator<StreamEvent, void, unknown>;

  /** Check if provider is configured */
  isConfigured(): boolean;
}

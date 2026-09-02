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
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
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
  | { type: "tool_use_end"; id: string; name?: string; input?: Record<string, unknown> }
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

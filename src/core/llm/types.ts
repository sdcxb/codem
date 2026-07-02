// ========== Provider Types ==========
export interface ProviderConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl?: string;
  models: ModelConfig[];
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
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  abortSignal?: AbortSignal;
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
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
  | { type: "image"; mediaType: string; data: string };

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
}

// ========== Streaming Types ==========
export type StreamEvent =
  | { type: "start"; id: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; input: string }
  | { type: "tool_use_end"; id: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "end"; finishReason: string }
  | { type: "error"; error: string };

// ========== Provider Interface ==========
export interface LLMProvider {
  id: string;
  name: string;

  /** List available models */
  listModels(): Promise<ModelConfig[]>;

  /** Non-streaming completion */
  complete(request: LLMRequest): Promise<LLMResponse>;

  /** Streaming completion */
  stream(request: LLMRequest): AsyncGenerator<StreamEvent, void, unknown>;

  /** Check if provider is configured */
  isConfigured(): boolean;
}

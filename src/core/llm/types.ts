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

/**
 * 思考强度档位（第 184 波 G10：放宽到含 `xhigh` / `max`）。
 *
 * 上游 Pi v1.1.0 支持到 `xhigh` / `max`（自适应思考）；我们原来只有 low/medium/high
 * ⇒ **无法表达**更高档位（能力被锁在上限之下）。注意各家接受的集合不同，
 * 发送前要经 `reasoning-effort.ts` 按族钳制。
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  abortSignal?: AbortSignal;
  /** Reasoning effort level (E2): controls how much the model "thinks" before responding */
  reasoningEffort?: ReasoningEffort;
  /** P-OPT5: Request purpose — used to add provider-specific headers (e.g. compaction) */
  purpose?: "conversation" | "compaction" | "session-title";
}

export interface LLMResponse {
  id: string;
  content: string;
  toolCalls?: ToolCallResult[];
  usage: TokenUsage;
  /**
   * 结束原因。★ 第 184 波：补上 `content_filter`（供应商会回它），
   * 且**陌生取值一律归 `error`**（不许说成 stop）—— 见 `finish-reason.ts`。
   */
  finishReason: "stop" | "tool_use" | "length" | "error" | "content_filter";
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
  /**
   * 第 84 波：`status: "error"` 的来源。
   *
   * - `"tool"`：工具**自己汇报**的失败（例如 `Error: oldString not found`）。
   *   模型应当看到文本并自行纠正，因此**不**算"执行层异常"——
   *   streaming-executor 不会把它转成 tool_error，也就不会累加
   *   `consecutiveErrors`（否则连错 3 次就把整轮干掉，比原来更容易卡死）。
   * - 其它（含未设置）：管线/宿主层的失败（权限拒绝、守卫拦截、异常、中止）。
   *   这些仍然按原路径抛出并计入连续错误。
   * - `"loop"`（第 97 波）：这条结果**不是工具自己产出的**，而是循环合成的 ——
   *   读缓存命中（`[CACHE HIT]`）、重复写被跳过（`[NO-OP]`）、重复调用守卫抑制等。
   *   它同样**不参与工具的输出契约校验**：工具声明了 `outputSchema` 也不该为"缓存命中的文本"
   *   背锅（真机实测：这条把 `read` 的每次缓存命中都变成
   *   `Error: read declared outputSchema but returned no value`，模型因此放弃 read/bash/glob/grep）。
   */
  errorSource?: "tool" | "pipeline" | "loop";
  /**
   * 第 183 波：工具结果的**结构化诊断**（对标 Pi 的 `ToolDiagnostic`）。
   *
   * 为什么要有它：截断/分页这类"元信息"原来是一条散装括号文本
   * （`... (showing lines 1-2 ... use offset to continue reading)`），**形态上像正文**
   * —— 而 `read` 的输出外面还裹着"这是待分析数据"的边界框，模型很难分辨
   * "这是文件里的字"与"这是系统在说『你只看到了一部分』"。
   *
   * 结构化之后：既能统一渲染成带标记的块（见 `tool-diagnostics.ts`），
   * 也能让 UI 独立消费（不必去正则匹配正文）。
   */
  diagnostics?: Array<{ severity: "info" | "warn" | "error"; code: string; message: string }>;
  /** 工具执行元数据（如 subagentId 等）— 从 ToolExecuteResult 透传 */
  metadata?: Record<string, any>;
  /**
   * 结构化结果值（第 121 轮新增，照 DSH 的 `output.schema` 形态）。
   *
   * ## 为什么需要它（此前只有字符串 `output`）
   *
   * 工具结果此前是**不透明的字符串**，于是下游只能靠**字符串嗅探**去理解它：
   * `micro-compact.ts` 用正则从文本里抠文件路径 / 退出码 / 命令；
   * `spill` 只能按字节数截；结果展示只能猜。而且**没有任何东西可校验** ——
   * 我们那个 `output-contract` 框架因此长期形同虚设（0 个工具注册过契约）。
   *
   * 现在工具可以返回 `value`（结构化事实），由 `contract.outputSchema` 校验，
   * 再由 `contract.renderOutput` 渲染成 `output`（给模型看的文本）。
   * **三者分工**：`value` 是事实、`output` 是呈现、中间那次校验是保障。
   *
   * ## 兼容
   *
   * 可选字段。没有 `value` 的老工具照旧只填 `output`，行为零变化；
   * 有 `value` 的工具才受校验与下游结构化消费。
   */
  value?: unknown;
  /**
   * 展示用结构化载荷（纯投影，不参与校验、不回灌模型）。
   * 供 UI 渲染卡片等用途，照 DSH 的 `presentationMeta`。
   */
  meta?: Record<string, unknown>;
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

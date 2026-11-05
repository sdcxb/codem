/**
 * OpenAI 兼容的流式 provider（Host 侧）—— 与渲染侧 `src/core/llm/provider.ts` 的
 * `OpenAICompatibleProvider` **同一套线上协议**，但只依赖 `fetch`（Node 18+ 内置）。
 *
 * 为什么 Host 不能直接复用渲染侧那个类：
 * 它绑定了渲染侧的超时/重试/成本单例与 `AbortSignal.timeout` 的宿主策略，
 * 且带 UI 诊断钩子。Host 需要的是"最小、可判据化"的实现：判据用本地假模型
 * （`packages/host/scripts/mock-provider.mjs`）驱动，不依赖任何外网账号。
 *
 * ★ 终端形态下这两份实现会合并成一份（`packages/agent`）；本文件的定位是
 * **Spike 的可执行证据**，不是第二个长期真相。ADR-0001 的迁移清单里它排第 3。
 */

import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ModelConfig,
  StreamEvent,
  TokenUsage,
} from "../../../src/core/llm/types";
import {
  aggregateStream,
  classifyAICodeWithModel,
  isAICodeWithChatModel,
  streamAnthropic,
  streamGemini,
} from "../../../src/core/llm/aicodewith-protocols";

export interface OpenAILikeOptions {
  id?: string;
  name?: string;
  /** 形如 `http://127.0.0.1:PORT/v1`（不带尾斜杠也可以） */
  baseUrl: string;
  apiKey?: string;
  /** 默认模型（请求未指定时用） */
  model: string;
  /** 连接超时（毫秒） */
  connectTimeoutMs?: number;
}

interface ChunkChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

interface Chunk {
  id?: string;
  model?: string;
  choices?: ChunkChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
  } | null;
}

/** 把一段 SSE 文本切成事件行（`data:` 前缀 + 空行分隔） */
export function* sseDataLines(text: string): Generator<string> {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line.startsWith("data:")) continue;
    yield line.slice(5).trim();
  }
}

/** 组装一次流式调用的增量状态（纯函数，便于单测） */
export interface ToolCallAccumulator {
  add(delta: NonNullable<ChunkChoice["delta"]>["tool_calls"]): void;
  finalize(): Array<{ id: string; name: string; arguments: string }>;
}

export function createToolCallAccumulator(): ToolCallAccumulator {
  const byIndex = new Map<number, { id: string; name: string; arguments: string }>();
  return {
    add(list) {
      if (!list) return;
      for (const call of list) {
        const index = typeof call.index === "number" ? call.index : byIndex.size;
        const current = byIndex.get(index) ?? { id: "", name: "", arguments: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name = call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        byIndex.set(index, current);
      }
    },
    finalize() {
      return [...byIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, v]) => v)
        .filter((v) => v.name.length > 0);
    },
  };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly connectTimeoutMs: number;

  constructor(opts: OpenAILikeOptions) {
    this.id = opts.id ?? "host-openai-compatible";
    this.name = opts.name ?? "Host OpenAI-compatible";
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.model = opts.model;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  }

  isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * AICodeWith 同一把 key 覆盖三家协议；只有确认是 AICodeWith 时才按模型族分派，
   * 避免把普通 OpenAI 兼容端点上的 `claude-*` 误走 Anthropic。
   */
  private aicodewithInfo(request: LLMRequest) {
    const isAICodeWith = this.apiKey.startsWith("sk-acw-") || /aicodewith\.(ai|com)/i.test(this.baseUrl);
    if (!isAICodeWith) return null;
    return classifyAICodeWithModel(request.model || this.model);
  }

  async listModels(): Promise<ModelConfig[]> {
    const info = this.apiKey.startsWith("sk-acw-") ? classifyAICodeWithModel(this.model) : null;
    return [
      {
        id: this.model,
        name: this.model,
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        supportsStreaming: true,
        dynamic: true,
        ...(info ? { inputModalities: info.inputModalities } : {}),
      },
    ];
  }

  async fetchModelsFromServer(): Promise<ModelConfig[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.connectTimeoutMs),
    });
    if (!res.ok) throw new Error(`GET /models ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const all = (body.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === "string")
      .map(
        (m) =>
          ({
            id: m.id,
            name: m.id,
            contextWindow: 128_000,
            maxOutputTokens: 8_192,
            supportsTools: true,
            supportsStreaming: true,
            dynamic: true,
          }),
      );
    if (this.apiKey.startsWith("sk-acw-")) {
      return all
        .filter((m) => isAICodeWithChatModel(m.id))
        .map((m) => ({ ...m, inputModalities: classifyAICodeWithModel(m.id)!.inputModalities }));
    }
    return all;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private body(request: LLMRequest, stream: boolean): Record<string, unknown> {
    return {
      model: request.model || this.model,
      messages: request.messages.map(toWireMessage),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const info = this.aicodewithInfo(request);
    if (info && info.protocol !== "openai") return aggregateStream(this.stream(request));
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.body(request, false)),
      signal: request.abortSignal ?? AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`POST /chat/completions ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      id?: string;
      model?: string;
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
        finish_reason?: string;
      }>;
      usage?: Chunk["usage"];
    };
    const choice = json.choices?.[0];
    return {
      id: json.id ?? `host-${Date.now()}`,
      content: choice?.message?.content ?? "",
      toolCalls: (choice?.message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        input: safeParse(c.function.arguments) ?? {},
        status: "completed" as const,
      })),
      usage: toUsage(json.usage),
      finishReason: mapFinish(choice?.finish_reason),
      model: json.model ?? request.model ?? this.model,
    };
  }

  async *stream(request: LLMRequest): AsyncGenerator<StreamEvent, void, unknown> {
    const info = this.aicodewithInfo(request);
    if (info?.protocol === "anthropic") {
      yield* streamAnthropic({ apiKey: this.apiKey, baseUrl: this.baseUrl }, request);
      return;
    }
    if (info?.protocol === "gemini") {
      yield* streamGemini({ apiKey: this.apiKey, baseUrl: this.baseUrl }, request);
      return;
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.body(request, true)),
      signal: request.abortSignal ?? AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      yield { type: "error", error: `POST /chat/completions ${res.status}: ${await res.text()}` };
      return;
    }
    const body = res.body;
    if (!body) {
      yield { type: "error", error: "响应没有 body（provider 不支持流式？）" };
      return;
    }
    let started = false;
    let finish: string | null = null;
    let usage: TokenUsage | null = null;
    const tools = createToolCallAccumulator();
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 以空行分隔事件；这里按行处理（`data:` 一行一个 JSON 是 OpenAI 的形态）
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const data of sseDataLines(lines.join("\n"))) {
          if (data === "[DONE]") continue;
          let chunk: Chunk;
          try {
            chunk = JSON.parse(data) as Chunk;
          } catch {
            continue; // 心跳/注释行
          }
          if (!started) {
            started = true;
            yield { type: "start", id: chunk.id ?? `host-${Date.now()}`, model: chunk.model ?? this.model };
          }
          if (chunk.usage) usage = toUsage(chunk.usage);
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) yield { type: "reasoning_delta", text: reasoning };
          if (delta.content) yield { type: "text_delta", text: delta.content };
          tools.add(delta.tool_calls);
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!started) {
      yield { type: "start", id: `host-${Date.now()}`, model: this.model };
    }
    for (const call of tools.finalize()) {
      yield { type: "tool_use_start", id: call.id || `call_${call.name}`, name: call.name };
      yield { type: "tool_use_delta", id: call.id || `call_${call.name}`, input: call.arguments };
      const parsed = safeParse(call.arguments);
      yield {
        type: "tool_use_end",
        id: call.id || `call_${call.name}`,
        name: call.name,
        ...(parsed === null ? { argsParseError: "工具参数不是合法 JSON" } : { input: parsed }),
        rawLength: call.arguments.length,
      };
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "end", finishReason: finish ?? "stop" };
  }
}

function toWireMessage(m: LLMMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: m.role, content: typeof m.content === "string" ? m.content : m.content };
  if (m.toolCallId) {
    base.tool_call_id = m.toolCallId;
  }
  if ("toolCalls" in m && Array.isArray((m as { toolCalls?: unknown }).toolCalls)) {
    base.tool_calls = (m as unknown as { toolCalls: Array<{ id: string; name: string; arguments: unknown }> }).toolCalls.map(
      (c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      }),
    );
  }
  return base;
}

function safeParse(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toUsage(u: Chunk["usage"]): TokenUsage {
  const prompt = u?.prompt_tokens ?? 0;
  const completion = u?.completion_tokens ?? 0;
  const hit = u?.prompt_cache_hit_tokens;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: u?.total_tokens ?? prompt + completion,
    ...(typeof hit === "number" ? { cacheHitTokens: hit, uncachedInputTokens: Math.max(0, prompt - hit) } : {}),
  };
}

function mapFinish(reason: string | null | undefined): LLMResponse["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return reason ? "error" : "stop";
  }
}

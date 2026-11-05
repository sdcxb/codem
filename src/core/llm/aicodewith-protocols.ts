/**
 * AI Code With 的三套协议适配（只服务 `AICodeWithProvider`）。
 *
 * 平台文档：Claude 走 Anthropic Messages，GPT / DeepSeek / GLM / Kimi 走 OpenAI
 * Chat Completions，Gemini 走 Google Gemini；三套 Base URL 不同，不能混用。
 * 本文件只做「Codem 的 LLMRequest/LLMResponse ↔ 各家 wire 格式」的转换，
 * 不碰 provider 注册与路由。
 */
import type {
  ContentBlock,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ModelConfig,
  StreamEvent,
  ToolDefinition,
  ToolCallResult,
  TokenUsage,
} from "./types";

export type AICodeWithProtocol = "openai" | "anthropic" | "gemini";

export interface AICodeWithModelInfo {
  protocol: AICodeWithProtocol;
  inputModalities: Array<"text" | "image">;
}

/**
 * 平台 `/v1/models` 没有协议/模态字段，按家族判定。
 * 图像/视频生成模型不是聊天模型，不进聊天选择器。
 */
export function classifyAICodeWithModel(modelId: string): AICodeWithModelInfo | null {
  const id = (modelId || "").trim().toLowerCase();
  if (!id) return null;
  if (id.startsWith("gpt-image-") || id.startsWith("nano-banana") || id.startsWith("seedance") ||
      id.startsWith("veo-") || id.startsWith("wan-") || id.startsWith("minimax-h3")) {
    return null;
  }
  if (id.startsWith("claude-")) return { protocol: "anthropic", inputModalities: ["text", "image"] };
  if (id.startsWith("gemini-")) return { protocol: "gemini", inputModalities: ["text", "image"] };
  if (id.startsWith("gpt-")) {
    return { protocol: "openai", inputModalities: ["text", "image"] };
  }
  if (id.startsWith("grok-")) return { protocol: "openai", inputModalities: ["text", "image"] };
  if (id.startsWith("deepseek-flash") || id.startsWith("deepseek-v4")) {
    return { protocol: "openai", inputModalities: ["text", "image"] };
  }
  if (id.startsWith("deepseek-")) return { protocol: "openai", inputModalities: ["text"] };
  if (id.startsWith("glm-") || id.startsWith("kimi-") || id.startsWith("minimax-") || id.startsWith("jev-")) {
    return { protocol: "openai", inputModalities: ["text"] };
  }
  return null;
}

export function isAICodeWithChatModel(modelId: string): boolean {
  return classifyAICodeWithModel(modelId) !== null;
}

export function decorateAICodeWithModel(model: ModelConfig): ModelConfig {
  const info = classifyAICodeWithModel(model.id);
  return info ? { ...model, inputModalities: info.inputModalities } : model;
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

function rootOf(baseUrl: string): string {
  return (baseUrl || "https://api.aicodewith.ai").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function anthropicContent(blocks: ContentBlock[]): any[] {
  const out: any[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "image") {
      out.push({ type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } });
    } else if (b.type === "tool_use") {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    } else if (b.type === "tool_result") {
      out.push({ type: "tool_result", tool_use_id: b.toolCallId, content: b.content });
    }
  }
  return out;
}

function toAnthropicMessages(messages: LLMMessage[]): { system: string; messages: any[] } {
  const systemParts: string[] = [];
  const out: any[] = [];
  const push = (role: "user" | "assistant", content: any[]) => {
    if (content.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(textOf(m.content));
      continue;
    }
    if (m.role === "tool") {
      push("user", [{
        type: "tool_result",
        tool_use_id: m.toolCallId || m.name || "tool",
        content: textOf(m.content),
      }]);
      continue;
    }
    const blocks = typeof m.content === "string"
      ? [{ type: "text" as const, text: m.content }]
      : m.content;
    push(m.role === "assistant" ? "assistant" : "user", anthropicContent(blocks));
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

function anthropicTools(tools: ToolDefinition[] | undefined): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

function mapAnthropicFinish(reason: string | null | undefined): LLMResponse["finishReason"] {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "length";
  return reason ? "error" : "stop";
}

interface SseFrame {
  event?: string;
  data: string;
}

async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (chunk: string): SseFrame => {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return { event, data: data.join("\n") };
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const chunk = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (chunk) yield parse(chunk);
        idx = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) yield parse(buffer.trim());
  } finally {
    reader.releaseLock();
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`API error ${response.status}: ${text.slice(0, 2000)}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function* streamAnthropic(
  config: { apiKey: string; baseUrl?: string },
  request: LLMRequest,
): AsyncGenerator<StreamEvent, void, unknown> {
  const { system, messages } = toAnthropicMessages(request.messages);
  const response = await postJson(
    `${rootOf(config.baseUrl || "")}/v1/messages`,
    {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    {
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      system: system || undefined,
      messages,
      tools: anthropicTools(request.tools),
      stream: true,
    },
    request.abortSignal,
  );
  if (!response.body) throw new Error("Anthropic 返回空响应体");

  let started = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;
  const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();

  for await (const frame of sseFrames(response.body)) {
    if (!frame.data || frame.data === "[DONE]") continue;
    let obj: any;
    try { obj = JSON.parse(frame.data); } catch { continue; }
    if (obj.type === "error") {
      yield { type: "error", error: String(obj.error?.message || "Anthropic 流错误") };
      return;
    }
    if (obj.type === "message_start") {
      if (!started) {
        started = true;
        yield { type: "start", id: obj.message?.id || `anthropic_${Date.now()}`, model: obj.message?.model || request.model };
      }
      inputTokens = Number(obj.message?.usage?.input_tokens ?? inputTokens) || 0;
      continue;
    }
    if (obj.type === "content_block_start") {
      const block = obj.content_block || {};
      const index = Number(obj.index ?? 0);
      if (block.type === "tool_use") {
        const id = String(block.id || `tool_${index}`);
        blocks.set(index, { type: "tool_use", id, name: String(block.name || "tool"), json: "" });
        yield { type: "tool_use_start", id, name: String(block.name || "tool") };
      } else {
        blocks.set(index, { type: "text", json: "" });
      }
      continue;
    }
    if (obj.type === "content_block_delta") {
      const index = Number(obj.index ?? 0);
      const block = blocks.get(index);
      const delta = obj.delta || {};
      if (delta.type === "text_delta" && delta.text) {
        yield { type: "text_delta", text: String(delta.text) };
      } else if (delta.type === "input_json_delta" && block?.type === "tool_use") {
        block.json += String(delta.partial_json || "");
        yield { type: "tool_use_delta", id: block.id!, input: String(delta.partial_json || "") };
      }
      continue;
    }
    if (obj.type === "content_block_stop") {
      const index = Number(obj.index ?? 0);
      const block = blocks.get(index);
      if (block?.type === "tool_use" && block.id) {
        let input: Record<string, unknown> = {};
        let argsParseError: string | undefined;
        try { input = block.json ? JSON.parse(block.json) : {}; }
        catch (e) { argsParseError = e instanceof Error ? e.message : String(e); }
        yield {
          type: "tool_use_end",
          id: block.id,
          name: block.name,
          input,
          ...(argsParseError ? { argsParseError, rawLength: block.json.length } : {}),
        };
      }
      continue;
    }
    if (obj.type === "message_delta") {
      finishReason = obj.delta?.stop_reason ?? finishReason;
      outputTokens = Number(obj.usage?.output_tokens ?? outputTokens) || 0;
      continue;
    }
    if (obj.type === "message_stop") {
      if (outputTokens || inputTokens) {
        yield {
          type: "usage",
          usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens },
        };
      }
      yield { type: "end", finishReason: mapAnthropicFinish(finishReason) };
      return;
    }
  }
  yield { type: "end", finishReason: mapAnthropicFinish(finishReason) };
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

function geminiParts(content: string | ContentBlock[]): any[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const out: any[] = [];
  for (const b of content) {
    if (b.type === "text") out.push({ text: b.text });
    else if (b.type === "image") out.push({ inlineData: { mimeType: b.mediaType, data: b.data } });
    else if (b.type === "tool_use") out.push({ functionCall: { name: b.name, args: b.input } });
    else if (b.type === "tool_result") out.push({ functionResponse: { name: b.toolCallId || "tool", response: { result: b.content } } });
  }
  return out;
}

function toGeminiContents(messages: LLMMessage[]): { system: string; contents: any[] } {
  const systemParts: string[] = [];
  const contents: any[] = [];
  const push = (role: "user" | "model", parts: any[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "system") { systemParts.push(textOf(m.content)); continue; }
    if (m.role === "tool") {
      const name = m.name || (m.toolCallId ? toolNames.get(m.toolCallId) : undefined) || "tool";
      push("user", [{ functionResponse: { name, response: { result: textOf(m.content) } } }]);
      continue;
    }
    if (typeof m.content !== "string") {
      for (const b of m.content) if (b.type === "tool_use") toolNames.set(b.id, b.name);
    }
    push(m.role === "assistant" ? "model" : "user", geminiParts(m.content));
  }
  return { system: systemParts.join("\n\n"), contents };
}

function geminiTools(tools: ToolDefinition[] | undefined): any[] | undefined {
  if (!tools?.length) return undefined;
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
}

function mapGeminiFinish(reason: string | undefined): LLMResponse["finishReason"] {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION") return "content_filter";
  return reason ? "error" : "stop";
}

export async function* streamGemini(
  config: { apiKey: string; baseUrl?: string },
  request: LLMRequest,
): AsyncGenerator<StreamEvent, void, unknown> {
  const { system, contents } = toGeminiContents(request.messages);
  const url = `${rootOf(config.baseUrl || "")}/gemini_cli/v1beta/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
  const response = await postJson(
    url,
    { Authorization: `Bearer ${config.apiKey}` },
    {
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      tools: geminiTools(request.tools),
      generationConfig: {
        temperature: request.temperature ?? 0.7,
        maxOutputTokens: request.maxTokens ?? 8192,
      },
    },
    request.abortSignal,
  );
  if (!response.body) throw new Error("Gemini 返回空响应体");

  let started = false;
  let usage: TokenUsage | null = null;
  let finishReason: string | undefined;
  let toolSeq = 0;
  for await (const frame of sseFrames(response.body)) {
    if (!frame.data || frame.data === "[DONE]") continue;
    let obj: any;
    try { obj = JSON.parse(frame.data); } catch { continue; }
    if (obj.error) {
      yield { type: "error", error: String(obj.error.message || "Gemini 流错误") };
      return;
    }
    if (!started) {
      started = true;
      yield { type: "start", id: `gemini_${Date.now()}`, model: request.model };
    }
    const u = obj.usageMetadata;
    if (u) {
      usage = {
        promptTokens: Number(u.promptTokenCount ?? 0),
        completionTokens: Number(u.candidatesTokenCount ?? 0),
        totalTokens: Number(u.totalTokenCount ?? 0),
      };
    }
    const candidate = obj.candidates?.[0];
    if (candidate?.finishReason) finishReason = String(candidate.finishReason);
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text) {
        yield { type: "text_delta", text: part.text };
      } else if (part.functionCall) {
        const id = `gemini_tool_${++toolSeq}`;
        const name = String(part.functionCall.name || "tool");
        const args = part.functionCall.args ?? {};
        yield { type: "tool_use_start", id, name };
        yield { type: "tool_use_delta", id, input: JSON.stringify(args) };
        yield { type: "tool_use_end", id, name, input: args };
        finishReason = finishReason || "STOP";
      }
    }
  }
  if (usage) yield { type: "usage", usage };
  yield { type: "end", finishReason: mapGeminiFinish(finishReason) };
}

// ---------------------------------------------------------------------------
// Aggregate a stream into a non-stream response（compaction / plan 路径用）
// ---------------------------------------------------------------------------

export async function aggregateStream(stream: AsyncGenerator<StreamEvent, void, unknown>): Promise<LLMResponse> {
  let id = "";
  let model = "";
  let content = "";
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const toolCalls: ToolCallResult[] = [];
  let finishReason: LLMResponse["finishReason"] = "stop";
  for await (const event of stream) {
    if (event.type === "start") { id = event.id; model = event.model; }
    else if (event.type === "text_delta") content += event.text;
    else if (event.type === "tool_use_end") {
      toolCalls.push({ id: event.id, name: event.name || "tool", input: event.input || {}, status: "pending" });
    } else if (event.type === "usage") Object.assign(usage, event.usage);
    else if (event.type === "end") {
      const fr = event.finishReason;
      finishReason = fr === "tool_use" || fr === "length" || fr === "content_filter" ? fr : "stop";
    } else if (event.type === "error") throw new Error(event.error);
  }
  return {
    id: id || `acw_${Date.now()}`,
    content,
    ...(toolCalls.length ? { toolCalls } : {}),
    usage,
    finishReason,
    model,
  };
}

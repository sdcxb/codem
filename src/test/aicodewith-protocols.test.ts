/**
 * AICodeWith 三套协议适配的 wire 级判据（不访问真实网络）：
 * - Claude 走 Anthropic Messages：URL/头/消息转换 + SSE 文本与 tool_use；
 * - Gemini 走 Google Gemini：URL/头/contents 转换 + SSE 文本与 functionCall；
 * - 模型家族分类（协议 + 是否多模态）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../core/llm/types";
import {
  classifyAICodeWithModel,
  streamAnthropic,
  streamGemini,
} from "../core/llm/aicodewith-protocols";

const encoder = new TextEncoder();
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join("\n\n") + "\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AICODEWITH-3 家族分类", () => {
  it("Claude/Gemini 用各自协议，且标为多模态；图像/视频模型不进聊天", () => {
    expect(classifyAICodeWithModel("claude-sonnet-4-6")).toEqual({ protocol: "anthropic", inputModalities: ["text", "image"] });
    expect(classifyAICodeWithModel("gemini-3-pro-preview")).toEqual({ protocol: "gemini", inputModalities: ["text", "image"] });
    expect(classifyAICodeWithModel("gpt-5.6-sol")?.protocol).toBe("openai");
    expect(classifyAICodeWithModel("glm-5.3")?.inputModalities).toEqual(["text"]);
    expect(classifyAICodeWithModel("gpt-image-2")).toBeNull();
    expect(classifyAICodeWithModel("seedance-2")).toBeNull();
  });
});

describe("AICODEWITH-4 Anthropic Messages", () => {
  it("Claude 走 /v1/messages，文本与 tool_use 流都能还原", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":12}}}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"read"}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(streamAnthropic(
      { apiKey: "sk-acw-test", baseUrl: "https://api.aicodewith.ai/v1" },
      {
        model: "claude-sonnet-4-6",
        messages: [
          { id: "s", role: "system", content: "你是助手" },
          { id: "u", role: "user", content: "读取 a.txt" },
          { id: "a", role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "read", input: { path: "a.txt" } }] },
          { id: "t", role: "tool", toolCallId: "tool_1", name: "read", content: "hello" },
        ],
        tools: [{ name: "read", description: "读文件", parameters: { type: "object" } }],
      },
    ));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.aicodewith.ai/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-acw-test");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init.body));
    /**
     * 提示缓存默认开（`codem-context-config.promptCache` 缺键 = true）⇒ system 从字符串
     * 变成「一个 text block + cache_control」的数组。断点位置与开关的判据在
     * `prompt-cache-breakpoints.test.ts`，这里只钉 wire 形状没被改坏。
     */
    expect(body.system).toEqual([
      { type: "text", text: "你是助手", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages.some((m: any) => m.content?.some?.((b: any) => b.type === "tool_result"))).toBe(true);
    expect(body.tools[0].input_schema).toBeTruthy();

    expect(events.find((e) => e.type === "text_delta")?.text).toBe("你好");
    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd).toMatchObject({ id: "tool_1", name: "read", input: { path: "a.txt" } });
    expect(events.at(-1)).toEqual({ type: "end", finishReason: "tool_use" });
  });

  it("历史 assistant 的 OpenAI 形状 tool_calls 必须转成 tool_use（否则 tool_result 孤立，模型重发调用）", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ]));
    vi.stubGlobal("fetch", fetchMock);

    await collect(streamAnthropic(
      { apiKey: "sk-acw-test", baseUrl: "https://api.aicodewith.ai/v1" },
      {
        model: "claude-sonnet-4-6",
        messages: [
          { id: "u", role: "user", content: "读取 a.txt" },
          /**
           * 消息表重建出来的 assistant 行就是这种形状：`content` 为空、调用在
           * `tool_calls`（OpenAI 形状）。Anthropic 不接受它，必须在这里转成 tool_use。
           */
          {
            id: "a",
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "tool_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
            ],
          } as never,
          { id: "t", role: "tool", toolCallId: "tool_1", name: "read", content: "hello" },
        ],
      },
    ));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const assistant = body.messages.find((m: any) => m.role === "assistant");
    expect(assistant, "assistant 消息必须存在（不能被空 content 丢掉）").toBeTruthy();
    expect(assistant.content).toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        id: "tool_1",
        name: "read",
        input: { path: "a.txt" },
      }),
    );
    const toolResult = body.messages
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .find((b: any) => b.type === "tool_result");
    expect(toolResult?.tool_use_id, "tool_result 必须指向同一条 tool_use").toBe("tool_1");
  });
});

describe("AICODEWITH-5 Gemini", () => {
  it("Gemini 走 /gemini_cli，文本与 functionCall 流都能还原", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      `data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}`,
      `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"path":"a.txt"}}}]},"finishReason":"STOP"}]}`,
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(streamGemini(
      { apiKey: "sk-acw-test", baseUrl: "https://api.aicodewith.ai/v1" },
      {
        model: "gemini-3-pro-preview",
        messages: [
          { id: "u", role: "user", content: "读取 a.txt" },
          { id: "t", role: "tool", toolCallId: "call_1", name: "read", content: "hello" },
        ],
        tools: [{ name: "read", description: "读文件", parameters: { type: "object" } }],
      },
    ));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.aicodewith.ai/gemini_cli/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-acw-test");
    const body = JSON.parse(String(init.body));
    const geminiParts = body.contents.flatMap((c: any) => c.parts);
    expect(geminiParts.find((p: any) => p.functionResponse)?.functionResponse.name).toBe("read");
    expect(body.tools[0].functionDeclarations[0].name).toBe("read");
    expect(events.find((e) => e.type === "text_delta")?.text).toBe("你好");
    expect(events.find((e) => e.type === "tool_use_end")).toMatchObject({ name: "read", input: { path: "a.txt" } });
  });
});

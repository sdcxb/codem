/**
 * Android 本机 Host 的 AICodeWith 三协议分派：同一把 `sk-acw-*` key，
 * Claude 走 Anthropic Messages、Gemini 走 Gemini、其余走 OpenAI 兼容。
 * 这是手机本地跑项目/对话的模型入口，不能只支持 OpenAI。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../../packages/host/src/provider";
import type { LLMRequest, StreamEvent } from "../core/llm/types";

const enc = new TextEncoder();
function sse(frames: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(frames.join("\n\n") + "\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const request = (model: string): LLMRequest => ({
  model,
  messages: [{ id: "u", role: "user", content: "hi" }],
});

async function collect(gen: AsyncGenerator<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("HOST-AICW 手机本机 Host 三协议", () => {
  it("Claude 走 Anthropic Messages（x-api-key + /v1/messages）", async () => {
    const mock = vi.fn(async () =>
      sse([
        `event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-4-6"}}`,
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}`,
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
        `event: message_stop\ndata: {"type":"message_stop"}`,
      ]),
    );
    vi.stubGlobal("fetch", mock);
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://api.aicodewith.ai/v1",
      apiKey: "sk-acw-test",
      model: "claude-sonnet-4-6",
    });
    const events = await collect(p.stream(request("claude-sonnet-4-6")));
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.aicodewith.ai/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-acw-test");
    expect(events.find((e) => e.type === "text_delta")?.text).toBe("OK");
  });

  it("Gemini 走 Gemini 协议，OpenAI 模型仍走 chat/completions", async () => {
    const mock = vi.fn(async () =>
      sse([`data: {"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}`]),
    );
    vi.stubGlobal("fetch", mock);
    const p = new OpenAICompatibleProvider({
      baseUrl: "https://api.aicodewith.ai/v1",
      apiKey: "sk-acw-test",
      model: "gemini-3-flash-preview",
    });
    await collect(p.stream(request("gemini-3-flash-preview")));
    expect(String((mock.mock.calls[0] as unknown as [string])[0])).toContain("/gemini_cli/v1beta/models/");

    mock.mockClear();
    mock.mockImplementation(async () => new Response('{"choices":[]}', { status: 200 }));
    const q = new OpenAICompatibleProvider({
      baseUrl: "https://api.aicodewith.ai/v1",
      apiKey: "sk-acw-test",
      model: "deepseek-v4-flash",
    });
    await collect(q.stream(request("deepseek-v4-flash")));
    expect(String((mock.mock.calls[0] as unknown as [string])[0])).toBe("https://api.aicodewith.ai/v1/chat/completions");
  });
});

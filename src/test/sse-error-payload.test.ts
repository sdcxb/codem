/**
 * 第 184 波（G1）：**SSE 里的 `error` 载荷不许被吞成"正常收尾"**。
 *
 * ## 缺陷形态（真机可复现，属"假成功"级）
 *
 * 供应商经常用 **HTTP 200 + `data: {"error":{"message":"server_busy"}}`** 报错
 * （OpenAI 兼容网关、各家代理都这么干）。改前 `provider.ts` 解析流时**完全不看 `parsed.error`**：
 *  · `finish_reason` 永远不出现 ⇒ 落到"流结束但没 finish_reason"的兜底；
 *  · 兜底只 `console.warn`、发 `usage` 全 0、发 **`finishReason: "stop"`**；
 *  ⇒ 用户看到的是"模型什么都没说就结束了"（**正常收尾**），成本记 0，而且**不重试** ——
 *  因为 `retry.ts` 那套文案分诊只在"有错误对象被抛出来"时才有机会跑。
 *
 * ## 判据
 *
 * | # | 输入 | 判据 |
 * | --- | --- | --- |
 * | SSE-1 | 流里先来一帧文本，再来 `{"error":{"message":"server_busy"}}` | **抛错**（不许静默 end） |
 * | SSE-2 | 抛出来的错误要**能被重试分诊认出容量类**（文案/`code` 都在） | `classifyError().isRetryable === true` |
 * | SSE-3 | 反向对照：**没有** error 载荷、服务端正常收尾（无 finish_reason） | 仍然安静收尾（既有兜底不许被一并改掉） |
 * | SSE-4 | 反向对照：正常的 `finish_reason: "stop"` 不受影响 | 正常 end |
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAICompatibleProvider } from "../core/llm/provider";
import { classifyError } from "../core/retry/retry";

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= frames.length) {
        c.close();
        return;
      }
      c.enqueue(new TextEncoder().encode(frames[i++]));
    },
  });
}

function makeProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "sse-provider",
    name: "SSE Mock",
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    models: [
      {
        id: "sse-model",
        name: "SSE Model",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ],
  });
}

function mockFetch(frames: string[]) {
  const body = sseStream(frames);
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    body,
    text: async () => "",
    headers: new Headers(),
  })) as never;
}

/** 驱动一次流式请求，收集事件；抛出则原样上抛 */
async function drive(frames: string[]): Promise<any[]> {
  mockFetch(frames);
  const provider = makeProvider();
  const events: any[] = [];
  for await (const ev of (provider as any).stream({
    model: "sse-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  })) {
    events.push(ev);
  }
  return events;
}

describe("第 184 波 · SSE error 载荷（G1）", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("SSE-1: `data: {\"error\":…}` 必须**抛错**，不许静默收尾成 stop", async () => {
    const frames = [
      'data: {"id":"m1","choices":[{"delta":{"content":"部分文本"}}]}\n\n',
      'data: {"error":{"message":"server_busy","type":"server_error"}}\n\n',
    ];
    await expect(drive(frames)).rejects.toThrow(/server_busy|stream error/i);
  });

  it("SSE-2: 抛出来的错误必须能被重试分诊认出（容量类 ⇒ 可重试）", async () => {
    const frames = ['data: {"error":{"message":"servers are currently busy"}}\n\n'];
    let caught: unknown = null;
    try {
      await drive(frames);
    } catch (e) {
      caught = e;
    }
    expect(caught, "必须抛错").not.toBeNull();
    // 文案里带原文 ⇒ 现有的可重试表能认出来
    expect(String((caught as Error).message)).toContain("servers are currently busy");
    expect(classifyError(caught).isRetryable, "busy 文案必须可重试").toBe(true);
    // code 也要带出来（供应商常把码放在 code/type）
    expect(classifyError(caught).type).toBe("capacity");
  });

  it("SSE-2b: 错误体里的 `code` 会被带上（供分诊按 codeText 匹配）", async () => {
    const frames = ['data: {"error":{"code":"server_busy","message":"busy"}}\n\n'];
    let caught: any = null;
    try {
      await drive(frames);
    } catch (e) {
      caught = e;
    }
    expect(caught?.code).toBe("server_busy");
    expect(classifyError(caught).isRetryable).toBe(true);
  });

  it("SSE-3 反向对照：没有 error 载荷、服务端正常收尾 ⇒ 仍走既有安静兜底（不许被一并改成抛错）", async () => {
    const frames = ['data: {"id":"m1","choices":[{"delta":{"content":"hi"}}]}\n\n'];
    const events = await drive(frames);
    const end = events.find((e) => e.type === "end");
    expect(end, "必须有 end 事件").toBeTruthy();
    expect(end.finishReason, "无 finish_reason 的兜底仍是 stop").toBe("stop");
  });

  it("SSE-4 反向对照：正常 finish_reason 不受影响", async () => {
    const frames = ['data: {"id":"m1","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'];
    const events = await drive(frames);
    const end = events.find((e) => e.type === "end");
    expect(end.finishReason).toBe("stop");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });
});

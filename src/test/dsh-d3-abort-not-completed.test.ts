/**
 * D3：**流中途被取消**不许被伪装成"正常结束"。
 *
 * ## 缺陷形态
 *
 * 用户点 ■ → `request.abortSignal` 触发 → provider 里的
 * `abortHandler = () => reader.cancel()`。而 `reader.cancel()` 会让挂起的
 * `reader.read()` 以 `{done: true}` **正常返回**（它不抛 `AbortError`）。
 * 于是代码走进"服务端没给 finish_reason 的兜底分支"，老老实实发出
 * `finishReason: "stop"`（有工具调用时是 `"tool_use"`）。
 *
 * 循环把 `stop` 记进 `lastFinishReason`，这一轮看起来**和正常完成一模一样**：
 * 用户按了停止，回合却以 `reason: "completed"` 收场（`executeIteration` 里那条
 * `if (error.name === "AbortError")` 分支对"流阶段取消"根本不会触发）。
 *
 * ## 判据（用**真实 provider** + 可控 SSE 流，端到端）
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | D3-A | 流吐一帧文本后挂住 → `loop.abort()` | end 事件 `result.type === "aborted"`，且 `reason !== "completed"` |
 * | D3-B | 流被服务端正常收尾（无 finish_reason、**没有**中止） | 仍然 `completed`（这条兜底路径不许被一并改成 aborted） |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { OpenAICompatibleProvider } from "../core/llm/provider";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";

const CWD = "C:\\d3-abort";

/**
 * 可控 SSE 响应体：先吐一帧合法的 `data:` 文本增量，之后 `pull()` 永远挂住
 * （模拟"服务端还在想 / 连接没断"），但 `cancel()` 会真的被调用。
 */
function controllableStream() {
  const state = { cancelled: false };
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(new TextEncoder().encode('data: {"id":"m1","choices":[{"delta":{"content":"hi"}}]}\n\n'));
    },
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    state,
    response: {
      ok: true,
      status: 200,
      body,
      text: async () => "",
      headers: new Headers(),
    },
    close: () => controller?.close(),
  };
}

function makeProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "d3-provider",
    name: "D3 Mock",
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    models: [
      {
        id: "d3-model",
        name: "D3 Model",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ],
  });
}

describe("D3：流中途取消必须如实上报 aborted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("D3-A: 流吐一帧文本后 abort() → end 事件 result.type === aborted", async () => {
    const s = controllableStream();
    global.fetch = vi.fn(async () => s.response) as never;

    const loop = new AgenticLoop(makeProvider() as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "d3-model",
      securityMode: "full",
    });

    const events: any[] = [];
    let aborted = false;
    for await (const e of loop.run("dsh-d3-a", "你好", CWD, "system prompt")) {
      events.push(e);
      if (e.type === "text_delta" && !aborted) {
        aborted = true;
        loop.abort(); // 用户点 ■ —— 此刻流还开着（reader.read() 正挂着）
      }
    }

    expect(aborted, "前置：必须真的在流中途按下取消").toBe(true);
    expect(s.state.cancelled, "前置：取消必须真的 cancel 掉 reader（否则流不会结束）").toBe(true);

    const ends = events.filter((e) => e.type === "end");
    expect(ends.length, "每一轮都必须以恰好一个 end 事件收场").toBe(1);
    expect(
      ends[0].result.type,
      `流中途被取消不是"完成"；实际 ${JSON.stringify(ends[0].result)}（改前这里恒为 {type:"stop",reason:"completed"}）`,
    ).toBe("aborted");
    expect(ends[0].result.reason).not.toBe("completed");
  });

  it("D3-B: 服务端正常收尾（无 finish_reason、未中止）→ 照旧 completed", async () => {
    const s = controllableStream();
    global.fetch = vi.fn(async () => s.response) as never;

    const loop = new AgenticLoop(makeProvider() as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "d3-model",
      securityMode: "full",
    });

    const events: any[] = [];
    for await (const e of loop.run("dsh-d3-b", "你好", CWD, "system prompt")) {
      events.push(e);
      if (e.type === "text_delta") {
        // 服务端自己收尾（连接关闭、没有 finish_reason）—— 这条兜底路径必须保持原语义
        s.close();
      }
    }

    const ends = events.filter((e) => e.type === "end");
    expect(ends.length).toBe(1);
    expect(
      ends[0].result,
      "没有中止信号时，兜底收尾仍然是正常完成（不许把这条路径一并改成 aborted）",
    ).toEqual(expect.objectContaining({ type: "stop", reason: "completed" }));
  });
});

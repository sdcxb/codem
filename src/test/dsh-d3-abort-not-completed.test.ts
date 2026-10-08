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

  /**
   * ★ 第 184 波（审计修复后更新）：这一条原来断言"服务端收尾但没给 finish_reason ⇒ 照旧 completed"。
   *
   * 审计指出那个契约**本身是个缺口**：连接被代理/网关半途掐断时形状完全一样
   * （挂起的 `reader.read()` 也是正常返回 `{done:true}`），于是**半个回答被当成完整回答**、
   * 界面显示"任务完成"、用量记 0。
   *
   * 现在 provider 用**协议终止符 `[DONE]`** 区分：
   * · 见过 `[DONE]` ⇒ 服务端确实收完了（缺 finish_reason 只是对端怪癖）；
   * · **没见过** ⇒ 如实报 `finishReason: "error"`，循环把它当"不完整"抛错走重试。
   *
   * 这条判据随之改成**两半**，并把原来那句"不许改成 aborted"的意图**保留**下来
   * （掐断 ≠ 用户中止：一个是可重试的传输问题，一个是用户意图）。
   */
  it("D3-B: 掐断（无 [DONE]、无 finish_reason）**不许**算完成 —— 必须走重试，且不许报 aborted", async () => {
    let attempt = 0;
    /**
     * 第一次：吐一段正文后**掐断**（无 `[DONE]`、无 `finish_reason`）。
     * 第二次（重试）：正常收尾（`finish_reason: "stop"` + `[DONE]`）。
     * ⇒ 既能证明"掐断被当成可重试的异常"，也能证明"重试后能正常完成"。
     */
    global.fetch = vi.fn(async () => {
      attempt++;
      const cut = attempt === 1;
      const frames = cut
        ? ['data: {"id":"m1","choices":[{"delta":{"content":"说到一半"}}]}\n\n']
        : [
            'data: {"id":"m1","choices":[{"delta":{"content":"说完了"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ];
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (i >= frames.length) {
            c.close();
            return;
          }
          c.enqueue(new TextEncoder().encode(frames[i++]));
        },
      });
      return { ok: true, status: 200, body, text: async () => "", headers: new Headers() };
    }) as never;

    const loop = new AgenticLoop(makeProvider() as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "d3-model",
      securityMode: "full",
    });

    const events: any[] = [];
    for await (const e of loop.run("dsh-d3-b", "你好", CWD, "system prompt")) events.push(e);

    const retried = events.some((e) => e.type === "retry");
    expect(
      retried,
      `"连接被掐断"必须被当成**可重试的异常**（改前它被当成正常完成，压根不重试）。事件序列：${events
        .map((e) => e.type)
        .join(",")}`,
    ).toBe(true);

    const ends = events.filter((e) => e.type === "end");
    expect(ends.length).toBe(1);
    // 保留原判据的意图：掐断 ≠ 用户中止
    expect(ends[0].result.type, "掐断不是 `aborted`（那是用户意图）").not.toBe("aborted");
    // 重试成功后这一轮才允许算完成
    expect(ends[0].result, "重试拿到正常收尾后应当完成").toEqual(
      expect.objectContaining({ type: "stop", reason: "completed" }),
    );
  });

  it("D3-C: 见过 `[DONE]` 而缺 finish_reason ⇒ 仍算正常完成（别把有终止符的也误判成掐断）", async () => {
    const frames = [
      'data: {"id":"m1","choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= frames.length) {
          c.close();
          return;
        }
        c.enqueue(new TextEncoder().encode(frames[i++]));
      },
    });
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body,
      text: async () => "",
      headers: new Headers(),
    })) as never;

    const loop = new AgenticLoop(makeProvider() as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "d3-model",
      securityMode: "full",
    });
    const events: any[] = [];
    for await (const e of loop.run("dsh-d3-c", "你好", CWD, "system prompt")) events.push(e);

    const ends = events.filter((e) => e.type === "end");
    expect(ends.length).toBe(1);
    expect(ends[0].result, "有协议终止符 ⇒ 正常完成（不许误报失败）").toEqual(
      expect.objectContaining({ type: "stop", reason: "completed" }),
    );
  });
});

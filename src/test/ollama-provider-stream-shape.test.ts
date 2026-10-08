/**
 * ★ 第 185 波（复审 R1-3 / I-6）：**Ollama 这条 provider 不许是"另一套真相"**。
 *
 * ## 钉的是什么
 *
 * ① `stream()` **从不发 `tool_use_end`**（全文件 7 处 yield 里没有它）⇒ 主循环的
 *    `tool_use_end` 分支（`agentic-loop.ts:3857`）永远不执行：`currentToolCalls` 里那几条
 *    `status:"pending"` / `input:{}` 就是全部下场，工具参数永远解析不出来；
 * ② `finish_reason` 不过唯一实现 `mapFinishReason`（`complete()` 把未知取值压成 `"stop"`，
 *    `stream()` 原样透传）⇒ 同一次 `length` 截断在 OpenAI 路径报 `length`、
 *    在 Ollama 路径报 `stop`（半截压缩摘要被当成完整摘要写回）；
 * ③ 丢行计数只进 `console.warn` —— 注释宣称"与 `provider.ts` 同形"，实现里却没有消费方。
 *
 * ## 判据（驱动**真 provider**，只把 `fetch` 换成可控 SSE）
 *
 * | id | 造法 | 判据 |
 * |---|---|---|
 * | OLL-1 | 两片参数增量 + `finish_reason:"tool_calls"` | 必须发出 `tool_use_end`，带**解析后的参数**与 id；`end.finishReason === "tool_use"` |
 * | OLL-2 | `finish_reason:"length"` | `end.finishReason === "length"`（不许压成 stop） |
 * | OLL-3 | 陌生 `finish_reason`（`"banana"`） | 归 `"error"`（"不知道它为什么结束" ≠ 正常结束） |
 * | OLL-4 | 流里丢过一行、但 JSON 恰好还能解析 | `tool_use_end` 必须带 `argsParseError`（"参数可能不完整"）与 `rawLength` |
 * | OLL-5 | 流没有 `finish_reason` 就结束 | 工具调用**也不许永远 pending**（兜底补发 `tool_use_end`） |
 * | OLL-6 | `complete()` 的 `finish_reason` | 与流式**同一套映射**（length/未知/tool_calls） |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { OllamaProvider } from "../core/llm/ollama-provider";
import type { StreamEvent, LLMRequest } from "../core/llm/types";

/** 可控 SSE 响应体（只用到 `ok` / `body.getReader()` / `json()`，与 provider 的用法一致） */
function sseResponse(frames: string[]) {
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
  return { ok: true, status: 200, body, text: async () => "", json: async () => ({}), headers: new Headers() };
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const request: LLMRequest = {
  model: "llama3.1",
  messages: [{ id: "m1", role: "user", content: "读一下 a.ts" }],
};

async function collect(frames: string[]): Promise<StreamEvent[]> {
  global.fetch = vi.fn(async () => sseResponse(frames)) as never;
  const provider = new OllamaProvider();
  const out: StreamEvent[] = [];
  for await (const ev of provider.stream(request)) out.push(ev);
  return out;
}

/** 工具参数分两片到达（第二片**不带 id** —— 真实 SSE 就是这个形状） */
const TOOL_FRAMES = (finish: string | null) => {
  const frames = [
    frame({
      id: "x",
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_ollama_1", function: { name: "read", arguments: '{"pa' } },
            ],
          },
        },
      ],
    }),
    frame({ id: "x", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] }),
  ];
  if (finish !== null) {
    frames.push(frame({ id: "x", choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
  }
  frames.push("data: [DONE]\n\n");
  return frames;
};

describe("Ollama provider：工具调用必须落地 + finish_reason 走唯一映射（R1-3/I-6）", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("OLL-1: 工具调用必须发 `tool_use_end`（带解析后的参数），end 为 tool_use", async () => {
    const events = await collect(TOOL_FRAMES("tool_calls"));

    const ends = events.filter((e) => e.type === "tool_use_end") as Extract<StreamEvent, { type: "tool_use_end" }>[];
    expect(
      ends.length,
      `工具调用必须落地：改前本 provider **从不发** tool_use_end（事件序列：${events.map((e) => e.type).join(",")}）`,
    ).toBe(1);
    expect(ends[0].id, "id 必须是**第一片**给的那个（后续增量片不带 id）").toBe("call_ollama_1");
    expect(ends[0].name).toBe("read");
    expect(ends[0].input, "两片增量必须被拼起来并解析成对象").toEqual({ path: "a.ts" });
    expect(ends[0].argsParseError, "参数完整时不许报解析错").toBeUndefined();

    const end = events.find((e) => e.type === "end") as Extract<StreamEvent, { type: "end" }>;
    expect(end.finishReason, "`tool_calls` 必须归一成内部的 `tool_use`").toBe("tool_use");
  });

  it("OLL-2: `length` 必须原样传到 `end`（截断不许被说成正常结束）", async () => {
    const events = await collect(TOOL_FRAMES("length"));
    const end = events.find((e) => e.type === "end") as Extract<StreamEvent, { type: "end" }>;
    expect(
      end.finishReason,
      "同一次截断在 OpenAI 路径报 length、在 Ollama 路径报 stop —— 这正是要消灭的两套真相",
    ).toBe("length");
  });

  it("OLL-3: 陌生 finish_reason 归 `error`（不认识的结束原因不是正常结束）", async () => {
    const events = await collect(TOOL_FRAMES("banana"));
    const end = events.find((e) => e.type === "end") as Extract<StreamEvent, { type: "end" }>;
    expect(end.finishReason).toBe("error");
  });

  it("OLL-4: 丢过行 ⇒ `tool_use_end` 上必须标出参数可能不完整（丢行计数要有消费方）", async () => {
    const frames = [
      frame({
        id: "x",
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_bad", function: { name: "write", arguments: '{"path":"b.txt","content":"ok"}' } }],
            },
          },
        ],
      }),
      // 一行坏数据（解析不了）—— 改前它只进 console.warn，下游看不到任何提示
      "data: { 这不是 JSON\n\n",
      frame({ id: "x", choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ];
    const events = await collect(frames);

    const end = events.find((e) => e.type === "tool_use_end") as Extract<StreamEvent, { type: "tool_use_end" }>;
    expect(end, "丢行不影响 tool_use_end 的发出").toBeTruthy();
    expect(
      end.argsParseError,
      `丢行必须在 tool_use_end 上可见（改前只打一行 console.warn，argsParseError/rawLength 没有任何消费方）`,
    ).toContain("unparsable SSE line");
    expect(typeof end.rawLength).toBe("number");
  });

  it("OLL-5: 流没有 `finish_reason` 就结束 ⇒ 工具调用也不许永远是 pending（兜底补发）", async () => {
    const events = await collect(TOOL_FRAMES(null));
    expect(
      events.some((e) => e.type === "tool_use_end"),
      "没有 finish_reason 时也必须有兜底 —— 否则主循环里那条调用永远解析不出参数",
    ).toBe(true);
  });

  it("OLL-6: 非流式 `complete()` 与流式**同一套映射**", async () => {
    const cases: Array<[string, string]> = [
      ["length", "length"],
      ["tool_calls", "tool_use"],
      ["banana", "error"],
      ["stop", "stop"],
    ];
    for (const [raw, expected] of cases) {
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: "c1",
          choices: [{ message: { content: "x" }, finish_reason: raw }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        text: async () => "",
        headers: new Headers(),
      })) as never;
      const resp = await new OllamaProvider().complete(request);
      expect(resp.finishReason, `complete() 对 ${raw} 的映射`).toBe(expected);
    }
  });
});

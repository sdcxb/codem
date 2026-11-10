/**
 * C03 可观测性：**真实 provider 的缓存命中必须可度量**。
 *
 * ## 修的是什么
 *
 * 修前有两处「看不见」：
 * 1. `usage-normalize.ts` 只认 DeepSeek 的 `prompt_cache_hit_tokens` 与旧的
 *    `cache_read_input_tokens`，不认 OpenAI 的 `prompt_tokens_details.cached_tokens`，
 *    也不认 Anthropic 的 `cache_creation_input_tokens`（写缓存）；
 * 2. `aicodewith-protocols.ts::streamAnthropic`（默认 provider 的 Claude 路径）
 *    只读 `input_tokens` / `output_tokens`，把 Anthropic 返回的缓存桶整段丢掉。
 *
 * 于是界面上的「缓存命中」永远是 0%（其实是「未上报」被聚合初始化成了 0）。
 *
 * ## 判据
 *
 * | # | 输入 | 判据 |
 * | --- | --- | --- |
 * | CACHE-OBS-1 | Anthropic 形状 `input_tokens + cache_read + cache_creation` | 读/写两个桶分别落到 `cacheReadTokens` / `cacheWriteTokens`，旧字段 `cacheHitTokens` 不变 |
 * | CACHE-OBS-2 | OpenAI 形状 `prompt_tokens_details.cached_tokens`（含扁平 `cached_tokens`） | 读缓存 600、写缓存缺报不出现、uncached = prompt − cached |
 * | CACHE-OBS-3 | 一个缓存字段都没有 | 归一化不产出缓存键；`TokenTracker` 累计 0 且 `cacheReported=false`（未上报 ≠ 确定 0） |
 * | CACHE-OBS-4 | 负数 / 字符串 | 不抛；坏值不挡住后面的合法值；全坏 ⇒ 0 + `cacheReported=false` |
 * | CACHE-OBS-5 | 两轮不同形状上报 | `TokenTracker` 累计读/写，`cacheReported=true` |
 * | CACHE-OBS-6 | `CostTracker` | 会话 / 模型 / 全局三处累计一致，未上报的会话标 false |
 * | CACHE-OBS-7 | 默认 provider 的 Anthropic 流 | `streamAnthropic` 的 usage 事件带缓存桶（旧实现整段丢） |
 * | CACHE-OBS-8 | OpenAI 兼容流 / 非流 | usage 事件的缓存桶与归一化一致 |
 * | CACHE-OBS-9 | 真循环 | `LoopResult.usage` 累计出读/写/上报标记（UI 从它取数） |
 *
 * 变异自证（会让本文件红）：
 * - 去掉 `usage-normalize.ts` 的 `prompt_tokens_details.cached_tokens` 分支 ⇒ CACHE-OBS-2 红；
 * - 去掉 `streamAnthropic` 的 `mergeUsage(obj.message?.usage)` ⇒ CACHE-OBS-7 红；
 * - 把聚合初始化的 `cacheReported: false` 改成 true ⇒ CACHE-OBS-3 红。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseProviderUsage, toTokenUsage } from "../core/llm/usage-normalize";
import { TokenTracker } from "../core/llm/token-tracker";
import { CostTracker } from "../core/llm/cost-tracker";
import { OpenAICompatibleProvider } from "../core/llm/provider";
import { streamAnthropic } from "../core/llm/aicodewith-protocols";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import type { StreamEvent } from "../core/llm/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

describe("CACHE-OBS：provider 缓存字段解析与累计", () => {
  it("CACHE-OBS-1：Anthropic 形状 → 读/写两桶分别落地，旧字段 cacheHitTokens 保持", () => {
    const u = parseProviderUsage({
      input_tokens: 1000,
      output_tokens: 20,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 100,
    });
    expect(u.cacheReadTokens, "Anthropic 的 cache_read_input_tokens 必须落到读桶").toBe(700);
    expect(u.cacheWriteTokens, "Anthropic 的 cache_creation_input_tokens 必须落到写桶").toBe(100);
    expect(u.cacheHitTokens, "旧字段必须保持（兼容既有消费方）").toBe(700);
    expect(u.cacheReported).toBe(true);
    // input_tokens 是「未命中输入」；prompt 总量 = 未命中 + 读缓存（写缓存单独一桶）
    expect(u.promptTokens).toBe(1700);
    expect(u.uncachedInputTokens).toBe(1000);
    expect(u.totalTokens).toBe(1720);
  });

  it("CACHE-OBS-2：OpenAI 形状（details.cached_tokens / 扁平 cached_tokens）→ 读桶 + uncached 减法", () => {
    const nested = parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 600 },
    });
    expect(nested.cacheReadTokens).toBe(600);
    expect(nested.cacheHitTokens).toBe(600);
    expect(nested.uncachedInputTokens).toBe(400);
    expect(nested.cacheReported).toBe(true);
    expect("cacheWriteTokens" in nested, "OpenAI 没有写缓存桶 ⇒ 键不许出现（缺报 ≠ 0）").toBe(false);

    const flat = parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      cached_tokens: 250,
    });
    expect(flat.cacheReadTokens).toBe(250);
    expect(flat.uncachedInputTokens).toBe(750);
  });

  it("CACHE-OBS-3：一个缓存字段都没有 ⇒ 不产出缓存键；累计 0 且 cacheReported=false", () => {
    const u = parseProviderUsage({ prompt_tokens: 1000, completion_tokens: 10 });
    expect("cacheReadTokens" in u).toBe(false);
    expect("cacheWriteTokens" in u).toBe(false);
    expect("cacheHitTokens" in u).toBe(false);
    expect("cacheReported" in u).toBe(false);

    const tracker = new TokenTracker(200000);
    const turn = tracker.recordActualUsage(
      { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 },
      0,
      "fp-1",
    );
    expect(turn.cacheReadTokens, "累计口径：缺报按 0 记").toBe(0);
    expect(turn.cacheWriteTokens).toBe(0);
    expect(turn.cacheReported, "0 是「未知」不是「确定未命中」").toBe(false);
    expect(turn.cacheHitTokens, "旧字段仍是 undefined（缺报即缺报）").toBeUndefined();

    const cumulative = tracker.getCumulative();
    expect(cumulative.cacheReadTokens).toBe(0);
    expect(cumulative.cacheWriteTokens).toBe(0);
    expect(cumulative.cacheReported).toBe(false);

    /**
     * 聚合形状（`LoopState.totalUsage` 的 0 值字段 + cacheReported:false）也走同一条纪律：
     * 显式布尔优先，绝不因为「键存在且为 0」就算成已上报。
     */
    const aggregateTurn = tracker.recordActualUsage(
      {
        promptTokens: 500,
        completionTokens: 5,
        totalTokens: 505,
        cacheHitTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheReported: false,
      } as never,
      0,
      "fp-aggregate",
    );
    expect(aggregateTurn.cacheReported).toBe(false);
    expect(aggregateTurn.cacheReadTokens).toBe(0);
  });

  it("CACHE-OBS-4：负数 / 字符串不抛；坏值不挡住合法值；全坏 ⇒ 0 + false", () => {
    expect(() =>
      parseProviderUsage({
        prompt_tokens: 1000,
        completion_tokens: 1,
        cache_read_input_tokens: -5,
        cache_creation_input_tokens: "abc",
        prompt_tokens_details: { cached_tokens: { evil: true } },
      }),
    ).not.toThrow();

    const allBad = parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 1,
      cache_read_input_tokens: -5,
      cache_creation_input_tokens: "abc",
      prompt_tokens_details: { cached_tokens: "700" },
    });
    expect("cacheReadTokens" in allBad, "坏值不能伪造出 0% 命中").toBe(false);
    expect("cacheWriteTokens" in allBad).toBe(false);
    expect(allBad.cacheReported).toBeUndefined();
    // 核心口径不受影响
    expect(allBad.promptTokens).toBe(1000);
    expect(allBad.totalTokens).toBe(1001);

    const tracker = new TokenTracker(200000);
    const turn = tracker.recordActualUsage(toTokenUsage(allBad), 0, "fp-bad");
    expect(turn.cacheReadTokens).toBe(0);
    expect(turn.cacheReported).toBe(false);

    // 第一个字段是坏值，第二个合法 ⇒ 用合法的那个（不是整组放弃）
    const mixed = parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 1,
      cache_read_input_tokens: -5,
      prompt_tokens_details: { cached_tokens: 600 },
    });
    expect(mixed.cacheReadTokens).toBe(600);
    expect(mixed.cacheReported).toBe(true);
  });

  it("CACHE-OBS-5：两轮不同形状 ⇒ TokenTracker 累计读/写并保持上报标记", () => {
    const tracker = new TokenTracker(200000);
    tracker.recordActualUsage(
      toTokenUsage(
        parseProviderUsage({
          input_tokens: 1000,
          output_tokens: 10,
          cache_read_input_tokens: 700,
          cache_creation_input_tokens: 100,
        }),
      ),
      0,
      "fp-a",
    );
    tracker.recordActualUsage(
      toTokenUsage(
        parseProviderUsage({
          prompt_tokens: 2000,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 1500 },
        }),
      ),
      0,
      "fp-b",
    );

    const cumulative = tracker.getCumulative();
    expect(cumulative.cacheReadTokens).toBe(2200);
    expect(cumulative.cacheWriteTokens).toBe(100);
    expect(cumulative.cacheHitTokens, "旧字段同步累计（兼容）").toBe(2200);
    expect(cumulative.cacheReported).toBe(true);
    expect(cumulative.promptTokens).toBe(1700 + 2000);
  });

  it("CACHE-OBS-6：CostTracker 会话 / 模型 / 全局三处累计一致，未上报会话标 false", () => {
    const tracker = new CostTracker({ persist: false, maxRecords: 100 });
    const usageOf = (raw: Record<string, unknown>) => toTokenUsage(parseProviderUsage(raw));

    tracker.recordUsage({
      sessionId: "cache-obs-s1",
      model: ANTHROPIC_MODEL,
      provider: "aicodewith",
      usage: usageOf({ input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 700, cache_creation_input_tokens: 100 }),
      duration: 1,
      toolCalls: 0,
    });
    tracker.recordUsage({
      sessionId: "cache-obs-s1",
      model: ANTHROPIC_MODEL,
      provider: "aicodewith",
      usage: usageOf({ prompt_tokens: 2000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1500 } }),
      duration: 1,
      toolCalls: 0,
    });
    // 第三次没有缓存字段：数值不变、上报标记保持 true（会话级事实）
    tracker.recordUsage({
      sessionId: "cache-obs-s1",
      model: ANTHROPIC_MODEL,
      provider: "aicodewith",
      usage: { promptTokens: 500, completionTokens: 2, totalTokens: 502 } as never,
      duration: 1,
      toolCalls: 0,
    });
    // 另一个会话完全没上报
    tracker.recordUsage({
      sessionId: "cache-obs-s2",
      model: "unknown-model",
      provider: "other",
      usage: { promptTokens: 100, completionTokens: 1, totalTokens: 101 } as never,
      duration: 1,
      toolCalls: 0,
    });

    const s1 = tracker.getSessionCost("cache-obs-s1")!;
    expect(s1.cacheReadTokens).toBe(2200);
    expect(s1.cacheWriteTokens).toBe(100);
    expect(s1.cacheReported).toBe(true);
    const modelAgg = s1.modelBreakdown[ANTHROPIC_MODEL];
    expect(modelAgg.cacheReadTokens).toBe(2200);
    expect(modelAgg.cacheWriteTokens).toBe(100);
    expect(modelAgg.cacheReported).toBe(true);

    const s2 = tracker.getSessionCost("cache-obs-s2")!;
    expect(s2.cacheReadTokens, "未上报会话：数值 0").toBe(0);
    expect(s2.cacheWriteTokens).toBe(0);
    expect(s2.cacheReported, "未上报会话：必须显式标 false").toBe(false);

    const stats = tracker.getStats();
    expect(stats.cacheReadTokens).toBe(2200);
    expect(stats.cacheWriteTokens).toBe(100);
    expect(stats.cacheReported).toBe(true);

    const byModel = tracker.getCacheByModel();
    expect(byModel[ANTHROPIC_MODEL].cacheReadTokens).toBe(2200);
    expect(byModel[ANTHROPIC_MODEL].cacheWriteTokens).toBe(100);
    expect(byModel[ANTHROPIC_MODEL].cacheReported).toBe(true);
  });

  /**
   * CACHE-OBS-6b（**真机 A/B 抓出来的回归**）：
   *
   * `LoopState.totalUsage` 的聚合形状**永远带** `cacheReadTokens: 0 / cacheWriteTokens: 0 /
   * cacheHitTokens: 0`（初始化成 0，见 `createInitialState`）。如果 CostTracker 按
   * 「键存在」判上报，未上报的回合会被落库成 `cacheReported: true` + 0/0，
   * 于是 UI 又显示「缓存命中 0%」——2026-11-07 真机 A/B 实际复现了这条。
   *
   * 契约：**显式布尔优先**；`cacheReported: false` 时即使数值键是 0 也不许算上报、
   * 不许把 0 写进记录（缺报 ≠ 0）。
   */
  it("CACHE-OBS-6b：聚合形状（带 0 值但 cacheReported:false）不许被落库成「已上报」", () => {
    const tracker = new CostTracker({ persist: false, maxRecords: 100 });
    /** 真循环 result.usage 的形状：缓存键都在，数值是初始化的 0 */
    const aggregateShape = {
      promptTokens: 1000,
      completionTokens: 10,
      totalTokens: 1010,
      cacheHitTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheReported: false,
      uncachedInputTokens: 1000,
    };

    const record = tracker.recordUsage({
      sessionId: "cache-obs-aggregate",
      model: ANTHROPIC_MODEL,
      provider: "aicodewith",
      usage: aggregateShape as never,
      duration: 1,
      toolCalls: 0,
    });
    expect(record.cacheReported, "显式 false 优先于「键存在」").toBe(false);
    expect("cacheReadTokens" in record, "未上报不许写 0（缺报 ≠ 0）").toBe(false);
    expect("cacheWriteTokens" in record).toBe(false);

    const session = tracker.getSessionCost("cache-obs-aggregate")!;
    expect(session.cacheReported).toBe(false);
    expect(session.cacheReadTokens).toBe(0);
    expect(session.cacheWriteTokens).toBe(0);

    const stats = tracker.getStats();
    expect(stats.cacheReported, "全局同样不许把未上报读成 0% 命中").toBe(false);
    expect(stats.cacheReadTokens).toBe(0);
  });
});

/** Anthropic Messages 的 SSE 帧（只给 usage 相关的最小集合） */
function anthropicSse(messageStartUsage: Record<string, unknown>, outputTokens: number): ReadableStream<Uint8Array> {
  const frames = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { id: "msg_cache", model: ANTHROPIC_MODEL, usage: messageStartUsage },
    })}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: outputTokens },
    })}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join("\n\n") + "\n\n"));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe("CACHE-OBS：wire 路径（默认 provider 的 Anthropic 流 / OpenAI 兼容流）", () => {
  it("CACHE-OBS-7：streamAnthropic 的 usage 事件带缓存读/写（旧实现整段丢）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          anthropicSse(
            { input_tokens: 1000, cache_read_input_tokens: 700, cache_creation_input_tokens: 100 },
            20,
          ),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    const events = await collect(
      streamAnthropic(
        { apiKey: "sk-test", baseUrl: "https://api.aicodewith.ai/v1" },
        { model: ANTHROPIC_MODEL, messages: [{ id: "u", role: "user", content: "只回复 OK" }] },
      ),
    );
    const usageEvent = events.find((e) => e.type === "usage") as any;
    expect(usageEvent, "必须有 usage 事件").toBeTruthy();
    expect(usageEvent.usage.cacheReadTokens).toBe(700);
    expect(usageEvent.usage.cacheWriteTokens).toBe(100);
    expect(usageEvent.usage.cacheHitTokens, "旧字段同步").toBe(700);
    expect(usageEvent.usage.cacheReported).toBe(true);
    expect(usageEvent.usage.promptTokens).toBe(1700);
    expect(usageEvent.usage.completionTokens).toBe(20);

    vi.unstubAllGlobals();

    // 反向对照：provider 不报缓存 ⇒ 不产出缓存键（不是 0）
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(anthropicSse({ input_tokens: 1000 }, 20), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    );
    const plain = await collect(
      streamAnthropic(
        { apiKey: "sk-test", baseUrl: "https://api.aicodewith.ai/v1" },
        { model: ANTHROPIC_MODEL, messages: [{ id: "u", role: "user", content: "只回复 OK" }] },
      ),
    );
    const plainUsage = plain.find((e) => e.type === "usage") as any;
    expect(plainUsage.usage.cacheReported).toBe(false);
    expect("cacheReadTokens" in plainUsage.usage).toBe(false);
    expect("cacheWriteTokens" in plainUsage.usage).toBe(false);
  });

  it("CACHE-OBS-8：OpenAI 兼容流式 / 非流式的 usage 都带缓存桶", async () => {
    const provider = new OpenAICompatibleProvider({
      id: "cache-obs-provider",
      name: "Cache OBS Mock",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      models: [
        {
          id: "obs-model",
          name: "OBS Model",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
    });

    // 流式
    const streamFrames = [
      `data: ${JSON.stringify({
        id: "chatcmpl-obs",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600 } },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(streamFrames.join("")));
            controller.close();
          },
        }),
        text: async () => "",
      })),
    );
    const events = await collect(
      provider.stream({ model: "obs-model", messages: [{ id: "u", role: "user", content: "hi" }] }),
    );
    const streamUsage = events.find((e) => e.type === "usage") as any;
    expect(streamUsage.usage.cacheReadTokens).toBe(600);
    expect(streamUsage.usage.cacheReported).toBe(true);
    expect(streamUsage.usage.uncachedInputTokens).toBe(400);

    // 非流式（压缩摘要等路径）：同一份归一化必须同样带缓存桶
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "",
        json: async () => ({
          id: "chatcmpl-obs-2",
          choices: [{ message: { content: "摘要" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600 } },
        }),
      })),
    );
    const response = await provider.complete({
      model: "obs-model",
      messages: [{ id: "u", role: "user", content: "总结" }],
    });
    expect(response.usage.cacheReadTokens).toBe(600);
    expect(response.usage.cacheHitTokens).toBe(600);
    expect(response.usage.uncachedInputTokens).toBe(400);
    expect(response.usage.cacheReported).toBe(true);
  });
});

/** 脚本化 provider：每次 stream 按队列回放事件（真循环的累计口径） */
class ScriptedProvider {
  id = "cache-obs-scripted";
  name = "Scripted";
  private queue: any[][] = [];
  setScript(scripts: any[][]) {
    this.queue = scripts;
  }
  async *stream(): AsyncGenerator<any> {
    const script = this.queue.length > 0 ? this.queue.shift()! : [];
    for (const event of script) yield event;
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "ok", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
  isConfigured() {
    return true;
  }
}

describe("CACHE-OBS：真循环累计（UI 从 result.usage 取数）", () => {
  it("CACHE-OBS-9：本轮 usage 带缓存桶 ⇒ result.usage 累计读/写/上报标记", async () => {
    const provider = new ScriptedProvider();
    provider.setScript([
      [
        {
          type: "usage",
          usage: {
            promptTokens: 1000,
            completionTokens: 10,
            totalTokens: 1010,
            cacheReadTokens: 700,
            cacheWriteTokens: 100,
            cacheReported: true,
            uncachedInputTokens: 300,
          },
        },
        { type: "text_delta", text: "第一轮" },
      ],
    ]);
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "obs-model",
      securityMode: "full",
    });
    let result: any;
    for await (const event of loop.run("cache-obs-loop", "task", "C:/x", "sys")) {
      if (event.type === "end") result = event.result;
    }
    const u = result.usage;
    expect(u.cacheReadTokens).toBe(700);
    expect(u.cacheHitTokens).toBe(700);
    expect(u.cacheWriteTokens).toBe(100);
    expect(u.cacheReported, "本轮上报过 ⇒ 整轮标记 true").toBe(true);
    expect(u.promptTokens).toBe(1000);
    expect(u.completionTokens).toBe(10);
  });

  it("CACHE-OBS-9b：本轮完全没报缓存 ⇒ 聚合仍是 0，但 cacheReported=false（不是假 0%）", async () => {
    const provider = new ScriptedProvider();
    provider.setScript([
      [
        { type: "usage", usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 } },
        { type: "text_delta", text: "无缓存字段" },
      ],
    ]);
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "obs-model",
      securityMode: "full",
    });
    let result: any;
    for await (const event of loop.run("cache-obs-loop-none", "task", "C:/x", "sys")) {
      if (event.type === "end") result = event.result;
    }
    const u = result.usage;
    expect(u.cacheReadTokens).toBe(0);
    expect(u.cacheWriteTokens).toBe(0);
    expect(u.cacheReported, "未上报与确定 0 必须可区分").toBe(false);
  });
});

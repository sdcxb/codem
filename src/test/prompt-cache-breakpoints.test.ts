/**
 * 提示缓存断点（Anthropic Messages 的 `cache_control`）行为判据。
 *
 * ## 这一组守的是什么
 *
 * 请求里**从不发 `cache_control`** 时，provider 不会缓存任何前缀 ——
 * `usage-normalize.ts` 的缓存桶解析、UI 的两态显示全都是"等一个永远不会来的读数"。
 * 上一轮真机 A/B 三轮 `cacheReported:false` 就是这么来的。所以这里钉的是
 * **请求体里真的出现了断点**，而不是"代码里有个函数"。
 *
 * | # | 判据 |
 * | --- | --- |
 * | PC-1 | 默认开：system 变 block 数组带断点；**锚点消息的最后一个 block** 带断点；易变尾部不带；总共 2 个断点 |
 * | PC-2 | `codem-context-config.promptCache=false` ⇒ 一个 `cache_control` 都不发（system 退回字符串形态） |
 * | PC-3 | 没有锚点（直接调用方）⇒ 退化为「倒数第 2 条 wire 消息」，且**最后一条**（易变尾部）不带 |
 * | PC-4 | OpenAI 协议 ⇒ 请求体里没有 `cache_control`（只对 Anthropic 生效） |
 * | PC-5 | 序列化形状合法：content 是 block 数组、`type`/`text` 不变、消息顺序与正文逐字保留 |
 * | PC-6 | 真循环把**稳定前缀最后一条**当锚点交给 provider（不是倒数第 2 条，也不是易变尾部） |
 * | PC-7 | `stablePrefixLastMessageId`：工作集索引消息之前的那条 / 否则最后一条 / 空数组无锚点 |
 *
 * ## 变异自证（实测跑过）
 *
 * 去掉 `streamAnthropic` 里的 `placeAnthropicMessageBreakpoint(...)` 与
 * `anthropicSystemWithCache(...)` ⇒ **PC-1 第一条红**（其余用例仍绿：它们钉的是
 * "关闭时不发""尾部不加"这些负向条件，本来就不该被正向断点影响）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMRequest, StreamEvent } from "../core/llm/types";
import { streamAnthropic } from "../core/llm/aicodewith-protocols";
import { AICodeWithProvider } from "../core/llm/provider";
import {
  DEFAULT_PROMPT_CACHE,
  isPromptCacheEnabled,
  stablePrefixLastMessageId,
} from "../core/llm/prompt-cache";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { clearTimeContext } from "../core/llm/time-context";
import { setStoragePort } from "../core/storage/port";
import { setSettingJSON } from "../core/storage/settings";
import { createMessage } from "../core/storage/message";
import { createFakeStoragePort } from "./fake-storage-port";

const encoder = new TextEncoder();

/** 只够走完一次 Anthropic 流的最小 SSE（usage 解析另有判据，这里不关心） */
function anthropicSse(): Response {
  const frames = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_pc","model":"claude-sonnet-4-6","usage":{"input_tokens":10}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
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

/** 跑一次 Anthropic 流，返回真正的请求体（wire 形状） */
async function captureAnthropicBody(request: LLMRequest): Promise<any> {
  const fetchMock = vi.fn(async () => anthropicSse());
  vi.stubGlobal("fetch", fetchMock);
  await collect(
    streamAnthropic({ apiKey: "sk-pc-test", baseUrl: "https://api.aicodewith.ai/v1" }, request),
  );
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body));
}

/** 收集请求体里所有带 cache_control 的位置（system + 每条消息的每个 block） */
function cacheControlSites(body: any): Array<{ where: string; block: any }> {
  const sites: Array<{ where: string; block: any }> = [];
  const system = Array.isArray(body.system) ? body.system : [];
  for (let i = 0; i < system.length; i += 1) {
    if (system[i]?.cache_control) sites.push({ where: `system[${i}]`, block: system[i] });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let m = 0; m < messages.length; m += 1) {
    const content = Array.isArray(messages[m]?.content) ? messages[m].content : [];
    for (let b = 0; b < content.length; b += 1) {
      if (content[b]?.cache_control) sites.push({ where: `messages[${m}].content[${b}]`, block: content[b] });
    }
  }
  return sites;
}

/**
 * 真机同款的稳定前缀 + 易变尾部：
 * system / 历史（user + assistant）/ **当前问题（锚点）** / 时间上下文（易变）/
 * 工作集索引（易变，真实会话里会被插在中间）。
 */
function stablePrefixMessages(): LLMRequest["messages"] {
  return [
    { id: "sys", role: "system", content: "你是测试用助手。" },
    { id: "u1", role: "user", content: "第一轮问题" },
    { id: "a1", role: "assistant", content: "第一轮回答" },
    { id: "u2", role: "user", content: "当前问题：只回复 OK" },
    { id: "turn-context-1", role: "user", content: "Time sampled: 2026-11-07T12:00:00+08:00" },
  ];
}

/** 断点日志的捕获器（PC-1 用它钉"真机取证那一行"的格式） */
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  /* 没有 Tauri 文件层 ⇒ 权威日志写入会走上报通道；本文件只关心请求体，静音噪声 */
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  /* 未注册存储端口 = 没写过任何设置 = 默认配置（promptCache 默认开） */
  setStoragePort(createFakeStoragePort({}));
});

afterEach(() => {
  setStoragePort(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PC：Anthropic 提示缓存断点（cache_control）", () => {
  it("PC-1: 默认开 ⇒ system 与稳定前缀最后一条带断点，易变尾部不带（共 2 个）", async () => {
    expect(DEFAULT_PROMPT_CACHE, "默认值必须是开").toBe(true);
    expect(isPromptCacheEnabled(), "没写过设置 ⇒ 默认开").toBe(true);

    const body = await captureAnthropicBody({
      model: "claude-sonnet-4-6",
      messages: stablePrefixMessages(),
      /* 稳定前缀最后一条 = 当前问题；时间上下文在它之后 */
      promptCache: { stablePrefixLastMessageId: "u2" },
    });

    // ---- 断点 1：system 变成 block 数组 + cache_control ----
    expect(body.system, "system 必须变成 block 数组（字符串形态没有地方挂元数据）").toEqual([
      { type: "text", text: "你是测试用助手。", cache_control: { type: "ephemeral" } },
    ]);

    /**
     * ---- 断点 2：锚点消息的最后一个 block ----
     * 连续 user 消息会被合并（`u2` 与 `turn-context-1` 落在同一个 wire 消息里），
     * 所以断点必须挂在 `content[0]`（u2 的最后一块），而不是 `content[1]`（易变尾部）。
     */
    const wire = body.messages;
    expect(wire.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(wire[2].content[0]).toMatchObject({ type: "text", text: "当前问题：只回复 OK" });
    expect(wire[2].content[0].cache_control, "稳定前缀最后一条必须带断点").toEqual({ type: "ephemeral" });
    expect(wire[2].content[1].text).toContain("Time sampled");
    expect(
      wire[2].content[1].cache_control,
      "易变尾部（时间上下文）**不许**带断点：它每轮都变，加上等于每轮都 miss",
    ).toBeUndefined();

    // ---- 断点总数：2（system 1 + 消息 1；Anthropic 上限 4）----
    expect(cacheControlSites(body)).toHaveLength(2);
    expect(cacheControlSites(body).map((s) => s.where)).toEqual([
      "system[0]",
      "messages[2].content[0]",
    ]);

    /* 真机取证用的那一行：来源必须是 anchor（退化路径会写 fallback，不能混） */
    const cacheLog = logSpy.mock.calls
      .map((args: any[]) => String(args[0]))
      .find((line: string) => line.startsWith("[prompt-cache] 断点注入"));
    expect(cacheLog, "每次 Anthropic 请求都必须留一行断点日志（真机 A/B 的证据来源）").toBeTruthy();
    expect(cacheLog).toContain("system=1");
    expect(cacheLog).toContain("message=1");
    expect(cacheLog).toContain("source=anchor");
  });

  it("PC-2: promptCache=false ⇒ 一个 cache_control 都不发（system 退回字符串形态）", async () => {
    setSettingJSON("codem-context-config", { promptCache: false });
    expect(isPromptCacheEnabled(), "显式 false 必须真的生效").toBe(false);

    const body = await captureAnthropicBody({
      model: "claude-sonnet-4-6",
      messages: stablePrefixMessages(),
      promptCache: { stablePrefixLastMessageId: "u2" },
    });

    expect(
      JSON.stringify(body).includes("cache_control"),
      "关闭时**任何**位置都不许出现 cache_control",
    ).toBe(false);
    expect(body.system, "关闭时保留旧的字符串形态（与改前逐字节一致）").toBe("你是测试用助手。");
    expect(cacheControlSites(body)).toHaveLength(0);
  });

  it("PC-2b: 缺键（旧配置）也视为开 —— 「没写过」不等于「用户关掉了」", async () => {
    setSettingJSON("codem-context-config", { compactionThreshold: 0.7 });
    expect(isPromptCacheEnabled()).toBe(true);
  });

  it("PC-3: 没有锚点 ⇒ 退化为倒数第 2 条 wire 消息（最后一条易变尾部仍不带）", async () => {
    const body = await captureAnthropicBody({
      model: "claude-sonnet-4-6",
      messages: stablePrefixMessages(),
      /* 故意不给 promptCache：压缩摘要 / 直接调用方走这条路 */
    });

    const wire = body.messages;
    expect(wire).toHaveLength(3);
    expect(wire[1].role).toBe("assistant");
    expect(wire[1].content.at(-1).cache_control, "降级位置 = 倒数第 2 条 wire 消息").toEqual({
      type: "ephemeral",
    });
    expect(
      wire[2].content.some((b: any) => b.cache_control),
      "最后一条（易变尾部所在消息）绝不能被降级逻辑圈进断点",
    ).toBe(false);
    expect(cacheControlSites(body)).toHaveLength(2);
  });

  it("PC-4: OpenAI 协议 ⇒ 请求体里没有 cache_control（只对 Anthropic 生效）", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AICodeWithProvider({
      id: "acw-pc-test",
      name: "ACW PC Test",
      apiKey: "sk-pc-test",
      baseUrl: "https://api.aicodewith.ai/v1",
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT Test",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
    });
    await collect(
      provider.stream({
        model: "gpt-5.6-sol",
        messages: stablePrefixMessages(),
        promptCache: { stablePrefixLastMessageId: "u2" },
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(JSON.stringify(body).includes("cache_control"), "OpenAI 协议保持原样").toBe(false);
    /* 反向对照：同一条 request 走 Anthropic 时确实会带断点（证明上一条不是"什么都没发生"） */
    vi.unstubAllGlobals();
    const anthropicBody = await captureAnthropicBody({
      model: "claude-sonnet-4-6",
      messages: stablePrefixMessages(),
      promptCache: { stablePrefixLastMessageId: "u2" },
    });
    expect(cacheControlSites(anthropicBody)).toHaveLength(2);
  });

  it("PC-5: 序列化形状合法（block 数组 / type+text 不变 / 顺序与正文逐字保留）", async () => {
    const messages = stablePrefixMessages();
    const body = await captureAnthropicBody({
      model: "claude-sonnet-4-6",
      messages,
      promptCache: { stablePrefixLastMessageId: "u2" },
    });

    const allowed = new Set(["text", "image", "tool_use", "tool_result"]);
    const wire = body.messages;
    for (const message of wire) {
      expect(Array.isArray(message.content), "content 必须仍是数组 block 形态").toBe(true);
      for (const block of message.content) {
        expect(allowed.has(block.type), `未知 block 类型：${block.type}`).toBe(true);
        if (block.type === "text") expect(typeof block.text).toBe("string");
        if (block.cache_control) expect(block.cache_control).toEqual({ type: "ephemeral" });
      }
    }
    /* 正文与顺序逐字保留：把 wire 里的 text 拼起来必须等于原消息正文（不含 system） */
    const wireText = wire
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text);
    const sourceText = messages
      .filter((m) => m.role !== "system")
      .map((m) => String(m.content));
    expect(wireText).toEqual(sourceText);
    /* 角色序列也只由源消息决定（合并只发生在相邻同角色之间） */
    expect(wire.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("PC-7: stablePrefixLastMessageId —— 工作集索引之前那条 / 否则最后一条 / 空数组无锚点", () => {
    // 没有工作集索引 ⇒ 稳定前缀到数组末尾
    expect(
      stablePrefixLastMessageId([{ id: "u1" }, { id: "u2" }]),
      "没有工作集索引 ⇒ 最后一条",
    ).toBe("u2");
    // 工作集索引是易变内容（每轮都变）⇒ 锚点取它前面那条
    expect(
      stablePrefixLastMessageId([
        { id: "u1" },
        { id: "a1" },
        { id: "ctx-workingset-index" },
        { id: "u2" },
      ]),
      "工作集索引之前的一条才是稳定前缀末尾",
    ).toBe("a1");
    // 索引被追加到末尾（最后一条 user 恰好是第 0 条时的形态）⇒ 前面那条
    expect(stablePrefixLastMessageId([{ id: "u1" }, { id: "ctx-workingset-index" }])).toBe("u1");
    // 退化输入不猜
    expect(stablePrefixLastMessageId([])).toBeUndefined();
    expect(stablePrefixLastMessageId(undefined)).toBeUndefined();
    expect(stablePrefixLastMessageId([{ id: "ctx-workingset-index" }, { id: "u2" }])).toBeUndefined();
    expect(stablePrefixLastMessageId([{ id: "" }, { id: "u2" }])).toBe("u2");
  });
});

// ---------------------------------------------------------------------------
// PC-6：真循环把「稳定前缀最后一条」当锚点交给 provider
// ---------------------------------------------------------------------------

const LOOP_SESSION = "prompt-cache-anchor-session";
const LOOP_CWD = "C:\\prompt-cache-anchor";
const LOOP_SYSTEM = "你是测试用助手。系统提示必须逐字节稳定。";

class RecordingProvider {
  id = "pc-recording-provider";
  name = "PC Recording";
  requests: any[] = [];
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "OK" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

describe("PC-6：循环侧的稳定前缀锚点", () => {
  beforeEach(() => {
    clearTimeContext(LOOP_SESSION);
  });

  it("PC-6: 锚点 = 易变尾部之前的那条历史消息（不是倒数第 2 条、不是易变尾部）", async () => {
    /**
     * 先落一条真实历史消息：`run()` 不会替调用方落用户消息（App/executor 才负责），
     * 不预置的话请求里只有 system + 易变尾部 —— 那测不到"稳定前缀最后一条"这个边界。
     */
    createMessage(
      {
        id: "pc-user-1",
        role: "user",
        content: "你好（只回复 OK）",
        timestamp: Date.now(),
        status: "done",
      },
      LOOP_SESSION,
    );

    const provider = new RecordingProvider();
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 1,
      model: "pc-model",
      securityMode: "full",
    });
    for await (const _event of loop.run(LOOP_SESSION, "你好（只回复 OK）", LOOP_CWD, LOOP_SYSTEM)) {
      /* drain */
    }

    expect(provider.requests.length, "必须真的发过一次请求").toBeGreaterThanOrEqual(1);
    const req = provider.requests[0];
    const anchor = req.promptCache?.stablePrefixLastMessageId;
    expect(anchor, "循环必须把稳定前缀锚点交给 provider（否则协议层只能猜倒数第 2 条）").toBeTruthy();
    expect(anchor, "锚点必须是那条真实历史消息（稳定前缀末尾）").toBe("pc-user-1");

    const ids = req.messages.map((m: any) => String(m.id ?? ""));
    const anchorAt = ids.indexOf(anchor);
    expect(anchorAt, "锚点必须真的在这条请求里").toBeGreaterThanOrEqual(1);
    expect(req.messages[anchorAt].role, "首轮锚点是用户问题").toBe("user");
    /**
     * 锚点之后**只许**是易变尾部（计划上下文 / 时间上下文）：它们每轮重算，
     * 断点落在锚点上才不会把易变文本圈进缓存。
     */
    const tailIds = ids.slice(anchorAt + 1);
    expect(tailIds.length, "首轮必须有易变尾部（时间上下文）—— 否则这条判据测不到边界").toBeGreaterThan(0);
    expect(
      tailIds.every((id) => /^(plan-context|turn-context)/.test(id)),
      `锚点之后只许是易变尾部，实际：${tailIds.join(",")}`,
    ).toBe(true);
    /* system 仍是字符串形态（断点在 wire 层才加，不改请求内容） */
    expect(req.messages[0].role).toBe("system");
    expect(typeof req.messages[0].content).toBe("string");
  });
});

/**
 * Bot/子智能体路径（`LLMEngine.processSubagent`）的**工具调用/结果落库** —— 判据 STP-1..6
 *
 * ## 被守的缺陷（独立复核 + 真机一致）
 *
 * `processSubagent` 用 `for await` 消费 `AgenticLoop.run()`，只转发事件、**从不落库**；
 * 而工具调用/结果落库在 `session/executor.ts`（UI 路径）。`buildMessages` 只从消息表读，
 * 于是 Bot 子智能体下一轮请求里看不到工具结果 ⇒ 模型重发同一个调用，直到空转/迭代上限。
 *
 * ## 判据与变异
 *
 * | id | 钉什么 | 变异（改坏）怎么红 |
 * |---|---|---|
 * | STP-1 | 第一轮调 `read` ⇒ **第二轮请求**里已有 assistant `tool_calls` + 该调用的 tool 结果 | 去掉 `onEvent` 落库 ⇒ 第二轮没有 tool 结果 ⇒ 红 |
 * | STP-2 | 结果进上下文后模型**不再重发**（同一调用执行恰好 1 次、最终正文回来了） | 不落库 ⇒ 假 provider（上下文驱动）重发 ⇒ 执行 ≥2 次 ⇒ 红 |
 * | STP-3 | 一轮只落**一条** user 消息；再跑一轮各一条（不按迭代/工具事件重复写） | 每迭代/每工具事件写 user ⇒ 条数变多 ⇒ 红 |
 * | STP-4 | `tool_error` 也落库（status=error + 原因进上下文），同一调用不重复 | 只处理 `tool_complete` ⇒ 错误结果看不到 ⇒ 红 |
 * | STP-5 | 记录器：同一调用 id 的重复 `tool_start` 只落一条；每轮各挂一行助手消息；空 id 的 LLM 级失败不落 | 去掉去重/轮换 ⇒ 条数或行数不对 ⇒ 红 |
 * | STP-6 | 落库失败**必须上报**（`reportPersistFailure` 的 area 可见），不静默 | 把 catch 改成吞掉 ⇒ `getPersistFailures()` 里没有该 area ⇒ 红 |
 *
 * ## 为什么用**真 `LLMEngine` + 假 provider**
 *
 * 判据必须落在真实链路上：真 `AgenticLoop` 产出真事件、真 `MessageStorage` 落库、
 * 真 `buildMessages` 重建请求。假 provider 只替掉网络，且它是**上下文驱动**的——
 * 「第二轮有没有看到 tool 结果」直接决定它收尾还是重发同一调用，而不是写死脚本。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/* 内存文件层：只替掉宿主文件 API（不 mock 被测逻辑） */
const { memFs } = vi.hoisted(() => ({ memFs: new Map<string, string>() }));

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\subagent-tool",
  exists: async (p: string) => memFs.has(p),
  readFile: async (p: string) => {
    if (!memFs.has(p)) throw new Error("ENOENT: " + p);
    return memFs.get(p)!;
  },
  readTextWindow: async (p: string, offset = 0, maxBytes?: number) => {
    const c = memFs.get(p) ?? "";
    const end = maxBytes ? Math.min(c.length, offset + maxBytes) : c.length;
    let text = c.slice(offset, end);
    if (end < c.length) {
      const cut = text.lastIndexOf("\n");
      if (cut >= 0) text = text.slice(0, cut + 1);
    }
    return { text, nextOffset: offset + text.length, eof: end >= c.length, size: c.length };
  },
  appendFile: async (p: string, c: string) => {
    memFs.set(p, (memFs.get(p) ?? "") + c + "\n");
  },
  writeFile: async (p: string, c: string) => {
    memFs.set(p, c);
  },
  deleteFile: async (p: string) => {
    memFs.delete(p);
  },
  deletePath: async (p: string) => {
    memFs.delete(p);
  },
  renameFile: async (a: string, b: string) => {
    const c = memFs.get(a);
    memFs.delete(a);
    if (c !== undefined) memFs.set(b, c);
  },
  listDirectory: async () => [],
  globSearch: async () => [],
  grepSearch: async () => [],
  readFileLines: async (p: string) => ({ text: memFs.get(p) ?? "", hasMore: false, totalLines: 1 }),
  isPathWithinWorkspace: () => true,
}));

import { LLMEngine } from "../core/llm";
import { createEngineBotRunner } from "../core/bots/service";
import type { BotTurnRequest } from "../core/bots/types";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import { listMessages } from "../core/storage/message";
import { __resetJsonlCache } from "../core/storage/session-jsonl";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { createSubagentToolCallRecorder } from "../core/subagent/tool-call-recorder";

const PROJECT_ID = "proj-subagent-tool";
const SESSION_ID = "sess-subagent-tool";
const CWD = "C:\\subagent-tool";
const CALL_ID = "call-read-1";
const TOOL_INPUT = { path: "C:\\subagent-tool\\a.txt" };
const FILE_BODY = "这是 read 工具返回的正文：模型必须看到它，才不会重发同一个调用。";
const FAIL_MESSAGE = "ENOENT: C:\\subagent-tool\\missing.txt（文件不存在）";

/**
 * 上下文驱动的假模型：**看见这次调用的 tool 结果就收尾，看不见就重发同一调用**。
 *
 * 这正是真机里发生的事（模型只能从请求里知道自己做过什么）——所以「不再重发」
 * 这条判据不靠脚本写死，而由「请求里有没有那条 tool 结果」决定。
 */
class ToolResultAwareProvider {
  id = "tool-persist-provider";
  name = "Tool Persist Provider";
  config = { apiKey: "sk-test", models: [{ id: "ctx-model", contextWindow: 128_000 }] };
  dynamicModels: unknown[] | null = null;
  requests: Array<{ messages?: any[] }> = [];
  /** 每轮请求里「是否已经看得到这次调用的工具结果」——判据的机制读数 */
  sawToolResult: boolean[] = [];

  isConfigured() {
    return true;
  }

  async listModels() {
    return [{ id: "ctx-model", name: "ctx-model", contextWindow: 128_000, supportsTools: true, supportsStreaming: true }];
  }

  async fetchModelsFromServer() {
    return this.listModels();
  }

  async complete() {
    return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }

  async *stream(request: { messages?: any[] }) {
    this.requests.push(request);
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const hasToolResult = messages.some((m) => m?.role === "tool" && m?.toolCallId === CALL_ID);
    this.sawToolResult.push(hasToolResult);

    if (hasToolResult) {
      yield { type: "text_delta", text: "已经读到文件内容，任务完成。" };
      yield { type: "end", finishReason: "stop" };
      return;
    }

    /* 还看不到结果 ⇒ 与真机同形：重发同一个调用（靠 maxIterations 兜住；落库缺失时判据据此变红） */
    yield { type: "tool_use_start", id: CALL_ID, name: "read" };
    yield { type: "tool_use_delta", id: CALL_ID, input: JSON.stringify(TOOL_INPUT) };
    yield { type: "tool_use_end", id: CALL_ID, input: TOOL_INPUT };
    yield { type: "end", finishReason: "tool_use" };
  }
}

function makeEngine(
  provider: ToolResultAwareProvider,
  executions: Array<Record<string, unknown>>,
  options: { failTool?: boolean } = {},
): LLMEngine {
  const engine = new LLMEngine();
  engine.providers.register(provider as never);
  (engine as any).profileManager = { resolveSlot: () => ({ provider: provider.id, model: "ctx-model" }) };
  (engine as any).config.defaultProvider = provider.id;
  (engine as any).config.defaultModel = "ctx-model";

  engine.tools.register({
    id: "read",
    description: "判据用假 read（记录执行次数，不碰真实文件系统）",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    contract: { readOnly: true, sideEffectScope: "none", accessScope: "none", persistResult: false },
    async execute(args: Record<string, unknown>) {
      executions.push(args);
      if (options.failTool) throw new Error(FAIL_MESSAGE);
      return { title: "read", output: FILE_BODY };
    },
  } as never);

  return engine;
}

/** 跑完一轮 `processSubagent`（真实生成器），把事件收下来 */
async function drainSubagent(engine: LLMEngine, message: string): Promise<any[]> {
  const events: any[] = [];
  for await (const event of engine.processSubagent(SESSION_ID, message, CWD, "general")) {
    events.push(event);
  }
  return events;
}

function textOf(events: any[]): string {
  return events
    .filter((e) => e.type === "text_delta")
    .map((e) => String(e.text ?? ""))
    .join("");
}

function toolCallsOfAssistant(messages: any[]): any[] {
  return messages.flatMap((m) => (m?.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : []));
}

beforeEach(() => {
  memFs.clear();
  __resetJsonlCache();
  resetPersistFailures();
  createProject({
    id: PROJECT_ID,
    name: "子智能体工具落库",
    path: CWD,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  } as any);
  createSession({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: "Bot 会话",
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    messageCount: 0,
  } as any);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetJsonlCache();
});

describe("Bot 子智能体的工具调用落库（真循环 + 上下文驱动的假 provider）", () => {
  it("STP-1: 第一轮调 read ⇒ 第二轮请求里已有 assistant tool_calls 与该调用的 tool 结果", async () => {
    const provider = new ToolResultAwareProvider();
    const executions: Array<Record<string, unknown>> = [];
    const engine = makeEngine(provider, executions);

    await drainSubagent(engine, "把 a.txt 的内容读出来并告诉我");

    const firstMessages = provider.requests[0]?.messages ?? [];
    expect(
      firstMessages.some((m) => m?.role === "tool"),
      "第一轮请求里当然还没有工具结果（这条是反向对照，防止判据自欺）",
    ).toBe(false);

    /* 核心：第二轮请求（同一次 processSubagent 内）里必须已经有这次调用与它的结果 */
    const secondMessages = provider.requests[1]?.messages ?? [];
    expect(
      provider.sawToolResult[1],
      "第二轮模型请求里必须已经能看到这次工具调用的结果（落库缺失 ⇒ 这里为 false ⇒ 红）",
    ).toBe(true);

    const assistantCalls = toolCallsOfAssistant(secondMessages);
    expect(assistantCalls.length, "第二轮请求里必须有一条带 tool_calls 的 assistant 消息").toBeGreaterThan(0);
    expect(assistantCalls[0].id).toBe(CALL_ID);
    expect(assistantCalls[0].function?.name).toBe("read");

    const toolResults = secondMessages.filter((m) => m?.role === "tool" && m?.toolCallId === CALL_ID);
    expect(toolResults, "同一个调用只许有一条 tool 结果（重复 id 会被 API 400 拒绝）").toHaveLength(1);
    expect(String(toolResults[0].content)).toContain("这是 read 工具返回的正文");

    /* 库里同样在：助手行挂着这条调用，状态与结果都对 */
    const assistants = listMessages(SESSION_ID).filter((m) => m.role === "assistant");
    expect(assistants, "一轮只有一个含工具调用的迭代 ⇒ 只该有一条助手行").toHaveLength(1);
    const calls = assistants[0].toolCalls ?? [];
    expect(calls.filter((tc) => tc.id === CALL_ID)).toHaveLength(1);
    const call = calls.find((tc) => tc.id === CALL_ID);
    expect(call?.status).toBe("done");
    expect(call?.result ?? "").toContain("这是 read 工具返回的正文");
  });

  it("STP-2: 工具结果进入上下文后，模型不再重发同一调用（执行恰好 1 次，最终正文回来了）", async () => {
    const provider = new ToolResultAwareProvider();
    const executions: Array<Record<string, unknown>> = [];
    const engine = makeEngine(provider, executions);

    const events = await drainSubagent(engine, "把 a.txt 的内容读出来并告诉我");

    expect(textOf(events), "看到工具结果后模型应当收尾（而不是继续重发）").toContain("已经读到文件内容");
    expect(
      executions,
      "同一个调用只执行一次；落库缺失 ⇒ 假模型（上下文驱动）会重发 ⇒ 这里 ≥2 ⇒ 红",
    ).toHaveLength(1);
    expect(executions[0].path, "工具真的按调用参数执行过").toBe(TOOL_INPUT.path);
    expect(
      provider.sawToolResult.filter(Boolean).length,
      "至少有一轮请求看到了工具结果（`sawToolResult` 是机制读数，不是日志推断）",
    ).toBeGreaterThanOrEqual(1);
  });

  it("STP-3: 一轮只落一条 user 消息；再跑一轮各一条（不按迭代/工具事件重复写）", async () => {
    const provider = new ToolResultAwareProvider();
    const executions: Array<Record<string, unknown>> = [];
    const engine = makeEngine(provider, executions);

    await drainSubagent(engine, "第一轮：读 a.txt");
    const afterFirst = listMessages(SESSION_ID).filter((m) => m.role === "user");
    expect(afterFirst.filter((m) => m.content === "第一轮：读 a.txt")).toHaveLength(1);

    await drainSubagent(engine, "第二轮：再读一次");
    const afterSecond = listMessages(SESSION_ID).filter((m) => m.role === "user");
    expect(afterSecond.filter((m) => m.content === "第一轮：读 a.txt")).toHaveLength(1);
    expect(afterSecond.filter((m) => m.content === "第二轮：再读一次")).toHaveLength(1);
    expect(afterSecond, "两轮 = 两条 user 消息（不许按迭代/工具事件重复写）").toHaveLength(2);
  });

  it("STP-4: tool_error 也落库（status=error + 原因进模型上下文），同一调用不重复", async () => {
    const provider = new ToolResultAwareProvider();
    const executions: Array<Record<string, unknown>> = [];
    const engine = makeEngine(provider, executions, { failTool: true });

    await drainSubagent(engine, "读一个不存在的文件");

    const secondMessages = provider.requests[1]?.messages ?? [];
    expect(
      provider.sawToolResult[1],
      "失败结果同样必须进第二轮上下文（否则模型会重发一个注定失败的调用）",
    ).toBe(true);
    const failureResult = secondMessages.find((m) => m?.role === "tool" && m?.toolCallId === CALL_ID);
    expect(String(failureResult?.content ?? "")).toContain("ENOENT");

    const calls = listMessages(SESSION_ID)
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.toolCalls ?? [])
      .filter((tc) => tc.id === CALL_ID);
    expect(calls, "同一个调用只许有一条记录").toHaveLength(1);
    expect(calls[0].status).toBe("error");
    expect(calls[0].result ?? "").toContain("ENOENT");
    expect(executions, "失败也只执行一次（没有被重复派发）").toHaveLength(1);
  });
});

describe("记录器本身：去重、按轮分行、空 id 不落、失败必须可见", () => {
  it("STP-5: 同一调用 id 的重复 tool_start 只落一条；每轮各挂一行；空 id 的 LLM 级失败不落", async () => {
    const sessionId = "sess-recorder-dedupe";
    const recorder = createSubagentToolCallRecorder({ sessionId, idPrefix: "rec", now: () => 1000 });
    const callA = { id: "dup-a", name: "read", input: { path: "a.txt" } };
    const callB = { id: "dup-b", name: "read", input: { path: "b.txt" } };

    await recorder.handle({ type: "start", iteration: 1 } as any);
    await recorder.handle({ type: "tool_start", toolCall: callA } as any);
    /* 真实循环里同一次调用会发两条 tool_start（流式 tool_use_end 一次、真正开始执行一次） */
    await recorder.handle({ type: "tool_start", toolCall: callA } as any);
    await recorder.handle({ type: "tool_complete", toolCall: callA, result: "正文 A" } as any);

    await recorder.handle({ type: "start", iteration: 2 } as any);
    await recorder.handle({ type: "tool_start", toolCall: callB } as any);
    await recorder.handle({ type: "tool_error", toolCall: callB, error: "boom" } as any);
    recorder.finalize();

    const assistants = listMessages(sessionId).filter((m) => m.role === "assistant");
    expect(assistants, "两个迭代各一条助手行（工具调用不挂在同一行上）").toHaveLength(2);
    expect(assistants[0].toolCalls ?? [], "重复的 tool_start 不许落成两条").toHaveLength(1);
    expect(assistants[0].toolCalls![0].status).toBe("done");
    expect(assistants[0].toolCalls![0].result).toBe("正文 A");
    expect(assistants[1].toolCalls ?? []).toHaveLength(1);
    expect(assistants[1].toolCalls![0].status).toBe("error");
    expect(assistants[1].toolCalls![0].result).toContain("boom");

    /* 空 id 的 tool_error = LLM 级失败（没有真实调用），不许造幽灵工具调用 */
    await recorder.handle({
      type: "tool_error",
      toolCall: { id: "", name: "", input: {}, status: "error" },
      error: "LLM down",
    } as any);
    const allCalls = listMessages(sessionId)
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.toolCalls ?? []);
    expect(allCalls.some((tc) => tc.id === ""), "空 id 的调用不许落库").toBe(false);
    expect(allCalls, "记录器不会因为空 id 事件多建行/多写调用").toHaveLength(2);
    expect(getPersistFailures(), "正常路径不该产生落库失败").toHaveLength(0);
  });

  it("STP-6: 落库抛错必须上报（reportPersistFailure 的 area 可见），不静默", async () => {
    const sessionId = "sess-recorder-report";
    const recorder = createSubagentToolCallRecorder({ sessionId, idPrefix: "rep", now: () => 5 });

    /* 让 args 展开时抛错（真实世界里相当于存储层/序列化层异常） */
    const throwingInput = {
      get path(): string {
        throw new Error("参数读取失败");
      },
    };
    await recorder.handle({
      type: "tool_start",
      toolCall: { id: "bad-a", name: "read", input: throwingInput },
    } as any);

    /* 让结果规范化时抛错（相当于工具返回了一个坏对象） */
    const throwingResult = {
      get output(): string {
        throw new Error("结果读取失败");
      },
    };
    await recorder.handle({
      type: "tool_complete",
      toolCall: { id: "bad-b", name: "read" },
      result: throwingResult,
    } as any);

    /* 让错误正文转换时抛错 */
    const throwingError = {
      toString(): string {
        throw new Error("错误正文转换失败");
      },
    };
    await recorder.handle({
      type: "tool_error",
      toolCall: { id: "bad-c", name: "read" },
      error: throwingError,
    } as any);

    const areas = getPersistFailures().map((f) => f.area);
    expect(areas, "tool_start 落库失败必须上报").toContain("toolCall.persistStart");
    expect(areas, "tool_complete 落库失败必须上报").toContain("toolCall.persistSuccess");
    expect(areas, "tool_error 落库失败必须上报").toContain("toolCall.persistError");
  });
});

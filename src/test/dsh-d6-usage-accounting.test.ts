/**
 * D6：一轮对话的 token 消耗必须**整轮累计**记账，且**失败/中止也要留痕**。
 *
 * ## 修的是什么
 *
 * `LLMEngine.process()` 原来这样记账：
 *
 * ```ts
 * for await (const event of loop.run(...)) {
 *   if (event.type === "usage") lastUsage = event.usage;   // ← 每次迭代覆盖
 * }
 * if (lastUsage.totalTokens > 0) { costTracker.recordUsage({ ..., success: true }); }
 * ```
 *
 * 两个后果（都能在下面的用例里直接看到）：
 *
 * 1. **只有最后一次 LLM 调用被记账**。`agentic-loop.ts` 只在每次迭代末尾
 *    `yield { type: "usage", usage }`，带的是**那一次**的用量；整轮累计在
 *    `run()` 的返回值里（`for await` 把它丢掉了）。一轮 15 次调用 → 只记 1/15。
 * 2. **失败/中止的回合一条记录都没有**（`recordUsage` 在循环之后，抛错就跳过），
 *    而且 `success` 恒为 `true`。
 *
 * 这两点合起来使得「同一模型 token 消耗不高于 DSH」这条验收**无法度量**：
 * 分子被系统性缩小，失败回合干脆不存在。
 *
 * ## 用例怎么造出"3 次迭代"
 *
 * 用脚本化 provider（沿用 `step-plan-dynamic-insert-loop.test.ts` /
 * `o28-assistant-event-wiring.test.ts` 的既有 harness 形态）：
 * `update_plan` 是纯会话状态工具（`ctx.updatePlan`，不碰文件系统），
 * 每次调用都产生一次 `tool_complete`，于是循环会进入下一轮迭代。
 *
 * | # | 判据 |
 * | --- | --- |
 * | D6-A | 3 次迭代各报 1000/10 → **恰好一条**记录，输入 3000、输出 30（不是 1000/10） |
 * | D6-B | 第 2 次调用抛 AbortError → 记录仍存在、`success === false`，且带的是抛错前已产生的累计 token |
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockExecuteCommand } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  /** 数据根：会话 JSONL / 事件日志要它定位，缺了会刷 "No getAppDataDir export" */
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\d6-usage",
  exists: vi.fn().mockReturnValue(true),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readTextWindow: vi.fn().mockResolvedValue({ text: "", nextOffset: 0, eof: true, size: 0 }),
  readFileLines: vi.fn().mockResolvedValue({ text: "", hasMore: false, totalLines: 1 }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  listDirectory: vi.fn().mockReturnValue([]),
  deletePath: vi.fn(),
  renameFile: vi.fn().mockResolvedValue(undefined),
  globSearch: vi.fn().mockResolvedValue([]),
  grepSearch: vi.fn().mockResolvedValue([]),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

import { LLMEngine } from "../core/llm/index";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import { setSetting } from "../core/storage/settings";
import { getCostTracker } from "../core/llm/cost-tracker";

const PROJECT_ID = "proj-d6";
const SESSION_ID = "sess-d6-usage";
const CWD = "C:\\d6-usage";

/**
 * 脚本化 provider：每次 `stream()` 消费一个脚本。
 * `usageEvent` 就是 `agentic-loop` 每轮迭代末尾会 yield 的那个事件形状。
 */
class ScriptedProvider {
  id = "d6-provider";
  name = "D6 Mock";
  config: any = {
    apiKey: "sk-test",
    models: [{ id: "d6-model", contextWindow: 128000, maxOutputTokens: 4096 }],
  };
  dynamicModels: any[] | null = null;
  private queue: any[][] = [];

  setScript(scripts: any[][]) {
    this.queue = scripts;
  }
  isConfigured() {
    return true;
  }
  async *stream(_request: any): AsyncGenerator<any> {
    // 队列空 = 现场写一个"抛错"的脚本（用于失败路径用例）
    const next = this.queue.shift();
    if (!next) throw Object.assign(new Error("脚本耗尽（该调用不该发生）"), { name: "AbortError" });
    for (const event of next) yield event;
  }
  async complete(_request: any) {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [{ id: "d6-model", name: "D6", contextWindow: 128000, maxOutputTokens: 4096, supportsTools: true, supportsStreaming: true }];
  }
  async fetchModelsFromServer() {
    return this.listModels();
  }
}

/** 一次迭代：报 usage（1000 输入 / 10 输出）+ 调一次 update_plan（产生 tool_complete） */
function planIteration(callId: string, promptTokens = 1000, completionTokens = 10): any[] {
  return [
    {
      type: "usage",
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    },
    { type: "tool_use_start", id: callId, name: "update_plan" },
    { type: "tool_use_delta", id: callId, input: JSON.stringify({ action: "append", titles: ["D6 探针"] }) },
    { type: "tool_use_end", id: callId, input: { action: "append", titles: ["D6 探针"] } },
    { type: "end", finishReason: "tool_use" },
  ];
}

/** 收尾迭代：同样报 usage，但不调工具 → 循环自然结束 */
function finalIteration(text: string): any[] {
  return [
    { type: "usage", usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 } },
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

/** 只报 usage、然后什么都不做的迭代（失败用例的第 1 轮） */
function usageOnlyIteration(toolCallId: string): any[] {
  return [
    { type: "usage", usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 } },
    { type: "tool_use_start", id: toolCallId, name: "update_plan" },
    { type: "tool_use_end", id: toolCallId, input: { action: "append", titles: ["D6 失败探针"] } },
    { type: "end", finishReason: "tool_use" },
  ];
}

/**
 * 第 2 轮：模型以 `stop` 结束但**什么输出都没有** → 循环抛
 * `EMPTY_RESPONSE`（`agentic-loop.ts` 的硬失败路径），`process()` 因此 reject。
 *
 * 为什么不用「provider 抛错」来造这条路：`executeIteration` 的 catch 会把
 * `AbortError` **静默 `return`**（`agentic-loop.ts:2285-2293`），错误根本走不出
 * 生成器 —— 那正好也说明"抛错路径"在旧代码里连记录都不会有。用 EMPTY_RESPONSE
 * 是**确定性**地让一轮对话在产生 token 之后以异常收场。
 */
function emptyStopIteration(): any[] {
  return [{ type: "end", finishReason: "stop" }];
}

/** 记录进 CostTracker 的那一次调用（spy 参数快照） */
type RecordedUsage = {
  sessionId: string;
  model: string;
  provider: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  duration: number;
  toolCalls?: number;
  success?: boolean;
  error?: string;
};

let engine: LLMEngine;
let provider: ScriptedProvider;

/** 私有字段：单例 CostTracker（引擎的记账出口）+ config（provider 路由） */
function wireEngine(): void {
  engine.providers.register(provider as any);
  (engine as any).config.defaultProvider = "d6-provider";
  (engine as any).config.defaultModel = "d6-model";
}

async function drainProcess(options?: any): Promise<any[]> {
  const events: any[] = [];
  for await (const event of engine.process(SESSION_ID, "跑一轮", CWD, undefined, options)) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteCommand.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
  // 安全模式 full：否则工具调用会被权限层拦下 → 只有 1 次迭代，用例失去意义
  setSetting("codem-security-mode", "full");

  createProject({
    id: PROJECT_ID,
    name: "D6 用量记账",
    path: CWD,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  } as any);
  createSession({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: "D6 用量会话",
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    messageCount: 0,
  } as any);

  provider = new ScriptedProvider();
  engine = new LLMEngine();
  wireEngine();
});

describe("D6：一轮对话的 token 消耗必须整轮累计记账", () => {
  it("D6-A：3 次迭代各 1000/10 → 恰好一条记录，输入 3000、输出 30", async () => {
    provider.setScript([
      planIteration("d6-a1"),
      planIteration("d6-a2"),
      finalIteration("三轮跑完"),
    ]);

    const spy = vi.spyOn(getCostTracker(), "recordUsage");
    const events = await drainProcess({ securityMode: "full" });

    // 先证明"这一轮真的跑了 3 次 LLM 调用"——否则下面的累计断言是空洞的
    const usageEvents = events.filter((e) => e.type === "usage");
    expect(
      usageEvents.length,
      `本用例要造的是 3 次迭代；实际收到 ${usageEvents.length} 个 usage 事件（脚本没被消费完？）`,
    ).toBe(3);
    expect(usageEvents.map((e) => e.usage.promptTokens)).toEqual([1000, 1000, 1000]);

    const records = spy.mock.calls.map((c) => c[0] as unknown as RecordedUsage);
    expect(
      records.length,
      `一轮对话必须**恰好**一条用量记录（多记=重复计费，少记=消耗量测不出来）。实际 ${records.length} 条`,
    ).toBe(1);

    const rec = records[0];
    expect(rec.sessionId).toBe(SESSION_ID);
    // 缺陷形态就是这里读到 1000 / 10（只有最后一次迭代）
    expect(rec.usage.promptTokens, "整轮输入 = 3 × 1000（旧实现只记最后一次 = 1000）").toBe(3000);
    expect(rec.usage.completionTokens, "整轮输出 = 3 × 10（旧实现只记最后一次 = 10）").toBe(30);
    expect(rec.usage.totalTokens).toBe(3030);
    expect(rec.success).toBe(true);
    // 工具计数/耗时仍按原样填充（不能因为换了记账路径就丢字段）
    expect(rec.toolCalls).toBe(2);
    expect(typeof rec.duration).toBe("number");
    expect(Number.isFinite(rec.duration)).toBe(true);
    expect(rec.duration).toBeGreaterThanOrEqual(0);
  });

  it("D6-B：异常收场 → 记录仍然存在、带累计 token，且不被当成正常完成", async () => {
    // 第 1 轮：报 1000/10 并调工具（累计里已经真的消耗了 1010）
    // 第 2 轮：EMPTY_RESPONSE → 循环把这一轮记成失败迭代并上报失败
    provider.setScript([usageOnlyIteration("d6-b1"), emptyStopIteration()]);

    const spy = vi.spyOn(getCostTracker(), "recordUsage");
    const events = await drainProcess({ securityMode: "full" });

    /**
     * 先证明这一轮**确实是失败的**（否则"标记失败"的断言没有对象）。
     * 循环把 provider 失败同时表达为 `tool_error`（结构化）+ 一句可见文本
     * （`agentic-loop.ts` 的 "LLM 调用失败" 分支）。
     */
    const failureSignal =
      events.some(
        (e) => e.type === "tool_error" && String(e.error ?? "").includes("EMPTY_RESPONSE"),
      ) ||
      events.some(
        (e) => e.type === "text_delta" && String(e.text ?? "").includes("LLM 调用失败"),
      );
    expect(
      failureSignal,
      "本用例要造的是『跑到一半挂了』—— 事件流里必须有失败信号，否则断言没有对象",
    ).toBe(true);
    // 循环对这次失败的**结构化**表达（引擎正是靠它判 success:false）
    const endResult = events.find((e) => e.type === "end")?.result;
    expect(
      endResult?.type === "error" || endResult?.reason === "too_many_errors",
      `失败回合的 LoopResult 必须能被识别为失败；实际：${JSON.stringify(endResult)}`,
    ).toBe(true);

    const records = spy.mock.calls.map((c) => c[0] as unknown as RecordedUsage);
    expect(
      records.length,
      "挂掉的回合也必须有且仅有一条记录（旧实现把 recordUsage 放在循环之后 ⇒ 一条都没有，消耗完全消失）",
    ).toBe(1);

    const rec = records[0];
    expect(rec.sessionId).toBe(SESSION_ID);
    // 抛错前的真实消耗不能丢：第 1 轮已经报过 1000/10
    expect(rec.usage.promptTokens, "失败回合取累计 usage，而不是 0（旧实现连记录都不写）").toBe(1000);
    expect(rec.usage.completionTokens).toBe(10);
    expect(rec.usage.totalTokens).toBe(1010);
    /**
     * 失败必须如实进记录。循环这一轮如实报了失败（上面已断言有失败信号
     * 且 `end.result.type === "error"` / reason 不是 completed），
     * 那么这条记录就不能是 `success: true` —— 否则用量面板会把
     * "跑到一半挂了"统计成一次正常调用。
     */
    expect(rec.success, "已经出现失败信号的回合不能记成成功").toBe(false);
  });

  /**
   * D6-C：**抛错路径本身**（`try/finally` 的失败分支）的确定性验证。
   *
   * 为什么必须单独造：真实的 `AgenticLoop` 把 provider 失败统统吞成
   * `stop / completed`（见 D6-B 的说明），`process()` 几乎不会真的收到异常。
   * 但 `recordUsage` 抛错（或未来 agentic-loop 改成如实抛出）时，
   * `try/finally` 不会跑 —— 那正是"失败回合没有记录"这条缺陷的形态。
   * 这里用一个"会抛错的 loop"直接驱动私有记账路径：事件照样转发、
   * 异常照样抛出、记录照样写下且 `success: false`。
   */
  it("D6-C：loop 抛错时事件照旧转发、异常照旧抛出，同时留下 success=false 的记录", async () => {
    /**
     * 关键形态：**抛出的那一次迭代只报了 1000/10**，而循环状态里的累计是
     * 3000/30（前两次调用已发生）。记录必须取累计值 —— 这正是
     * "只有最后一次 LLM 调用被记账"那条缺陷的反面。
     */
    const lastIteration = { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 };
    const cumulative = { promptTokens: 3000, completionTokens: 30, totalTokens: 3030 };
    const throwingLoop = {
      async *run() {
        yield { type: "usage", usage: lastIteration };
        yield { type: "tool_complete", toolCall: { id: "t1", name: "update_plan", input: {} } };
        throw Object.assign(new Error("provider exploded"), { name: "AbortError" });
      },
      getState() {
        return { totalUsage: { ...cumulative }, iteration: 3 };
      },
    };

    const spy = vi.spyOn(getCostTracker(), "recordUsage");
    const forwarded: string[] = [];
    const drive = async () => {
      for await (const event of (engine as any).runLoopAndRecordUsage({
        loop: throwingLoop,
        sessionId: "sess-d6-throw",
        message: "x",
        cwd: CWD,
        systemPrompt: "sys",
        startTime: Date.now(),
        successLogPrefix: "test",
      })) {
        forwarded.push(event.type);
      }
    };

    await expect(drive()).rejects.toThrow(/provider exploded/);
    // 事件必须在抛错前逐条转发出去（对外事件序列不变）
    expect(forwarded).toEqual(["usage", "tool_complete"]);

    const records = spy.mock.calls.map((c) => c[0] as unknown as RecordedUsage);
    expect(records.length, "抛错路径必须恰好留下一条记录").toBe(1);
    const rec = records[0];
    expect(rec.sessionId).toBe("sess-d6-throw");
    expect(rec.success, "抛错的回合必须标成不成功").toBe(false);
    expect(String(rec.error ?? "")).toMatch(/AbortError/);
    expect(rec.usage.promptTokens, "取累计 3000，而不是最后一次迭代的 1000").toBe(3000);
    expect(rec.usage.completionTokens).toBe(30);
    expect(rec.usage.totalTokens).toBe(3030);
    expect(rec.toolCalls, "tool_complete 计数在抛错前也要统计到").toBe(1);
  });
});

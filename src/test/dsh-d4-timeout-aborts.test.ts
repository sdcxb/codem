/**
 * D4：工具超时必须**真正中止工具**，而不是只放弃等待。
 *
 * ## 缺陷形态
 *
 * `runOneTool` / `executeSingle` 把 `pipelineResult` 与 `timeoutTimer(...).promise`
 * 丢进 `Promise.race`，而 `timeoutTimer` 只做一件事：`reject(new Error("... timed out ..."))`。
 * **race 的败者不会被取消** —— 工具继续在跑，它的副作用（写文件、跑命令）照样落盘，
 * 而模型已经被告知它失败了。结果是"失败"与"成果真的写进去了"同时成立。
 *
 * 注意那个 signal 本来是**交到工具手里的**
 * （`pipeline.execute(..., { ...ctx, abort: tc.abortController.signal })`）——
 * 超时时却从来没有人 `abort()` 它。（`bash` 早先单独修过同一形态；本组用例守的是
 * 执行器这一层的修法，所有工具都受益。）
 *
 * ## 判据
 *
 * 注册一个 `timeoutMs: 250` 的工具：它在 `ctx.abort` 上挂 abort 监听，然后睡 1.5s
 * （**远长于超时**）。断言：
 * 1. 工具**观察到了中止**（`observed.aborted === true`）；
 * 2. 上报的结果是结构化失败并带机器可读码 `TOOL_TIMEOUT`（不靠文本匹配分类）。
 *
 * ⚠️ 第 191 波（把"偶发假红"变成本判据的一部分）：这两个数字原来是 **50ms / 250ms**，
 * 在全量并行满载时会**偶发假红** —— 实测失败形态是 `sawSignal === false`（工具的
 * `execute` 根本没被调用：50ms 的定时器先到，而 `Promise.race` 的败者不会被取消，
 * 于是"超时先于工具起步"）。那不是产品缺陷，而是**判据自己的时间预算比被测机器的
 * 事件循环延迟还小**。放宽到 250ms / 1.5s 后不变式（超时 ≪ 干活）仍然成立，
 * 而"超时必须 abort 工具"这件事被证明的强度完全相同。
 *
 * ⚠️ 2026-11-07（默认 8 worker 全量偶发红治理）：250ms 在**满载**下仍可能被读盘/调度
 * 排队抢跑（报告的失败形态是「超时后 5s 内未观察到 abort」；可能是判据自己的 5s 预算
 * 先被顶穿，也可能是 250ms 抢在工具派发之前）。这次不靠「把数字再猜大一点」，而是
 * 两件事一起做：
 *   1. 超时窗口放宽到 **1s**、工具干活 **4s**（仍满足「超时 ≪ 干活」，强度不变）；
 *   2. 判据等的是**观察到 abort**（`waitForCondition`，宽松上限 10s），不是"跑完立刻断言"；
 *      用例本身显式 **30s**，不再用 vitest 默认 5s 去赌机器负载。
 * 「必须观察到 abort」「超时必须是结构化失败」两条断言一字未改。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { TOOL_TIMEOUT } from "../core/llm/streaming-executor";

const SESSION_ID = "dsh-d4-timeout";
const CWD = "C:\\d4-timeout";
const TOOL_NAME = "probe_slow";

/**
 * 超时预算：**远小于**工具自己的睡眠时长（4s）。见上面那句为什么不是 50ms / 250ms。
 * 1s 是「满载时事件循环能把派发拖多久」的预算，不是判据强度的一部分。
 */
const TOOL_TIMEOUT_MS = 1000;
/** 工具"干活"的时长：确保超时必然先到（4× 超时，不变式仍是「超时 ≪ 干活」） */
const TOOL_WORK_MS = 4000;

/**
 * 轮询到条件成立（宽松上限 10s）。
 *
 * 超时中止是**异步观察**：定时器可能在工具派发前后任意一个调度间隙触发。
 * 原来"跑完立刻断言"把「观察窗口」压成一次采样 —— 满载时工具还没被派发，
 * 断言就先失败了（`sawSignal === false`）。等到条件成立立刻返回；
 * 上限只用于「真的没发生」时判红，不会把红判据变成绿。
 */
async function waitForCondition(predicate: () => boolean, timeoutMs = 10_000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

/** 一次回复里给一个慢工具调用 */
function oneCall(): any[] {
  const id = "call_slow";
  return [
    { type: "tool_use_start", id, name: TOOL_NAME },
    { type: "tool_use_delta", id, input: JSON.stringify({ note: "sleep" }) },
    { type: "tool_use_end", id, input: { note: "sleep" } },
    { type: "end", finishReason: "tool_use" },
  ];
}

class ScriptedProvider {
  id = "d4-provider";
  name = "D4 Mock";
  private scripts: any[][] = [];
  setScript(scripts: any[][]) {
    this.scripts = scripts;
  }
  isConfigured() {
    return true;
  }
  async *stream(): AsyncGenerator<any> {
    const script = this.scripts.shift() ?? [{ type: "end", finishReason: "stop" }];
    for (const e of script) yield e;
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

describe("D4：超时必须 abort 掉工具的 controller", () => {
  let observed: { aborted: boolean; sawSignal: boolean };

  beforeEach(() => {
    vi.clearAllMocks();
    observed = { aborted: false, sawSignal: false };
  });

  function buildRegistry() {
    const registry = createDefaultToolRegistry();
    registry.register({
      id: TOOL_NAME,
      description: "测试用慢工具：监听 ctx.abort，睡到超时之后",
      parameters: {
        type: "object",
        properties: { note: { type: "string" } },
        required: [],
      },
      contract: {
        readOnly: false,
        concurrencySafe: false,
        sideEffectScope: "session",
        accessScope: "none",
        persistResult: false,
        timeoutMs: TOOL_TIMEOUT_MS,
      },
      async execute(_args: any, ctx: any) {
        const signal: AbortSignal | undefined = ctx?.abort;
        observed.sawSignal = !!signal;
        await new Promise<void>((resolve) => {
          if (!signal) return resolve();
          if (signal.aborted) {
            observed.aborted = true;
            return resolve();
          }
          signal.addEventListener(
            "abort",
            () => {
              observed.aborted = true;
              resolve();
            },
            { once: true },
          );
          // 超时之后仍会继续跑很久 —— 这正是"只放弃等待"时副作用照样落盘的窗口
          setTimeout(resolve, TOOL_WORK_MS);
        });
        return { title: "slow", output: observed.aborted ? "stopped" : "finished" };
      },
    } as any);
    return registry;
  }

  it("D4-A: 超时触发时工具必须观察到 abort（改前它一直跑到自己结束）", { timeout: 30_000 }, async () => {
    const provider = new ScriptedProvider();
    provider.setScript([
      oneCall(),
      [{ type: "text_delta", text: "工具已超时上报" }, { type: "end", finishReason: "stop" }],
    ]);

    const loop = new AgenticLoop(provider as any, buildRegistry(), {
      maxIterations: 3,
      model: "d4-model",
      securityMode: "full",
    });

    const events: any[] = [];
    for await (const e of loop.run(SESSION_ID, "跑一个慢工具", CWD, "system prompt")) events.push(e);

    /*
     * 等的是「观察到了 abort」这个**状态**（宽松上限 10s），不是"跑完刚好也观察到了"。
     * 若产品真的没把中止传到工具，10s 后这里仍然 false ⇒ 照红（不会变成假绿）。
     */
    const sawAbort = await waitForCondition(() => observed.sawSignal && observed.aborted);
    expect(observed.sawSignal, "前置：工具必须真的拿到 per-call 的 abort signal").toBe(true);
    expect(
      sawAbort,
      `超时后 10s 内没有观察到 ctx.abort 被中止 —— 工具观察到 ctx.abort 被中止才算真的停下（改前这里恒为 false：race 只放弃等待，工具继续跑完）`,
    ).toBe(true);

    const timeoutErrors = events.filter(
      (e) => e.type === "tool_error" && (e as any).code === TOOL_TIMEOUT,
    );
    expect(
      timeoutErrors.length,
      `超时结果必须是**结构化失败**（机器可读码 ${TOOL_TIMEOUT}），不能只靠文本匹配分类`,
    ).toBe(1);
    expect(String(timeoutErrors[0].error)).toMatch(new RegExp(`timed out after ${TOOL_TIMEOUT_MS}ms`));
  });
});

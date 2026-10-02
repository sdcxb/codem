/**
 * D1：**LLM 调用最终失败**不许被上报成 `reason: "completed"`。
 *
 * ## 缺陷形态
 *
 * `executeIteration` 的 catch 在"重试耗尽 / 不可重试的 4xx"之后
 * `consecutiveErrors++` 然后 `return` —— 它**永远走不到**
 * `this.state.toolCallsInIteration = currentToolCalls.length` 那一行。
 * 主循环因此看到 `toolCallsInIteration === 0`，把"这一轮没有工具调用"
 * 当成"模型自然结束"，返回 `{ type: "stop", reason: "completed" }`。
 *
 * 后果（真机可见）：用户发一条消息，助手没有任何回复，界面却显示"已完成"；
 * 用量面板把它记成一次**成功**调用。同时 `LoopResult` 里声明的
 * `{ type: "error"; error: string }` 从来没有任何地方构造过 —— 它是死代码。
 *
 * ## 这一组用例的判据（全部断言**可观测结果**，不看源码文本）
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | D1-A | provider 抛 `status: 400`（不可重试） | end 事件是 `type: "error"`，且 `reason !== "completed"` |
 * | D1-B | 同上 + `maxConsecutiveErrors: 1` | end 事件的 `reason === "too_many_errors"`（证明该分支可达） |
 * | D1-C | 第一次 500（可重试）→ 重试成功 | 仍然 `completed`（**重试成功的那次不许置失败标志**） |
 * | D1-D | 第 1 轮失败、但有待消费的指引 ⇒ 循环进入第 2 轮并成功 | 第 2 轮结果是 `completed`（失败标志**不许跨迭代泄漏**） |
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getGuidanceQueue } from "../core/llm/guidance-queue";

const CWD = "C:\\d1-llm-failure";

/** 脚本化 provider：每次 `stream()` 消费一个脚本；脚本项可以是 Error（抛出）。 */
class ScriptedProvider {
  id = "d1-provider";
  name = "D1 Mock";
  config: any = { apiKey: "sk-test" };
  dynamicModels: any[] | null = null;
  requests: any[] = [];
  /** 每次 `stream()` 被调用时触发（用于"在第 1 轮失败时塞一条指引"） */
  onStream: (() => void) | null = null;
  private queue: any[][] = [];

  setScript(scripts: any[][]) {
    this.queue = scripts;
  }
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    const script = this.queue.shift();
    this.onStream?.();
    if (!script) throw new Error("脚本耗尽（不该发生的额外调用）");
    for (const item of script) {
      if (item instanceof Error) throw item;
      yield item;
    }
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

function apiError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

async function drain(loop: AgenticLoop, sessionId: string): Promise<any[]> {
  const events: any[] = [];
  for await (const e of loop.run(sessionId, "hi", CWD, "system prompt")) events.push(e);
  return events;
}

function endResult(events: any[]): any {
  const ends = events.filter((e) => e.type === "end");
  expect(ends.length, "每一轮都必须以恰好一个 end 事件收场").toBe(1);
  return ends[0].result;
}

describe("D1：LLM 调用失败必须如实上报，不能报成 completed", () => {
  let provider: ScriptedProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ScriptedProvider();
    getGuidanceQueue().clearAll();
  });

  it("D1-A: provider 抛 400（重试耗尽）→ end 结果是 type=error，绝不是 reason=completed", async () => {
    provider.setScript([[apiError("API error 400: bad model", 400)]]);
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "d1-model",
      securityMode: "full",
    });

    const result = endResult(await drain(loop, "dsh-d1-a"));

    expect(
      result.type,
      `LLM 硬失败必须上报 error；实际 ${JSON.stringify(result)}（改前这里恒为 {type:"stop",reason:"completed"}）`,
    ).toBe("error");
    expect(result.reason, "失败回合不许带 completed 这个结束原因").not.toBe("completed");
    expect(String(result.error), "错误原因要透出去（用户与用量面板都要看到）").toContain("bad model");
  });

  it("D1-B: maxConsecutiveErrors=1 时 → too_many_errors 分支可达（改前它排在 completed 之后，永远不触发）", async () => {
    provider.setScript([[apiError("API error 400: bad model", 400)]]);
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "d1-model",
      securityMode: "full",
      maxConsecutiveErrors: 1,
    });

    const result = endResult(await drain(loop, "dsh-d1-b"));

    expect(
      result.reason,
      "连续错误到上限就该以 too_many_errors 收场 —— 这条分支在 LLM 失败路径上原本不可达",
    ).toBe("too_many_errors");
  });

  it("D1-C: 可重试错误重试后成功 → 仍然是 completed（重试成功不许置失败标志）", async () => {
    provider.setScript([
      [apiError("API error 500: transient", 500)],
      [{ type: "text_delta", text: "重试成功" }, { type: "end", finishReason: "stop" }],
    ]);
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "d1-model",
      securityMode: "full",
    });

    const events = await drain(loop, "dsh-d1-c");
    const result = endResult(events);

    expect(provider.requests.length, "第一次失败应当触发一次重试").toBeGreaterThanOrEqual(2);
    expect(
      result,
      "重试最终成功的一轮必须照旧算完成（失败标志只能在**最终失败**时置位）",
    ).toEqual(expect.objectContaining({ type: "stop", reason: "completed" }));
    expect(
      (loop as any).getState().lastIterationError,
      "成功收场时不得残留失败标志",
    ).toBeNull();
  });

  it("D1-D: 第 1 轮 LLM 失败 → 指引待消费 ⇒ 第 2 轮成功，结果必须是 completed（标志不许跨迭代泄漏）", async () => {
    /**
     * 造出"失败但没有立刻收场"的形态：第 1 轮 provider 抛 400（不可重试）后，
     * 主循环进入 completed 分支，而**待消费的指引**让分支 `continue` 到第 2 轮。
     * 如果失败标志不在每个迭代开头清空，第 2 轮会被第 1 轮的失败污染成 error。
     */
    provider.setScript([
      [apiError("API error 400: bad model (iteration 1)", 400)],
      [{ type: "text_delta", text: "第 2 轮正常" }, { type: "end", finishReason: "stop" }],
    ]);
    provider.onStream = () => {
      // 首次调用时排入一条指引：循环在第 1 轮的 stop 判定处会先看到它并继续
      if (provider.requests.length === 1) {
        getGuidanceQueue().enqueue("dsh-d1-d", "继续（这是运行中的指引）");
      }
    };

    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 4,
      model: "d1-model",
      securityMode: "full",
    });

    const events = await drain(loop, "dsh-d1-d");
    const result = endResult(events);

    expect(provider.requests.length, "第 1 轮失败后应当继续到第 2 轮").toBeGreaterThanOrEqual(2);
    expect(
      result.type,
      `第 2 轮是正常完成，失败标志不能从第 1 轮泄漏过来（实际 ${JSON.stringify(result)}）`,
    ).toBe("stop");
    expect(result.reason).toBe("completed");
  });
});

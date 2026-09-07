/**
 * cache 累计端到端集成测试（采集 → AgenticLoop 汇总 → result.usage）
 *
 * 不依赖真实 API：用脚本化 mock provider 回放带 cache 字段的 usage 事件，
 * 验证 agentic-loop 的 totalUsage 正确累计 cacheHitTokens / uncached /
 * cost（含缓存价差计价）——StatsLine/每轮用量 UI 的数据源闭环。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { CostTracker } from "../core/llm/cost-tracker";

const SESSION_ID = "cache-sess-1";

/** 脚本化 provider：stream 每次调用按队列消耗脚本（含 usage 事件） */
class ScriptedProvider {
  id = "mock-provider";
  name = "Mock";
  private queue: any[][] = [];

  setScript(scripts: any[][]) { this.queue = scripts; }

  async *stream(_request: any): AsyncGenerator<any> {
    const script = this.queue.length > 0 ? this.queue.shift()! : [];
    for (const e of script) yield e;
    yield { type: "end", finishReason: "stop" };
  }

  async complete() {
    return { content: "ok", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
  }
  async listModels() { return []; }
  async fetchModelsFromServer() { return []; }
  isConfigured() { return true; }
}

function usageEvent(prompt: number, comp: number, hit: number, miss: number) {
  return {
    type: "usage",
    usage: {
      promptTokens: prompt,
      completionTokens: comp,
      totalTokens: prompt + comp,
      cacheHitTokens: hit,
      uncachedInputTokens: miss,
    },
  };
}

describe("AgenticLoop cache 累计（端到端）", () => {
  let provider: ScriptedProvider;
  beforeEach(() => {
    provider = new ScriptedProvider();
  });

  it("单次调用：usage 事件(cache 900/1000) → result.usage 累计 cache/uncached/cost", async () => {
    provider.setScript([
      [
        usageEvent(1000, 100, 900, 100),
        { type: "text_delta", text: "hi" },
      ],
    ]);
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "deepseek-chat",
      securityMode: "full",
      costTracker: new CostTracker({ maxRecords: 100 }),
    });
    let result: any;
    for await (const event of loop.run(SESSION_ID, "task", "C:/x", "sys")) {
      if (event.type === "end") result = event.result;
    }
    expect(result).toBeTruthy();
    const u = result.usage;
    expect(u.promptTokens).toBe(1000);
    expect(u.completionTokens).toBe(100);
    expect(u.cacheHitTokens).toBe(900);
    expect(u.uncachedInputTokens).toBe(100);
    // 成本：100 uncached×0.00027/1K + 900 cache×0.00007/1K + 100 out×0.0011/1K
    expect(u.cost).toBeCloseTo(
      (100 / 1000) * 0.00027 + (900 / 1000) * 0.00007 + (100 / 1000) * 0.0011,
      12,
    );
  });

  it("无 cache 上报时：uncached = prompt、cost 按全量输入价（兼容口径）", async () => {
    provider.setScript([
      [
        { type: "usage", usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 } },
        { type: "text_delta", text: "hi" },
      ],
    ]);
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "deepseek-chat",
      securityMode: "full",
      costTracker: new CostTracker({ maxRecords: 100 }),
    });
    let result: any;
    for await (const event of loop.run(SESSION_ID, "task", "C:/x", "sys")) {
      if (event.type === "end") result = event.result;
    }
    const u = result.usage;
    expect(u.cacheHitTokens).toBe(0);
    expect(u.uncachedInputTokens).toBe(1000);
    expect(u.cost).toBeCloseTo((1000 / 1000) * 0.00027 + (50 / 1000) * 0.0011, 12);
  });
});

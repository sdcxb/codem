/**
 * 「非正常收场不许被用量记账当成成功」（第 93 波，第 4 处「把被杀掉的循环呈现成完成」）。
 *
 * ## 缺陷形态
 *
 * `LLMEngine.runLoopAndRecordUsage` 里那段判据**只认两种形状**：
 * `{ type: "error" }` 与 `reason === "too_many_errors"`；其余一律当成功。
 * 于是 `plan_stale`（循环被停滞守卫杀掉）、`repeat_guard`（零信息增益打转）、
 * `output_truncated` / `context_overflow` / `no_progress` / `max_iterations` /
 * `safety_valve` / 成本上限……**全都被记成一次正常调用**。
 * 用户报的「任务提前停掉，然后说完成了」，在用量/成本这一侧就是这个样子。
 *
 * ## 判据（驱动**真实**的记账路径 `runLoopAndRecordUsage`，只把 loop 换成夹具）
 *
 * | # | 收场形状 | 判据 |
 * | --- | --- | --- |
 * | USAGE-PLAN-STALE | `{type:"stop", reason:"plan_stale", detail:{stalledFor:24}}` | `success === false`，失败原因里能看到 `plan_stale` |
 * | USAGE-REPEAT-GUARD | `{type:"stop", reason:"repeat_guard"}` | `success === false` |
 * | USAGE-MAX-ITER | `{type:"stop", reason:"max_iterations"}` | `success === false` |
 * | USAGE-TOOMANY（回归锁） | `{type:"stop", reason:"too_many_errors"}` | 仍然 `success === false`，且失败原因**仍是** `too_many_errors`（旧口径不许漂） |
 * | USAGE-ERROR（回归锁） | `{type:"error", error:"boom"}` | `success === false`，失败原因 `error: boom` |
 * | USAGE-COMPLETED（反向对照） | `{type:"stop", reason:"completed"}` | `success === true`（不许把正常完成判成失败） |
 *
 * 变异自证：把 `index.ts` 里的 `notCompleted` 换回旧口径
 * （只认 `type === "error"` 与 `reason === "too_many_errors"`）⇒
 * USAGE-PLAN-STALE / REPEAT-GUARD / MAX-ITER 三条必须变红。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { LLMEngine } from "../core/llm";
import { getCostTracker } from "../core/llm/cost-tracker";

interface RecordedUsage {
  sessionId: string;
  success?: boolean;
  error?: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  toolCalls?: number;
}

/**
 * 夹具 loop：吐给定事件，并**把 LoopResult 作为生成器的返回值**交回
 * （`runLoopAndRecordUsage` 是手动驱动迭代器的：`for await` 拿不到返回值 —— 见它的方法头）。
 */
class FakeLoop {
  constructor(
    private events: any[],
    private cumulative: { promptTokens: number; completionTokens: number; totalTokens: number },
    private result: any,
  ) {}
  async *run() {
    for (const e of this.events) yield e;
    return this.result;
  }
  getState() {
    return { totalUsage: { ...this.cumulative }, iteration: 24 };
  }
}

const SESSION = "sess-usage-noncompletion";

async function recordFor(result: any): Promise<RecordedUsage> {
  const engine = new LLMEngine();
  const spy = vi.spyOn(getCostTracker(), "recordUsage");
  const cumulative = { promptTokens: 1000, completionTokens: 30, totalTokens: 1030 };
  const loop = new FakeLoop(
    [
      { type: "usage", usage: { promptTokens: 1000, completionTokens: 30, totalTokens: 1030 } },
      { type: "end", result },
    ],
    cumulative,
    result,
  );

  for await (const _event of (engine as any).runLoopAndRecordUsage({
    loop,
    sessionId: SESSION,
    message: "x",
    cwd: "C:\\usage-noncompletion",
    systemPrompt: "sys",
    startTime: Date.now(),
    successLogPrefix: "test",
  })) {
    /* drain */
  }

  const records = spy.mock.calls.map((c) => c[0] as unknown as RecordedUsage);
  expect(records.length, "一轮对话必须恰好留下一条用量记录").toBe(1);
  return records[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("非正常收场的回合不许被记成成功（第 93 波）", () => {
  it("USAGE-PLAN-STALE: 被停滞守卫杀掉的那一轮 → success=false，原因里能看到 plan_stale", async () => {
    const rec = await recordFor({ type: "stop", reason: "plan_stale", detail: { stalledFor: 24 } });
    expect(
      rec.success,
      "循环被停滞守卫杀掉，用量面板却记成一次正常调用 —— 这正是「任务提前停掉，然后说完成了」在记账侧的形态",
    ).toBe(false);
    expect(String(rec.error ?? "")).toMatch(/plan_stale/);
  });

  it("USAGE-REPEAT-GUARD: 零信息增益打转停下 → success=false", async () => {
    const rec = await recordFor({ type: "stop", reason: "repeat_guard" });
    expect(rec.success).toBe(false);
    expect(String(rec.error ?? "")).toMatch(/repeat_guard/);
  });

  it("USAGE-MAX-ITER: 撞到迭代上限 → success=false", async () => {
    const rec = await recordFor({ type: "stop", reason: "max_iterations" });
    expect(rec.success).toBe(false);
  });

  it("USAGE-TOOMANY（回归锁）: 连续错误上限仍然记失败，且原因口径不漂（仍是 too_many_errors）", async () => {
    const rec = await recordFor({ type: "stop", reason: "too_many_errors" });
    expect(rec.success).toBe(false);
    expect(String(rec.error ?? "")).toBe("too_many_errors");
  });

  it("USAGE-ERROR（回归锁）: LLM 调用最终失败仍然记 error: …", async () => {
    const rec = await recordFor({ type: "error", error: "boom" });
    expect(rec.success).toBe(false);
    expect(String(rec.error ?? "")).toBe("error: boom");
  });

  it("USAGE-COMPLETED 反向对照: 正常完成必须仍然是成功", async () => {
    const rec = await recordFor({ type: "stop", reason: "completed" });
    expect(rec.success, "把正常完成判成失败会让用量面板全线飘红").toBe(true);
    expect(rec.error).toBeFalsy();
  });
});

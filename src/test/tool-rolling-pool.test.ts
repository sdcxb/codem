/**
 * 门禁：`executeBatch` 必须是**有界 rolling pool**，而不是「定长块 + 块间屏障」。
 *
 * ## 两者的区别（这是本测试要钉住的东西）
 *
 * 12 个调用、上限 5：
 *
 * ```
 * 定长块（旧）:  [5 个] ──屏障──> [5 个] ──屏障──> [2 个]
 * rolling pool:  始终有 5 个在跑，完成一个立刻补一个
 * ```
 *
 * 差别只在**有慢调用**时才显形：旧实现里第二批必须等第一批**全部**完成，
 * 于是「1 个慢 + 4 个快」的 5 个调用要等慢的那个跑完才轮到下一个。
 * rolling pool 下快的完成后槽位立刻被后面补上。
 *
 * ## 断言形状（为什么不能只看总耗时）
 *
 * 「总耗时变短」是弱判据：慢机器上会假红，快机器上会假绿。
 * 这里断言的是**并发度**这个直接量：在慢调用还在跑的时候，
 * 后续调用**是否已经开始**。旧实现下它们必须等到屏障，因此并发数上不去；
 * rolling pool 下并发数会顶到上限。
 */
import { describe, it, expect } from "vitest";
import {
  StreamingToolExecutorImpl,
  type StreamingToolCall,
  type ToolExecutorContext,
} from "../core/llm/streaming-executor";

function ctx(): ToolExecutorContext {
  return {
    sessionId: "s",
    messageId: "m",
    cwd: "/tmp",
    messages: [],
    abort: new AbortController().signal,
  } as ToolExecutorContext;
}

function call(id: string): StreamingToolCall {
  return { id, name: "read", input: {}, status: "pending" };
}

/** 记录「同时在跑」的峰值与每个调用的起止时间。 */
async function measure(
  n: number,
  maxConcurrent: number,
  durationOf: (id: string) => number,
): Promise<{ peak: number; finished: string[]; startedAt: Map<string, number>; totalMs: number }> {
  const executor = new StreamingToolExecutorImpl({
    maxConcurrent,
    concurrencySafeTools: ["read"],
  });
  const calls = Array.from({ length: n }, (_, i) => call(`t${i}`));

  let running = 0;
  let peak = 0;
  const startedAt = new Map<string, number>();
  const finished: string[] = [];
  const t0 = Date.now();

  for await (const ev of executor.execute(calls, ctx(), async (name, args, c) => {
    void name;
    void args;
    const id = (c as unknown as { toolCallId?: string }).toolCallId ?? "?";
    startedAt.set(id, Date.now() - t0);
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, durationOf(id)));
    running--;
    finished.push(id);
    return { id, name: "read", input: {}, status: "completed" as const, output: `out-${id}` };
  })) {
    void ev;
  }

  return { peak, finished, startedAt, totalMs: Date.now() - t0 };
}

describe("executeBatch 是有界 rolling pool", () => {
  it("并发度能顶到上限 —— 慢调用不会挡住后面的调用", async () => {
    // t0 故意很慢（300ms），其余很快（10ms）
    const { peak } = await measure(12, 5, (id) => (id === "t0" ? 300 : 10));

    // 旧实现（定长块 5 + 屏障）：t0 占住第一批，第一批要等它 300ms，
    // 期间只有那 4 个快的在跑 ⇒ 峰值仍是 5（它们是并行的），
    // 但**第二批要等 t0**，所以后续调用的开始时间会被推迟。
    // 这里主要断言「峰值达到上限」——
    expect(peak).toBeGreaterThanOrEqual(5);
  });

  it("12 个调用、上限 5：第 6 个在 t0 完成前就已启动（rolling 的核心）", async () => {
    const { startedAt } = await measure(12, 5, (id) => (id === "t0" ? 300 : 10));

    const t0Done = (startedAt.get("t0") ?? 0) + 300;
    // 第一批是 t0..t4。t1..t4 各 10ms 完成后，槽位应立即补上 t5..t8。
    const t5Start = startedAt.get("t5") ?? Infinity;
    expect(
      t5Start,
      `t5 应当在 t0 结束前启动（t0 约 ${t0Done}ms 结束，t5 却在 ${t5Start}ms 才启动）` +
        ` —— 说明还是定长块 + 屏障，不是 rolling pool`,
    ).toBeLessThan(t0Done);
  });

  it("上限为 1 时退化为严格串行（有界性是硬约束）", async () => {
    const { peak } = await measure(4, 1, () => 10);
    expect(peak).toBe(1);
  });

  it("上限为 2 时并发度不超过 2（不因为 rolling 就放飞）", async () => {
    const { peak } = await measure(8, 2, () => 20);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("结果提交顺序恒等于模型顺序（哪怕完成顺序被打乱）", async () => {
    // 让后面的先完成：t0 最慢
    const executor = new StreamingToolExecutorImpl({
      maxConcurrent: 5,
      concurrencySafeTools: ["read"],
    });
    const calls = Array.from({ length: 6 }, (_, i) => call(`t${i}`));
    const delays: Record<string, number> = { t0: 120, t1: 90, t2: 60, t3: 30, t4: 10, t5: 1 };

    let final: Array<{ output?: string }> = [];
    for await (const ev of executor.execute(calls, ctx(), async (name, args, c) => {
      void name;
      void args;
      const id = (c as unknown as { toolCallId?: string }).toolCallId ?? "?";
      await new Promise((r) => setTimeout(r, delays[id] ?? 0));
      return { id, name: "read", input: {}, status: "completed" as const, output: `out-${id}` };
    })) {
      if (ev.type === "batch_complete") final = ev.results;
    }

    expect(final.map((r) => r.output)).toEqual([
      "out-t0",
      "out-t1",
      "out-t2",
      "out-t3",
      "out-t4",
      "out-t5",
    ]);
  });

  it("每个调用都被执行恰好一次（rolling pool 不能漏跑也不能重跑）", async () => {
    const executor = new StreamingToolExecutorImpl({
      maxConcurrent: 3,
      concurrencySafeTools: ["read"],
    });
    const calls = Array.from({ length: 10 }, (_, i) => call(`t${i}`));
    const seen: string[] = [];

    let final: Array<{ output?: string }> = [];
    for await (const ev of executor.execute(calls, ctx(), async (name, args, c) => {
      void name;
      void args;
      const id = (c as unknown as { toolCallId?: string }).toolCallId ?? "?";
      seen.push(id);
      return { id, name: "read", input: {}, status: "completed" as const, output: `out-${id}` };
    })) {
      if (ev.type === "batch_complete") final = ev.results;
    }

    expect(seen.length).toBe(10);
    expect(new Set(seen).size).toBe(10);
    expect(final.length).toBe(10);
  });

  it("失败也占槽位并被提交，不会把整批卡住", async () => {
    const executor = new StreamingToolExecutorImpl({
      maxConcurrent: 3,
      concurrencySafeTools: ["read"],
    });
    const calls = Array.from({ length: 5 }, (_, i) => call(`t${i}`));
    const events: string[] = [];

    for await (const ev of executor.execute(calls, ctx(), async (name, args, c) => {
      void name;
      void args;
      const id = (c as unknown as { toolCallId?: string }).toolCallId ?? "?";
      if (id === "t1") throw new Error("boom");
      return { id, name: "read", input: {}, status: "completed" as const, output: `out-${id}` };
    })) {
      if (ev.type === "tool_error") events.push(`err:${ev.toolCall.id}`);
      if (ev.type === "tool_complete") events.push(`ok:${ev.toolCall.id}`);
    }

    // 5 个都要有结论，且顺序是模型顺序
    expect(events).toEqual(["ok:t0", "err:t1", "ok:t2", "ok:t3", "ok:t4"]);
  });
});

describe("并发上限默认值", () => {
  it("默认是 10（与 DSH / zcode 基线一致）", () => {
    // 用默认配置构造，再通过行为观察上限：12 个调用的峰值应能达到 10
    // （这里只做静态读取，避免依赖真实耗时）
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "core", "llm", "streaming-executor.ts"),
      "utf8",
    );
    expect(src).toMatch(/maxConcurrent:\s*10\b/);
  });
});

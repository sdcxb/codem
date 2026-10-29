/**
 * **3 并发会话**的隔离与稳定性（第 233 轮 · 用户批准项 2A 的可重复夹具）。
 *
 * ## 为什么用确定性夹具而不是直接打真实模型
 *
 * 「3 并发」要证明的是**并发安全**：三个会话同时跑时，状态不会串
 * （用量/中止信号/事件流/压缩计数各归各的）。这一层的缺陷**真实模型跑一次也未必暴露**
 * （取决于时序），确定性夹具可以每次都压在同一处。
 * 真实模型的吞吐/失败率属于另一类指标（要花 token、且受服务端波动），
 * 由 `.preview-shot` 的真机实验负责；这里钉住「并发不串」这条不变量。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | CONC-1 | 3 个循环**真并发**（总耗时 < 单段之和的 0.75，否则说明是串行） |
 * | CONC-2 | 每个循环拿到**自己的**输出与用量，互不污染 |
 * | CONC-3 | 每个 provider 只服务**自己那一个**循环（各 1 次请求，总数 3） |
 * | CONC-4 | 中止其中一个，另外两个照常完成（AbortSignal 不共享） |
 * | CONC-5（反向对照） | 三个循环共用一个 provider 时，它收到 3 次请求且三路输出相同 —— 证明 CONC-2 的"各归各"不是恒真 |
 *
 * 变异自证：把 `AgenticLoop` 的 state 改成模块级单例 ⇒ CONC-2 红。
 */
import { describe, it, expect } from "vitest";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";

class RecordingProvider {
  id = "mock";
  name = "Mock";
  requests: any[] = [];
  constructor(private readonly reply: string, private readonly delayMs = 60) {}

  /** 让引擎能解析上下文窗口（否则会走默认值并打一条警告） */
  async listModels() {
    return [{ id: "deepseek-flash", name: "flash", contextWindow: 1_000_000, maxOutputTokens: 8192 }];
  }

  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    await new Promise((r) => setTimeout(r, this.delayMs));
    yield { type: "text_delta", text: this.reply };
    yield { type: "usage", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
    yield { type: "end", finishReason: "stop" };
  }

  async complete() {
    return { content: this.reply, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
  }
}

function makeLoop(provider: any, opts: { signal?: AbortSignal } = {}) {
  return new AgenticLoop(provider, createDefaultToolRegistry(), {
    maxIterations: 2,
    model: "deepseek-flash",
    securityMode: "full",
    ...(opts.signal ? { abortSignal: opts.signal } : {}),
  } as any);
}

async function runLoop(loop: AgenticLoop, sessionId: string, task: string) {
  const events: any[] = [];
  let result: any = null;
  for await (const e of loop.run(sessionId, task, "C:/x", "sys")) {
    events.push(e);
    if (e.type === "end") result = e.result;
  }
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  return { events, result, text };
}

const TASKS = ["任务甲：只回答 A", "任务乙：只回答 B", "任务丙：只回答 C"];
const REPLIES = ["A", "B", "C"];
const DELAY = 150;

describe("3 并发会话：隔离与稳定性", () => {
  it("CONC-1/2/3: 三个循环真并发、输出与用量各归各的、每个 provider 只服务一个循环", async () => {
    const providers = REPLIES.map((r) => new RecordingProvider(r, DELAY));
    const loops = providers.map((p) => makeLoop(p));

    const t0 = Date.now();
    const runs = await Promise.all(loops.map((loop, i) => runLoop(loop, `sess-${i}`, TASKS[i])));
    const elapsed = Date.now() - t0;

    // CONC-1：单段 150ms，三段串行 ≥450ms；真并发应显著更短
    expect(elapsed, `三段总耗时 ${elapsed}ms —— 看起来是串行跑的（并发失败）`).toBeLessThan(DELAY * 3 * 0.75);

    // CONC-2：输出与用量各归各的
    runs.forEach((run, i) => {
      expect(run.text, `第 ${i} 个循环的输出被串了`).toBe(REPLIES[i]);
      expect(run.result?.usage?.totalTokens ?? 0, `第 ${i} 个循环没有自己的用量`).toBeGreaterThan(0);
    });

    // CONC-3：每个 provider 只服务自己那一个循环
    providers.forEach((p, i) => {
      expect(p.requests.length, `第 ${i} 个 provider 的服务次数异常（应该只服务自己那一路）`).toBe(1);
    });
  });

  it("CONC-4: 中止其中一个，另外两个照常完成", async () => {
    const providers = REPLIES.map((r) => new RecordingProvider(r, DELAY));
    const loops = providers.map((p) => makeLoop(p));

    const ac = new AbortController();
    const aborted = makeLoop(new RecordingProvider("X", DELAY), { signal: ac.signal });

    const keep0 = runLoop(loops[0], "keep-0", TASKS[0]);
    const keep1 = runLoop(loops[1], "keep-1", TASKS[1]);
    const doomed = runLoop(aborted, "abort-me", TASKS[2]);
    setTimeout(() => ac.abort(), 20);

    const [a, b, c] = await Promise.allSettled([keep0, keep1, doomed]);
    expect(a.status, "中止一路不该影响其它两路").toBe("fulfilled");
    expect(b.status, "中止一路不该影响其它两路").toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(c.status);
    if (a.status === "fulfilled") expect(a.value.text).toBe("A");
    if (b.status === "fulfilled") expect(b.value.text).toBe("B");
  });

  it("CONC-5（反向对照）: 共用一个 provider 时三路输出相同 —— 证明 CONC-2 不是恒真", async () => {
    const shared = new RecordingProvider("shared", 20);
    const loops = [0, 1, 2].map(() => makeLoop(shared));
    const runs = await Promise.all(loops.map((loop, i) => runLoop(loop, `shared-${i}`, TASKS[i])));

    expect(shared.requests.length, "共用 provider 时它要服务 3 次（这正是「串」的形态）").toBe(3);
    const texts = runs.map((r) => r.text);
    expect(new Set(texts).size, "共用 provider 时三路输出无法区分（各归各的前提被破坏）").toBe(1);
  });
});

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
 * | CONC-1 | 3 个循环**真并发**：同时在飞的请求数峰值 = 3（串行实现无论机器多快都只能是 1） |
 * | CONC-1b（反向对照） | 串行跑三次时峰值并发只能是 1 —— 证明 CONC-1 的观察不是恒真 |
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
  constructor(
    private readonly reply: string,
    private readonly delayMs = 60,
    /** 并发观测器（可选）：串行跑时峰值只能是 1，真并发时才会到 2/3 */
    private readonly tracker: InFlightTracker | null = null,
  ) {}

  /** 让引擎能解析上下文窗口（否则会走默认值并打一条警告） */
  async listModels() {
    return [{ id: "deepseek-flash", name: "flash", contextWindow: 1_000_000, maxOutputTokens: 8192 }];
  }

  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    this.tracker?.enter();
    try {
      await new Promise((r) => setTimeout(r, this.delayMs));
    } finally {
      this.tracker?.leave();
    }
    yield { type: "text_delta", text: this.reply };
    yield { type: "usage", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
    yield { type: "end", finishReason: "stop" };
  }

  async complete() {
    return { content: this.reply, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
  }
}

/**
 * 并发观测器：记录「同时在飞」的请求数峰值。
 *
 * ⚠️ 为什么不用总耗时证明并发（本文件第 233 轮的写法是
 * `elapsed < 单段之和 × 0.75`）：三段并发本身只需要 ≈150ms，而阈值只有 337.5ms ——
 * 8 worker 满载时一次几百毫秒的读盘/调度停顿就足以把总耗时顶过阈值，于是
 * 「机器当时快不快」会冒充「代码是否串行」，表现为整批红、单跑绿。峰值同时在飞数
 * 是**关于执行形状**的观察：串行实现无论机器多快，峰值都只能是 1；真并发则必然到 3。
 */
class InFlightTracker {
  private active = 0;
  max = 0;
  enter(): void {
    this.active += 1;
    this.max = Math.max(this.max, this.active);
  }
  leave(): void {
    this.active -= 1;
  }
}

/**
 * 轮询到条件成立（宽松上限 10s）。
 *
 * 并发/中止这类判据等的是「某个状态出现过」，不是一次采样；固定 sleep 在满载时
 * 可能落在状态出现之前（这正是偶发假红的形态）。等到条件成立就立刻返回，
 * 上限只用来保证「真的没发生」时能判红而不是挂死。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000, stepMs = 5): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
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
  it("CONC-1/2/3: 三个循环真并发、输出与用量各归各的、每个 provider 只服务一个循环", { timeout: 20_000 }, async () => {
    const tracker = new InFlightTracker();
    const providers = REPLIES.map((r) => new RecordingProvider(r, DELAY, tracker));
    const loops = providers.map((p) => makeLoop(p));

    const runsPromise = Promise.all(loops.map((loop, i) => runLoop(loop, `sess-${i}`, TASKS[i])));

    /*
     * CONC-1：三路请求必须**同时在飞**（峰值 = 3）。
     * 串行实现无论机器多快峰值都只能是 1，所以这条不再受「满载计时抖动」影响；
     * 10s 只是「条件真的不成立」时的判红上限（判据语义是必须观察到并发，不是最终结果对）。
     */
    const overlapped = await waitFor(() => tracker.max === 3);
    expect(
      overlapped,
      `10s 内没有观察到三路同时在飞（峰值 ${tracker.max}）—— 三个循环是串行跑的（并发失败）`,
    ).toBe(true);

    const runs = await runsPromise;

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

  /**
   * 反向对照：把同一套观测器放到**串行**执行上，峰值必须是 1。
   *
   * 没有这条时，`tracker.max === 3` 可能因为观测器写坏而恒真；有它才能说明
   * CONC-1 观察到的是「并发」而不是「先后」。
   */
  it("CONC-1b（反向对照）: 串行跑三次时峰值并发只能是 1 —— 证明 CONC-1 的观察不是恒真", { timeout: 20_000 }, async () => {
    const tracker = new InFlightTracker();
    const provider = new RecordingProvider("S", 30, tracker);
    for (let i = 0; i < 3; i++) {
      await runLoop(makeLoop(provider), `serial-${i}`, TASKS[i]);
    }

    expect(provider.requests.length, "串行执行也应当服务 3 次（否则不是对照）").toBe(3);
    expect(tracker.max, "串行执行时同时只能有一个请求在飞 —— 峰值必须是 1（否则 CONC-1 是恒真）").toBe(1);
  });

  it("CONC-4: 中止其中一个，另外两个照常完成", { timeout: 20_000 }, async () => {
    const providers = REPLIES.map((r) => new RecordingProvider(r, DELAY));
    const loops = providers.map((p) => makeLoop(p));

    const ac = new AbortController();
    /*
     * 中止时机：等被中止那一路**真的开始**（provider 已进入在飞状态）再 abort。
     * 原来是固定 `setTimeout(..., 20)` —— 满载时它可能先于派发，于是「在飞中止」
     * 这件事根本没被测到（用例仍然绿）。轮询到条件成立，断言反而更实。
     */
    const doomedTracker = new InFlightTracker();
    const aborted = makeLoop(new RecordingProvider("X", DELAY, doomedTracker), { signal: ac.signal });

    const keep0 = runLoop(loops[0], "keep-0", TASKS[0]);
    const keep1 = runLoop(loops[1], "keep-1", TASKS[1]);
    const doomed = runLoop(aborted, "abort-me", TASKS[2]);
    await waitFor(() => doomedTracker.max === 1);
    ac.abort();

    const [a, b, c] = await Promise.allSettled([keep0, keep1, doomed]);
    expect(a.status, "中止一路不该影响其它两路").toBe("fulfilled");
    expect(b.status, "中止一路不该影响其它两路").toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(c.status);
    if (a.status === "fulfilled") expect(a.value.text).toBe("A");
    if (b.status === "fulfilled") expect(b.value.text).toBe("B");
  });

  it("CONC-5（反向对照）: 共用一个 provider 时三路输出相同 —— 证明 CONC-2 不是恒真", { timeout: 20_000 }, async () => {
    const shared = new RecordingProvider("shared", 20);
    const loops = [0, 1, 2].map(() => makeLoop(shared));
    const runs = await Promise.all(loops.map((loop, i) => runLoop(loop, `shared-${i}`, TASKS[i])));

    expect(shared.requests.length, "共用 provider 时它要服务 3 次（这正是「串」的形态）").toBe(3);
    const texts = runs.map((r) => r.text);
    expect(new Set(texts).size, "共用 provider 时三路输出无法区分（各归各的前提被破坏）").toBe(1);
  });
});

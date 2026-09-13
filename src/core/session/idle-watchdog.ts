/**
 * 空闲看门狗（第 64 波）—— 对齐 DSH 的 `@deepseek-ai/dsh-timeout` 的 `idleWatchdog`。
 *
 * ## 为什么要有它（用户质疑「用时间做可靠性」是对的）
 *
 * 我上一版给后台会话加了「15 分钟墙钟上限」。那是个**错的机制**：
 *   · 合法的长任务（装依赖、跑全量测试、编译）很容易超过 15 分钟 —— 会被**误杀**；
 *   · 而真正卡住的循环如果还在产出文字（哪怕全是废话），墙钟到点之前谁都拦不住；
 *   · 更根本的是：**"耗时"不能判断卡住**，能判断卡住的是**"没有动静"**。
 *
 * DSH 就是这么分的（本机 `dsh-timeout/lib/index.js` 可查）：
 *   · `deadline(upstream, timeoutMs, code)` —— **单次能力调用**的绝对截止
 *     （文件 API 60s；bash/pwsh 默认 120s、上限 600s，且每次都可由调用方传入并用 `clampTimeout` 夹住）；
 *   · `idleWatchdog(upstream, timeoutMs, code)` —— LLM 流的**空闲**看门狗（默认 300s）：
 *     只在"等下一个 chunk 期间没有任何字节"时触发，且提供 `pulse()` 在**有进展时重新上弦**；
 *     文档还特别写明「timer 只在 next() 未完成期间存在，所以**消费者的思考时间不算 provider 空闲**」。
 * 也就是：**时间只用来测"沉默"，不用来测"总共干了多久"**。
 *
 * 本文件把同一语义移植到 Codem 的后台执行上：后台会话每收到一个事件就 `pulse()` 一次，
 * 只有在**连续 N 分钟一个事件都没有**时才中止。合法长任务只要还在产出（哪怕只是不断有工具结果）
 * 就永远不会被杀；真正挂死（工具卡住、provider 不回、循环停摆）才会被中止。
 *
 * 与 DSH 的差异（有意）：DSH 的看门狗只在 `next()` 未完成期间计时（因为它在包装一个 async iterator）；
 * 后台会话是一个事件流，没有"消费者思考时间"这回事，所以这里创建即上弦、`pulse()` 即重新上弦。
 */

export interface IdleWatchdog {
  /** 与 upstream 融合后的中止信号（稳定不变，只在超时/上游取消时 abort） */
  readonly signal: AbortSignal;
  /** 有进展 —— 重新上弦（`idleMs <= 0` 时为空操作） */
  pulse(): void;
  /** 停止计时并释放（不 abort） */
  dispose(): void;
  /** 本次空闲窗口的时长，便于日志与文案 */
  readonly idleMs: number;
  /** 是否因为空闲而触发 */
  timedOut(): boolean;
}

/** 中止原因里携带的标记（对齐 DSH 的 capability-owned code） */
export class IdleTimeoutError extends Error {
  constructor(
    readonly code: string,
    readonly idleMs: number,
  ) {
    super(`${code} after ${idleMs}ms idle`);
    this.name = "IdleTimeoutError";
  }
}

/** 从 abort reason 里取回空闲超时的标记（对齐 DSH 的 `timeoutOf`） */
export function idleTimeoutOf(signalOrReason: unknown, code?: string): IdleTimeoutError | undefined {
  const reason =
    signalOrReason && typeof signalOrReason === "object" && "reason" in (signalOrReason as any)
      ? (signalOrReason as AbortSignal).reason
      : signalOrReason;
  if (reason instanceof IdleTimeoutError && (code === undefined || reason.code === code)) return reason;
  return undefined;
}

/**
 * 创建空闲看门狗。
 *
 * @param upstream 上游取消信号（与看门狗信号融合；上游 abort 时同样中止）
 * @param idleMs   空闲窗口（毫秒）。**`<= 0` 表示不设空闲上限**（对齐 DSH 的 `timeoutMs <= 0` 语义）
 * @param code     能力自己的错误码（日志/文案里区分是谁超时）
 */
export function idleWatchdog(upstream: AbortSignal | undefined, idleMs: number, code: string): IdleWatchdog {
  const controller = new AbortController();
  const signal = upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let fired = false;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  /** 上弦：仅在"看门狗还没响、还没释放、空闲窗口为正"时计时 */
  const arm = () => {
    if (disposed || fired || idleMs <= 0) return;
    clear();
    timer = setTimeout(() => {
      fired = true;
      controller.abort(new IdleTimeoutError(code, idleMs));
    }, idleMs);
    // 后台计时器不应把进程钉住（Node 语义；浏览器里是空操作）
    (timer as any)?.unref?.();
  };

  arm();

  return {
    signal,
    idleMs,
    pulse() {
      if (disposed || fired) return;
      arm();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
    },
    timedOut() {
      return fired;
    },
  };
}

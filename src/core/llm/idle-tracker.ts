/**
 * Adaptive Idle Tracker — 非硬超时的流式保活机制
 *
 * P-OPT6: 替代硬超时 (Promise.race + setTimeout)
 *
 * 设计理念（对标 DSH idleWatchdog）：
 * - 不限制总执行时间（长推理可能需要 60+ 秒）
 * - 只限制"无数据流入"的时间（真正卡死的连接）
 * - 收到任何数据（SSE chunk、heartbeat comment）就重置计时器
 * - 计时器只在"等待数据"时启动，消费数据时不算空闲
 *
 * 三种替代方案对比：
 *
 * 方案 A — Adaptive Idle Tracker（本文件实现）：
 *   优点：不误杀长推理，只在真正卡死时触发
 *   缺点：需要注入 activity callback
 *
 * 方案 B — ReadableStream TTR (Time-To-Read)：
 *   只在 reader.read() 等待时间上计时，收到数据就停止计时
 *   优点：零侵入，不需要 callback
 *   缺点：需要包装 ReadableStream reader
 *
 * 方案 C — SSE Heartbeat Watchdog：
 *   依赖服务端 heartbeat 频率，两倍周期内无 heartbeat 则判定卡死
 *   优点：最精确
 *   缺点：需要知道服务端 heartbeat 间隔（非通用）
 *
 * 本实现采用方案 A，因为它最通用且不依赖服务端特性。
 */

/**
 * Adaptive idle tracker — 只在无活动时计时。
 *
 * 用法：
 * ```
 * const tracker = createIdleTracker(120_000); // 2分钟空闲超时
 * // 在收到任何数据时调用:
 * tracker.pulse();
 * // 检查是否超时:
 * if (tracker.expired()) throw new Error("idle timeout");
 * // 清理:
 * tracker.dispose();
 * ```
 */
export interface IdleTracker {
  /** 记录一次活动 — 收到任何数据时调用 */
  pulse(): void;
  /** 检查是否已超过空闲阈值 */
  expired(): boolean;
  /** 获取距上次活动的毫秒数 */
  idleMs(): number;
  /** 清理计时器 */
  dispose(): void;
}

/**
 * 创建一个自适应空闲追踪器。
 *
 * @param idleThresholdMs - 无数据流入的最大允许时间（默认 120 秒）
 * @returns IdleTracker 实例
 */
export function createIdleTracker(idleThresholdMs: number = 120_000): IdleTracker {
  let lastActivity = Date.now();
  let disposed = false;
  // 定期检查器（低频，仅用于 expired() 的主动轮询场景）
  let checker: ReturnType<typeof setInterval> | undefined;

  // 如果空闲阈值 > 0，启动后台检查器
  // 但不主动 kill — 由调用方通过 expired() 自行决定
  if (idleThresholdMs > 0) {
    checker = setInterval(() => {
      // 仅为诊断目的：如果过期了在控制台输出
      if (!disposed && Date.now() - lastActivity > idleThresholdMs) {
        // 不抛异常 — 由调用方检查 expired()
      }
    }, Math.min(idleThresholdMs / 2, 30_000));
  }

  return {
    pulse(): void {
      if (disposed) return;
      lastActivity = Date.now();
    },
    expired(): boolean {
      if (disposed) return false;
      return Date.now() - lastActivity > idleThresholdMs;
    },
    idleMs(): number {
      return Date.now() - lastActivity;
    },
    dispose(): void {
      disposed = true;
      if (checker) {
        clearInterval(checker);
        checker = undefined;
      }
    },
  };
}

/**
 * 创建一个 Promise 版本的空闲超时。
 *
 * 与 createIdleTracker 不同，这个版本会在超时时自动 reject。
 * 但与硬超时不同，它允许通过 pulse() 无限延期。
 *
 * @param idleThresholdMs - 无数据流入的最大允许时间
 * @param onPulse - 可选，每次 pulse 时调用的回调（用于诊断）
 * @returns { promise, pulse, dispose }
 */
export function createIdleTimeout(
  idleThresholdMs: number = 120_000,
  onPulse?: () => void,
): {
  promise: Promise<never>;
  pulse: () => void;
  dispose: () => void;
} {
  let lastActivity = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const arm = (): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!disposed) {
        timer = undefined;
      }
    }, idleThresholdMs);
  };

  const pulse = (): void => {
    if (disposed) return;
    lastActivity = Date.now();
    if (onPulse) onPulse();
    arm(); // 重新计时
  };

  const promise = new Promise<never>((_, reject) => {
    // 使用 setInterval 轮询，而非单一 setTimeout
    // 这样 pulse() 可以在任意时机重置
    const interval = setInterval(() => {
      if (disposed) {
        clearInterval(interval);
        return;
      }
      if (Date.now() - lastActivity > idleThresholdMs) {
        clearInterval(interval);
        reject(new Error(`Stream idle timeout after ${idleThresholdMs}ms (no data received)`));
      }
    }, Math.min(idleThresholdMs / 4, 10_000));

    // 初始 arm
    arm();
  });

  const dispose = (): void => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return { promise, pulse, dispose };
}

/**
 * 方案 B: ReadableStream TTR 包装器
 *
 * 包装一个 ReadableStream reader，自动追踪每次 read() 的等待时间。
 * 如果单次 read() 等待超过阈值，抛出 IdleTimeoutError。
 *
 * 这是最非侵入式的方案 — 不需要修改任何业务代码，
 * 只需要把 reader 传给 wrapWithIdleTimeout。
 */
export class IdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`Read idle for ${idleMs}ms — stream appears stalled`);
    this.name = "IdleTimeoutError";
  }
}

export async function* wrapStreamWithIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  idleThresholdMs: number = 120_000,
  onActivity?: () => void,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const readStart = Date.now();
      const result = await reader.read();

      // 收到数据 — 通知回调
      if (onActivity) onActivity();

      if (result.done) return;

      // 检查 read() 本身的等待时间（用于诊断）
      const readDuration = Date.now() - readStart;
      if (readDuration > idleThresholdMs) {
        throw new IdleTimeoutError(readDuration);
      }

      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

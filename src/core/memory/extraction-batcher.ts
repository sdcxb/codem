/**
 * 记忆提取的**空闲批次调度器**（24 号文 §P0-3：不要每回合立即跑）。
 *
 * ## 被守的形态
 *
 * `onTurnComplete` 是**每一轮**都调的。旧实现每轮立刻发一次提取请求（再由"至少新增 4 条"
 * 的限频门挡一部分），用户侧看到的是"刚聊完就有人在后台读我的对话"，成本也高。
 * 现在回合结束只是**排一个延迟批次**：计时到、且会话**确实还有新消息**才真的跑。
 *
 * ## 语义（三条判据钉住）
 *
 * 1. **首次排期优先**：同一个会话在计时窗口内再次触发**不重置**计时器
 *    （否则连续说话会让提取永远不被调度 —— 那等于关掉了提取）；
 * 2. **触发前再查一次**：计时器到点时调用 `hasNewMessages`；没有新消息就**什么都不做**
 *    （不空跑一次模型调用）。这一步也覆盖"会话被清空/消息被删"的形态；
 * 3. **关闭会话取消**：`cancel()` 清掉计时器；`pending` 表是唯一真相 ——
 *    即使平台把已取消计时器的回调排进了队列，`fire()` 找不到排期就直接返回。
 *
 * ## 为什么时钟/计时器可注入
 *
 * 判据不能靠 sleep（30 秒起步）—— 注入 `now` / `setTimer` / `clearTimer` 之后，
 * "前进 30 秒才跑"是确定性的（`advance(30_000)` 即触发），不依赖墙钟。
 */
import { EXTRACTION_IDLE_DELAY_MAX_MS, EXTRACTION_IDLE_DELAY_MIN_MS } from "./extraction-delay";

export interface MemoryExtractionBatcherOptions {
  /**
   * 延迟毫秒（默认由引擎给 `EXTRACTION_IDLE_DELAY_MIN_MS`）。
   *
   * 允许函数是为了"测试注入 0"与"运行时读设置"两条路共用一个入口；
   * 生产路径不接受 < 30s 的值（见 `normalizeExtractionIdleDelay`），
   * 只有测试 seam（`setMemoryExtractionIdleDelay`）能传 0。
   */
  delayMs: number | (() => number);
  /** 到点后是否还有新消息（引擎用游标判定；抛错按"没有新消息"处理，不空跑） */
  hasNewMessages: (sessionId: string) => boolean;
  /** 真的跑一次提取（引擎实现；错误由它自己收口） */
  run: (sessionId: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  warn?: (message: string) => void;
}

interface PendingBatch {
  handle: unknown;
  dueAt: number;
  /** 到点后要用的归属项目（会话级记忆写入身份；最后一次触发为准） */
  projectId?: string;
}

/**
 * 生产档位：30–120 秒（24 §P0-3 的原话「例如 30–120 秒」）。
 *
 * **0 是判据专用的压平档**（`setMemoryExtractionIdleDelay(0)`）：它让计时器走
 * `setTimeout(0)`，既有集成判据不必真的等 30 秒。生产路径没有调用方会传 0
 * （默认值就是 `EXTRACTION_IDLE_DELAY_MIN_MS` = 30s），所以这不构成"退化成每回合立即跑"的后门。
 */
export function normalizeExtractionIdleDelay(ms: number): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return EXTRACTION_IDLE_DELAY_MIN_MS;
  if (n <= 0) return 0;
  return Math.min(EXTRACTION_IDLE_DELAY_MAX_MS, Math.max(EXTRACTION_IDLE_DELAY_MIN_MS, Math.floor(n)));
}

export class MemoryExtractionBatcher {
  private readonly pending = new Map<string, PendingBatch>();

  constructor(private readonly options: MemoryExtractionBatcherOptions) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.options.setTimer) return this.options.setTimer(fn, ms);
    const handle = setTimeout(fn, ms);
    /**
     * Node（判据环境）里 `unref()` 让"还没到点的后台批次"**不阻塞进程退出**：
     * 否则每个引擎实例都会留一个 30–120s 的活计时器，测试进程要等它（或被强杀）才退。
     * 浏览器 / Electron 渲染侧的 `setTimeout` 返回 number（没有 unref）⇒ 这一步自然跳过。
     */
    try {
      (handle as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* 拿不到 unref 不影响调度（只是进程退出晚一点） */
    }
    return handle;
  }

  private clearTimer(handle: unknown): void {
    if (this.options.clearTimer) this.options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private warn(message: string): void {
    if (this.options.warn) this.options.warn(message);
    else console.warn(`[memory-extraction-batch] ${message}`);
  }

  /** 当前是否已有排期待跑的批次（诊断/判据用） */
  isScheduled(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** 排期中的会话数（诊断用） */
  pendingCount(): number {
    return this.pending.size;
  }

  /** 该会话的到期时刻（毫秒时间戳；没有排期时为 `null`） */
  dueAt(sessionId: string): number | null {
    return this.pending.get(sessionId)?.dueAt ?? null;
  }

  /**
   * 排一个批次。
   *
   * - 已有排期 ⇒ **不重置计时器**（首次排期优先），只更新归属项目；
   * - `delayMs` 解析失败 ⇒ 用下限（不排 0 秒，避免退化成"每回合立即跑"）。
   *
   * @returns 是否新建了排期（`false` = 已有排期，这次只是合并进来）
   */
  schedule(sessionId: string, projectId?: string): boolean {
    if (!sessionId) return false;
    const existing = this.pending.get(sessionId);
    if (existing) {
      if (projectId !== undefined) existing.projectId = projectId;
      return false;
    }
    const resolved = typeof this.options.delayMs === "function" ? this.options.delayMs() : this.options.delayMs;
    const delay = normalizeExtractionIdleDelay(resolved);
    const entry: PendingBatch = { handle: undefined, dueAt: this.now() + delay, projectId };
    entry.handle = this.setTimer(() => this.fire(sessionId), delay);
    this.pending.set(sessionId, entry);
    return true;
  }

  /**
   * 取消某会话的排期（关闭/删除会话时调）。
   *
   * @returns 是否真的取消了一个排期（`false` = 此刻没有排期，调用方不必当失败）
   */
  cancel(sessionId: string): boolean {
    if (!sessionId) return false;
    const entry = this.pending.get(sessionId);
    if (!entry) return false;
    this.pending.delete(sessionId);
    this.clearTimer(entry.handle);
    return true;
  }

  /** 取消全部排期（进程退出/测试收尾用） */
  cancelAll(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.cancel(id);
    return ids.length;
  }

  /** 计时器到点：先确认没被取消、也确实还有新消息，再跑 */
  private fire(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return; // 已被 cancel（或已经跑过一次）
    this.pending.delete(sessionId);
    let hasNew = false;
    try {
      hasNew = this.options.hasNewMessages(sessionId);
    } catch (e) {
      this.warn(
        `会话 ${sessionId} 的批次到点检查新消息失败（本批跳过，下回合会再排）：` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    if (!hasNew) return;
    try {
      this.options.run(sessionId);
    } catch (e) {
      this.warn(
        `会话 ${sessionId} 的空闲提取批次启动失败（下回合会再排）：` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

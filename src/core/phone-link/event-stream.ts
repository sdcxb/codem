/**
 * 手机事件流（阶段 2）—— 把"轮询"换成"推"。
 *
 * ## 为什么不用 SSE/WebSocket，而是**长轮询**
 *
 * 最自然的做法是 SSE：桌面推、手机收。但我们的链路有两条，而其中之一**不支持流式**：
 *
 * - **LAN 边缘**这条路是直连 HTTPS，SSE 可行；
 * - **中继**那条路是**纯隧道**（`tools/relay/codem-relay.mjs` 只做"请求→应答"），
 *   一个长活的流式响应会被隧道的超时逻辑掐掉。
 *
 * 与其维护两套推送机制（一套只在一半场景可用，必然分叉），不如选**一条两条路都能走**的：
 * 客户端发 `GET /api/events?since=N&wait=10000`，服务端**挂住**这个请求，
 * 有事件就立刻回，没事件就等到超时回空。这在链路上仍然是一次普通的请求→应答，
 * 但对客户端的效果是"变化几乎立刻可见，没有变化时一个包都不用发"。
 *
 * ## 挂起时间必须**小于**上游的代理超时（这是硬约束）
 *
 * Rust 侧转发到渲染进程等的是 `PROXY_TIMEOUT = 15s`（`phone/mod.rs:988`）——
 * 我们挂得比它久，客户端拿到的就是 **504 而不是事件**，而且会表现为"偶尔整批丢失"。
 * 所以 `EVENT_WAIT_MAX_MS` 取 10s，留出余量。中继侧 30s、上游 25s 都比它宽，不是瓶颈。
 *
 * ## 对标 DSH 的同步模型（`sync.subscribe` / `sync.ack` / 检查点）
 *
 * DSH 的同步有几条经验我们直接照抄：
 *
 * 1. **序号 + 检查点**：客户端回报"我处理到哪了"（DSH 是 `ack` 带 checkpoint）。
 *    我们让客户端带 `since=<seq>`，等价且更简单（HTTP 无状态）。
 * 2. **检查点不可用时必须明说，不许静默跳过** —— 这是 DSH 里最要紧的一条：
 *    它「**不复用旧版本的检查点**」，宁可重来也不让"旧映射长期留在历史里"。
 *    我们对应的是：若客户端要的 `since` 比环形缓冲里最老的事件还老，
 *    说明中间的事件**已经被丢弃**，此时回 `reset: true` 让客户端**整批重取**，
 *    而不是从现有缓冲里挑几条给它（那会让客户端永久缺一段而不自知）。
 * 3. **分页与预算**：DSH 有"每帧最多 1000 项 / 7 MiB"。我们按 **200 项 / 256 KiB**，
 *    并回 `hasMore` 让客户端继续取 —— 移动网络下"一次拉太多"比"多拉几次"更糟。
 * 4. **每页有寿命**：DSH `PAGE_LIFETIME = 120_000`。我们的寿命就是"长轮询挂起的那 10 秒"。
 *
 * ## 载荷策略：小的内联，大的只给提示
 *
 * `approval` / `run` 这类状态很小，直接内联进事件，客户端不必再发请求；
 * `messages` / `sessions` 可能很大，事件只带**提示**（哪个会话变了），
 * 客户端收到后再去取实际数据。这样推送通道永远很小，也不会与既有的取数路径分叉。
 */

/** 事件类型。`sessionId` 缺省表示"全局事件"（任何会话的订阅都该被唤醒）。 */
export type PhoneEventType = "sessions" | "messages" | "approval" | "run" | "presence";

interface PhoneEvent {
  seq: number;
  type: PhoneEventType;
  /** 缺省 = 全局（例如会话说列表变了） */
  sessionId?: string;
  at: number;
  /** 小载荷内联；大载荷留空，客户端收到提示后自己去取 */
  payload?: unknown;
}

export interface EventBatch {
  events: PhoneEvent[];
  /** 客户端下次该带的 `since` */
  nextSeq: number;
  /** 还有更多（受条数/字节预算限制） */
  hasMore: boolean;
  /**
   * **检查点失效**：客户端要的那一段已经不在缓冲里了。
   * 此时 `events` 必为空，客户端必须**丢掉本地状态整批重取**。
   */
  reset: boolean;
  /** 缓冲里最老的序号（诊断用；也方便界面说明"我们只能从这里开始"） */
  oldestSeq: number;
}

/** 环形缓冲上限（条）。够覆盖一次断线重连，又不至于吃内存。 */
export const EVENT_RING_MAX = 500;
/** 单次返回的最大条数（对齐 DSH"每帧有上限"的思路）。 */
export const EVENT_BATCH_MAX_ITEMS = 200;
/** 单次返回的最大字节数（移动网络下，一次拉太多比多拉几次更糟）。 */
export const EVENT_BATCH_MAX_BYTES = 256 * 1024;
/** 长轮询最长挂起（**必须**小于 `PROXY_TIMEOUT` 15s，见文件头）。 */
export const EVENT_WAIT_MAX_MS = 10_000;
/** 默认挂起时间。 */
export const EVENT_WAIT_DEFAULT_MS = 10_000;

let seqCounter = 0;
let ring: PhoneEvent[] = [];
/** 缓冲里最老的序号（ring 为空时 = seqCounter + 1，表示"没有被丢弃的"） */
let oldestSeq = 1;

interface Waiter {
  sessionId?: string;
  since: number;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const waiters = new Set<Waiter>();

function jsonBytes(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** 事件是否与某个订阅（可选 sessionId）相关。 */
function matches(ev: PhoneEvent, sessionId?: string): boolean {
  // 全局事件对所有订阅都相关；会话事件只对该会话相关
  return ev.sessionId === undefined || sessionId === undefined || ev.sessionId === sessionId;
}

/**
 * 发一个事件。返回它的序号。
 *
 * @param type      事件类型
 * @param sessionId 相关会话；缺省 = 全局（会话说列表变化这类）
 * @param payload   小载荷（`approval`/`run` 用）；大载荷留空只做提示
 */
export function emitPhoneEvent(
  type: PhoneEventType,
  sessionId?: string,
  payload?: unknown,
): number {
  const seq = ++seqCounter;
  const ev: PhoneEvent = {
    seq,
    type,
    ...(sessionId ? { sessionId } : {}),
    at: Date.now(),
    ...(payload === undefined ? {} : { payload }),
  };
  ring.push(ev);
  // 有界：丢最老的，并记住"从这里之前都不可用了"
  while (ring.length > EVENT_RING_MAX) {
    const dropped = ring.shift();
    if (dropped) oldestSeq = dropped.seq + 1;
  }
  // 唤醒相关等待者（**只唤醒相关的**：不相关会话的变更不该打断这个订阅的等待）
  for (const w of [...waiters]) {
    if (ev.seq > w.since && matches(ev, w.sessionId)) {
      clearTimeout(w.timer);
      waiters.delete(w);
      w.resolve();
    }
  }
  return seq;
}

/**
 * 取 `since` 之后的事件（不挂起）。
 *
 * 关键语义：**若 `since` 早于缓冲里最老的事件，说明中间有一段已经被丢弃** ——
 * 此时回 `reset: true` 且不带事件，让客户端整批重取。
 * 绝不做"把现有缓冲里剩下的给你"这种事：那会让客户端**永久缺一段而不自知**。
 */
export function eventsSince(
  since: number,
  sessionId?: string,
  budget: { maxItems?: number; maxBytes?: number } = {},
): EventBatch {
  const maxItems = Math.max(1, budget.maxItems ?? EVENT_BATCH_MAX_ITEMS);
  const maxBytes = Math.max(1024, budget.maxBytes ?? EVENT_BATCH_MAX_BYTES);
  const s = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;

  // 检查点失效判定：缓冲里最老的都比 s+1 还新 ⇒ 中间被丢过
  const earliestAvailable = ring.length > 0 ? ring[0].seq : seqCounter + 1;
  if (s + 1 < earliestAvailable) {
    return { events: [], nextSeq: s, hasMore: false, reset: true, oldestSeq: earliestAvailable };
  }

  const out: PhoneEvent[] = [];
  let bytes = 0;
  let hasMore = false;
  for (const ev of ring) {
    if (ev.seq <= s) continue;
    if (!matches(ev, sessionId)) continue;
    const b = jsonBytes(ev);
    if (out.length >= maxItems || bytes + b > maxBytes) {
      hasMore = true;
      break;
    }
    out.push(ev);
    bytes += b;
  }
  const nextSeq = out.length > 0 ? out[out.length - 1].seq : s;
  return { events: out, nextSeq, hasMore, reset: false, oldestSeq: earliestAvailable };
}

/**
 * 长轮询：有事件立刻回；没有就等到 `waitMs`（上限 `EVENT_WAIT_MAX_MS`）后回空。
 *
 * 为什么必须有上限而不是"等到有为止"：链路每一跳都有超时（Rust 代理 15s、
 * 上游 25s、中继 30s）。挂得比最短的那一跳还久，客户端拿到的是**超时**，
 * 而超时与"暂时没有事件"在客户端看来是一样的 —— 于是要么白等、要么疯狂重连。
 */
export function waitPhoneEvents(
  since: number,
  sessionId: string | undefined,
  waitMs: number = EVENT_WAIT_DEFAULT_MS,
  budget: { maxItems?: number; maxBytes?: number } = {},
): Promise<EventBatch> {
  const immediate = eventsSince(since, sessionId, budget);
  if (immediate.reset || immediate.events.length > 0 || immediate.hasMore) {
    return Promise.resolve(immediate);
  }
  const capped = Math.max(0, Math.min(EVENT_WAIT_MAX_MS, Math.floor(waitMs)));
  if (capped === 0) return Promise.resolve(immediate);
  return new Promise<EventBatch>((resolve) => {
    const w: Waiter = {
      sessionId,
      since,
      resolve: () => {
        // 醒来后正常取；若期间发生了丢弃，这里会如实回 reset
        resolve(eventsSince(since, sessionId, budget));
      },
      timer: setTimeout(() => {
        waiters.delete(w);
        resolve(eventsSince(since, sessionId, budget));
      }, capped),
    };
    waiters.add(w);
  });
}

/** 当前等待中的订阅数（诊断用）。 */
export function pendingWaiters(): number {
  return waiters.size;
}

/** 当前序号（诊断/判据用）。 */
export function currentSeq(): number {
  return seqCounter;
}

/** 测试用：清空。 */
export function __resetPhoneEventsForTests(): void {
  for (const w of waiters) clearTimeout(w.timer);
  waiters.clear();
  ring = [];
  seqCounter = 0;
  oldestSeq = 1;
}

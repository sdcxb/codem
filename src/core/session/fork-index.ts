/**
 * 「窗口内下标」→「会话内绝对下标」的换算（第 47 轮补，功能上下文审计 **P0**）。
 *
 * ## 为什么必须有一个专门的换算函数
 *
 * UI 展示的消息列表**不是整个会话的历史**：`loadMessages` 只装载**最后 10 条**
 * （`src/store.ts` 的 `INITIAL_LIMIT`），向上滚动时才按批**前插**更旧的
 * （`loadMoreMessages`）。而 `ChatPanel` 传给 `onFork` 的 `origIndex` 是
 * **这份窗口里的下标**。
 *
 * 下游的 `store.forkSession(sourceId, messageIndex)` 拿这个数当**会话内绝对下标**
 * 去 `MessageStorage.listMessages()`（全量会话）里切片。于是真机形态是：
 *
 * ```text
 * 一个 100 条的会话里，点最后一轮的分叉
 *   → 窗口下标 9
 *   → forkSession 从全量列表第 0 条切到第 10 条
 *   → 子会话里的内容是**会话开头那 10 条**，而不是分叉点之前的 100 条
 * ```
 *
 * 静默、无报错，而且**短会话（≤10 条）下完全正常** —— 这正是它一直没被发现的原因
 * （既有用例传的都是绝对值）。
 *
 * ## 换算方式：数出"窗口首条之前还有多少条历史"
 *
 * 判据落在**窗口首条这条消息本身**（按 timestamp 比较），而不是"用总数减窗口长度"：
 * 后者在"中途删除过消息"或"窗口不是从 0 开始的整块"时会算错，
 * 而"比窗口首条更旧的还有几条"是这个问题的**定义**，不受那两种情况影响。
 *
 * 同时天然覆盖两种截断来源：
 * 1. `loadMessages` 的初始窗口截断（一次丢掉最旧的 N 条）；
 * 2. `loadMoreMessages` 的前插分页（补回一批，窗口首条跟着往前移）。
 *
 * ## 失败处置
 *
 * 读不到全量列表（端口未就绪）或找不到窗口首条时，**返回原下标**（保守：宁可保持
 * 旧行为，也不猜一个更大的数 —— 猜大 = 多复制用户以为已经排除掉的内容）。
 */

/** 只要 `id` 与 `timestamp`，这样既能喂 `Message` 也能喂测试夹具 */
export interface IndexAnchor {
  id: string;
  timestamp: number;
}

export interface ResolveForkIndexResult {
  /** 换算结果（会话内绝对下标） */
  absoluteIndex: number;
  /** 窗口首条在会话里的绝对位置；`-1` = 找不到（换算失败或无窗口） */
  windowStartAbsoluteIndex: number;
  /** 窗口首条之前被截断掉的历史条数（= 换算的偏移量） */
  offset: number;
  /** 是否真的做了换算（用于日志/诊断：`false` 表示沿用了原下标） */
  shifted: boolean;
}

/**
 * 把"窗口内下标"换算成"会话内绝对下标"。
 *
 * @param sessionId 会话 id（用于读全量历史）
 * @param windowIndex UI 传来的窗口内下标
 * @param window 当前窗口里的消息（按显示顺序）；缺省时由调用方从 store 取
 * @param listAll 读全量历史的函数（注入以便测试；生产传 `MessageStorage.listMessages`）
 */
export function resolveSessionAbsoluteIndex(
  sessionId: string,
  windowIndex: number,
  window: readonly IndexAnchor[],
  listAll: (sessionId: string) => readonly IndexAnchor[],
): ResolveForkIndexResult {
  const safeIndex = Math.max(windowIndex, 0);
  const fallback: ResolveForkIndexResult = {
    absoluteIndex: safeIndex,
    windowStartAbsoluteIndex: -1,
    offset: 0,
    shifted: false,
  };

  const anchor = window[0];
  if (!anchor) return fallback;

  let all: readonly IndexAnchor[];
  try {
    all = listAll(sessionId);
  } catch {
    return fallback;
  }
  if (all.length === 0) return fallback;

  // 数出"比窗口首条更旧的还有几条" —— 这就是偏移量
  let offset = 0;
  for (const m of all) {
    if (m.timestamp < anchor.timestamp) offset += 1;
  }
  const absoluteIndex = offset + safeIndex;

  /*
   * 夹取：绝对下标不许越过全量长度（`forkSession` 自己也会夹，但在这里夹住更早暴露错误）。
   */
  const clamped = Math.min(absoluteIndex, all.length);

  return {
    absoluteIndex: clamped,
    windowStartAbsoluteIndex: offset,
    offset,
    shifted: clamped !== safeIndex,
  };
}

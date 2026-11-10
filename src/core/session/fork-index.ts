import { listDisplayMessages } from "../storage/message";

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
 * 去 `MessageStorage.listDisplayMessages()`（全量会话；P0-0 起与模型投影分开）里切片。
 * 于是真机形态是：
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
 * ## ⚠️ P0-0（D11）：定位优先用**消息 id**，不用"时间戳偏移 + 窗口下标"
 *
 * 后者假设"窗口是 `all` 的连续后缀"。改造前两边都是 `listMessages`，这个假设成立；
 * P0-0 之后窗口仍是模型投影、`all` 变成 DisplayView —— **不再是同一序列**
 * （marker 被挪到最前、hidden 行只在 DisplayView、换段后投影少一整段）。
 * 只有被点消息的 id 在两份数据里都稳定，所以 `resolveSessionAbsoluteIndex`
 * 先按 id 定位，定位不到才回退到时间戳算法。
 *
 * ## 失败处置
 *
 * 读不到全量列表（端口未就绪）或找不到窗口首条时，**返回原下标**（保守：宁可保持
 * 旧行为，也不猜一个更大的数 —— 猜大 = 多复制用户以为已经排除掉的内容）。
 *
 * ## ⚠️ P0-0（D11）：`listAll` 必须是 DisplayView
 *
 * 会话换过段（`kind="switch"` epoch）时，模型投影只有最新段。用它数偏移量会让
 * 两个列表的下标空间不一致 ⇒ 分叉点被往前挪。生产路径一律走
 * `resolveForkIndexForSession`（下面），它注入的就是 `listDisplayMessages`。
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
 * 会话级入口：用**DisplayView**（而不是模型投影）作为「全量会话」。
 *
 * ## 为什么不能注入 `listMessages`
 *
 * 分叉的切片发生在 `store.forkSession` 里，它现在读 `listDisplayMessages`（P0-0 / D11）。
 * 如果这里仍用 `listMessages`（投影视图）数偏移量，两个列表的**下标空间**就不一致：
 *
 * - 换过段的会话里，投影视图只有最新段 ⇒ 偏移量算小 ⇒ 分叉点被**往前挪**；
 * - 表现是「点最后一轮分叉，子会话少了换段前的内容」，静默无报错。
 *
 * 所以「读全量」这件事必须与「切片」用同一个函数。这条不是可选项：
 * 两侧一旦分叉，分叉功能在最需要它的长会话上正好是坏的。
 */
export function resolveForkIndexForSession(
  sessionId: string,
  windowIndex: number,
  window: readonly IndexAnchor[],
): ResolveForkIndexResult {
  return resolveSessionAbsoluteIndex(sessionId, windowIndex, window, (sid) => listDisplayMessages(sid));
}
/**
 * 把"窗口内下标"换算成"会话内绝对下标"（纯函数，注入 `listAll` 便于测试）。
 *
 * @param sessionId 会话 id（用于读全量历史）
 * @param windowIndex UI 传来的窗口内下标
 * @param window 当前窗口里的消息（按显示顺序）；缺省时由调用方从 store 取
 * @param listAll 读全量历史的函数；生产请用 `resolveForkIndexForSession`
 *               （它注入 DisplayView，与 `forkSession` 的切片空间一致）
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

  /**
   * ## ① 首选：按**被点消息的 id** 在 `all` 里定位（P0-0 / D11，复核 2 抓出的二层缺陷）
   *
   * 为什么"比窗口首条更旧的条数 + 窗口下标"不够：那个算法假设
   * **窗口是 `all` 的连续后缀**。这在改造前成立（窗口与全量都是 `listMessages`），
   * 但 P0-0 之后生产窗口仍来自 `listMessages`（模型投影），而 `all` 是
   * `listDisplayMessages`（DisplayView）—— 两者**不是同一序列**：
   *
   * - marker 在时间线上位于某个位置，投影却把它**挪到最前**；
   * - hidden 行只出现在 DisplayView；
   * - 换段后投影还少一整段。
   *
   * 于是"数时间戳"会指到错误的消息（实测：点 m3，算出来是 m4）。
   * id 是这两份数据里**唯一稳定的锚**（消息 id 全局唯一、分叉会换新但源侧不变）。
   */
  const clicked = window[safeIndex];
  if (clicked) {
    const clickedIndex = all.findIndex((m) => m.id === clicked.id);
    if (clickedIndex >= 0) {
      const startIndex = all.findIndex((m) => m.id === anchor.id);
      return {
        absoluteIndex: clickedIndex,
        windowStartAbsoluteIndex: startIndex,
        offset: startIndex >= 0 ? startIndex : Math.max(0, clickedIndex - safeIndex),
        shifted: clickedIndex !== safeIndex,
      };
    }
  }

  /**
   * ## ② 回退：窗口里的消息不在全量列表里（陈旧窗口 / 消息已被删）
   *
   * 只能按旧的 timestamp 偏移算 —— 这是保守降级，不是首选路径。
   */
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

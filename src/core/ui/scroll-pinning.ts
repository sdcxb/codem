/**
 * 流式滚动的「图钉」判定 —— 纯函数，便于判据直接测（不依赖布局引擎）。
 *
 * ## 为什么需要它（对标 open-claude-ui 的滚动物理学）
 *
 * 我们原来只有"底部 / 近底 / 已滚开"三档分类（`store.scrollPosition`），缺三件事：
 *
 * 1. **用户输入冷却**：用户刚用滚轮/触摸/键盘滚过，紧接着流式 token 追加进来，
 *    自动滚动会立刻把视口拽回底部 —— 用户看到的"我刚滚上去又被弹回来"就是这个；
 *    对标实现用 **150ms 冷却窗口**（`performance.now() - lastUserInputAt > 150`）。
 * 2. **流式期用 `behavior:"auto"`**：`smooth` 动画与流式追加互相拉扯，在高频追加时
 *    会出现"永远追不上、一直在滚"的观感；瞬时对齐反而稳定。
 * 3. **贴底容差 40px**：用户停在离底部 20px 的位置，语义上就是"我在看最新"。
 *
 * 判据 `SCROLLPIN-1..4`。
 */

/** 贴底容差（px）：离底 ≤ 这个值视为"用户在看最新" */
export const SCROLL_PIN_TOLERANCE_PX = 40;
/** 用户输入冷却（ms）：刚滚过就不抢视口 */
export const SCROLL_USER_INPUT_COOLDOWN_MS = 150;

export interface AutoScrollDecisionInput {
  /** 离底距离（px）；容器不可用时传 0（视为贴底） */
  distanceFromBottom: number;
  /** 距上一次"用户主动滚动"过去了多少毫秒（没有记录时传 Infinity） */
  msSinceUserInput: number;
  /** 当前是否在流式输出 */
  streaming: boolean;
  /** 分类结果（来自 store）；缺省时按 distanceFromBottom 判定 */
  isPinned?: boolean;
}

export interface AutoScrollDecision {
  /** 是否应当把视口滚到底 */
  scroll: boolean;
  /** 滚动行为：流式期一律 `auto`（瞬时对齐），非流式才允许 `smooth` */
  behavior: "auto" | "smooth";
}

/** 是否算"贴底" */
export function isNearBottom(distanceFromBottom: number, tolerance = SCROLL_PIN_TOLERANCE_PX): boolean {
  return distanceFromBottom <= tolerance;
}

/**
 * 决定这条新消息（或这次 token 追加）要不要把视口滚到底。
 *
 * 顺序有意义：
 * ① 用户不在底部 ⇒ **绝不滚**（哪怕刚发生输入，也不能抢）；
 * ② 刚滚过（≤150ms）⇒ 不滚（冷却窗口）；
 * ③ 其余情况滚：流式用 auto，非流式用 smooth。
 */
export function decideAutoScroll(input: AutoScrollDecisionInput): AutoScrollDecision {
  const pinned = input.isPinned ?? isNearBottom(input.distanceFromBottom);
  if (!pinned) return { scroll: false, behavior: "auto" };
  if (input.msSinceUserInput <= SCROLL_USER_INPUT_COOLDOWN_MS) return { scroll: false, behavior: "auto" };
  return { scroll: true, behavior: input.streaming ? "auto" : "smooth" };
}

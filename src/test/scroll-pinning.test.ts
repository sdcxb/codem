/**
 * SCROLLPIN：流式滚动的「图钉」判定。
 *
 * ## 对标的差距（open-claude-ui 的滚动物理学）
 *
 * 我们原来只有 `store.scrollPosition` 的分类，缺三件事：
 * ① 用户刚滚过时**不抢视口**（150ms 冷却）；
 * ② 流式追加用 `behavior:"auto"` 瞬时对齐（`smooth` 会和追加互相拉扯）；
 * ③ 贴底容差 40px（"我在看最新"的语义边界）。
 *
 * 这些是纯判定，所以直接测纯函数 —— 比在 jsdom 里伪造滚动布局可靠得多
 * （happy-dom 没有布局引擎，`scrollHeight` 恒 0，测不出真实滚动）。
 */
import { describe, it, expect } from "vitest";
import {
  decideAutoScroll,
  isNearBottom,
  SCROLL_PIN_TOLERANCE_PX,
  SCROLL_USER_INPUT_COOLDOWN_MS,
} from "../core/ui/scroll-pinning";

describe("SCROLLPIN 流式滚动图钉", () => {
  it("SCROLLPIN-1: 贴底容差 40px（含边界）", () => {
    expect(SCROLL_PIN_TOLERANCE_PX).toBe(40);
    expect(isNearBottom(0)).toBe(true);
    expect(isNearBottom(40)).toBe(true);
    expect(isNearBottom(41)).toBe(false);
  });

  it("SCROLLPIN-2: 用户在底部 + 没有刚滚过 ⇒ 滚；流式期用 auto，非流式 smooth", () => {
    expect(
      decideAutoScroll({ distanceFromBottom: 10, msSinceUserInput: Infinity, streaming: true }),
    ).toEqual({ scroll: true, behavior: "auto" });
    expect(
      decideAutoScroll({ distanceFromBottom: 10, msSinceUserInput: Infinity, streaming: false }),
    ).toEqual({ scroll: true, behavior: "smooth" });
  });

  it("SCROLLPIN-3: 用户刚滚过（≤150ms）⇒ 不抢视口，哪怕就贴在底部", () => {
    expect(SCROLL_USER_INPUT_COOLDOWN_MS).toBe(150);
    expect(
      decideAutoScroll({ distanceFromBottom: 0, msSinceUserInput: 150, streaming: true }),
    ).toEqual({ scroll: false, behavior: "auto" });
    expect(
      decideAutoScroll({ distanceFromBottom: 0, msSinceUserInput: 151, streaming: true }).scroll,
    ).toBe(true);
  });

  it("SCROLLPIN-4: 用户滚开了 ⇒ 无论多久都不抢（新消息靠未读提示条）", () => {
    expect(
      decideAutoScroll({ distanceFromBottom: 400, msSinceUserInput: Infinity, streaming: true }),
    ).toEqual({ scroll: false, behavior: "auto" });
    // 分类结果优先：即使距离算出来很近，store 说"已滚开"就不滚
    expect(
      decideAutoScroll({
        distanceFromBottom: 10,
        msSinceUserInput: Infinity,
        streaming: true,
        isPinned: false,
      }).scroll,
    ).toBe(false);
  });
});

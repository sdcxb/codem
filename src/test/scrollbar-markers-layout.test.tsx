/**
 * 滚动条标记**不许每 flush 强制整列布局**（第 233 轮审计 · P1 流式卡顿）。
 *
 * ## 缺陷形态
 *
 * `ScrollbarMarkers` 的 `calculatePositions()` 依赖 `[messages, …]` —— 而流式期间
 * `messages` 数组**每 100ms 换一次身份**（追加一个 token），于是每 flush 都会：
 * 1. 对**每条 user 消息**做一次 `container.querySelector(...)`（选择器遍历）；
 * 2. 每条再读**两次** `getBoundingClientRect()`（一次算位置、一次判是否在视口）。
 *
 * 100 个用户回合 ≈ 每 flush 300+ 次**强制布局**；而带 `content-visibility:auto` 的屏外行
 * 被读到就要**现算布局** —— 这正是"流式越跑越卡"的直接来源（实测 20 个回合 ×10 flush = 410 次读取）。
 *
 * ## 修法（不牺牲标记准确性）
 *
 * 标记位置的真实来源是**内容坐标**（`contentTop` px）：它只在"它上面的内容变高/变矮"时变，
 * 而流式**追加**只让 `scrollHeight` 变大 ⇒ 百分比可以**零布局读取**地重算。于是：
 *
 * - 集合没变（id 序列 + pinned 不变）⇒ 用缓存的内容坐标换算百分比；
 * - 集合变了 / resize ⇒ 才真去量（并写回缓存）；
 * - 度量用 `requestAnimationFrame` 合并，一帧最多一次。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | SBM-1 | 流式增长（id 序列不变）⇒ **一次布局读取都不发** |
 * | SBM-2 | 新消息出现 ⇒ 必须真的量它（反向对照：标记要跟上新回合） |
 * | SBM-3 | 窗口 resize ⇒ 重新量（反向对照：轨道几何变了） |
 *
 * 变异自证：去掉"集合签名"判断（每次都全量量）⇒ SBM-1 红（实测 410 次）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { ScrollbarMarkers } from "../components/ScrollbarMarkers";

type Msg = { id: string; role: string; content: string; timestamp: number };
const msg = (id: string, role: string, content: string): Msg =>
  ({ id, role, content, timestamp: 1 }) as unknown as Msg;

/** 宿主：`.chat-body`（真滚动体）> `.messages-container`（组件拿到的 containerRef） */
function Host({ messages }: { messages: Msg[] }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="chat-body">
      <div className="messages-container" ref={ref}>
        {messages.map((m) => (
          <div key={m.id} data-message-id={m.id} style={{ height: 10 }} />
        ))}
      </div>
      <ScrollbarMarkers messages={messages} containerRef={ref} />
    </div>
  );
}

let rectReads = 0;
const originalRect = Element.prototype.getBoundingClientRect;
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");

beforeEach(() => {
  rectReads = 0;
  Element.prototype.getBoundingClientRect = function () {
    rectReads += 1;
    return {
      x: 0, y: 100, top: 100, left: 0, right: 100, bottom: 200, width: 100, height: 100,
      toJSON: () => ({}),
    } as DOMRect;
  } as typeof Element.prototype.getBoundingClientRect;
  // jsdom 没有布局引擎：给滚动体一个"高 800 / 内容 8000"的形状
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      // 流式追加会让它变大；这里按子节点数大致模拟（内容更长 ⇒ 更高）
      return 8000 + (this.querySelectorAll?.("[data-message-id]").length ?? 0) * 10;
    },
  });
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
});

const flushFrames = async () => {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await new Promise((r) => setTimeout(r, 0));
};

describe("ScrollbarMarkers：流式期间不许强制布局", () => {
  it("SBM-1: 只有内容变长（id 序列不变）⇒ 不再读布局", async () => {
    const users: Msg[] = Array.from({ length: 20 }, (_, i) => msg(`u${i}`, "user", "问题"));
    const assistant: Msg = msg("a1", "assistant", "回答");

    const { rerender } = render(<Host messages={[...users, assistant]} />);
    await flushFrames();
    const afterMount = rectReads;
    expect(afterMount, "挂载时至少要量一次（否则标记根本没位置）").toBeGreaterThan(0);

    for (let i = 0; i < 10; i++) {
      const grown = { ...assistant, content: "回答".repeat(i + 2) } as unknown as Msg;
      rerender(<Host messages={[...users, grown]} />);
      await flushFrames();
    }

    const afterStream = rectReads - afterMount;
    expect(
      afterStream,
      `流式 10 次 flush 读了 ${afterStream} 次布局（内容坐标没变，一次都不该读）`,
    ).toBe(0);
  });

  it("SBM-2（反向对照）: 新消息出现 ⇒ 必须量它（标记要跟上新回合）", async () => {
    const base: Msg[] = Array.from({ length: 3 }, (_, i) => msg(`u${i}`, "user", "问题"));
    const { rerender } = render(<Host messages={base} />);
    await flushFrames();
    const before = rectReads;

    rerender(<Host messages={[...base, msg("u-new", "user", "新问题")]} />);
    await flushFrames();

    expect(rectReads, "新消息必须被量到（否则标记不更新）").toBeGreaterThan(before);
  });

  it("SBM-3（反向对照）: 窗口 resize ⇒ 重新量", async () => {
    const base: Msg[] = Array.from({ length: 5 }, (_, i) => msg(`u${i}`, "user", "问题"));
    render(<Host messages={base} />);
    await flushFrames();
    const before = rectReads;

    window.dispatchEvent(new Event("resize"));
    await flushFrames();
    expect(rectReads, "resize 之后轨道与内容坐标都可能变，必须重量").toBeGreaterThan(before);
  });

  /**
   * SBM-4：**标记位置按"内容比例"，不是"视口比例"** —— 这条把原来那条
   * "钉实现文本"的判据（REG-FULL-001b 里要求逐字出现某个表达式）升级成**行为判据**。
   *
   * 为什么必须行为化：重构之后局部变量名变了，文本断言只能跟着改；而它真正要防的
   * 缺陷是 `((elTop - scrollTop) / viewportHeight) * 100` 那种**视口相对**算法 ——
   * 那会让离屏的回合**全部挤到轨道两端**（一屏只剩 1-2 个点，导航形同虚设）。
   *
   * 做法：给三条消息固定的内容坐标（0 / 5000 / 9000px，总内容 10000px），
   * 断言渲染出来的标记 top ≈ 0% / 50% / 90%；
   * 若退回视口相对算法，三者会变成 0% / 625% / 1125%（被 clamp 成 0/100/100）。
   */
  it("SBM-4: 标记位置按内容比例（回归视口相对算法会全挤到两端）", async () => {
    const perElementRect = function (this: Element) {
      const top = Number((this as HTMLElement).getAttribute?.("data-top") ?? 0);
      return {
        x: 0, y: top, top, left: 0, right: 100, bottom: top + 100, width: 100, height: 100,
        toJSON: () => ({}),
      } as DOMRect;
    };
    const prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = perElementRect as typeof Element.prototype.getBoundingClientRect;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 10_000 });

    try {
      // 三条消息：内容坐标 0 / 5000 / 9000 ⇒ 期望 0% / 50% / 90%
      const rows: Array<[string, number]> = [
        ["u0", 0],
        ["u1", 5000],
        ["u2", 9000],
      ];
      function PositionHost() {
        const ref = useRef<HTMLDivElement>(null);
        return (
          <div className="chat-body">
            <div className="messages-container" ref={ref}>
              {rows.map(([id, top]) => (
                <div key={id} data-message-id={id} data-top={top} />
              ))}
            </div>
            <ScrollbarMarkers messages={rows.map(([id]) => msg(id, "user", "问题"))} containerRef={ref} />
          </div>
        );
      }

      render(<PositionHost />);
      await flushFrames();

      const percents = [...document.querySelectorAll(".scrollbar-marker")].map((el) => {
        // style.top = `calc(<percent>% - 3px)`
        const raw = (el as HTMLElement).style.top;
        const m = /calc\(\s*([\d.]+)%/.exec(raw);
        return m ? Number(m[1]) : NaN;
      });

      expect(percents.length, "三条消息应有三个标记").toBe(3);
      const [p0, p1, p2] = percents;
      expect(p0, `第一个标记应在顶部（0%），实际 ${p0}`).toBeLessThan(2);
      expect(p1, `中间标记应按内容比例落在 ~50%，实际 ${p1}%（视口相对算法会给出 100%）`).toBeGreaterThan(45);
      expect(p1).toBeLessThan(55);
      expect(p2, `最后一个标记应按内容比例落在 ~90%，实际 ${p2}%`).toBeGreaterThan(85);
      expect(p2).toBeLessThan(95);
    } finally {
      Element.prototype.getBoundingClientRect = prevRect;
    }
  });
});

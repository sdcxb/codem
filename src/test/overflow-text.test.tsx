/**
 * OverflowText 的行为用例（第 171 轮 P2-5）。
 *
 * 为什么必须**造**布局：jsdom 没有排版引擎，`scrollWidth`/`clientWidth` 恒为 0 ——
 * 真跑起来"有没有被截断"永远是 false，组件会看起来"没 bug"。所以这里在元素原型上
 * 定义这两个属性来模拟两种真实情况（放得下 / 放不下），再断言 **title 只在真被截断时出现**。
 *
 * 三个判据：
 * ① 放不下 ⇒ 挂 title（值 = 文本）；② 放得下 ⇒ **不挂** title（这正是本组件存在的理由：
 * 无条件 title 会让"没截断也弹提示"）；③ 调用方显式给 title ⇒ 原样透传。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { OverflowText } from "../components/OverflowText";

/** 把 scrollWidth/clientWidth（或 scrollHeight/clientHeight）设成固定值，模拟"截断/未截断" */
function stubMetrics({ scroll, client, axis }: { scroll: number; client: number; axis: "x" | "y" }) {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const scrollKey = axis === "x" ? "scrollWidth" : "scrollHeight";
  const clientKey = axis === "x" ? "clientWidth" : "clientHeight";
  Object.defineProperty(proto, scrollKey, { configurable: true, get: () => scroll });
  Object.defineProperty(proto, clientKey, { configurable: true, get: () => client });
  return () => {
    delete proto[scrollKey];
    delete proto[clientKey];
  };
}

afterEach(() => cleanup());

describe("OverflowText", () => {
  it("OVF-1：真的放不下时挂 title（单行看宽度）", () => {
    const restore = stubMetrics({ scroll: 300, client: 120, axis: "x" });
    const { container } = render(<OverflowText className="probe">一段很长很长很长很长的会话标题</OverflowText>);
    const el = container.querySelector("span")!;
    expect(el.className).toContain("truncate");
    expect(el.getAttribute("title")).toBe("一段很长很长很长很长的会话标题");
    restore();
  });

  it("OVF-2：放得下就**不挂** title（无条件 title 是本组件要消掉的噪声）", () => {
    const restore = stubMetrics({ scroll: 100, client: 120, axis: "x" });
    const { container } = render(<OverflowText className="probe">短标题</OverflowText>);
    const el = container.querySelector("span")!;
    expect(el.getAttribute("title")).toBeNull();
    restore();
  });

  it("OVF-3：多行按高度判定，并用 .truncate-2 工具类", () => {
    const restore = stubMetrics({ scroll: 90, client: 40, axis: "y" });
    const { container } = render(<OverflowText lines={2}>两行放不下的长摘要</OverflowText>);
    const el = container.querySelector("span")!;
    expect(el.className).toContain("truncate-2");
    expect(el.getAttribute("title")).toBe("两行放不下的长摘要");
    restore();
  });

  it("OVF-4：调用方显式给 title 时原样透传（不被「未截断」吞掉）", () => {
    const restore = stubMetrics({ scroll: 100, client: 120, axis: "x" });
    const { container } = render(<OverflowText title="指定提示">短</OverflowText>);
    expect(container.querySelector("span")!.getAttribute("title")).toBe("指定提示");
    restore();
  });

  it("OVF-5：文本变化后重新丈量（截断状态跟着文本走）", () => {
    let scroll = 100;
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => scroll });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 120 });
    const { container, rerender } = render(<OverflowText>短</OverflowText>);
    expect(container.querySelector("span")!.getAttribute("title")).toBeNull();
    scroll = 400; // 换成更长的文本（模拟同一元素被塞进长标题）
    act(() => rerender(<OverflowText>换成一个非常非常非常长的标题</OverflowText>));
    expect(container.querySelector("span")!.getAttribute("title")).toBe("换成一个非常非常非常长的标题");
    delete proto.scrollWidth;
    delete proto.clientWidth;
  });
});

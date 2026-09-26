/**
 * α 感知颜色解析与合成的契约用例（第 165 轮 P2-1 高对比档）。
 *
 * 为什么单独一组：这一组守的是**测量能力本身**。高对比档的判据是
 * "文字更黑、边框更实、焦点环更粗"，其中"边框更实"必须量**半透明边框压在面上之后的可见度** ——
 * 而在此之前，`parseColorValue` 连 `rgb(31 31 30 / 9%)`（现代空格写法）都解析不出来，
 * 也就是说这一路上**从来没有人量过边框**。
 *
 * ⚠️ 全组最关键的是 `ALPHA-1`：`color-mix(in srgb, …)` 按规范是**预乘 α** 混合。
 * 这个坑在本仓库出现过**三次**（每写一个新的颜色工具就踩一次），所以这里直接用规范行为钉住：
 * `color-mix(in srgb, red 50%, transparent)` 的结果是"**红色本身、α=0.5**"，不是"暗一半的红"。
 */
import { describe, it, expect } from "vitest";
import { resolveRgba, compositeOver, contrastOfRgba, visibleContrastOver } from "../core/theme/contrast-checker";

const round = (c: { r: number; g: number; b: number; a: number }) => ({
  r: c.r,
  g: c.g,
  b: c.b,
  a: Number(c.a.toFixed(3)),
});

describe("ALPHA 颜色解析与合成（第 165 轮）", () => {
  it("ALPHA-1：`color-mix(in srgb, C p%, transparent)` 是**预乘 α** 混合 —— 结果保留 C 的色相、α 变小", () => {
    /* 规范行为：red 50% + transparent 50% ⇒ { 255, 0, 0, 0.5 }（**不是** { 128, 0, 0 }）。
       压在白底上应是 #ff8080（not #bf7f7f）—— 后者就是"没做预乘"的错答案。 */
    expect(round(resolveRgba("color-mix(in srgb, #ff0000 50%, transparent)")!)).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(round(compositeOver(resolveRgba("color-mix(in srgb, #ff0000 50%, transparent)")!, resolveRgba("#ffffff")!))).toEqual({ r: 255, g: 128, b: 128, a: 1 });

    /* 本项目真实的边框写法：墨 #1f1f1e 的 26% ⇒ α 0.26、色相仍是 #1f1f1e */
    const vars = { "--text-base": "#1f1f1e" };
    const border = resolveRgba("color-mix(in srgb, var(--text-base) 26%, transparent)", vars)!;
    expect(round(border)).toEqual({ r: 31, g: 31, b: 30, a: 0.26 });
    expect(round(compositeOver(border, resolveRgba("#ffffff")!))).toEqual({ r: 197, g: 197, b: 197, a: 1 });
  });

  it("ALPHA-2：`rgb()` 的**空格 + 斜杠**写法必须认（逗号版正则认不出它，这就是缺口本身）", () => {
    expect(round(resolveRgba("rgb(31 31 30 / 9%)")!)).toEqual({ r: 31, g: 31, b: 30, a: 0.09 });
    expect(round(resolveRgba("rgb(31, 31, 30)")!)).toEqual({ r: 31, g: 31, b: 30, a: 1 });
    expect(round(resolveRgba("rgba(255, 255, 255, 0.14)")!)).toEqual({ r: 255, g: 255, b: 255, a: 0.14 });
    expect(round(resolveRgba("rgb(255 255 255 / 50%)")!)).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
    expect(round(resolveRgba("#fff")!)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(round(resolveRgba("#ffffff80")!)).toEqual({ r: 255, g: 255, b: 255, a: 0.502 });
    expect(round(resolveRgba("transparent")!)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    /* 解析不了的**必须返回 null**，不许猜（猜出来的对比度等于没测）。
       注意命名色（`white`）也**不在**支持范围内 —— 它与本项目令牌的实际写法无关，
       而"悄悄按某种近似值算"正是这一路上出过三次的错。 */
    expect(resolveRgba("hsl(120 50% 50%)")).toBeNull();
    expect(resolveRgba("white")).toBeNull();
    expect(resolveRgba("var(--nope)")).toBeNull();
    expect(resolveRgba("var(--nope, hsl(1 2% 3%))")).toBeNull();
  });

  it("ALPHA-3：`visibleContrastOver` 量的是**合成之后**的可见度（边框够不够实）", () => {
    const face = "#ffffff";
    /* 亮色档实测：常态 α9% ≈ 1.19:1，高对比 α26% ≈ 1.73:1（与选值脚本算的一致） */
    const normal = visibleContrastOver("rgb(31 31 30 / 9%)", face)!;
    const high = visibleContrastOver("color-mix(in srgb, #1f1f1e 26%, transparent)", face)!;
    expect(normal).toBeGreaterThan(1.1);
    expect(normal).toBeLessThan(1.3);
    expect(high).toBeGreaterThan(1.6);
    expect(high, "高对比的边框必须**严格**比常态更实").toBeGreaterThan(normal);
    /* 暗色档：面 #0e0f0f，常态 14% 白 ≈ 1.47:1 */
    const darkNormal = visibleContrastOver("rgba(255, 255, 255, 0.14)", "#0e0f0f")!;
    const darkHigh = visibleContrastOver("color-mix(in srgb, #d4d4d4 26%, transparent)", "#0e0f0f")!;
    expect(darkNormal).toBeGreaterThan(1.3);
    expect(darkHigh).toBeGreaterThan(darkNormal);
  });

  it("ALPHA-4：不透明颜色上的对比度与既有检查器一致（新解析器不许改变老口径的数字）", () => {
    /* 与 contrastRatio（老函数）在**不透明**输入上必须给同一个数：老函数是本项目所有门禁的基准，
       新老不一致就说明新解析器有 bug。这里取几个真实令牌取值。 */
    const cases: Array<[string, string]> = [
      ["#1f1f1e", "#ffffff"],
      ["#57564f", "#ffffff"],
      ["#d4d4d4", "#0e0f0f"],
      ["rgb(255 255 255 / 100%)", "#0e0f0f"],
    ];
    for (const [fg, bg] of cases) {
      const mine = contrastOfRgba(resolveRgba(fg)!, resolveRgba(bg)!);
      expect(mine, `${fg} on ${bg}`).toBeCloseTo(visibleContrastOver(fg, bg)!, 6);
    }
    /* 反例：带 α 的前景必须**合成后**再算，直接当实色算会明显偏大（这正是这次要修的错法） */
    const naive = contrastOfRgba({ r: 31, g: 31, b: 30, a: 1 }, resolveRgba("#ffffff")!);
    const real = visibleContrastOver("rgb(31 31 30 / 9%)", "#ffffff")!;
    expect(naive).toBeGreaterThan(real * 5);
  });
});

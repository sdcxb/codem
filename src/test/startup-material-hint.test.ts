/**
 * 启动时序：**首帧不被系统材质探测拖住**（第 233 轮审计 · P2 冷启动）。
 *
 * ## 缺陷形态
 *
 * `main.tsx` 里 `await Promise.race([applyNativeMaterialHint(), sleep(400)])` 之后才
 * `renderApp()` —— 材质探测要走一次 IPC，一旦它慢/卡，用户看到的是**最长 400ms 的白屏**，
 * 而这段等待对"能不能开始用"没有任何帮助（探测只是给 `<html>` 打一个属性）。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | START-1 | 探测**永远不返回** ⇒ 首帧仍必须在 `limitMs` 内渲染（默认 60ms；原来 400ms） |
 * | START-2（反向对照）| 探测**很快**返回 ⇒ 属性先落地、再渲染（不会先画一帧实色再变玻璃） |
 * | START-3 | 渲染只发生**一次**（探测晚到 / 超时都到齐时不许渲染两次） |
 *
 * 变异自证：把 `limitMs` 改回 400 且改成"等探测完成才渲染"⇒ START-1 超时红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startWithMaterialHint, DEFAULT_MATERIAL_HINT_LIMIT_MS } from "../core/boot/material-hint";

describe("启动：首帧不被材质探测拖住", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("START-1: 探测永不返回 ⇒ 首帧仍要在 limitMs 内渲染", async () => {
    const order: string[] = [];
    let renderedAt: number | null = null;
    const start = Date.now();

    void startWithMaterialHint({
      probe: () => new Promise<void>(() => {}), // 永不 resolve
      render: () => {
        renderedAt = Date.now() - start;
        order.push("render");
      },
    });

    // 立刻推进到上限（默认 60ms）
    await vi.advanceTimersByTimeAsync(DEFAULT_MATERIAL_HINT_LIMIT_MS + 1);

    expect(order, "超时后必须已经渲染（否则就是白屏）").toEqual(["render"]);
    expect(renderedAt, `首帧被拖到 ${renderedAt}ms`).toBeLessThanOrEqual(DEFAULT_MATERIAL_HINT_LIMIT_MS + 5);
    expect(DEFAULT_MATERIAL_HINT_LIMIT_MS, "默认上限必须远小于原来的 400ms").toBeLessThan(200);
  });

  it("START-2（反向对照）: 探测很快返回 ⇒ 先打属性、再渲染", async () => {
    const order: string[] = [];
    await startWithMaterialHint({
      probe: async () => {
        order.push("probe");
      },
      render: () => order.push("render"),
    });
    expect(order, "正常路径上属性必须先于首帧落地（否则会闪一帧实色）").toEqual(["probe", "render"]);
  });

  it("START-3: 渲染只发生一次（探测晚到 + 超时都到齐）", async () => {
    const render = vi.fn();
    let resolveProbe!: () => void;
    const probe = new Promise<void>((r) => {
      resolveProbe = r;
    });

    void startWithMaterialHint({ probe: () => probe, render });

    await vi.advanceTimersByTimeAsync(DEFAULT_MATERIAL_HINT_LIMIT_MS + 1);
    expect(render).toHaveBeenCalledTimes(1);

    resolveProbe();
    await vi.advanceTimersByTimeAsync(1000);
    expect(render, "晚到的探测不许触发第二次渲染").toHaveBeenCalledTimes(1);
  });
});

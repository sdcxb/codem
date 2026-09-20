/**
 * LO-FIT —— 「适应窗口」的缩放下限与「手动缩放」的下限必须分开（回归）。
 *
 * 真机背景（安装版 1.16.113，任务中心 → 概览 → 场景实况卡）：
 *   画布固定 1920×1072，宿主 `.lo-scene-host` 只有约 **480.97×191.18**（overflow:hidden）。
 *   把整幅画塞进去需要的缩放 = min(480.97/1920, 191.18/1072) × 0.99 ≈ **0.1766**，
 *   而 `fitView()` 里写成 `Math.max(MIN_SCALE, …)`（MIN_SCALE = 0.3）⇒ 缩放被钳在 0.3：
 *   画布实渲 576×321.6，被宿主裁掉上沿 65.2px、左右各 47.5px —— **"适应窗口"永远适应不了**，
 *   4 个房间的可见区只剩 24% / 2% / 0% / 0%。
 *
 * 判据分层：
 *   · **强判据（真机几何）**：`.preview-shot/audit-loroom2-01-before.mjs`（改前）与
 *     `.preview-shot/audit-loroom2-02-after.mjs`（改后：把源码里的 `fitViewFor` **直接 import 进来**
 *     算出的取景写进运行中页面后复量）。它们量的是真实 `getBoundingClientRect` /
 *     `elementFromPoint` / 有效可见矩形 —— happy-dom 不做布局，这一层在单测里测不了。
 *   · **本文件（纯函数判据）**：把"fit 的缩放允许低于手动下限""手动缩放下限仍是 0.3""手动缩放
 *     不会把已经低于 0.3 的当前值**抬回** 0.3"这三条策略钉死。它们是策略正确性的必要证据，
 *     但**不能**证明真机上房间都进可视区（那要真机脚本）。
 */
import { describe, it, expect } from "vitest";
import {
  ISO_SCENE_SCALE,
  PIXEL_SCENE_SCALE,
  clampManualScale,
  fitViewFor,
  manualScaleFloor,
} from "../plugins/library-ops/core/scene-view";
import { CLAW_SCENE } from "../plugins/library-ops/data/pixel-art";

/** 真机读数（1.16.113，概览卡）：宿主内容盒 */
const OVERVIEW_HOST = { w: 480.97, h: 191.18 };
const CANVAS = { w: CLAW_SCENE.displayWidth, h: CLAW_SCENE.displayHeight };
/** 旧公式（改前）的取值，用来做"确实是这条导致的"的对照 */
const OLD_FIT = Math.max(PIXEL_SCENE_SCALE.manualMin, Math.min(1e9, Math.min(OVERVIEW_HOST.w / CANVAS.w, OVERVIEW_HOST.h / CANVAS.h) * 0.99));

describe("LO-FIT 取景缩放（fit 下限 ≠ 手动缩放下限）", () => {
  it("LO-FIT-0：画布与宿主就是真机那组数字（回归前提）", () => {
    expect([CANVAS.w, CANVAS.h]).toEqual([1920, 1072]);
    expect(OVERVIEW_HOST.w / OVERVIEW_HOST.h).toBeGreaterThan(CANVAS.w / CANVAS.h); // 宿主比画布更"扁"→ 由高度定缩放
    expect(OLD_FIT).toBeCloseTo(0.3, 6); // 改前：被 MIN_SCALE 钳在 0.3
  });

  it("LO-FIT-1（策略）：概览尺寸下 fit 算出 ≈0.1766，**低于手动下限 0.3** 且未被钳住", () => {
    const v = fitViewFor(OVERVIEW_HOST, CANVAS, PIXEL_SCENE_SCALE, 0.99);
    expect(v).not.toBeNull();
    expect(v!.scale).toBeLessThan(PIXEL_SCENE_SCALE.manualMin); // 核心：fit 可以低于 0.3
    expect(v!.scale).toBeCloseTo(0.17656, 4);
    expect(v!.scale).toBeGreaterThan(PIXEL_SCENE_SCALE.fitMin); // 仍受"病态兜底"约束
  });

  it("LO-FIT-2（几何）：改前 0.3 会裁掉一大半，改后整幅画都在宿主内并居中", () => {
    // 改前：画布 576×321.6 > 宿主 → 上下各裁 65.2、左右各 47.5（与真机读数一致）
    expect(CANVAS.w * OLD_FIT).toBeCloseTo(576, 3);
    expect(CANVAS.h * OLD_FIT).toBeCloseTo(321.6, 3);
    expect((CANVAS.h * OLD_FIT - OVERVIEW_HOST.h) / 2).toBeCloseTo(65.21, 1);
    expect((CANVAS.w * OLD_FIT - OVERVIEW_HOST.w) / 2).toBeCloseTo(47.515, 2);

    const v = fitViewFor(OVERVIEW_HOST, CANVAS, PIXEL_SCENE_SCALE, 0.99)!;
    expect(CANVAS.w * v.scale).toBeLessThanOrEqual(OVERVIEW_HOST.w + 1e-9);
    expect(CANVAS.h * v.scale).toBeLessThanOrEqual(OVERVIEW_HOST.h + 1e-9);
    expect(v.tx).toBeGreaterThanOrEqual(-1e-9);
    expect(v.ty).toBeGreaterThanOrEqual(-1e-9);
    // 居中：左右/上下余量相等
    expect(v.tx).toBeCloseTo((OVERVIEW_HOST.w - CANVAS.w * v.scale) / 2, 9);
    expect(v.ty).toBeCloseTo((OVERVIEW_HOST.h - CANVAS.h * v.scale) / 2, 9);
  });

  it("LO-FIT-3：fit 仍受上限约束；宿主/画布尺寸无效时返回 null（不写 NaN 进样式）", () => {
    const big = fitViewFor({ w: 8000, h: 6000 }, CANVAS, PIXEL_SCENE_SCALE, 0.99)!;
    expect(big.scale).toBe(PIXEL_SCENE_SCALE.max);
    expect(fitViewFor({ w: 0, h: 200 }, CANVAS, PIXEL_SCENE_SCALE)).toBeNull();
    expect(fitViewFor({ w: 200, h: 0 }, CANVAS, PIXEL_SCENE_SCALE)).toBeNull();
    expect(fitViewFor({ w: 200, h: 200 }, { w: 0, h: 0 }, PIXEL_SCENE_SCALE)).toBeNull();
    expect(fitViewFor({ w: Number.NaN, h: 200 }, CANVAS, PIXEL_SCENE_SCALE)).toBeNull();
  });

  it("LO-FIT-4（策略）：手动缩放（滚轮/按钮）仍守 0.3 下限 —— 没有被放开", () => {
    // 当前在正常档位（≥0.3）时，往下缩被 0.3 挡住
    expect(clampManualScale(0.5, 0.5 * 0.8, PIXEL_SCENE_SCALE)).toBeCloseTo(0.4, 9);
    expect(clampManualScale(0.32, 0.32 * 0.8, PIXEL_SCENE_SCALE)).toBeCloseTo(PIXEL_SCENE_SCALE.manualMin, 9);
    expect(clampManualScale(0.3, 0.01, PIXEL_SCENE_SCALE)).toBeCloseTo(0.3, 9);
    // 上限仍然生效
    expect(clampManualScale(3, 10, PIXEL_SCENE_SCALE)).toBeCloseTo(3.2, 9);
    expect(manualScaleFloor(0.9, PIXEL_SCENE_SCALE)).toBeCloseTo(0.3, 9);
  });

  it("LO-FIT-5（策略）：当前缩放低于 0.3（fit 放进去的）时，手动缩小**不得把它抬回** 0.3", () => {
    const fit = fitViewFor(OVERVIEW_HOST, CANVAS, PIXEL_SCENE_SCALE, 0.99)!.scale; // 0.17656
    // 缩小：不动（而不是 0.1766 → 0.3 的"按缩小反而放大"）
    expect(clampManualScale(fit, fit * 0.8, PIXEL_SCENE_SCALE)).toBeCloseTo(fit, 9);
    // 放大：照常
    expect(clampManualScale(fit, fit * 1.25, PIXEL_SCENE_SCALE)).toBeCloseTo(fit * 1.25, 9);
    // 一旦用户自己放大回 0.3 以上，下限立刻恢复成 0.3
    expect(manualScaleFloor(fit, PIXEL_SCENE_SCALE)).toBeCloseTo(fit, 9);
    expect(manualScaleFloor(0.45, PIXEL_SCENE_SCALE)).toBeCloseTo(0.3, 9);
    expect(clampManualScale(0.45, 0.1, PIXEL_SCENE_SCALE)).toBeCloseTo(0.3, 9);
    // 非正/非法当前值：退回"按手动下限处理"，不出 NaN
    expect(clampManualScale(0, 0.1, PIXEL_SCENE_SCALE)).toBeCloseTo(0.3, 9);
    expect(clampManualScale(Number.NaN, 0.9, PIXEL_SCENE_SCALE)).toBeCloseTo(0.9, 9);
  });

  it("LO-FIT-6：等距矢量场景用同一策略，上限仍是它自己的 3", () => {
    expect(ISO_SCENE_SCALE.max).toBe(3);
    const v = fitViewFor(OVERVIEW_HOST, { w: 1600, h: 900 }, ISO_SCENE_SCALE, 0.98)!;
    expect(v.scale).toBeLessThan(ISO_SCENE_SCALE.manualMin);
    expect(fitViewFor({ w: 8000, h: 6000 }, { w: 1600, h: 900 }, ISO_SCENE_SCALE)!.scale).toBe(3);
  });
});

/**
 * 场景取景（view）的纯计算 —— **「适应窗口算出来的缩放」与「用户手动缩放的下限」是两个概念**。
 *
 * 为什么必须分开（真机 1.16.113，任务中心 → 概览 → 场景实况卡）：
 *   · 画布固定 1920×1072，而概览卡里的 `.lo-scene-host` 只有约 480.97×191.18（overflow:hidden）；
 *     把整幅画塞进这个宿主需要的缩放是 `min(480.97/1920, 191.18/1072) ≈ 0.178`；
 *   · 但 `fitView()` 里写成 `Math.max(MIN_SCALE, …)`（MIN_SCALE = 0.3），于是缩放被钳在 0.3：
 *     画布实渲 576×321.6，被宿主裁掉上沿 65.2px、左右各 47.5px —— **"适应窗口"永远适应不了**，
 *     4 个房间的可见区只剩 24% / 2% / 0% / 0%（其中两个房间根本没画进可视区）。
 *
 * 所以本模块把两条下限拆成两个字段：
 *   · `manualMin` —— **用户手动缩放**（滚轮 / 加减按钮）的下限。保留 0.3 的理由：
 *     它是"用户主动把画面缩成看不清的一个点"的防护，作用对象是滚轮/按钮这类**把用户意图变成缩放倍数**
 *     的入口；0.3 大致是"还能看清角色与房间标签"的底线。
 *   · `fitMin` —— **适应窗口**的下限，只做"宿主小到病态"（0 宽高已被拒）时的兜底，取 0.05。
 *     fit 的语义是"把给定的整幅画装进给定的视口"，这个目标不随用户档位变化：
 *     宿主多小就该缩多小，没有任何理由被手动档位挡住。
 *
 * 派生规则（`clampManualScale`）：手动缩放的下限取 `min(manualMin, current)`。
 *   因为一次 fit 可能把当前缩放放到 manualMin 以下（概览就是 0.178），此时：
 *   · 若硬钳回 0.3 —— 用户按「缩小」反而会**被放大**（0.178 → 0.3），这是明显的坏交互；
 *   · 取 min 后 —— 在 0.178 上按「缩小」不动（已经比手动下限还小了，不允许更小），按「放大」照常；
 *     一旦用户自己放大回 0.3 以上，下限立刻恢复成 manualMin。
 */

/** 一组缩放档位（同一场景风格共用） */
export interface ScaleBounds {
  /** 手动缩放（滚轮 / 按钮）的下限 */
  manualMin: number;
  /** 缩放上限（fit 与手动共用：图再小也不该超过它） */
  max: number;
  /** 「适应窗口」的下限（只防宿主病态，不表达用户档位） */
  fitMin: number;
}

/** 像素场景（ClawLibrary）：上限 3.2，手动下限 0.3 */
export const PIXEL_SCENE_SCALE: ScaleBounds = { manualMin: 0.3, max: 3.2, fitMin: 0.05 };
/** 等距矢量场景：上限 3，手动下限 0.3 */
export const ISO_SCENE_SCALE: ScaleBounds = { manualMin: 0.3, max: 3, fitMin: 0.05 };

/** 画布上的一个取景：缩放 + 平移（画布左上角相对宿主的位移） */
export interface SceneView {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * 「适应窗口」：把 canvasW×canvasH 的画布整幅塞进 w×h 的宿主并居中。
 * 返回 null 表示宿主/画布尺寸无效（调用方保持原取景，不要写 NaN 进样式）。
 */
export function fitViewFor(
  viewport: { w: number; h: number },
  canvas: { w: number; h: number },
  bounds: ScaleBounds,
  padding = 0.99,
): SceneView | null {
  const { w, h } = viewport;
  const { w: cw, h: ch } = canvas;
  if (!(w > 0) || !(h > 0) || !(cw > 0) || !(ch > 0)) return null;
  // 注意：这里**没有** manualMin —— fit 的缩放只受 fitMin（病态兜底）与 max（上限）约束
  const scale = Math.min(bounds.max, Math.max(bounds.fitMin, Math.min(w / cw, h / ch) * padding));
  return { scale, tx: (w - cw * scale) / 2, ty: (h - ch * scale) / 2 };
}

/** 手动缩放的下限：见文件头「派生规则」——当前已在 manualMin 以下时，不允许被钳着放大 */
export function manualScaleFloor(current: number, bounds: ScaleBounds): number {
  return Math.min(bounds.manualMin, current);
}

/** 手动缩放（滚轮 / 按钮）的收敛：`next` 被夹进 [manualScaleFloor(current), max] */
export function clampManualScale(current: number, next: number, bounds: ScaleBounds): number {
  if (!(current > 0)) return Math.min(bounds.max, Math.max(bounds.manualMin, next));
  return Math.min(bounds.max, Math.max(manualScaleFloor(current, bounds), next));
}

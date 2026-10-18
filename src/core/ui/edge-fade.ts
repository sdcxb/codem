/**
 * 滚动边缘渐隐（mask）—— 纯几何计算，便于判据直接测。
 *
 * ## 为什么需要（对标 open-claude-ui 的 ScrollFadeContainer）
 *
 * 滚动容器的内容在边缘处**硬切**：最后一行文字贴着容器边界消失，看起来像被裁掉。
 * 对标实现用 28px 羽化 + **7 档非线性 alpha**（y ≈ x^1.5）逼近肉眼平滑的渐隐，
 * 并且在**已经触顶/触底**时把对应那一侧的 mask 归零 —— 否则首行会被"渐隐"成淡字，
 * 那是另一种错。
 *
 * 为什么不只用两档线性：线性 alpha 在纯色大背景上会出现可见台阶；7 档 + 幂函数
 * 把相邻档差压到肉眼阈值以下（像素值按我们自己的 28px 羽毛距离算，不照搬对方数值）。
 *
 * 判据 `EDGEFADE-1..4`。
 */

/** 羽化距离（px） */
export const EDGE_FADE_FEATHER_PX = 28;
/** 每侧渐隐档数（含两端） */
export const EDGE_FADE_STOPS = 7;
/** 触顶/触底判定容差（px）—— "贴边"语义，与滚动图钉的 40px 不是一回事 */
export const EDGE_FADE_EDGE_TOLERANCE_PX = 2;

export interface EdgeFadeState {
  atTop: boolean;
  atBottom: boolean;
}

/** alpha 曲线：y = x^1.5（x∈[0,1]），x=0 全透明、x=1 不透明 */
export function edgeFadeAlpha(x: number): number {
  const clamped = Math.min(1, Math.max(0, x));
  return Math.round(Math.pow(clamped, 1.5) * 1000) / 1000;
}

/**
 * 生成 `mask-image` 的 `linear-gradient`（`to bottom`）。
 *
 * - 上侧：7 档，`0px`（外缘）→ `28px`（内）；
 * - 中间：`28px` 到 `calc(100% - 28px)` 全不透明；
 * - 下侧：7 档，`calc(100% - 28px)` → `100%`（外缘）；
 * - **已触顶**：上侧退化成 `0px` 一个不透明 stop（等于不遮上边）；
 * - **已触底**：下侧退化成 `100%` 一个不透明 stop。
 *
 * 返回值可直接用于 `style.maskImage` / `WebkitMaskImage`。
 */
export function edgeFadeMask(state: EdgeFadeState): string {
  const stops: string[] = [];

  if (state.atTop) {
    stops.push("rgba(0,0,0,1) 0px");
  } else {
    for (let i = 0; i < EDGE_FADE_STOPS; i++) {
      const x = i / (EDGE_FADE_STOPS - 1);
      stops.push(`rgba(0,0,0,${edgeFadeAlpha(x)}) ${px(x * EDGE_FADE_FEATHER_PX)}`);
    }
  }

  stops.push(`rgba(0,0,0,1) ${px(EDGE_FADE_FEATHER_PX)}`);
  stops.push(`rgba(0,0,0,1) calc(100% - ${px(EDGE_FADE_FEATHER_PX)})`);

  if (state.atBottom) {
    stops.push("rgba(0,0,0,1) 100%");
  } else {
    // 从内到外：alpha 1 → 0
    for (let i = EDGE_FADE_STOPS - 1; i >= 0; i--) {
      const x = i / (EDGE_FADE_STOPS - 1);
      const offset = EDGE_FADE_FEATHER_PX - x * EDGE_FADE_FEATHER_PX;
      stops.push(`rgba(0,0,0,${edgeFadeAlpha(x)}) calc(100% - ${px(offset)})`);
    }
  }

  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/** 从元素的滚动几何判断是否贴边（纯函数，便于测） */
export function edgeFadeStateFromMetrics(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): EdgeFadeState {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  return {
    atTop: scrollTop <= EDGE_FADE_EDGE_TOLERANCE_PX,
    atBottom: scrollHeight - scrollTop - clientHeight <= EDGE_FADE_EDGE_TOLERANCE_PX,
  };
}

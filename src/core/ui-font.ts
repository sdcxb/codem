/**
 * ui-font — 全局字号缩放（D1：让设置页字号滑杆真正生效）
 *
 * 历史缺陷：SettingsPanel 的字号滑杆只写入 codem-settings JSON，
 * 全仓无消费方把字号应用到 DOM —— UI 字号恒为静态令牌（13px 基准）。
 *
 * 修复：引入 `--ui-font-scale` CSS 变量（styles.css :root，基准 13px → scale =
 * fontSize/13），styles.css 全部 --fs-* 刻度已改为 `calc(<px> * var(--ui-font-scale))`。
 * 本模块负责"读取已存字号 → 应用到 documentElement"，供应用启动与设置页复用。
 */

const FONT_BASE_PX = 13;
export { FONT_BASE_PX };

/** 把字号 px 值写入 CSS 变量（13px 基准 → scale） */
export function applyUiFontScale(fontSizePx: number): void {
  try {
    const clamped = Math.min(20, Math.max(10, fontSizePx || FONT_BASE_PX));
    const scale = (clamped / FONT_BASE_PX).toFixed(3);
    document.documentElement.style.setProperty("--ui-font-scale", scale);
  } catch {
    /* non-DOM env — no-op */
  }
}

/** 从 settings 读取已存字号并应用（默认 13） */
export function applyStoredUiFont(getSetting: (key: string) => string | null): void {
  try {
    const raw = getSetting("codem-font-size");
    const px = raw ? parseInt(raw, 10) : NaN;
    applyUiFontScale(Number.isFinite(px) ? px : FONT_BASE_PX);
  } catch {
    applyUiFontScale(FONT_BASE_PX);
  }
}

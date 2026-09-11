/**
 * ui-font — 全局字号缩放（D1：让设置页字号滑杆真正生效）
 *
 * 历史缺陷 ①：SettingsPanel 的字号滑杆只写入 codem-settings JSON，
 * 全仓无消费方把字号应用到 DOM —— UI 字号恒为静态令牌（13px 基准）。
 * 修复：引入 `--ui-font-scale` CSS 变量（styles.css :root，基准 13px → scale = fontSize/13），
 * styles.css 全部 --fs-* 刻度已改为 `calc(<px> * var(--ui-font-scale))`。
 *
 * 历史缺陷 ②（第 56 波修复，用户报「打开设置后主页文字突然变大、关了也不回退」）：
 *   - 启动路径**存在**（Sidebar 挂载时调 `applyStoredUiFont(getSetting)`），但它读的是**旧扁平键**
 *     `codem-font-size` —— 只有用户手动拖过字号滑杆才会写这个键，所以全新/未拖过的用户启动时
 *     回落到基准 13px（scale 1.0）；
 *   - 而设置页**打开时**应用的是另一个来源 `codem-settings.fontSize`，它的默认值是 **14**
 *     → 全站瞬间放大 14/13 ≈ 7.7%；
 *   - 变量写在 `<html>` 的行内样式上，关掉设置不会复原（本会话一直放大），重启又回到 13
 *     —— 于是表现为"奇怪的跳变"。
 *   根子在于**同一个设置存了两个键、两处各带一个不同的默认值**。
 *
 * 现在**单一来源**：`codem-settings.fontSize` 为权威（设置页滑杆显示并保存的就是它），
 * `codem-font-size` 仅作旧版本兼容回退；默认值统一为基准 13px（与 `--fs-*` 的缩放基准一致，故打开设置不再跳字）。
 * 应用时机：**数据库就绪后（App.tsx）** + 侧栏挂载时 + 设置页打开/改动时 —— 三处共用下面这个解析器。
 */

import { getSetting, getSettingJSON } from "./storage/settings";

/** 缩放基准：--fs-* 刻度以 13px 为 1.0，故默认 UI 字号也是 13px */
const FONT_BASE_PX = 13;
export { FONT_BASE_PX };

/** 滑杆范围（与设置页的 min/max 保持一致） */
const FONT_MIN_PX = 10;
const FONT_MAX_PX = 20;

/** 权威来源：设置页写入的完整设置对象 */
const SETTINGS_KEY = "codem-settings";
/** 旧版本只写过这个扁平键；它**只由字号滑杆写入**，因此它的存在等价于「用户确实调过字号」 */
const LEGACY_FONT_KEY = "codem-font-size";
/**
 * 旧代码的默认字号。`defaultSettings.fontSize` 是 14，而保存任何设置时都会把整个设置对象
 * （含这个默认值）写进 `codem-settings` —— 于是「14」既可能是用户自己选的、也可能只是默认值。
 * 判定：只有当旧扁平键不存在（= 从没拖过滑杆）时，才把 14 当作"未设置"归一为基准 13，
 * 这样"从没动过字号"的用户看到的字号与修复前启动时一致（不再跳变）；
 * 反过来，用户一旦拖过滑杆（写了旧键），14 就是他明确的选择，照用。
 */
const LEGACY_DEFAULT_FONT_PX = 14;

function parsePx(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPx(px: number): number {
  if (!Number.isFinite(px)) return FONT_BASE_PX;
  return Math.min(FONT_MAX_PX, Math.max(FONT_MIN_PX, Math.round(px)));
}

/**
 * 纯函数形式的解析（便于单测）。优先级：
 *   ① 旧扁平键（只由滑杆写入 ⇒ 用户明确选择）→ ② 设置对象里的 fontSize（14 且无旧键视为未设置）
 *   → ③ 基准 13。任何异常输入都回落到基准，绝不产生 NaN/越界。
 */
export function resolveUiFontPx(input: { fontSize?: unknown; legacyRaw?: string | null }): number {
  const explicit = parsePx(input.legacyRaw);
  if (explicit !== null) return clampPx(explicit);

  const fromSettings = parsePx(input.fontSize);
  if (fromSettings === null) return FONT_BASE_PX;
  if (fromSettings === LEGACY_DEFAULT_FONT_PX) return FONT_BASE_PX; // 旧默认值 = 未设置
  return clampPx(fromSettings);
}

/** 从存储里解析生效字号（权威源 → 旧键 → 基准） */
export function readStoredUiFontPx(): number {
  try {
    const json = getSettingJSON<{ fontSize?: unknown } | null>(SETTINGS_KEY, null);
    return resolveUiFontPx({ fontSize: json?.fontSize, legacyRaw: getSetting(LEGACY_FONT_KEY) });
  } catch {
    return FONT_BASE_PX;
  }
}

/** 把字号 px 值写入 CSS 变量（13px 基准 → scale） */
export function applyUiFontScale(fontSizePx: number): void {
  try {
    const clamped = clampPx(fontSizePx);
    const scale = (clamped / FONT_BASE_PX).toFixed(3);
    document.documentElement.style.setProperty("--ui-font-scale", scale);
  } catch {
    /* non-DOM env — no-op */
  }
}

/**
 * 读取已存字号并应用（启动时与设置页共用同一个解析器 —— 这是不再跳变的关键）。
 * @returns 实际生效的 px 值
 */
export function applyStoredUiFont(): number {
  const px = readStoredUiFontPx();
  applyUiFontScale(px);
  return px;
}

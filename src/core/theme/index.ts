/**
 * 主题系统入口
 */

export { ThemeManager } from './theme-manager';
export { ThemeExtractor } from './theme-extractor';
export { useSkin } from './use-skin';
export { DEFAULT_THEME, THEME_SETTING_KEY, THEME_CACHE_KEY, isThemeMode, readCachedTheme, cacheTheme, applyThemeAttribute } from './theme-default';
/** 皮肤首屏镜像 + 端口就绪校正（第 45 轮 D-17） */
export { readCachedSkin } from './theme-manager';
export { SKIN_PRESETS, DEFAULT_DARK, DEFAULT_LIGHT, HUB_SKIN, DREAM_SKIN, DEFAULT_DREAM_CONFIG } from './presets';
/** ⚠️ 第 46 波：`parseColor` 从这行**摘掉** ✓ —— 它只被 `contrast-checker.ts` 内部用（第 96 行 ✓），
 *  桶再导出它会让 `audit:knip` 的 `exports` 棘轮涨一格 ✗（取证与修法见 `contrast-checker.ts` 的注释 ✓）。 */
export { evaluateContrast, contrastRatio, formatRatio } from './contrast-checker';
export type { ContrastResult, ColorPair } from './contrast-checker';
export type { SkinId, ThemeMode, SkinConfig, SkinLayout, SkinColors, DreamSkinConfig, ExtractedPalette, ThemeState } from './types';

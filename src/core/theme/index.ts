/**
 * 主题系统入口
 */

export { ThemeManager } from './theme-manager';
export { ThemeExtractor } from './theme-extractor';
export { useSkin } from './use-skin';
export { DEFAULT_THEME, THEME_SETTING_KEY, THEME_CACHE_KEY, isThemeMode, readCachedTheme, cacheTheme, applyThemeAttribute } from './theme-default';
export { SKIN_PRESETS, DEFAULT_DARK, DEFAULT_LIGHT, HUB_SKIN, DREAM_SKIN, DEFAULT_DREAM_CONFIG, DREAM_COLOR_PRESETS } from './presets';
export { evaluateContrast, contrastRatio, formatRatio, checkPairs, parseColor, relativeLuminance } from './contrast-checker';
export type { ContrastResult, ColorPair } from './contrast-checker';
export type { SkinId, ThemeMode, SkinConfig, SkinLayout, SkinColors, DreamSkinConfig, ExtractedPalette, ThemeState } from './types';

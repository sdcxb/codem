/**
 * 皮肤系统类型定义
 */

/** 皮肤 ID */
export type SkinId = 'default' | 'hub' | 'dream';

/** 明暗模式（仅 default 皮肤有效） */
export type ThemeMode = 'light' | 'dark';

/** 皮肤布局配置 */
export interface SkinLayout {
  leftSidebarWidth: number;
  rightSidebarWidth?: number;      // Hub 专属
  topNavbarHeight?: number;        // Hub 专属
  titleBarHeight?: number;         // Dream 专属
}

/** 皮肤颜色配置 */
export interface SkinColors {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary?: string;
  bgHover?: string;
  bgCard?: string;
  bgInput?: string;
  accent: string;
  accentHover: string;
  accentMuted?: string;
  accentLight?: string;           // Dream 专属
  textPrimary: string;
  textSecondary: string;
  textMuted?: string;
  textOnAccent: string;
  borderPrimary: string;
  borderSecondary?: string;
  success?: string;
  warning?: string;
  error?: string;
  info?: string;
  [key: string]: string | undefined;
}

/** 梦幻皮肤专属配置 */
export interface DreamSkinConfig {
  backgroundImage: string | null;   // base64 data URL 或文件路径
  extractedPalette: ExtractedPalette | null;
  customAccent?: string;            // 用户自定义强调色（覆盖自动提取）
  blurRadius: number;               // 毛玻璃模糊度（px）
  cardOpacity: number;              // 卡片透明度 (0-1)
  decorations: boolean;             // 是否显示装饰元素（花瓣等）
  polaroid: boolean;                // 是否显示拍立得
  scriptFont: boolean;              // 是否使用手写字体
  safeArea: 'auto' | 'left' | 'right' | 'center' | 'none';
}

/** 从图片提取的色板 */
export interface ExtractedPalette {
  dominant: string;       // 主色调（hex）
  accent: string;         // 强调色（hex）
  background: string;     // 推荐背景色（hex）
  textPrimary: string;    // 推荐文本色（hex）
  textSecondary: string;  // 推荐次文本色（hex）
  isDark: boolean;        // 图片是否偏暗
  palette: string[];      // 完整色板（6色，hex）
}

/** 完整的皮肤配置 */
export interface SkinConfig {
  id: SkinId;
  name: string;
  description: string;
  layout: SkinLayout;
  colors: SkinColors;
  dream?: DreamSkinConfig;
}

/** 主题状态 */
export interface ThemeState {
  skin: SkinId;
  themeMode: ThemeMode;
  dreamConfig: DreamSkinConfig | null;
}

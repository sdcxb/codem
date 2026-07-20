/**
 * 皮肤预设配置
 */
import type { SkinConfig, DreamSkinConfig } from './types';

/** 默认皮肤 - 暗色 */
export const DEFAULT_DARK: SkinConfig = {
  id: 'default',
  name: '默认',
  description: '经典暗色/亮色主题',
  layout: {
    leftSidebarWidth: 260,
  },
  colors: {
    bgPrimary: 'rgba(13, 17, 23, 0.85)',
    bgSecondary: 'rgba(22, 27, 34, 0.90)',
    bgTertiary: 'rgba(33, 38, 45, 0.90)',
    bgHover: 'rgba(48, 54, 61, 0.90)',
    accent: '#7c6cf0',
    accentHover: '#8b7df5',
    accentMuted: 'rgba(124, 108, 240, 0.20)',
    textPrimary: '#f0f6fc',
    textSecondary: '#8b949e',
    textMuted: '#6e7681',
    textOnAccent: '#ffffff',
    borderPrimary: 'rgba(48, 54, 61, 0.80)',
    borderSecondary: 'rgba(33, 38, 45, 0.80)',
    success: '#3fb950',
    warning: '#d29922',
    error: '#f85149',
    info: '#58a6ff',
  },
};

/** 默认皮肤 - 亮色 */
export const DEFAULT_LIGHT: SkinConfig = {
  ...DEFAULT_DARK,
  colors: {
    bgPrimary: 'rgba(255, 255, 255, 0.85)',
    bgSecondary: 'rgba(246, 248, 250, 0.90)',
    bgTertiary: 'rgba(234, 238, 242, 0.90)',
    bgHover: 'rgba(208, 215, 222, 0.90)',
    accent: '#6b5ce7',
    accentHover: '#5a4bd1',
    accentMuted: 'rgba(107, 92, 231, 0.15)',
    textPrimary: '#1f2328',
    textSecondary: '#656d76',
    textMuted: '#8b949e',
    textOnAccent: '#ffffff',
    borderPrimary: 'rgba(208, 215, 222, 0.80)',
    borderSecondary: 'rgba(234, 238, 242, 0.80)',
    success: '#1a7f37',
    warning: '#9a6700',
    error: '#cf222e',
    info: '#6b5ce7',
  },
};

/** Hub 皮肤 */
export const HUB_SKIN: SkinConfig = {
  id: 'hub',
  name: 'Hub',
  description: '深色科技感 Hub 界面，三栏布局',
  layout: {
    leftSidebarWidth: 260,
    rightSidebarWidth: 300,
    topNavbarHeight: 50,
  },
  colors: {
    bgPrimary: '#0a0a0a',
    bgSecondary: '#121212',
    bgTertiary: '#1c1c1e',
    bgHover: '#2a2a2a',
    bgCard: '#1c1c1e',
    bgInput: '#151515',
    accent: '#ff6b00',
    accentHover: '#e56000',
    accentMuted: 'rgba(255, 107, 0, 0.15)',
    textPrimary: '#e0e0e0',
    textSecondary: '#888888',
    textMuted: '#666666',
    textOnAccent: '#ffffff',
    borderPrimary: '#2a2a2a',
    borderSecondary: '#1c1c1e',
    success: '#4ade80',
    warning: '#d29922',
    error: '#f85149',
    info: '#58a6ff',
  },
};

/** 梦幻皮肤默认配置 */
export const DEFAULT_DREAM_CONFIG: DreamSkinConfig = {
  backgroundImage: null,
  extractedPalette: null,
  blurRadius: 2,
  cardOpacity: 0.3,
  decorations: true,
  polaroid: true,
  scriptFont: true,
  safeArea: 'auto',
};

/** 梦幻皮肤 */
export const DREAM_SKIN: SkinConfig = {
  id: 'dream',
  name: '梦幻',
  description: '浅色梦幻氛围感，支持背景图自适应主题色',
  layout: {
    leftSidebarWidth: 220,
    titleBarHeight: 38,
  },
  colors: {
    bgPrimary: '#fdf5f7',
    bgSecondary: '#ffffff',
    bgTertiary: '#fce8eb',
    bgHover: '#f7dee2',
    bgCard: 'rgba(255, 255, 255, 0.65)',
    bgInput: 'rgba(255, 255, 255, 0.65)',
    accent: '#e88c9a',
    accentHover: '#d97a88',
    accentMuted: 'rgba(232, 140, 154, 0.15)',
    accentLight: '#fce8eb',
    textPrimary: '#6c474d',
    textSecondary: '#a88a8f',
    textMuted: '#d6b8be',
    textOnAccent: '#ffffff',
    borderPrimary: '#f7dee2',
    borderSecondary: '#fce8eb',
    success: '#4ade80',
    warning: '#d29922',
    error: '#ef4444',
    info: '#e88c9a',
  },
  dream: DEFAULT_DREAM_CONFIG,
};

/** 所有皮肤预设 */
export const SKIN_PRESETS: Record<string, SkinConfig> = {
  default: DEFAULT_DARK,
  hub: HUB_SKIN,
  dream: DREAM_SKIN,
};

/** 梦幻预设色板（当无法从图片提取时的 fallback） */
export const DREAM_COLOR_PRESETS: Record<string, { name: string; accent: string; bg: string; text: string }> = {
  pink: { name: '粉色系', accent: '#e88c9a', bg: '#fdf5f7', text: '#6c474d' },
  blue: { name: '蓝色系', accent: '#7bb3d9', bg: '#f0f4f8', text: '#3d556b' },
  green: { name: '绿色系', accent: '#8bc34a', bg: '#f1f8f4', text: '#3a5a40' },
  purple: { name: '紫色系', accent: '#b39ddb', bg: '#f5f0fa', text: '#4a3a5a' },
  orange: { name: '橙色系', accent: '#ffb74d', bg: '#fff8f0', text: '#5a4530' },
  dark: { name: '暗色系', accent: '#9fa8da', bg: '#1a1a2e', text: '#e0e0e0' },
};

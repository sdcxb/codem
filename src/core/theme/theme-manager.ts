/**
 * 主题管理器（重构版）
 *
 * 设计原则：
 * - 默认皮肤完全独立，由 Sidebar 原有的 codem-theme 系统管理明暗模式
 * - ThemeManager 不干预默认皮肤的任何 DOM/CSS
 * - 切换到 Hub/Dream 时才设置 data-skin 属性，切回 default 时清除
 * - Hub 皮肤：独立 CSS 作用域 [data-skin="hub"]
 * - Dream 皮肤：注入提取的色板为 CSS 变量 + 透明覆盖默认皮肤变量
 */

import type { SkinId, DreamSkinConfig, ExtractedPalette } from './types';
import { DEFAULT_DREAM_CONFIG } from './presets';
import { ThemeExtractor } from './theme-extractor';
import { getSetting, setSetting } from '../storage/settings';

const SETTINGS_KEY_SKIN = 'skin-id';
const SETTINGS_KEY_DREAM = 'dream-config';

/** 需要在切回 default 时清理的 CSS 变量 */
const DREAM_CSS_VARS = [
  '--dream-bg-image',
  '--dream-accent',
  '--dream-text-main',
  '--dream-text-muted',
  '--dream-bg-card',
  '--dream-bg-panel',
  '--dream-border-color',
  '--dream-blur-px',
  '--dream-card-opacity',
  // 覆盖默认皮肤的变量
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-hover',
  '--sidebar-bg',
  '--input-bg',
  '--code-bg',
  '--accent',
  '--accent-hover',
  '--accent-muted',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--border-primary',
  '--border-secondary',
  '--user-bg',
  '--assistant-bg',
  '--system-bg',
];

/** 皮肤切换监听器 */
type SkinChangeListener = (skin: SkinId) => void;

class ThemeManagerClass {
  private currentSkin: SkinId = 'default';
  private dreamConfig: DreamSkinConfig = { ...DEFAULT_DREAM_CONFIG };
  private listeners: Set<SkinChangeListener> = new Set();

  /**
   * 初始化：从存储加载皮肤状态
   */
  init(): void {
    try {
      const savedSkin = getSetting(SETTINGS_KEY_SKIN) as SkinId | null;
      if (savedSkin && ['default', 'hub', 'dream'].includes(savedSkin)) {
        this.currentSkin = savedSkin;
      }

      const savedDream = getSetting(SETTINGS_KEY_DREAM);
      if (savedDream) {
        const parsed = typeof savedDream === 'string' ? JSON.parse(savedDream) : savedDream;
        if (parsed && typeof parsed === 'object') {
          this.dreamConfig = { ...DEFAULT_DREAM_CONFIG, ...(parsed as Record<string, unknown>) } as DreamSkinConfig;
        }
      }
    } catch {
      // 首次启动或配置损坏，使用默认值
    }
    this.applySkin();
    this.notifyListeners();
  }

  /** 获取当前皮肤 ID */
  getSkin(): SkinId {
    return this.currentSkin;
  }

  /** 获取梦幻皮肤配置 */
  getDreamConfig(): DreamSkinConfig {
    return this.dreamConfig;
  }

  /** 切换皮肤 */
  setSkin(skin: SkinId): void {
    this.currentSkin = skin;
    setSetting(SETTINGS_KEY_SKIN, skin);
    this.applySkin();
    this.notifyListeners();
  }

  /** 更新梦幻皮肤配置 */
  updateDreamConfig(config: Partial<DreamSkinConfig>): void {
    this.dreamConfig = { ...this.dreamConfig, ...config };
    setSetting(SETTINGS_KEY_DREAM, JSON.stringify(this.dreamConfig));
    if (this.currentSkin === 'dream') {
      this.applyDreamCSS();
    }
    this.notifyListeners();
  }

  /** 设置梦幻皮肤背景图 */
  async setDreamBackground(imageSrc: string | null, extractPalette = true): Promise<void> {
    if (!imageSrc) {
      this.updateDreamConfig({
        backgroundImage: null,
        extractedPalette: null,
      });
      return;
    }

    const compressed = await ThemeExtractor.compressImage(imageSrc);

    let palette: ExtractedPalette | null = null;
    if (extractPalette) {
      try {
        palette = await ThemeExtractor.extractPalette(compressed);
      } catch (e) {
        console.warn('[ThemeManager] 主题色提取失败:', e);
      }
    }

    this.updateDreamConfig({
      backgroundImage: compressed,
      extractedPalette: palette,
    });
  }

  /**
   * 应用皮肤：设置 data-skin 属性 + 注入/清理 CSS 变量
   */
  private applySkin(): void {
    const root = document.documentElement;

    if (this.currentSkin === 'default') {
      // 默认皮肤：清除所有皮肤相关 DOM 痕迹
      root.removeAttribute('data-skin');
      this.cleanDreamCSS();
    } else {
      root.setAttribute('data-skin', this.currentSkin);
      if (this.currentSkin === 'dream') {
        this.applyDreamCSS();
      } else {
        this.cleanDreamCSS();
      }
    }
  }

  /** 只设置 data-skin 属性（兼容旧调用） */
  private applySkinAttribute(): void {
    this.applySkin();
  }

  /**
   * 注入梦幻皮肤 CSS 变量
   * - 背景图 URL
   * - 提取的色板颜色（覆盖默认皮肤的 CSS 变量）
   * - 毛玻璃参数
   */
  private applyDreamCSS(): void {
    const root = document.documentElement;
    const config = this.dreamConfig;
    const palette = config.extractedPalette;

    // 背景图
    if (config.backgroundImage) {
      root.style.setProperty('--dream-bg-image', `url(${config.backgroundImage})`);
    } else {
      root.style.removeProperty('--dream-bg-image');
    }

    // 毛玻璃参数
    root.style.setProperty('--dream-blur-px', `${config.blurRadius}px`);
    root.style.setProperty('--dream-card-opacity', `${config.cardOpacity}`);

    // 提前声明，两个分支都用
    const opacity = config.cardOpacity;

    // 将 hex 转为 rgba 的工具函数
    const hexToRgba = (hex: string, alpha: number): string => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    if (palette) {
      // 使用提取的色板覆盖所有颜色变量
      const accent = palette.accent;
      const textPrimary = palette.textPrimary;
      const textSecondary = palette.textSecondary;
      const bgColor = palette.background;
      const isDark = palette.isDark;

      // 边框色：使用深色中性色确保可见性，而非 accent 的低透明度
      const borderColor = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)';
      const borderColorStrong = isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.2)';

      // Dream 专属变量
      root.style.setProperty('--dream-accent', accent);
      root.style.setProperty('--dream-text-main', textPrimary);
      root.style.setProperty('--dream-text-muted', textSecondary);
      root.style.setProperty('--dream-bg-card', isDark ? `rgba(30, 30, 46, ${opacity})` : `rgba(255, 255, 255, ${opacity})`);
      root.style.setProperty('--dream-bg-panel', isDark ? `rgba(30, 30, 46, ${Math.min(opacity + 0.1, 0.95)})` : `rgba(255, 255, 255, ${Math.min(opacity + 0.1, 0.95)})`);
      root.style.setProperty('--dream-border-color', borderColor);

      // 覆盖默认皮肤的 CSS 变量（让 Sidebar、ChatPanel 等组件也能自适应）
      root.style.setProperty('--bg-primary', 'transparent');
      root.style.setProperty('--bg-secondary', isDark ? `rgba(30, 30, 46, ${opacity})` : `rgba(255, 255, 255, ${opacity})`);
      root.style.setProperty('--bg-tertiary', isDark ? `rgba(40, 40, 56, ${Math.min(opacity + 0.05, 0.9)})` : `rgba(250, 250, 252, ${Math.min(opacity + 0.05, 0.9)})`);
      root.style.setProperty('--bg-hover', isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)');
      root.style.setProperty('--sidebar-bg', isDark ? `rgba(30, 30, 46, ${opacity})` : `rgba(255, 255, 255, ${opacity})`);
      root.style.setProperty('--input-bg', isDark ? `rgba(40, 40, 56, ${Math.min(opacity + 0.1, 0.9)})` : `rgba(255, 255, 255, ${Math.min(opacity + 0.1, 0.9)})`);
      root.style.setProperty('--code-bg', isDark ? `rgba(20, 20, 36, ${Math.min(opacity + 0.15, 0.95)})` : `rgba(245, 245, 248, ${Math.min(opacity + 0.15, 0.95)})`);

      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-hover', accent);
      root.style.setProperty('--accent-muted', isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)');

      root.style.setProperty('--text-primary', textPrimary);
      root.style.setProperty('--text-secondary', textSecondary);
      root.style.setProperty('--text-muted', textSecondary);

      root.style.setProperty('--border-primary', borderColorStrong);
      root.style.setProperty('--border-secondary', borderColor);

      root.style.setProperty('--user-bg', isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)');
      root.style.setProperty('--assistant-bg', isDark ? `rgba(30, 30, 46, ${opacity})` : `rgba(255, 255, 255, ${opacity})`);
      root.style.setProperty('--system-bg', isDark ? `rgba(40, 40, 56, ${Math.min(opacity + 0.05, 0.9)})` : `rgba(250, 250, 252, ${Math.min(opacity + 0.05, 0.9)})`);
    } else {
      // 没有提取色板时，使用高对比度中性色（与有 palette 时一致）
      const defaultAccent = '#e88c9a';
      const defaultText = '#1a1a2e';
      const defaultTextMuted = '#555566';
      const defaultBorder = 'rgba(0, 0, 0, 0.12)';
      const defaultBorderStrong = 'rgba(0, 0, 0, 0.2)';

      root.style.setProperty('--dream-accent', defaultAccent);
      root.style.setProperty('--dream-text-main', defaultText);
      root.style.setProperty('--dream-text-muted', defaultTextMuted);
      root.style.setProperty('--dream-bg-card', `rgba(255, 255, 255, ${opacity})`);
      root.style.setProperty('--dream-bg-panel', `rgba(255, 255, 255, ${Math.min(opacity + 0.1, 0.95)})`);
      root.style.setProperty('--dream-border-color', defaultBorder);

      // 覆盖默认变量
      root.style.setProperty('--bg-primary', 'transparent');
      root.style.setProperty('--bg-secondary', `rgba(255, 255, 255, ${opacity})`);
      root.style.setProperty('--bg-tertiary', `rgba(250, 250, 252, ${Math.min(opacity + 0.05, 0.9)})`);
      root.style.setProperty('--bg-hover', 'rgba(0, 0, 0, 0.05)');
      root.style.setProperty('--sidebar-bg', `rgba(255, 255, 255, ${opacity})`);
      root.style.setProperty('--input-bg', `rgba(255, 255, 255, ${Math.min(opacity + 0.1, 0.9)})`);
      root.style.setProperty('--code-bg', `rgba(245, 245, 248, ${Math.min(opacity + 0.15, 0.95)})`);

      root.style.setProperty('--accent', defaultAccent);
      root.style.setProperty('--accent-hover', '#d97a88');
      root.style.setProperty('--accent-muted', 'rgba(0, 0, 0, 0.06)');

      root.style.setProperty('--text-primary', defaultText);
      root.style.setProperty('--text-secondary', defaultTextMuted);
      root.style.setProperty('--text-muted', defaultTextMuted);

      root.style.setProperty('--border-primary', defaultBorderStrong);
      root.style.setProperty('--border-secondary', defaultBorder);

      root.style.setProperty('--user-bg', 'rgba(0, 0, 0, 0.04)');
      root.style.setProperty('--assistant-bg', `rgba(255, 255, 255, ${opacity})`);
      root.style.setProperty('--system-bg', `rgba(250, 250, 252, ${Math.min(opacity + 0.05, 0.9)})`);
    }
  }

  /** 清理梦幻皮肤注入的 CSS 变量 */
  private cleanDreamCSS(): void {
    const root = document.documentElement;
    for (const varName of DREAM_CSS_VARS) {
      root.style.removeProperty(varName);
    }
  }

  /** 通知监听器 */
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.currentSkin);
    }
  }

  /** 添加皮肤切换监听器 */
  onChange(listener: SkinChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 获取所有可用皮肤列表 */
  getAvailableSkins(): { id: SkinId; name: string; description: string }[] {
    return [
      { id: 'default', name: '默认', description: '经典暗色/亮色主题' },
      { id: 'hub', name: 'Hub', description: '深色科技感 Hub 界面，三栏布局' },
      { id: 'dream', name: '梦幻', description: '浅色梦幻氛围感，支持背景图自适应主题色' },
    ];
  }
}

/** 主题管理器单例 */
export const ThemeManager = new ThemeManagerClass();

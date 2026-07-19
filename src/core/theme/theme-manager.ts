/**
 * 主题管理器
 * 管理皮肤切换、持久化、CSS 变量注入
 */

import type { SkinId, ThemeMode, DreamSkinConfig, ExtractedPalette, SkinConfig } from './types';
import { SKIN_PRESETS, DEFAULT_DARK, DEFAULT_LIGHT, HUB_SKIN, DREAM_SKIN, DEFAULT_DREAM_CONFIG } from './presets';
import { ThemeExtractor } from './theme-extractor';
import { getSetting, setSetting } from '../storage/settings';

const SETTINGS_KEY_SKIN = 'skin-id';
const SETTINGS_KEY_THEME_MODE = 'theme-mode';
const SETTINGS_KEY_DREAM = 'dream-config';

/** 皮肤切换监听器 */
type SkinChangeListener = (skin: SkinId, config: SkinConfig) => void;

class ThemeManagerClass {
  private currentSkin: SkinId = 'default';
  private currentThemeMode: ThemeMode = 'dark';
  private dreamConfig: DreamSkinConfig = { ...DEFAULT_DREAM_CONFIG };
  private listeners: Set<SkinChangeListener> = new Set();

  /**
   * 初始化：从存储加载
   */
  init(): void {
    try {
      const savedSkin = getSetting(SETTINGS_KEY_SKIN) as SkinId | null;
      const savedMode = getSetting(SETTINGS_KEY_THEME_MODE) as ThemeMode | null;
      const savedDream = getSetting(SETTINGS_KEY_DREAM);

      if (savedSkin && ['default', 'hub', 'dream'].includes(savedSkin)) {
        this.currentSkin = savedSkin;
      }
      if (savedMode && ['light', 'dark'].includes(savedMode)) {
        this.currentThemeMode = savedMode;
      }
      if (savedDream && typeof savedDream === 'object') {
        this.dreamConfig = { ...DEFAULT_DREAM_CONFIG, ...savedDream };
      }
    } catch {
      // 首次启动，使用默认值
    }
    this.applyToDOM();
  }

  /**
   * 获取当前皮肤 ID
   */
  getSkin(): SkinId {
    return this.currentSkin;
  }

  /**
   * 获取当前主题模式
   */
  getThemeMode(): ThemeMode {
    return this.currentThemeMode;
  }

  /**
   * 获取梦幻皮肤配置
   */
  getDreamConfig(): DreamSkinConfig {
    return this.dreamConfig;
  }

  /**
   * 获取当前皮肤的完整配置
   */
  getCurrentConfig(): SkinConfig {
    if (this.currentSkin === 'default') {
      return this.currentThemeMode === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT;
    }
    if (this.currentSkin === 'hub') return HUB_SKIN;
    if (this.currentSkin === 'dream') {
      return {
        ...DREAM_SKIN,
        dream: this.dreamConfig,
      };
    }
    return DEFAULT_DARK;
  }

  /**
   * 切换皮肤
   */
  setSkin(skin: SkinId): void {
    this.currentSkin = skin;
    setSetting(SETTINGS_KEY_SKIN, skin);
    this.applyToDOM();
    this.notifyListeners();
  }

  /**
   * 切换明暗模式（仅 default 皮肤有效）
   */
  setThemeMode(mode: ThemeMode): void {
    this.currentThemeMode = mode;
    setSetting(SETTINGS_KEY_THEME_MODE, mode);
    this.applyToDOM();
    this.notifyListeners();
  }

  /**
   * 更新梦幻皮肤配置
   */
  updateDreamConfig(config: Partial<DreamSkinConfig>): void {
    this.dreamConfig = { ...this.dreamConfig, ...config };
    setSetting(SETTINGS_KEY_DREAM, JSON.stringify(this.dreamConfig));
    this.applyToDOM();
    this.notifyListeners();
  }

  /**
   * 设置梦幻皮肤背景图
   * @param imageSrc base64 data URL 或 null（清除）
   * @param extractPalette 是否自动提取主题色
   */
  async setDreamBackground(imageSrc: string | null, extractPalette = true): Promise<void> {
    if (!imageSrc) {
      this.updateDreamConfig({
        backgroundImage: null,
        extractedPalette: null,
      });
      return;
    }

    // 压缩图片
    const compressed = await ThemeExtractor.compressImage(imageSrc);

    // 提取主题色
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
   * 应用到 DOM（设置 data-skin 属性和 CSS 变量）
   */
  private applyToDOM(): void {
    const root = document.documentElement;

    // 设置 data-skin 属性
    root.setAttribute('data-skin', this.currentSkin);

    // 设置 data-theme 属性（明暗模式，仅 default 皮肤）
    if (this.currentSkin === 'default') {
      root.setAttribute('data-theme', this.currentThemeMode);
    } else {
      // Hub 始终暗色，Dream 始终亮色
      root.setAttribute('data-theme', this.currentSkin === 'hub' ? 'dark' : 'light');
    }

    // 获取当前皮肤配置
    const config = this.getCurrentConfig();

    // 注入 CSS 变量
    const colors = config.colors;
    for (const [key, value] of Object.entries(colors)) {
      if (value !== undefined) {
        const cssVar = this.keyToCssVar(key);
        root.style.setProperty(cssVar, value);
      }
    }

    // 梦幻皮肤特殊变量
    if (this.currentSkin === 'dream' && this.dreamConfig) {
      const dream = this.dreamConfig;

      // 如果有自定义强调色，覆盖
      if (dream.customAccent) {
        root.style.setProperty('--accent', dream.customAccent);
      } else if (dream.extractedPalette) {
        // 使用提取的主题色
        root.style.setProperty('--accent', dream.extractedPalette.accent);
        root.style.setProperty('--bg-primary', dream.extractedPalette.background);
        root.style.setProperty('--text-primary', dream.extractedPalette.textPrimary);
        root.style.setProperty('--text-secondary', dream.extractedPalette.textSecondary);
      }

      // 背景图
      if (dream.backgroundImage) {
        root.style.setProperty('--dream-bg-image', `url(${dream.backgroundImage})`);
      } else {
        root.style.removeProperty('--dream-bg-image');
      }

      // 毛玻璃参数
      root.style.setProperty('--dream-blur', `${dream.blurRadius}px`);
      root.style.setProperty('--dream-card-opacity', `${dream.cardOpacity}`);

      // 装饰元素
      root.style.setProperty('--dream-decorations', dream.decorations ? '1' : '0');
      root.style.setProperty('--dream-polaroid', dream.polaroid ? '1' : '0');
      root.style.setProperty('--dream-script-font', dream.scriptFont ? '1' : '0');

      // 安全区
      root.setAttribute('data-dream-safe', dream.safeArea);
    } else {
      // 清除梦幻变量
      root.style.removeProperty('--dream-bg-image');
      root.style.removeProperty('--dream-blur');
      root.style.removeProperty('--dream-card-opacity');
      root.style.removeProperty('--dream-decorations');
      root.style.removeProperty('--dream-polaroid');
      root.style.removeProperty('--dream-script-font');
      root.removeAttribute('data-dream-safe');
    }
  }

  /**
   * 将配置键名转为 CSS 变量名
   * 例: bgPrimary → --bg-primary, accentHover → --accent-hover
   */
  private keyToCssVar(key: string): string {
    return `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
  }

  /**
   * 通知监听器
   */
  private notifyListeners(): void {
    const config = this.getCurrentConfig();
    for (const listener of this.listeners) {
      listener(this.currentSkin, config);
    }
  }

  /**
   * 添加皮肤切换监听器
   */
  onChange(listener: SkinChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 获取所有可用皮肤列表
   */
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

/**
 * 皮肤系统测试（重构版）
 *
 * 设计原则：
 * - 默认皮肤完全独立，明暗模式由 Sidebar codem-theme 系统管理
 * - ThemeManager 只管理皮肤 ID 切换 + Dream 配置
 * - ThemeManager 不干预默认皮肤的 DOM/CSS
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { getSetting, setSetting } from "../core/storage/settings";
import { ThemeExtractor } from "../core/theme/theme-extractor";
import { ThemeManager } from "../core/theme/theme-manager";
import {
  SKIN_PRESETS,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  HUB_SKIN,
  DREAM_SKIN,
  DEFAULT_DREAM_CONFIG,
} from "../core/theme/presets";
import type { DreamSkinConfig, ExtractedPalette } from "../core/theme/types";

beforeEach(async () => {
  delete (window as any).__TAURI__;
  try {
    await resetDatabase();
  } catch {
    await initDatabase();
  }
  localStorage.clear();
  // 重置存储为默认值
  setSetting("skin-id", "default");
  setSetting("dream-config", JSON.stringify(DEFAULT_DREAM_CONFIG));
  // 清除 DOM 属性
  document.documentElement.removeAttribute("data-skin");
  ThemeManager.init();
});

describe("皮肤系统 - 预设配置", () => {
  it("SKIN_PRESETS 包含三套皮肤", () => {
    expect(SKIN_PRESETS.default).toBeDefined();
    expect(SKIN_PRESETS.hub).toBeDefined();
    expect(SKIN_PRESETS.dream).toBeDefined();
  });

  it("默认暗色皮肤颜色配置完整", () => {
    expect(DEFAULT_DARK.id).toBe("default");
    expect(DEFAULT_DARK.colors.accent).toMatch(/^#/);
    expect(DEFAULT_DARK.colors.bgPrimary).toBeDefined();
    expect(DEFAULT_DARK.colors.textPrimary).toBeDefined();
  });

  it("默认亮色皮肤继承默认皮肤结构", () => {
    expect(DEFAULT_LIGHT.id).toBe("default");
    expect(DEFAULT_LIGHT.colors.accent).not.toBe(DEFAULT_DARK.colors.accent);
  });

  it("Hub 皮肤使用橙色强调色", () => {
    expect(HUB_SKIN.id).toBe("hub");
    expect(HUB_SKIN.colors.accent).toBe("#ff6b00");
    expect(HUB_SKIN.layout.rightSidebarWidth).toBe(300);
    expect(HUB_SKIN.layout.topNavbarHeight).toBe(50);
  });

  it("梦幻皮肤默认配置正确", () => {
    expect(DEFAULT_DREAM_CONFIG.backgroundImage).toBeNull();
    expect(DEFAULT_DREAM_CONFIG.extractedPalette).toBeNull();
    expect(DEFAULT_DREAM_CONFIG.blurRadius).toBe(2);
    expect(DEFAULT_DREAM_CONFIG.cardOpacity).toBe(0.3);
    expect(DEFAULT_DREAM_CONFIG.decorations).toBe(true);
    expect(DEFAULT_DREAM_CONFIG.polaroid).toBe(true);
    expect(DEFAULT_DREAM_CONFIG.scriptFont).toBe(true);
    expect(DEFAULT_DREAM_CONFIG.safeArea).toBe("auto");
  });

  it("梦幻皮肤使用粉色系强调色", () => {
    expect(DREAM_SKIN.id).toBe("dream");
    expect(DREAM_SKIN.colors.accent).toBe("#e88c9a");
    expect(DREAM_SKIN.dream).toBeDefined();
  });
});

describe("皮肤系统 - ThemeManager 状态管理", () => {
  it("初始状态为 default 皮肤", () => {
    expect(ThemeManager.getSkin()).toBe("default");
  });

  it("切换到 hub 皮肤", () => {
    ThemeManager.setSkin("hub");
    expect(ThemeManager.getSkin()).toBe("hub");
  });

  it("切换到 dream 皮肤", () => {
    ThemeManager.setSkin("dream");
    expect(ThemeManager.getSkin()).toBe("dream");
  });

  it("皮肤切换后持久化到存储", () => {
    ThemeManager.setSkin("hub");
    expect(getSetting("skin-id")).toBe("hub");
  });

  it("从存储加载皮肤状态", () => {
    setSetting("skin-id", "dream");
    ThemeManager.init();
    expect(ThemeManager.getSkin()).toBe("dream");
  });

  it("无效皮肤 ID 保持 default", () => {
    setSetting("skin-id", "invalid-skin");
    ThemeManager.init();
    expect(ThemeManager.getSkin()).toBe("default");
  });

  it("getAvailableSkins 返回三套皮肤", () => {
    const skins = ThemeManager.getAvailableSkins();
    expect(skins).toHaveLength(3);
    expect(skins.map((s) => s.id)).toContain("default");
    expect(skins.map((s) => s.id)).toContain("hub");
    expect(skins.map((s) => s.id)).toContain("dream");
  });
});

describe("皮肤系统 - 默认皮肤不干预 DOM", () => {
  it("default 皮肤不设置 data-skin 属性", () => {
    ThemeManager.setSkin("default");
    expect(document.documentElement.getAttribute("data-skin")).toBeNull();
  });

  it("hub 皮肤设置 data-skin=hub", () => {
    ThemeManager.setSkin("hub");
    expect(document.documentElement.getAttribute("data-skin")).toBe("hub");
  });

  it("dream 皮肤设置 data-skin=dream", () => {
    ThemeManager.setSkin("dream");
    expect(document.documentElement.getAttribute("data-skin")).toBe("dream");
  });

  it("切回 default 清除 data-skin 属性", () => {
    ThemeManager.setSkin("hub");
    expect(document.documentElement.getAttribute("data-skin")).toBe("hub");
    ThemeManager.setSkin("default");
    expect(document.documentElement.getAttribute("data-skin")).toBeNull();
  });
});

describe("皮肤系统 - 梦幻皮肤配置", () => {
  it("初始梦幻配置为默认值", () => {
    const config = ThemeManager.getDreamConfig();
    expect(config.blurRadius).toBe(2);
    expect(config.cardOpacity).toBe(0.3);
    expect(config.decorations).toBe(true);
  });

  it("更新模糊度", () => {
    ThemeManager.updateDreamConfig({ blurRadius: 20 });
    expect(ThemeManager.getDreamConfig().blurRadius).toBe(20);
  });

  it("更新卡片透明度", () => {
    ThemeManager.updateDreamConfig({ cardOpacity: 0.8 });
    expect(ThemeManager.getDreamConfig().cardOpacity).toBe(0.8);
  });

  it("切换装饰元素显示", () => {
    ThemeManager.updateDreamConfig({ decorations: false });
    expect(ThemeManager.getDreamConfig().decorations).toBe(false);
  });

  it("切换拍立得显示", () => {
    ThemeManager.updateDreamConfig({ polaroid: false });
    expect(ThemeManager.getDreamConfig().polaroid).toBe(false);
  });

  it("切换手写字体", () => {
    ThemeManager.updateDreamConfig({ scriptFont: false });
    expect(ThemeManager.getDreamConfig().scriptFont).toBe(false);
  });

  it("设置安全区", () => {
    ThemeManager.updateDreamConfig({ safeArea: "left" });
    expect(ThemeManager.getDreamConfig().safeArea).toBe("left");
  });

  it("部分更新不覆盖其他字段", () => {
    ThemeManager.updateDreamConfig({ blurRadius: 25 });
    ThemeManager.updateDreamConfig({ cardOpacity: 0.9 });
    const config = ThemeManager.getDreamConfig();
    expect(config.blurRadius).toBe(25);
    expect(config.cardOpacity).toBe(0.9);
    expect(config.decorations).toBe(true);
  });

  it("梦幻配置持久化", () => {
    ThemeManager.updateDreamConfig({ blurRadius: 30, cardOpacity: 0.5 });
    const saved = getSetting("dream-config");
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved as string);
    expect(parsed.blurRadius).toBe(30);
    expect(parsed.cardOpacity).toBe(0.5);
  });

  it("从存储加载梦幻配置", () => {
    const customConfig: Partial<DreamSkinConfig> = {
      blurRadius: 18,
      cardOpacity: 0.7,
      decorations: false,
      polaroid: false,
      scriptFont: false,
      safeArea: "right",
    };
    setSetting("dream-config", JSON.stringify({ ...DEFAULT_DREAM_CONFIG, ...customConfig }));
    ThemeManager.init();
    const config = ThemeManager.getDreamConfig();
    expect(config.blurRadius).toBe(18);
    expect(config.decorations).toBe(false);
    expect(config.safeArea).toBe("right");
  });
});

describe("皮肤系统 - 监听器机制", () => {
  it("注册监听器后收到皮肤切换通知", () => {
    const listener = vi.fn();
    const unsubscribe = ThemeManager.onChange(listener);
    ThemeManager.setSkin("hub");
    expect(listener).toHaveBeenCalledWith("hub");
    unsubscribe();
  });

  it("取消订阅后不再收到通知", () => {
    const listener = vi.fn();
    const unsubscribe = ThemeManager.onChange(listener);
    unsubscribe();
    ThemeManager.setSkin("dream");
    expect(listener).not.toHaveBeenCalled();
  });

  it("多个监听器都收到通知", () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = ThemeManager.onChange(listener1);
    const unsub2 = ThemeManager.onChange(listener2);
    ThemeManager.setSkin("dream");
    expect(listener1).toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();
    unsub1();
    unsub2();
  });
});

describe("主题色提取器 - 颜色工具函数", () => {
  it("rgbToHex 正确转换", () => {
    expect(ThemeExtractor.rgbToHex({ r: 255, g: 0, b: 0 })).toBe("#ff0000");
    expect(ThemeExtractor.rgbToHex({ r: 0, g: 255, b: 0 })).toBe("#00ff00");
    expect(ThemeExtractor.rgbToHex({ r: 0, g: 0, b: 255 })).toBe("#0000ff");
    expect(ThemeExtractor.rgbToHex({ r: 255, g: 255, b: 255 })).toBe("#ffffff");
    expect(ThemeExtractor.rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
  });

  it("getLuminance 计算亮度", () => {
    expect(ThemeExtractor.getLuminance(255, 255, 255)).toBeCloseTo(1, 2);
    expect(ThemeExtractor.getLuminance(0, 0, 0)).toBe(0);
    expect(ThemeExtractor.getLuminance(0, 255, 0)).toBeGreaterThan(
      ThemeExtractor.getLuminance(255, 0, 0)
    );
  });
});

/**
 * Canvas 相关测试需要 mock，happy-dom 不支持 Canvas 2D API
 */
function mockCanvasContext(fillColor?: { r: number; g: number; b: number }) {
  const mockCtx: any = {
    fillStyle: "",
    drawImage: vi.fn(),
    getImageData: vi.fn(() => {
      const r = fillColor?.r ?? 255;
      const g = fillColor?.g ?? 0;
      const b = fillColor?.b ?? 0;
      const data = new Uint8ClampedArray(100 * 100 * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
      return { data };
    }),
    toDataURL: vi.fn(() => "data:image/jpeg;base64,mock"),
  };
  const mockCanvas: any = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => mockCtx),
    toDataURL: vi.fn(() => "data:image/jpeg;base64,mock"),
  };
  return { mockCanvas, mockCtx };
}

describe("主题色提取器 - extractPalette (mocked Canvas)", () => {
  it("从纯色图片提取色板", async () => {
    const { mockCanvas } = mockCanvasContext({ r: 255, g: 0, b: 0 });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") return mockCanvas;
      return origCreate(tag);
    });

    const origImage = global.Image;
    global.Image = class {
      src = "";
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        setTimeout(() => {
          this.onload?.();
        }, 0);
      }
    } as any;

    try {
      const palette = await ThemeExtractor.extractPalette("data:image/png;base64,mock");
      expect(palette.dominant).toMatch(/^#/);
      expect(palette.accent).toMatch(/^#/);
      expect(palette.background).toMatch(/^#/);
      expect(palette.palette.length).toBeGreaterThan(0);
      expect(palette.palette.length).toBeLessThanOrEqual(6);
    } finally {
      global.Image = origImage;
      vi.restoreAllMocks();
    }
  });

  it("亮色图片 isDark 为 false", async () => {
    const { mockCanvas } = mockCanvasContext({ r: 255, g: 255, b: 255 });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") return mockCanvas;
      return origCreate(tag);
    });
    const origImage = global.Image;
    global.Image = class {
      onload: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onload?.(), 0);
      }
    } as any;

    try {
      const palette = await ThemeExtractor.extractPalette("data:image/png;base64,mock");
      expect(palette.isDark).toBe(false);
    } finally {
      global.Image = origImage;
      vi.restoreAllMocks();
    }
  });

  it("暗色图片 isDark 为 true", async () => {
    // 亮度 = 50/255 = 0.196，在 MIN_BRIGHTNESS(0.15) 和 0.5 之间
    const { mockCanvas } = mockCanvasContext({ r: 50, g: 50, b: 50 });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") return mockCanvas;
      return origCreate(tag);
    });
    const origImage = global.Image;
    global.Image = class {
      onload: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onload?.(), 0);
      }
    } as any;

    try {
      const palette = await ThemeExtractor.extractPalette("data:image/png;base64,mock");
      expect(palette.isDark).toBe(true);
    } finally {
      global.Image = origImage;
      vi.restoreAllMocks();
    }
  });

  it("提取的色板每个颜色都是有效 hex", async () => {
    const { mockCanvas } = mockCanvasContext({ r: 124, g: 108, b: 240 });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") return mockCanvas;
      return origCreate(tag);
    });
    const origImage = global.Image;
    global.Image = class {
      onload: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onload?.(), 0);
      }
    } as any;

    try {
      const palette = await ThemeExtractor.extractPalette("data:image/png;base64,mock");
      for (const color of palette.palette) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    } finally {
      global.Image = origImage;
      vi.restoreAllMocks();
    }
  });
});

describe("主题色提取器 - 图片压缩 (mocked Canvas)", () => {
  it("compressImage 返回压缩后的 data URL", async () => {
    const { mockCanvas } = mockCanvasContext();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") return mockCanvas;
      return origCreate(tag);
    });
    const origImage = global.Image;
    global.Image = class {
      width = 3000;
      height = 2000;
      onload: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onload?.(), 0);
      }
    } as any;

    try {
      const compressed = await ThemeExtractor.compressImage(
        "data:image/png;base64,mock",
        1920,
        1080,
        0.8
      );
      expect(compressed).toMatch(/^data:image\/jpeg;base64,/);
    } finally {
      global.Image = origImage;
      vi.restoreAllMocks();
    }
  });
});

describe("主题色提取器 - fileToDataURL", () => {
  it("将 File 转为 data URL", async () => {
    const blob = new Blob(["test"], { type: "text/plain" });
    const file = new File([blob], "test.txt", { type: "text/plain" });
    const dataUrl = await ThemeExtractor.fileToDataURL(file);
    expect(dataUrl).toMatch(/^data:text\/plain;base64,/);
  });
});

describe("皮肤系统 - 边界情况", () => {
  it("损坏的梦幻配置 JSON 回退到默认", () => {
    // setSetting 存储字符串 'not-a-json'
    // init() 中 JSON.parse 会抛异常，被 catch 捕获，保持默认值
    setSetting("dream-config", "not-a-json");
    ThemeManager.init();
    const config = ThemeManager.getDreamConfig();
    expect(config.blurRadius).toBe(2);
    expect(config.cardOpacity).toBe(0.3);
  });

  it("setDreamBackground(null) 清除背景图和色板", async () => {
    ThemeManager.setSkin("dream");
    ThemeManager.updateDreamConfig({
      backgroundImage: "data:image/png;base64,abc",
      extractedPalette: {
        dominant: "#ff0000",
        accent: "#00ff00",
        background: "#ffffff",
        textPrimary: "#000000",
        textSecondary: "#666666",
        isDark: false,
        palette: ["#ff0000"],
      } as ExtractedPalette,
    });
    await ThemeManager.setDreamBackground(null, false);
    const config = ThemeManager.getDreamConfig();
    expect(config.backgroundImage).toBeNull();
    expect(config.extractedPalette).toBeNull();
  });

  it("多次切换皮肤状态一致", () => {
    ThemeManager.setSkin("hub");
    expect(ThemeManager.getSkin()).toBe("hub");
    ThemeManager.setSkin("dream");
    expect(ThemeManager.getSkin()).toBe("dream");
    ThemeManager.setSkin("default");
    expect(ThemeManager.getSkin()).toBe("default");
    ThemeManager.setSkin("hub");
    expect(ThemeManager.getSkin()).toBe("hub");
  });
});

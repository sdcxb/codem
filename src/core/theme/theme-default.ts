/**
 * 主题档位的**唯一真相源**（第 36 波）。
 *
 * 背景：默认主题此前散在 5 个地方各写一遍 `|| "dark"`（TitleBar / SkinSelector /
 * CodeBlockView / ThemeManager / CSS 的 `:root` 选择器），改默认档位要同时改五处，
 * 而且首屏还会闪一下 —— `index.html` 里没有 data-theme，浏览器先按 `:root`（当时的暗色）
 * 渲染一帧，等 JS 读到设置再切，浅色用户能看到明显的白/黑闪烁。
 *
 * 现在：
 * - `DEFAULT_THEME` 是唯一的默认档位（浅色暖中性，与参考实现的取向一致）；
 * - 主题变化时往 localStorage 写一份**同步可读**的镜像，`index.html` 的内联脚本
 *   在首屏渲染前就读它并设置 `data-theme`，两个方向都不再闪烁
 *   （SQLite 里的 `codem-theme` 仍是真相源，镜像只是"首屏预测"）。
 */

export type ThemeMode = "light" | "dark";

/** 默认主题档位：改这一行即可全局改默认（CSS 的 `:root` 也对应这一档） */
export const DEFAULT_THEME: ThemeMode = "light";

/** 设置里的键（SQLite 持久化，真相源） */
export const THEME_SETTING_KEY = "codem-theme";

/** localStorage 镜像键（首屏同步读取，避免闪烁） */
export const THEME_CACHE_KEY = "codem-theme-cache";

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark";
}

/** 读取首屏镜像；读不到就用默认档位 */
export function readCachedTheme(): ThemeMode {
  try {
    const v = globalThis.localStorage?.getItem(THEME_CACHE_KEY);
    return isThemeMode(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function cacheTheme(mode: ThemeMode): void {
  try {
    globalThis.localStorage?.setItem(THEME_CACHE_KEY, mode);
  } catch {
    /* localStorage 不可用时静默降级：只是少了首屏预测 */
  }
}

/**
 * 把档位写到 DOM。默认档位也显式写属性（而不是靠"没有属性"表示默认）——
 * 这样读代码的人不必记得"缺省是什么"，CSS 两档也完全对称。
 */
export function applyThemeAttribute(mode: ThemeMode, root?: HTMLElement | null): void {
  const el = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  el.setAttribute("data-theme", mode);
  cacheTheme(mode);
}

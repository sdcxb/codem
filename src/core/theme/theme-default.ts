/**
 * 主题档位的**唯一真相源**（第 36 波；第 60 波补「启动期有效值」）。
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
 *
 * 第 60 波修复「启动时先白后暗 / 先黑后亮 / 黑→亮→黑」（用户报的老问题，三个现象一个根因）：
 * 应用启动时 SQLite 还没就绪，而 TitleBar 的 `theme` 状态是用「DB → **默认档**」初始化的
 * —— 于是**挂载 effect 会把默认档写进 DOM，同时把镜像也改成默认档**：
 *   ① 暗色用户：预渲染已是暗色 → 挂载瞬间被改成浅色（白闪）→ DB 就绪后再改回暗色；
 *   ② 若进程在那 1 秒里退出，镜像就永久停在错的档位 → 下次启动预渲染直接用错档（黑/白闪）。
 * 于是这里给出**启动期有效值** `resolveEffectiveTheme()`：**DB（就绪后）→ 镜像 → 默认档**，
 * 启动路径（TitleBar / SkinSelector / ThemeManager）一律用它，不再各自 `|| DEFAULT_THEME`。
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
    if (globalThis.localStorage?.getItem(THEME_CACHE_KEY) === mode) return; // 值没变就不写，避免无谓抖动
    globalThis.localStorage?.setItem(THEME_CACHE_KEY, mode);
  } catch {
    /* localStorage 不可用时静默降级：只是少了首屏预测 */
  }
}

/**
 * **启动期有效主题**：DB（真相源，就绪后）→ 镜像（首屏预测 / DB 未就绪）→ 默认档。
 *
 * 关键点：DB 未就绪时返回的是**镜像**而不是默认档 —— 镜像记录的是"上次实际生效的档位"，
 * 也正是 `index.html` 内联脚本已经写进 `data-theme` 的那个值。启动路径用它，才不会
 * 把预渲染好的正确档位覆盖成默认档。
 *
 * 说明：这里**不**静态 import 存储模块 —— 因为 `index.html` 的内联脚本与 `main.tsx` 的最早阶段
 * 都会走这个文件，把 SQLite（sql.js）拖进来会拖慢首屏。读取回调由调用方注入
 * （组件里传 `getSetting`；不传时退化为"只看镜像"）。
 *
 * @param readSetting 读设置的回调（DB 未就绪时它自然返回 null）
 */
export function resolveEffectiveTheme(readSetting?: (key: string) => string | null): ThemeMode {
  let saved: string | null = null;
  try {
    if (readSetting) saved = readSetting(THEME_SETTING_KEY);
  } catch {
    saved = null;
  }
  if (isThemeMode(saved)) return saved;
  return readCachedTheme();
}

/**
 * 把档位写到 DOM。默认档位也显式写属性（而不是靠"没有属性"表示默认）——
 * 这样读代码的人不必记得"缺省是什么"，CSS 两档也完全对称。
 * **幂等**：值没变时不碰 DOM、不重写镜像。
 */
export function applyThemeAttribute(mode: ThemeMode, root?: HTMLElement | null): void {
  const el = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  if (el.getAttribute("data-theme") === mode) {
    cacheTheme(mode); // 镜像可能缺失（首次启动），补一次即可
    return;
  }
  el.setAttribute("data-theme", mode);
  cacheTheme(mode);
}

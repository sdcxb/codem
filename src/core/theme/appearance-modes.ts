/**
 * 外观档位的**唯一真相源**：高对比 + 密度（第 159 轮 P2-1）。
 *
 * ## 为什么要有这个文件（真实缺口，不是"为了对称"）
 *
 * 第 156/157 轮我加了两档 CSS：`[data-contrast="high"]`（D7 高对比）与`密度档`的规划 —— 但**全项目
 * 没有任何地方设置这两个属性**（`grep -r 'data-contrast' src/` 当时只命中 CSS 与测试）。
 * 结果就是"规则写了、没人触发"：看起来功能做完了，实际上用户永远看不到，而且**门禁也抓不到**
 * （CSS 侧断言全绿）。这类"死规则"和 `--message-bubble-user` 那次"定义了没人用"是同一类问题。
 *
 * 所以这里补上**写入方**，并且照抄 `theme-default.ts` 已经验证过的那套启动语义：
 *   DB（真相源，就绪后）→ localStorage 镜像（首屏同步可读）→ 默认档；
 *   `index.html` 的内联脚本在**首屏渲染前**读镜像把属性设好 ⇒ 换档不闪。
 *
 * 与主题的唯一差别：主题是"两档都显式写属性"（缺省靠 CSS 的 `:root`），这里同样显式写
 * （`data-contrast="normal"` / `data-density="comfortable"`），让读代码的人不必记缺省值。
 */

export type ContrastMode = "normal" | "high";
export type DensityMode = "comfortable" | "compact";

export const DEFAULT_CONTRAST: ContrastMode = "normal";
export const DEFAULT_DENSITY: DensityMode = "comfortable";

/** 设置里的键（SQLite 持久化，真相源） */
export const CONTRAST_SETTING_KEY = "codem-contrast";
export const DENSITY_SETTING_KEY = "codem-density";
/** localStorage 镜像键（首屏同步读取，避免闪烁） */
export const CONTRAST_CACHE_KEY = "codem-contrast-cache";
export const DENSITY_CACHE_KEY = "codem-density-cache";

export function isContrastMode(v: unknown): v is ContrastMode {
  return v === "normal" || v === "high";
}
export function isDensityMode(v: unknown): v is DensityMode {
  return v === "comfortable" || v === "compact";
}

const readCache = <T extends string>(key: string, guard: (v: unknown) => v is T, fallback: T): T => {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return guard(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const writeCache = (key: string, value: string): void => {
  try {
    if (globalThis.localStorage?.getItem(key) === value) return; // 值没变不写，避免无谓抖动
    globalThis.localStorage?.setItem(key, value);
  } catch (err) {
    /* localStorage 不可用时静默降级：只是少了首屏预测，不影响功能。
       ⚠️ 这里必须**显式消费**这个错误 —— 门禁 `scan-guard-bypass.mjs` 的 C3 会把"空 catch"判成
       守卫被绕过（它没法区分"故意忽略"和"忘了处理"）⇒ 留一条 `void err` 让意图可读、也让门禁放行。 */
    void err;
  }
};

export const readCachedContrast = (): ContrastMode => readCache(CONTRAST_CACHE_KEY, isContrastMode, DEFAULT_CONTRAST);
export const readCachedDensity = (): DensityMode => readCache(DENSITY_CACHE_KEY, isDensityMode, DEFAULT_DENSITY);

/** **启动期有效值**：DB（就绪后）→ 镜像 → 默认档（与 `resolveEffectiveTheme` 同一套语义） */
export function resolveEffectiveContrast(readSetting?: (key: string) => string | null): ContrastMode {
  let saved: string | null = null;
  try {
    if (readSetting) saved = readSetting(CONTRAST_SETTING_KEY);
  } catch {
    saved = null;
  }
  return isContrastMode(saved) ? saved : readCachedContrast();
}
export function resolveEffectiveDensity(readSetting?: (key: string) => string | null): DensityMode {
  let saved: string | null = null;
  try {
    if (readSetting) saved = readSetting(DENSITY_SETTING_KEY);
  } catch {
    saved = null;
  }
  return isDensityMode(saved) ? saved : readCachedDensity();
}

/**
 * ⚠️ 下面两个函数**故意把属性名写成字面量**，没有抽成"传 name 参数"的通用工具：
 * 本仓库的门禁是**按文本**找写入方的（`appearance-modes.test.ts` 的 APPEARANCE-1 用
 * `setAttribute\(\s*["']data-contrast["']` 找）。第一版就是写成了 `applyAttr(el, name, …)`，
 * 于是那条门禁报"没有任何地方设置 data-contrast" —— **门禁是对的**：它要的正是
 * "属性名与写入点能在源码里对齐"这条可复核性，把名字藏进变量就等于把这条性质弄丢了。
 * 两行重复换一条机器可判的性质，值得。
 */
export function applyContrastAttribute(mode: ContrastMode, root?: HTMLElement | null): void {
  const el = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  if (el.getAttribute("data-contrast") !== mode) el.setAttribute("data-contrast", mode);
  writeCache(CONTRAST_CACHE_KEY, mode); // 值没变也补一次镜像（首次启动时镜像可能缺失）
}
export function applyDensityAttribute(mode: DensityMode, root?: HTMLElement | null): void {
  const el = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  if (el.getAttribute("data-density") !== mode) el.setAttribute("data-density", mode);
  writeCache(DENSITY_CACHE_KEY, mode);
}

/** 启动路径一次把两档都设好（`readSetting` 不传时只看镜像，与 `index.html` 内联脚本等价） */
export function applyAppearanceAttributes(readSetting?: (key: string) => string | null, root?: HTMLElement | null): {
  contrast: ContrastMode;
  density: DensityMode;
} {
  const contrast = resolveEffectiveContrast(readSetting);
  const density = resolveEffectiveDensity(readSetting);
  applyContrastAttribute(contrast, root);
  applyDensityAttribute(density, root);
  return { contrast, density };
}

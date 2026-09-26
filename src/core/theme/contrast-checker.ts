/**
 * contrast-checker — WCAG 2.1 对比度计算工具
 *
 * 用于验证三套皮肤（default / hub / dream）的颜色配对是否满足无障碍标准。
 * 计算 relative luminance 后求对比比比率。
 *
 * 参考：https://www.w3.org/TR/WCAG21/#contrast-minimum
 */

/** 将 hex 颜色解析为 {r, g, b}（0–255） */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace(/^#/, "").trim();
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    return { r, g, b };
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return { r, g, b };
  }
  return null;
}

/**
 * 尝试从 rgba/rgb 字符串中提取 r,g,b 值。
 * 如果包含 alpha，会与背景混合后返回等效 rgb。
 */
function parseRgba(color: string): { r: number; g: number; b: number } | null {
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!m) return null;
  const r = parseFloat(m[1]);
  const g = parseFloat(m[2]);
  const b = parseFloat(m[3]);
  const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
  if (a >= 1) return { r, g, b };
  // 与白色背景混合（模拟最常见的底色）
  return {
    r: Math.round(r * a + 255 * (1 - a)),
    g: Math.round(g * a + 255 * (1 - a)),
    b: Math.round(b * a + 255 * (1 - a)),
  };
}

/** 将颜色字符串（hex 或 rgba）解析为 {r, g, b} */
export function parseColor(color: string): { r: number; g: number; b: number } | null {
  if (!color) return null;
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) return hexToRgb(trimmed);
  if (trimmed.startsWith("rgb")) return parseRgba(trimmed);
  return null;
}

/**
 * **解析"派生令牌"**（`var(--x)` / `color-mix(...)`）—— 第 159 轮 P1-2 新增。
 *
 * 起因很具体：文字三档改成从 `--text-base` 派生之后（`color-mix(in srgb, var(--text-base) 75%, …)`），
 * 这个检查器立刻解析不出来（它只认 hex/rgb），`skin-contrast.test.ts` 当场红。
 * 也就是说：**令牌一解耦，对比度门禁就瞎了** —— 这不是"测试要改"，而是检查器缺能力。
 *
 * 口径：只能解析它**明确支持**的两种写法（`var()` 查 `vars` 表、`color-mix(in srgb, A p%, B)`），
 * 其余一律返回 null（**不做猜测**：猜出来的对比度等于没测）。
 *
 * @param color 颜色值或派生表达式
 * @param vars  变量表（`{ "--text-base": "#1f1f1e", … }`），解析 `var()` 用
 */
export function parseColorValue(color: string, vars?: Record<string, string>, depth = 0): { r: number; g: number; b: number } | null {
  if (!color) return null;
  if (depth > 8) return null; // 防循环引用
  const v = color.trim();

  const alias = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(v);
  if (alias) {
    const found = vars?.[alias[1]];
    if (found !== undefined) return parseColorValue(found, vars, depth + 1);
    return alias[2] !== undefined ? parseColorValue(alias[2], vars, depth + 1) : null;
  }

  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\)$/i.exec(v);
  if (mix) {
    const a = parseColorValue(mix[1], vars, depth + 1);
    const b = parseColorValue(mix[3], vars, depth + 1);
    if (!a || !b) return null;
    const w = Number(mix[2]) / 100;
    return {
      r: Math.round(a.r * w + b.r * (1 - w)),
      g: Math.round(a.g * w + b.g * (1 - w)),
      b: Math.round(a.b * w + b.b * (1 - w)),
    };
  }

  if (/^transparent$/i.test(v)) return { r: 0, g: 0, b: 0 };
  return parseColor(v);
}

/** 计算单个通道的线性值（sRGB → linear） */
function channelLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * 计算相对亮度（relative luminance）
 * 返回 0–1 的值，0 = 最暗，1 = 最亮
 */
export function relativeLuminance(color: string, vars?: Record<string, string>): number | null {
  const rgb = parseColorValue(color, vars);
  if (!rgb) return null;
  const rl = 0.2126 * channelLinear(rgb.r) + 0.7152 * channelLinear(rgb.g) + 0.0722 * channelLinear(rgb.b);
  return rl;
}

/**
 * 计算两个颜色之间的 WCAG 对比度比率
 * 返回 1–21 的值（1 = 无对比，21 = 最大对比）
 */
export function contrastRatio(fg: string, bg: string, vars?: Record<string, string>): number | null {
  const l1 = relativeLuminance(fg, vars);
  const l2 = relativeLuminance(bg, vars);
  if (l1 === null || l2 === null) return null;
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 等级判定结果 */
export interface ContrastResult {
  ratio: number;
  /** AA 标准：正常文本 ≥ 4.5，大文本 ≥ 3.0 */
  passesAA: boolean;
  /** AA 标准：大文本（≥18pt 或 ≥14pt bold） */
  passesAALarge: boolean;
  /** AAA 标准：正常文本 ≥ 7.0，大文本 ≥ 4.5 */
  passesAAA: boolean;
  /** AAA 标准：大文本 */
  passesAAALarge: boolean;
  /** 人类可读的等级标签 */
  grade: "AAA" | "AA" | "AA Large" | "Fail";
}

/**
 * 判定对比度是否满足 WCAG 标准。
 * `vars` 可选：给了它就能解析 `var()` / `color-mix()` 这类**派生令牌**（第 159 轮 P1-2）。
 */
export function evaluateContrast(fg: string, bg: string, vars?: Record<string, string>): ContrastResult | null {
  const ratio = contrastRatio(fg, bg, vars);
  if (ratio === null) return null;

  const passesAA = ratio >= 4.5;
  const passesAALarge = ratio >= 3.0;
  const passesAAA = ratio >= 7.0;
  const passesAAALarge = ratio >= 4.5;

  let grade: ContrastResult["grade"] = "Fail";
  if (passesAAA) grade = "AAA";
  else if (passesAA) grade = "AA";
  else if (passesAALarge) grade = "AA Large";

  return { ratio, passesAA, passesAALarge, passesAAA, passesAAALarge, grade };
}

/** 颜色配对定义 */
export interface ColorPair {
  name: string;
  fg: string;
  bg: string;
}

/** 检查一组颜色配对，返回所有结果 */
export function checkPairs(pairs: ColorPair[]): Array<ColorPair & { result: ContrastResult | null }> {
  return pairs.map((p) => ({ ...p, result: evaluateContrast(p.fg, p.bg) }));
}

/**
 * 将比率格式化为可读字符串
 */
export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(2)}:1`;
}

/* ==========================================================================
 * α 感知的颜色解析与合成（第 165 轮 P2-1 高对比档新增）
 *
 * ## 为什么需要**另**一个解析器（不是把上面那个改掉）
 *
 * 上面那两个（`parseColorValue` / `parseColor`）有两个已知限制，正好卡在本轮的判据上：
 *  ① **认不出空格写法**：`parseRgba` 的正则是逗号版 `rgba?\(\s*(\d+)\s*,…`，
 *     而 `--border-primary` 亮色档写的是 `rgb(31 31 30 / 9%)`（现代语法）⇒ 直接返回 null，
 *     **半透明边框的可见度从来没人量过**；
 *  ② **α 被丢掉或按"合成到白底"折算**：`color-mix(in srgb, var(--text-base) 26%, transparent)`
 *     这种写法解析出来会是"墨混黑"的实色，而不是"α=0.26 的墨"⇒ 合到面上算出来的对比度是错的。
 *
 * 所以这里补一组**按 CSS 规范**解析的函数（只新增，不动上面那两个 —— 它们的口径已被
 * `skin-contrast.test.ts` / `light-theme-contrast.test.ts` 钉住，改它们等于改别人的判据）。
 *
 * ## 一个必须记住的点：`color-mix(in srgb, …)` 是**预乘 α** 混合
 *
 * 规范（CSS Color 5）规定 `in srgb` 也要先预乘再插值，否则 `color-mix(C 50%, transparent)`
 * 会算成"暗一半的 C 且 α 未知"。正确结果是 **C 本身、α=0.5**：
 *   `color-mix(in srgb, red 50%, transparent)` 压在白底上 = `#ff8080`（不是 `#bf7f7f`）。
 * 这个坑在本仓库**已经出现过三次**，`ALPHA-1` 用规范里的参照值把它钉住。
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const hexToRgba = (hex: string): Rgba | null => {
  const c = hex.replace(/^#/, "").trim();
  if (c.length === 3 || c.length === 4) {
    const [r, g, b, a] = c.split("").map((x) => parseInt(x + x, 16));
    return { r, g, b, a: c.length === 4 ? a / 255 : 1 };
  }
  if (c.length === 6 || c.length === 8) {
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const a = c.length === 8 ? parseInt(c.slice(6, 8), 16) / 255 : 1;
    return Number.isNaN(r + g + b + a) ? null : { r, g, b, a };
  }
  return null;
};

/** `rgb()` / `rgba()`：**逗号与空格两种写法都认**，α 支持 `0.5` 与 `50%` */
const rgbFnToRgba = (value: string): Rgba | null => {
  const m = /^rgba?\(([^)]*)\)$/i.exec(value.trim());
  if (!m) return null;
  const parts = m[1]
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const num = (x: string) => (x.endsWith("%") ? (Number(x.slice(0, -1)) / 100) * 255 : Number(x));
  const r = num(parts[0]);
  const g = num(parts[1]);
  const b = num(parts[2]);
  let a = 1;
  if (parts[3] !== undefined) a = parts[3].endsWith("%") ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
  if ([r, g, b, a].some((x) => Number.isNaN(x))) return null;
  return { r, g, b, a };
};

/**
 * 解析任意颜色/派生表达式为 `{ r, g, b, a }`；解析不了返回 `null`。
 *
 * 支持：`#rgb/#rgba/#rrggbb/#rrggbbaa`、`rgb()/rgba()`（逗号或空格、α 小数或百分比）、
 * `transparent`、`var(--令牌)`（查 `vars`）、`color-mix(in srgb, A p%, B)`（**预乘 α**）。
 * 其余一律 `null` —— **不猜**：猜出来的对比度等于没测。
 * （命名色 `white` / `hsl()` 都**不在**支持范围内：令牌里不用它们，而"按近似值悄悄算"是这一路上出过三次的错。）
 */
export function resolveRgba(color: string, vars?: Record<string, string>, depth = 0): Rgba | null {
  if (!color) return null;
  if (depth > 8) return null; // 防循环引用
  const v = color.trim();
  if (/^transparent$/i.test(v)) return { r: 0, g: 0, b: 0, a: 0 };
  const alias = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(v);
  if (alias) {
    const found = vars?.[alias[1]];
    if (found !== undefined) return resolveRgba(found, vars, depth + 1);
    return alias[2] !== undefined ? resolveRgba(alias[2], vars, depth + 1) : null;
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\)$/i.exec(v);
  if (mix) {
    const a = resolveRgba(mix[1], vars, depth + 1);
    const b = resolveRgba(mix[3], vars, depth + 1);
    if (!a || !b) return null;
    const w = Number(mix[2]) / 100;
    /* 预乘 α：先各自乘自己的 α 加权，再除以合成后的 α 还原成"逻辑颜色" */
    const alpha = a.a * w + b.a * (1 - w);
    if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (x: number, y: number) => Math.round((x * a.a * w + y * b.a * (1 - w)) / alpha);
    return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b), a: alpha };
  }
  if (v.startsWith("#")) return hexToRgba(v);
  if (/^rgba?\(/i.test(v)) return rgbFnToRgba(v);
  return null;
}

/** 源覆盖合成（`fg` 压在 `bg` 上），返回不透明或半透明的结果 */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (x: number, y: number) => Math.round((x * fg.a + y * bg.a * (1 - fg.a)) / a);
  return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b), a };
}

/** 两个**已解析**颜色之间的对比度（α 先合成到不透明白底上，避免"没合成就量"） */
export function contrastOfRgba(fg: Rgba, bg: Rgba): number {
  const opaque = (c: Rgba) => (c.a >= 1 ? c : compositeOver(c, { r: 255, g: 255, b: 255, a: 1 }));
  return ratioOfOpaque(opaque(fg), opaque(bg));
}

function ratioOfOpaque(a: Rgba, b: Rgba): number {
  const lum = (c: Rgba) => 0.2126 * channelLinear(c.r) + 0.7152 * channelLinear(c.g) + 0.0722 * channelLinear(c.b);
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * **半透明前景压在背景上的可见度**：先把 `fg` 合成到 `bg` 上，再和 `bg` 比。
 * 这正是"边框/分隔线够不够实"的判据 —— `--border-primary` 是 `rgb(31 31 30 / 9%)` 这种带 α 的值，
 * 不合成直接算会得到"纯墨压白底 16:1"这种没有意义的数字。
 */
export function visibleContrastOver(fg: string, bg: string, vars?: Record<string, string>): number | null {
  const f = resolveRgba(fg, vars);
  const b = resolveRgba(bg, vars);
  if (!f || !b) return null;
  const bgOpaque = b.a >= 1 ? b : compositeOver(b, { r: 255, g: 255, b: 255, a: 1 });
  return ratioOfOpaque(compositeOver(f, bgOpaque), bgOpaque);
}

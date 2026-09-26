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

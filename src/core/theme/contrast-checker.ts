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

/** 计算单个通道的线性值（sRGB → linear） */
function channelLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * 计算相对亮度（relative luminance）
 * 返回 0–1 的值，0 = 最暗，1 = 最亮
 */
export function relativeLuminance(color: string): number | null {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const rl = 0.2126 * channelLinear(rgb.r) + 0.7152 * channelLinear(rgb.g) + 0.0722 * channelLinear(rgb.b);
  return rl;
}

/**
 * 计算两个颜色之间的 WCAG 对比度比率
 * 返回 1–21 的值（1 = 无对比，21 = 最大对比）
 */
export function contrastRatio(fg: string, bg: string): number | null {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
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
 * 判定对比度是否满足 WCAG 标准
 */
export function evaluateContrast(fg: string, bg: string): ContrastResult | null {
  const ratio = contrastRatio(fg, bg);
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

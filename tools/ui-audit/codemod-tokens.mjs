/**
 * UI 令牌化 codemod（开发工具）。
 *
 * 把「本该用令牌却写死」的字面量替换成语义令牌，**只做一对一、无歧义的映射**：
 * 颜色 → 语义令牌、字号 → --fs-* 刻度、圆角 → --radius-* 刻度。
 *
 * 安全边界：
 * - 只改 `style={{ … }}` 里的 TSX 字面量（SVG/Canvas 属性与图表入参不吃 CSS 变量，一律不碰）；
 * - CSS 文件全量处理（但跳过 :root/[data-theme]/[data-skin] 令牌定义块）；
 * - 复杂表达式（渐变、多层 color-mix、动态拼接）不猜，留在审计报告里人工处理。
 *
 * 用法：
 *   node tools/ui-audit/codemod-tokens.mjs            # 预览（不写文件）
 *   node tools/ui-audit/codemod-tokens.mjs --write    # 实际写入
 *   node tools/ui-audit/codemod-tokens.mjs --file=src/components/X.tsx --write
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const EXCLUDE_DIRS = new Set(["node_modules", "dist", "target", "test", "__snapshots__", ".git"]);
/** 与 scan-ui.mjs 保持一致的例外（美术/令牌/内容配色） */
const ALLOWLIST = [
  /^src\/core\/theme\//,
  /^src\/core\/knowledge\/ppt-/,
  /^src\/plugins\/monopoly-game\//,
  /^src\/plugins\/library-ops\/data\/characters\.ts$/,
  /^src\/styles\.css$/,
  /\.test\.(ts|tsx)$/,
];

// ========== 映射表（一对一、无语义歧义；按属性分类，白/灰在不同属性里语义不同） ==========
const TEXT_MAP = new Map([
  ["#fff", "var(--text-on-accent)"],
  ["#ffffff", "var(--text-on-accent)"],
  ["white", "var(--text-on-accent)"],
  ["#e8e8f0", "var(--text-primary)"],
  ["#e0e0e0", "var(--text-primary)"],
  ["#d4d4d4", "var(--text-primary)"],
  ["#b0b0b0", "var(--text-secondary)"],
  ["#aaa", "var(--text-secondary)"],
  ["#a0a0a0", "var(--text-secondary)"],
  ["#888", "var(--text-muted)"],
  ["#888888", "var(--text-muted)"],
  ["#6b7280", "var(--text-muted)"],
  ["#666", "var(--text-muted)"],
  ["#555", "var(--text-muted)"],
  ["#22c55e", "var(--success)"],
  ["#2ecc71", "var(--success)"],
  ["#10b981", "var(--success)"],
  ["#3fb950", "var(--success)"],
  ["#ef4444", "var(--error)"],
  ["#e74c3c", "var(--error)"],
  ["#f87171", "var(--error)"],
  ["#f85149", "var(--error)"],
  ["#eab308", "var(--warning)"],
  ["#f59e0b", "var(--warning)"],
  ["#d29922", "var(--warning)"],
  ["#3b82f6", "var(--info)"],
  ["#60a5fa", "var(--info)"],
  ["#58a6ff", "var(--info)"],
  ["#7c6cf0", "var(--accent)"],
  ["#6366f1", "var(--accent)"],
  ["#9333ea", "var(--accent)"],
  ["#a855f7", "var(--accent)"],
  ["#c084fc", "var(--accent)"],
  ["#4ade80", "var(--success)"],
  ["#ff8080", "var(--error)"],
  ["#ff6b00", "var(--warning)"],
  ["#fb923c", "var(--warning)"],
]);

/** 背景属性：白/黑/灰是"面"，映射到层级令牌而不是文字色 */
const SURFACE_MAP = new Map([
  ["#fff", "var(--bg-primary)"],
  ["#ffffff", "var(--bg-primary)"],
  ["white", "var(--bg-primary)"],
  ["#000", "var(--bg-primary)"],
  ["#0a0a0a", "var(--bg-primary)"],
  ["#121212", "var(--bg-primary)"],
  ["#1c1c1e", "var(--bg-secondary)"],
  ["#1f2328", "var(--bg-secondary)"],
  ["#2a2a2a", "var(--bg-tertiary)"],
  ["#333", "var(--bg-hover)"],
  ["#ef4444", "var(--error)"],
  ["#22c55e", "var(--success)"],
  ["#2ecc71", "var(--success)"],
  ["#7c6cf0", "var(--accent)"],
  ["rgba(0,0,0,0.5)", "var(--overlay-backdrop)"],
  ["rgba(0, 0, 0, 0.5)", "var(--overlay-backdrop)"],
  ["rgba(0,0,0,0.6)", "var(--overlay-backdrop-strong)"],
  ["rgba(0, 0, 0, 0.6)", "var(--overlay-backdrop-strong)"],
  ["rgba(0,0,0,0.7)", "var(--overlay-backdrop-strong)"],
  ["rgba(0,0,0,0.85)", "var(--overlay-backdrop-strong)"],
  ["rgba(0,0,0,0.4)", "var(--overlay-backdrop)"],
  ["rgba(0, 0, 0, 0.4)", "var(--overlay-backdrop)"],
  ["rgba(255,255,255,0.15)", "var(--bg-hover)"],
  ["rgba(255, 255, 255, 0.15)", "var(--bg-hover)"],
  ["rgba(255,255,255,0.1)", "var(--bg-hover)"],
  ["rgba(255, 255, 255, 0.1)", "var(--bg-hover)"],
  ["rgba(30, 30, 46, 0.92)", "var(--bg-secondary)"],
  ["rgba(24, 26, 38, 0.92)", "var(--bg-secondary)"],
  ["#ff6b00", "var(--warning)"],
  ["#ef4444", "var(--error)"],
]);

/** 边框属性 */
const BORDER_MAP = new Map([
  ["#fff", "var(--border-primary)"],
  ["#ffffff", "var(--border-primary)"],
  ["#888", "var(--border-primary)"],
  ["#555", "var(--border-primary)"],
  ["#22c55e", "var(--success)"],
  ["#ef4444", "var(--error)"],
  ["#3b82f6", "var(--info)"],
  ["#6b7280", "var(--border-primary)"],
  ["rgba(255,255,255,0.1)", "var(--border-primary)"],
  ["rgba(255, 255, 255, 0.1)", "var(--border-primary)"],
  ["rgba(255,255,255,0.06)", "var(--border-secondary)"],
  ["rgba(255, 255, 255, 0.06)", "var(--border-secondary)"],
]);

/** 兼容旧引用（CSS 里无属性上下文时的兜底表 = 文字表） */
const COLOR_MAP = TEXT_MAP;

/**
 * 颜色族 → 令牌 + 通道值：用于把 `rgba(R,G,B,a)` 的**淡色底/淡色边**改写成
 * `color-mix(in srgb, var(--token) N%, transparent)`（状态色不做实心填充的规范做法）。
 */
const TINT_FAMILIES = [
  { rgb: [239, 68, 68], token: "--error" },
  { rgb: [231, 76, 60], token: "--error" },
  { rgb: [248, 81, 73], token: "--error" },
  { rgb: [34, 197, 94], token: "--success" },
  { rgb: [46, 204, 113], token: "--success" },
  { rgb: [16, 185, 129], token: "--success" },
  { rgb: [234, 179, 8], token: "--warning" },
  { rgb: [245, 158, 11], token: "--warning" },
  { rgb: [209, 153, 34], token: "--warning" },
  { rgb: [124, 108, 240], token: "--accent" },
  { rgb: [99, 102, 241], token: "--accent" },
  { rgb: [147, 51, 234], token: "--accent" },
  { rgb: [59, 130, 246], token: "--info" },
  { rgb: [96, 165, 250], token: "--info" },
];

function tintFor(r, g, b, a) {
  const fam = TINT_FAMILIES.find((f) => f.rgb[0] === r && f.rgb[1] === g && f.rgb[2] === b);
  if (!fam) return null;
  const pct = Math.round(a * 100);
  if (pct <= 0 || pct >= 100) return null;
  return `color-mix(in srgb, var(${fam.token}) ${pct}%, transparent)`;
}

/** 在任意属性里把 rgba(状态色, alpha) 换成 color-mix 令牌表达 */
function transformTints(line, rel, lineNo) {
  return line.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/g, (m, r, g, b, a) => {
    const tint = tintFor(Number(r), Number(g), Number(b), Number(a));
    if (!tint) return m;
    record(rel, lineNo, m, tint);
    return tint;
  });
}

function mapForProp(prop) {
  if (/^background/i.test(prop)) return SURFACE_MAP;
  if (/border/i.test(prop)) return BORDER_MAP;
  return TEXT_MAP;
}

/** 字号字面量 → 刻度令牌 */
const FS_MAP = new Map([
  ["8", "var(--fs-xs)"],
  ["9", "var(--fs-xs)"],
  ["10", "var(--fs-xs)"],
  ["11", "var(--fs-sm)"],
  ["12", "var(--fs-sm)"],
  ["13", "var(--fs-base)"],
  ["14", "var(--fs-md)"],
  ["15", "var(--fs-md)"],
  ["16", "var(--fs-lg)"],
  ["17", "var(--fs-lg)"],
  ["18", "var(--fs-xl)"],
  ["20", "var(--fs-2xl)"],
  ["24", "var(--fs-3xl)"],
  ["28", "var(--fs-3xl)"],
  ["32", "var(--fs-3xl)"],
  ["40", "var(--fs-3xl)"],
]);

/** 圆角字面量 → 刻度令牌 */
const RADIUS_MAP = new Map([
  ["3", "var(--radius-sm)"],
  ["5", "var(--radius-sm)"],
  ["7", "var(--radius)"],
  ["9", "var(--radius-md)"],
]);

/**
 * 间距离格值 → 最近的对齐值（2px 网格）。
 * 只处理**离格**的数字（3/5/7/9/11/13），对齐值最多 ±1px，肉眼不可见；
 * 已对齐的值一律不动，保证 diff 最小可复核。
 */
const SPACING_FIX_MAP = new Map([
  ["3", "4"],
  ["5", "4"],
  ["7", "8"],
  ["9", "8"],
  ["11", "12"],
  ["13", "12"],
]);

const SPACING_PROPS =
  "padding|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginTop|marginBottom|marginLeft|marginRight|gap|rowGap|columnGap";

/** TSX 内联样式里的离格间距：`gap: 3` → `gap: 4` */
function transformSpacing(line, rel, lineNo) {
  return line.replace(
    new RegExp(`(?:^|[\\s,{])((?:${SPACING_PROPS}))(\\s*:\\s*)(['"]?)([0-9]+)(px)?\\3(?=\\s*[,}])`, "g"),
    (m, prop, sep, q, num, unit) => {
      const fixed = SPACING_FIX_MAP.get(num);
      if (!fixed) return m;
      record(rel, lineNo, `${prop}: ${num}${unit ?? ""}`, `${prop}: ${fixed}${unit ?? ""}`);
      const prefix = m.slice(0, m.indexOf(prop));
      return `${prefix}${prop}${sep}${q}${fixed}${unit ?? ""}${q}`;
    },
  );
}

/** CSS 里的离格间距：`gap: 3px` → `gap: 4px` */
function transformSpacingCss(line, rel, lineNo) {
  return line.replace(
    new RegExp(`\\b(${SPACING_PROPS})(\\s*:\\s*)([0-9]+)(px)?`, "g"),
    (m, prop, sep, num, unit) => {
      const fixed = SPACING_FIX_MAP.get(num);
      if (!fixed) return m;
      record(rel, lineNo, `${prop}: ${num}${unit ?? ""}`, `${prop}: ${fixed}${unit ?? ""}`);
      return `${prop}${sep}${fixed}${unit ?? ""}`;
    },
  );
}

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if ([".tsx", ".ts", ".css"].includes(extname(entry))) files.push(full);
  }
})(join(ROOT, "src"));

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const onlyFile = (args.find((a) => a.startsWith("--file=")) ?? "").slice(7);

const changes = [];
const touchedByFile = new Map();

function record(rel, line, from, to) {
  changes.push({ rel, line, from, to });
  touchedByFile.set(rel, (touchedByFile.get(rel) ?? 0) + 1);
}

/** 颜色：`prop: "<literal>"` → `prop: "<token>"`（只处理属性级，避免误伤渐变串） */
function transformColors(line, rel, lineNo, apply) {
  let out = line;
  const props = "color|background|backgroundColor|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|outlineColor|fill|stroke";
  const re = new RegExp(`(${props})(\\s*:\\s*)(['"])([^'"]+)\\3`, "g");
  out = out.replace(re, (m, prop, sep, q, value) => {
    const token = COLOR_MAP.get(value.trim().toLowerCase());
    if (!token) return m;
    record(rel, lineNo, `${prop}: ${value}`, `${prop}: ${token}`);
    return `${prop}${sep}${q}${token}${q}`;
  });
  return out;
}

/** 字号：`fontSize: 13` / `fontSize: "13px"` → `fontSize: "var(--fs-*)"`（必须是字符串，数字会失效） */
function transformFontSize(line, rel, lineNo) {
  return line.replace(/fontSize(\s*:\s*)(['"]?)([0-9]+)(?:px)?\2/g, (m, sep, _q, num) => {
    const token = FS_MAP.get(num);
    if (!token) return m;
    record(rel, lineNo, `fontSize: ${num}`, `fontSize: "${token}"`);
    return `fontSize${sep}"${token}"`;
  });
}

/** 圆角：数字或 px 字符串 → `var(--radius-*)` */
function transformRadius(line, rel, lineNo) {
  return line.replace(/borderRadius(\s*:\s*)(['"]?)([0-9]+)(?:px)?\2/g, (m, sep, _q, num) => {
    const token = RADIUS_MAP.get(num);
    if (!token) return m;
    record(rel, lineNo, `borderRadius: ${num}`, `borderRadius: "${token}"`);
    return `borderRadius${sep}"${token}"`;
  });
}

for (const full of files) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  if (ALLOWLIST.some((re) => re.test(rel))) continue;
  if (onlyFile && !rel.includes(onlyFile)) continue;

  const src = readFileSync(full, "utf8");
  const lines = src.split("\n");
  const isCss = full.endsWith(".css");
  let styleDepth = 0;
  let inTokenBlock = false;
  let inCssComment = false;
  let out = [];

  lines.forEach((raw, i) => {
    const no = i + 1;
    if (isCss) {
      if (/^\s*(:root|\[data-theme|\[data-skin)/.test(raw)) inTokenBlock = true;
      if (inTokenBlock && /^\s*\}/.test(raw)) inTokenBlock = false;
      // 注释里的色值示例不动（否则会把说明文字改坏）
      const trimmed = raw.trim();
      const commentOnly = inCssComment || trimmed.startsWith("/*") || trimmed.startsWith("*");
      if (trimmed.startsWith("/*") && !trimmed.includes("*/")) inCssComment = true;
      else if (inCssComment && trimmed.includes("*/")) inCssComment = false;
      if (inTokenBlock || commentOnly) {
        out.push(raw);
        return;
      }
      // 已有 var() 的行多半是「令牌 + 兜底值」写法（var(--x, #fff)），改兜底值没有意义且会写出
      // var(--accent, var(--accent)) 这种怪东西；box-shadow 里的色值留给人工用 --shadow-* 统一。
      if (/var\(--/.test(raw) || /box-shadow|text-shadow/.test(raw)) {
        out.push(raw);
        return;
      }
      let line = raw;
      // 先处理「状态色 + alpha」的淡色写法，再处理属性级字面量
      line = transformTints(line, rel, no);
      line = transformSpacingCss(line, rel, no);
      // CSS 里颜色可能出现在任意属性（border: 1px solid #333 / background: #fff）
      line = line.replace(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))(?![\w-])/g, (m) => {
        const token = COLOR_MAP.get(m.toLowerCase());
        if (!token) return m;
        record(rel, no, m, token);
        return token;
      });
      line = line.replace(/font-size(\s*:\s*)([0-9]+)(?:px)?/g, (m, sep, num) => {
        const token = FS_MAP.get(num);
        if (!token) return m;
        record(rel, no, `font-size: ${num}`, `font-size: ${token}`);
        return `font-size${sep}${token}`;
      });
      line = line.replace(/border-radius(\s*:\s*)([0-9]+)(?:px)?/g, (m, sep, num) => {
        const token = RADIUS_MAP.get(num);
        if (!token) return m;
        record(rel, no, `border-radius: ${num}`, `border-radius: ${token}`);
        return `border-radius${sep}${token}`;
      });
      out.push(line);
      return;
    }

    // TSX：只在 style={{ … }} 里改
    const opens = (raw.match(/style=\{\{/g) ?? []).length;
    const inStyleHere = styleDepth > 0 || opens > 0;
    if (opens > 0) styleDepth += opens;
    let line = raw;
    if (inStyleHere) {
      line = transformTints(line, rel, no);
      line = transformSpacing(line, rel, no);
      line = transformColors(line, rel, no);
      line = transformFontSize(line, rel, no);
      line = transformRadius(line, rel, no);
    }
    if (styleDepth > 0) {
      const braces = (line.match(/[{}]/g) ?? []).length - opens * 2;
      styleDepth = Math.max(0, styleDepth - (braces < 0 ? -braces : 0) + (braces > 0 ? 0 : 0));
      if (styleDepth > 0 && braces < 0) styleDepth += braces;
    }
    out.push(line);
  });

  const next = out.join("\n");
  if (next !== src) {
    if (WRITE) writeFileSync(full, next);
  }
}

const byRule = {};
for (const c of changes) {
  const kind = c.from.startsWith("fontSize") ? "font" : c.from.startsWith("borderRadius") ? "radius" : "color";
  byRule[kind] = (byRule[kind] ?? 0) + 1;
}
console.log(`${WRITE ? "已写入" : "预览（未写入）"} —— 共 ${changes.length} 处替换：${JSON.stringify(byRule)}`);
const top = [...touchedByFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [f, n] of top) console.log(`  ${String(n).padStart(4)}  ${f}`);

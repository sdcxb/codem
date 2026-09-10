/**
 * UI 一致性审计（开发工具 + 可重复门禁）。
 *
 * 目的：把「样式风格是否统一」变成可测量、可回归的数字 ——
 * 支持「优化 → 审计 → 再优化」的闭环，直到违规清零。
 *
 * 用法：
 *   node tools/ui-audit/scan-ui.mjs                 # 汇总（默认）
 *   node tools/ui-audit/scan-ui.mjs --verbose       # 汇总 + 每规则前若干示例
 *   node tools/ui-audit/scan-ui.mjs --rule=fs-hardcoded
 *   node tools/ui-audit/scan-ui.mjs --json          # 机器可读
 *   node tools/ui-audit/scan-ui.mjs --file=src/components/AgentPanel.tsx
 *   node tools/ui-audit/scan-ui.mjs --write-baseline  # 记录当前计数（门禁用）
 *
 * 规则分层：
 *   error（门禁要求清零）：字体硬编码、颜色硬编码、圆角离格、弹窗外壳未用统一类
 *   warn（工作量指标）：间距离格、内联样式过密、遗留 shell 类名
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const BASELINE_PATH = join(HERE, "baseline.json");

// ========== 扫描范围 ==========
const SCAN_DIRS = ["src"];
const EXCLUDE_DIRS = new Set(["node_modules", "dist", "target", "test", "__snapshots__", ".git"]);
const EXCLUDE_FILE_RE = [
  /\.test\.(ts|tsx)$/,
  /\.d\.ts$/,
  // 令牌定义处允许出现原始色值/像素（它们是"唯一真相源"）
  /^src[\\/]styles\.css$/,
];

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else if ([".tsx", ".ts", ".css"].includes(extname(entry))) out.push(full);
  }
  return out;
}

function shouldSkip(rel) {
  return EXCLUDE_FILE_RE.some((re) => re.test(rel)) || !!allowedReason(rel);
}

/**
 * 合法例外：这些文件里的原始颜色是**数据/内容**而不是 UI 样式 ——
 * 皮肤令牌定义、PPT 生成内容配色、游戏美术（大富翁棋盘/角色自带一套美术语言）。
 * 例外必须写明理由，避免例外表退化成"绕过审计"的后门。
 */
const ALLOWLIST = [
  { re: /^src\/core\/theme\//, why: "主题/令牌定义源（原始色值是唯一真相源）" },
  { re: /^src\/core\/knowledge\/ppt-/, why: "PPT 生成内容的配色（导出文件的内容样式，不跟随宿主皮肤）" },
  { re: /^src\/plugins\/monopoly-game\//, why: "大富翁游戏插件（自带美术语言：棋盘/卡牌/角色是一套独立视觉，改令牌会破坏美术）" },
  { re: /^src\/styles\/skin-[^/]+\.css$/, why: "皮肤定义源（每个皮肤的调色板与覆盖层：原始色值就是该皮肤的真相源）" },
  { re: /^src\/plugins\/library-ops\/data\/characters\.ts$/, why: "图书馆角色调色板（注释性常量，实际渲染已用 var() 令牌）" },
];
function allowedReason(rel) {
  const hit = ALLOWLIST.find((a) => a.re.test(rel));
  return hit?.why ?? null;
}

// ========== 允许的刻度 ==========
/** 圆角刻度（来自 --radius-sm/md/lg/full + 设计规范里的 4/6/8/10/14） */
const RADIUS_OK = new Set(["0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20", "24", "999", "9999", "50%"]);
/** 间距按 2px 网格；1px 用于边框/细线 */
const SPACING_OK = (n) => n % 2 === 0 || n === 1;

const RULES = {
  "fs-hardcoded": { level: "error", desc: "字体大小硬编码（应使用 var(--fs-*)）" },
  "color-hardcoded-tsx": { level: "error", desc: "TSX 内联样式里的硬编码颜色（应使用语义令牌）" },
  "color-hardcoded-css": { level: "error", desc: "CSS 里的硬编码颜色（应使用语义令牌）" },
  "radius-offscale": { level: "error", desc: "圆角不在刻度上" },
  "modal-shell-bespoke": { level: "error", desc: "弹窗/浮层外壳未使用统一 modal-overlay/modal-editor 类" },
  "spacing-offgrid": { level: "warn", desc: "间距不在 2px 网格上" },
  "inline-style-dense": { level: "warn", desc: "单文件内联样式过密（考虑抽成 CSS 类）" },
  "legacy-popup-shell": { level: "warn", desc: "历史遗留的自建浮层类名" },
  "css-class-undefined": { level: "warn", desc: "tsx 里用了但没有任何 CSS 定义的类名（等于没样式）" },
};

// ========== 扫描器 ==========
const findings = [];
function add(rule, file, line, text, detail) {
  findings.push({ rule, file, line, text: text.trim().slice(0, 140), detail });
}

/** 去掉行内注释，避免把注释里的示例算成违规 */
function stripComments(line) {
  return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
}

function scanTsx(rel, src) {
  const lines = src.split("\n");
  let styleProps = 0;
  let modalish = 0; // position:fixed + inset 的浮层样式块计数
  let hasUnifiedShell = false;

  // 统一外壳类名（出现任意一个即认为该文件用了共享外壳）
  if (/modal-overlay|modal-panel|modal-editor|drawer-|popover-|task-center-panel/.test(src)) hasUnifiedShell = true;

  /**
   * 只在 `style={{ … }}` 里判定颜色/字号/圆角：
   * - SVG/Canvas 属性（`stroke="#888"`、`fill="…"`）与图表库入参不能吃 CSS 变量，属正当用法；
   * - 非样式上下文里的色值字符串（如传给 canvas 的主题常量）同理。
   * 这样门禁只盯「本该用令牌的地方」，避免假阳性把例外表撑爆。
   */
  let styleDepth = 0;

  lines.forEach((raw, i) => {
    const line = stripComments(raw);
    const no = i + 1;
    const opens = (line.match(/style=\{\{/g) ?? []).length;
    const inStyleHere = styleDepth > 0 || opens > 0;
    const wasInStyle = inStyleHere;

    // 更新样式对象深度：进入 +1，之后的 { 与 } 逐个平衡
    if (opens > 0) styleDepth += opens;
    if (styleDepth > 0) {
      const braces = (line.match(/[{}]/g) ?? []).length - opens * 2;
      styleDepth = Math.max(0, styleDepth + braces);
    }

    if (!wasInStyle) {
      if (/position:\s*(?:'|")fixed/.test(line)) modalish++;
      styleProps += (line.match(/[a-zA-Z]+:\s*(?:'|"|\{|[0-9]|var\()/g) ?? []).length;
      return;
    }

    // 1) 字体硬编码：fontSize: 13 / fontSize: "13px" / fontSize: '0.8rem'
    const fs = /fontSize:\s*(?:'|")?([0-9.]+)(px|rem|em)?(?:'|")?/.exec(line);
    if (fs && !line.includes("var(--fs")) {
      add("fs-hardcoded", rel, no, raw, `fontSize: ${fs[1]}${fs[2] ?? ""}`);
    }

    // 2) 颜色硬编码（属性级：color/background/border*Color/fill/stroke）
    const colorProp =
      /(?:^|[\s,{])(color|background|backgroundColor|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|outlineColor|fill|stroke)\s*:\s*(?:'|")(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|(?:red|blue|green|white|black|gray|grey|orange|purple|pink|yellow|cyan|magenta|transparent))(?:'|")/;
    const colorM = colorProp.exec(line);
    if (colorM && !line.includes("var(--") && colorM[2] !== "transparent") {
      add("color-hardcoded-tsx", rel, no, raw, `${colorM[1]}: ${colorM[2]}`);
    }
    // 属性级不够时兜底：样式对象里直接出现 hex（排除 boxShadow 字符串）
    if (!colorM && !line.includes("var(--")) {
      const hex = /(?:'|")(#[0-9a-fA-F]{3,8})(?:'|")/.exec(line);
      if (hex && !/boxShadow|textShadow|filter/.test(line)) {
        add("color-hardcoded-tsx", rel, no, raw, `hex ${hex[1]}`);
      }
    }

    // 3) 圆角离格
    const br = /borderRadius:\s*(?:'|")?([0-9.]+)(px|rem|%)?(?:'|")?/.exec(line);
    if (br && !line.includes("var(--")) {
      const v = br[1];
      const unit = br[2] ?? "";
      let ok = false;
      if (unit === "%") ok = true;
      else if (unit === "rem") ok = SPACING_OK(parseFloat(v) * 16);
      else ok = RADIUS_OK.has(v);
      if (!ok) add("radius-offscale", rel, no, raw, `borderRadius: ${v}${unit}`);
    }

    // 4) 间距离格（padding/margin/gap 的纯数字）
    const sp = /(?:^|[\s,{])(padding|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginTop|marginBottom|marginLeft|marginRight|gap|rowGap|columnGap)\s*:\s*([0-9]+)(?:\s*[,}])/.exec(line);
    if (sp && !SPACING_OK(parseInt(sp[2], 10)) && !line.includes("var(--")) {
      add("spacing-offgrid", rel, no, raw, `${sp[1]}: ${sp[2]}`);
    }

    styleProps += (line.match(/[a-zA-Z]+:\s*(?:'|"|\{|[0-9]|var\()/g) ?? []).length;
    if (/position:\s*(?:'|")fixed/.test(line)) modalish++;
  });

  if (modalish > 0 && !hasUnifiedShell) {
    add("modal-shell-bespoke", rel, 1, "(file-level)", `${modalish} 处 position:fixed 浮层，未见统一外壳类`);
  }
  if (styleProps > 120) {
    add("inline-style-dense", rel, 1, "(file-level)", `${styleProps} 个内联样式属性`);
  }
  if (/className="(?:popup|overlay|modal-box|dialog-box|sheet)-/.test(src)) {
    add("legacy-popup-shell", rel, 1, "(file-level)", "自建浮层类名");
  }
}

function scanCss(rel, src) {
  const lines = src.split("\n");
  let inRoot = false;
  lines.forEach((raw, i) => {
    const no = i + 1;
    const line = stripComments(raw);
    if (/^\s*:root|^\s*\[data-theme|^\s*\[data-skin/.test(line)) inRoot = true;
    if (inRoot && /^\s*\}/.test(line)) inRoot = false;
    if (inRoot) return; // 令牌定义块允许原始值

    const hex = /#[0-9a-fA-F]{3,8}\b/.exec(line);
    const rgb = /\b(?:rgba?|hsla?)\(/.exec(line);
    if ((hex || rgb) && !line.includes("var(--")) {
      add("color-hardcoded-css", rel, no, raw, hex ? hex[0] : "rgb()/hsl()");
    }
    const br = /border-radius:\s*([0-9.]+)(px|rem|%)?/.exec(line);
    if (br && !line.includes("var(--") && br[2] !== "%") {
      const v = br[2] === "rem" ? parseFloat(br[1]) * 16 : parseFloat(br[1]);
      if (!RADIUS_OK.has(String(v))) add("radius-offscale", rel, no, raw, `border-radius: ${br[0]}`);
    }
  });
}

// ========== 主流程 ==========
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const a = args.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : null;
};

const files = SCAN_DIRS.flatMap((d) => (existsSync(join(ROOT, d)) ? listFiles(join(ROOT, d)) : []));

// ---- 先建「CSS 里定义过的类名」索引（跨文件，供 css-class-undefined 规则用） ----
const definedClasses = new Set();
for (const full of files) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  // 注意：令牌源 styles.css 虽然不参与"违规扫描"，但它是类名的主要定义处，
  // 建索引时必须包含（否则所有类名都会被误判成"未定义"）。
  if (!rel.endsWith(".css") || /\.test\./.test(rel)) continue;
  const css = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) definedClasses.add(m[1]);
}
/** 运行时状态类 / 工具类：由 JS 动态加，或本就是约定俗成的状态修饰，不算缺失 */
const RUNTIME_CLASS_RE = /^(is-|has-|js-|no-|with-)|^(active|open|selected|hover|focus|visible|hidden|disabled|dragging|loading|dark|light|compact|wide|narrow)$/;
/** 第三方库自带的类名（样式由库自己的 CSS/内联注入，不归本项目管） */
const THIRD_PARTY_CLASS_RE = /^(xterm|react-flow|monaco|katex|mermaid|shiki|hljs|cm-|cm_|prose|token|language-|ace_|pdf|docx|sheet|ph-|leaflet|recharts|swiper|tippy|radix|rt-|fl-|fa-|fas|far|fab)/;

for (const full of files) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  if (shouldSkip(rel)) continue;
  const src = readFileSync(full, "utf8");
  if (rel.endsWith(".css")) {
    scanCss(rel, src);
    continue;
  }
  scanTsx(rel, src);

  // 静态 className 字面量（跳过含 ${} 的动态拼接）
  for (const m of src.matchAll(/className=(?:"([^"{}]+)"|\{'([^'{}]+)'\})/g)) {
    const raw = m[1] ?? m[2] ?? "";
    // 该元素自己带了内联样式 → 已经"有样式"，类名只是钩子，不算"等于没样式"
    const tail = src.slice(m.index, m.index + 220);
    const hasInlineStyle = /^\s*>?[\s\S]{0,160}?style=\{\{/.test(tail.replace(/^className=[^>]*/, "")) ||
      /style=\{\{/.test(tail);
    if (hasInlineStyle) continue;
    for (const cls of raw.split(/\s+/).filter(Boolean)) {
      if (RUNTIME_CLASS_RE.test(cls) || THIRD_PARTY_CLASS_RE.test(cls) || definedClasses.has(cls)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      add("css-class-undefined", rel, line, cls, `未定义类名: ${cls}`);
    }
  }
}

const onlyRule = value("--rule");
const onlyFile = value("--file");
const filtered = findings.filter(
  (f) => (!onlyRule || f.rule === onlyRule) && (!onlyFile || f.file.includes(onlyFile)),
);

const byRule = {};
for (const f of filtered) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
const byFile = {};
for (const f of filtered) byFile[f.file] = (byFile[f.file] ?? 0) + 1;

const errorCount = filtered.filter((f) => RULES[f.rule]?.level === "error").length;
const warnCount = filtered.filter((f) => RULES[f.rule]?.level === "warn").length;

if (flag("--write-baseline")) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ at: new Date().toISOString(), errorCount, warnCount, byRule }, null, 2) + "\n",
  );
  console.log(`baseline written → ${relative(ROOT, BASELINE_PATH)}  errors=${errorCount} warns=${warnCount}`);
  process.exit(0);
}

if (flag("--census")) {
  const census = (kind) => {
    const counts = new Map();
    for (const f of filtered) {
      if (kind === "fs" && f.rule !== "fs-hardcoded") continue;
      if (kind === "color" && !f.rule.startsWith("color-hardcoded")) continue;
      if (kind === "radius" && f.rule !== "radius-offscale") continue;
      const key = f.detail ?? "(file)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  for (const kind of ["fs", "color", "radius"]) {
    console.log(`\n=== ${kind} 字面量分布 ===`);
    for (const [k, n] of census(kind)) console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  process.exit(0);
}

if (flag("--json")) {
  console.log(JSON.stringify({ errorCount, warnCount, byRule, byFile, findings: filtered }, null, 2));
  process.exit(0);
}

console.log(`UI 一致性审计 —— 扫描 ${files.length} 个文件`);
console.log(`\n按规则（error ${errorCount} / warn ${warnCount}）`);
for (const [rule, meta] of Object.entries(RULES)) {
  const n = byRule[rule] ?? 0;
  const mark = meta.level === "error" ? "✗" : "·";
  console.log(`  ${mark} ${rule.padEnd(22)} ${String(n).padStart(5)}   ${meta.desc}`);
}

const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15);
if (top.length) {
  console.log(`\n问题最多的文件（前 15）`);
  for (const [file, n] of top) console.log(`  ${String(n).padStart(5)}  ${file}`);
}

if (flag("--verbose")) {
  console.log(`\n示例（每规则最多 8 条）`);
  const seen = {};
  for (const f of filtered) {
    seen[f.rule] = (seen[f.rule] ?? 0) + 1;
    if (seen[f.rule] > 8) continue;
    console.log(`  [${f.rule}] ${f.file}:${f.line}  ${f.detail ?? ""}`);
  }
}

process.exit(errorCount > 0 && flag("--strict") ? 1 : 0);

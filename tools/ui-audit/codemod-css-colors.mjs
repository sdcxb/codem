/**
 * CSS 色值 codemod：把样式表里写死的颜色换成语义令牌（第 13 波）。
 *
 * 背景：`src/styles.css` 有 239 处色值字面量（141 个不同取值），
 * 它们不跟随主题/皮肤 —— 换肤后这块永远停在写死的那套色上。
 *
 * 映射原则（逐条都能推出「为什么是这个令牌」）：
 *   1. 状态色按色系归位：红→--error、绿→--success、琥珀→--warning、蓝→--info、紫蓝→--accent；
 *      带 alpha 的一律写成 `color-mix(in srgb, var(--token) N%, transparent)`
 *      （§2.3：状态色不做实心填充，用「文字色 + 淡底 + 淡边」表达）。
 *   2. 黑/白的 alpha 按属性判定：
 *      box-shadow 里的黑 → --shadow-color / --shadow-color-soft；
 *      background 里的黑 → --overlay-backdrop(-strong)（遮罩）；
 *      白 → 前景色场景用 --text-on-accent，背景用 --surface-content。
 *   3. 「外来内容」与「平台惯例」不塞进令牌体系，而单列语义令牌：
 *      终端表面、纯黑舞台/信箱、iframe/幻灯片白底、macOS 红黄绿、Windows 关闭红、皮肤色卡。
 *   4. `var(--token, #fallback)` 里的兜底值**不动**：那是令牌的兜底，不是写死的样式。
 *
 * 用法：
 *   node tools/ui-audit/codemod-css-colors.mjs            # 预览
 *   node tools/ui-audit/codemod-css-colors.mjs --write    # 落地
 *   node tools/ui-audit/codemod-css-colors.mjs --file=src/styles/codem-ui.css
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WRITE = process.argv.includes("--write");
const TARGET = process.argv.find((a) => a.startsWith("--file="))?.slice(7) ?? null;

/** 十六进制字面量 → 令牌 */
const HEX_MAP = {
  // 红系
  "#ef4444": "var(--error)", "#f87171": "var(--error)", "#ff5050": "var(--error)",
  "#ff6b6b": "var(--error)", "#f44336": "var(--error)", "#e74c3c": "var(--error)",
  "#ff8080": "var(--error)", "#e81123": "var(--window-close-bg)",
  // 绿系
  "#22c55e": "var(--success)", "#4ade80": "var(--success)", "#3cc83c": "var(--success)",
  "#10b981": "var(--success)", "#2ecc71": "var(--success)", "#28c840": "var(--mac-btn-maximize)",
  // 琥珀系
  "#f59e0b": "var(--warning)", "#ffa500": "var(--warning)", "#e0a91f": "var(--warning)",
  "#fbbf24": "var(--warning)", "#f5c542": "var(--warning)", "#febc2e": "var(--mac-btn-minimize)",
  // 蓝系
  "#3b82f6": "var(--info)", "#60a5fa": "var(--info)", "#93c5fd": "var(--info)",
  "#64a0ff": "var(--info)",
  // 紫蓝（项目主色系）
  "#7c6cf0": "var(--accent)", "#6b46c1": "var(--accent)", "#6366f1": "var(--accent)",
  "#9333ea": "var(--accent)", "#a855f7": "var(--accent)", "#c864ff": "var(--accent)",
  // 中性
  "#6e7681": "var(--text-muted)",
  // 外来内容 / 平台惯例
  "#0d1117": "var(--terminal-bg)",
  "#f0f6fc": "var(--terminal-fg)",
  "#fe5f57": "var(--mac-btn-close)",
  "#000": "var(--backdrop-black)", "#000000": "var(--backdrop-black)",
  // 皮肤色卡
  "#161b22": "var(--skin-preview-default-2)",
  "#1f242c": "var(--skin-preview-default-3)",
  "#0a0a0a": "var(--skin-preview-hub-1)",
  "#1c1c1e": "var(--skin-preview-hub-2)",
  "#121212": "var(--skin-preview-hub-3)",
  "#ff6b00": "var(--skin-preview-hub-accent)",
  "#fdf5f7": "var(--skin-preview-dream-1)",
  "#fce8eb": "var(--skin-preview-dream-2)",
  "#f7dee2": "var(--skin-preview-dream-3)",
};

/** rgba 色系（按 RGB 分量归位到语义令牌） */
const RGB_MAP = {
  "239,68,68": "--error", "248,81,73": "--error", "255,80,80": "--error",
  "255,107,107": "--error", "244,67,54": "--error", "231,76,60": "--error",
  "34,197,94": "--success", "63,185,80": "--success", "60,200,60": "--success",
  "74,222,128": "--success",
  "245,158,11": "--warning", "210,153,34": "--warning", "255,165,0": "--warning",
  "224,169,31": "--warning",
  "59,130,246": "--info", "47,129,247": "--info", "100,160,255": "--info",
  "96,165,250": "--info", "97,135,216": "--info",
  "99,102,241": "--accent", "124,108,240": "--accent", "147,51,234": "--accent",
  "200,100,255": "--accent",
  "192,132,252": "--security-auto",
  "110,118,129": "--text-muted",
  "120,84,0": "--warning",
};

/** 与 scan-ui.mjs 的 ALLOWLIST 保持一致：这些文件的原始色值是"数据/美术"，不许动 */
const SKIP_RE = [
  /^src\/plugins\/monopoly-game\//,
  /^src\/styles\/skin-[^/]+\.css$/,
  /^src\/core\/theme\//,
  /^src\/core\/knowledge\/ppt-/,
];

const pct = (a) => `${Math.round(a * 100)}%`;

/** 一行里所有 `var(...)` 的区间（含 fallback）：这些位置的原始值是令牌兜底，不能动 */
function varRanges(line) {
  const ranges = [];
  let i = 0;
  while (i < line.length) {
    const at = line.indexOf("var(", i);
    if (at < 0) break;
    let j = at + 3;
    let depth = 0;
    do {
      const c = line[j];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    } while (j < line.length && depth > 0);
    ranges.push([at, j]);
    i = j;
  }
  return ranges;
}

function rgbaReplacement(prop, r, g, b, a) {
  const key = `${r},${g},${b}`;
  if (key === "0,0,0") {
    if (a === 0) return "transparent"; // 全透明停靠点（渐变淡出）
    if (prop === "box-shadow") return a <= 0.15 ? "var(--shadow-color-soft)" : "var(--shadow-color)";
    if (prop === "background") {
      if (a >= 0.7) return "var(--overlay-backdrop-strong)";
      if (a >= 0.4) return "var(--overlay-backdrop)";
      return null; // 小 alpha 的黑底另有语义（如 hover 底色），交人工
    }
    return null;
  }
  if (key === "255,255,255") {
    if (a === 0) return "transparent";
    return `color-mix(in srgb, var(--text-on-accent) ${pct(a)}, transparent)`;
  }
  const token = RGB_MAP[key];
  if (!token) return null;
  if (a === 0) return "transparent";
  if (a === 1) return `var(${token})`;
  return `color-mix(in srgb, var(${token}) ${pct(a)}, transparent)`;
}

function namedReplacement(prop, word) {
  if (word === "white") {
    if (prop === "background" || prop === "background-color") return "var(--surface-content)";
    return "var(--text-on-accent)";
  }
  if (word === "black") {
    if (prop === "background" || prop === "background-color") return "var(--backdrop-black)";
    return "var(--text-primary)";
  }
  return null;
}

/** 一次扫描匹配所有色值写法（单趟替换，偏移量才始终有效） */
const LITERAL_RE =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*(?:,\s*[0-9.]+\s*)?\)|(?<=^|[\s,:(])(white|black)(?=[\s,;)]|$)/gi;

function listCss(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "target") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...listCss(full));
    else if (extname(e) === ".css") out.push(full);
  }
  return out;
}

const skipped = new Map();
let replaced = 0;
let files = 0;

for (const full of listCss(join(ROOT, "src"))) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  if (TARGET && rel !== TARGET) continue;
  if (SKIP_RE.some((re) => re.test(rel))) continue;
  const lines = readFileSync(full, "utf8").split("\n");
  let inRoot = false;
  let n = 0;
  const out = lines.map((raw) => {
    const line = raw.replace(/\/\*.*?\*\//g, "");
    if (/^\s*(:root|\[data-theme|\[data-skin)/.test(line)) inRoot = true;
    const isRoot = inRoot;
    if (inRoot && /^\s*\}/.test(line)) inRoot = false;
    if (isRoot) return raw;

    const ranges = varRanges(raw);
    const propMatches = [...raw.matchAll(/([a-z-]+)\s*:/gi)].map((m) => ({ name: m[1], index: m.index }));
    const propOf = (index) => {
      let p = propMatches[0]?.name ?? "";
      for (const m of propMatches) if (m.index < index) p = m.name;
      return p;
    };

    const next = raw.replace(LITERAL_RE, (whole, namedWord, offset) => {
      if (ranges.some(([s, e]) => offset >= s && offset < e)) return whole; // 令牌兜底值
      const prop = propOf(offset);
      let rep = null;
      if (namedWord) {
        rep = namedReplacement(prop, namedWord.toLowerCase());
      } else if (whole.startsWith("#")) {
        const key = whole.toLowerCase();
        if ((key === "#fff" || key === "#ffffff") && prop !== "color") {
          rep = prop === "background" ? "var(--surface-content)" : "var(--text-on-accent)";
        } else {
          rep = HEX_MAP[key] ?? ((key === "#fff" || key === "#ffffff") ? "var(--text-on-accent)" : null);
        }
      } else {
        const m = /rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)/i.exec(whole);
        if (m) rep = rgbaReplacement(prop, m[1], m[2], m[3], m[4] === undefined ? 1 : parseFloat(m[4]));
      }
      if (!rep) {
        skipped.set(`${prop}\t${whole.replace(/\s+/g, "")}`, (skipped.get(`${prop}\t${whole.replace(/\s+/g, "")}`) ?? 0) + 1);
        return whole;
      }
      n++;
      replaced++;
      return rep;
    });
    return next;
  });
  if (n > 0) {
    files++;
    if (WRITE) writeFileSync(full, out.join("\n"));
  }
}

console.log(`${WRITE ? "已写入" : "预览"}：${files} 个文件 / ${replaced} 处色值令牌化`);
if (skipped.size) {
  console.log("未映射（需人工判断）：");
  for (const [k, v] of [...skipped.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
}
if (!WRITE) console.log("（加 --write 落地）");

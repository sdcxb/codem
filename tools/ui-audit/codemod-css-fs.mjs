/**
 * CSS 字号 codemod：把 CSS 里写死的字号换成 --fs-* 令牌。
 *
 * 背景：`src/styles.css` 之前整份被排除在审计之外，而它恰恰是最大的现场 ——
 * 实测 591 处 font-size 写死像素（12px×170 / 11px×121 / 13px×118 …）。
 * 这些字号不仅不在刻度上，还**不吃 `--ui-font-scale`** —— 这正是
 * 「设置里调字号没反应」的根因（滑杆只影响 var(--fs-*)）。
 *
 * 用法：
 *   node tools/ui-audit/codemod-css-fs.mjs            # 预览（默认）
 *   node tools/ui-audit/codemod-css-fs.mjs --write    # 落地
 *   node tools/ui-audit/codemod-css-fs.mjs --verbose  # 逐条打印
 *
 * 映射表见 FS_MAP；不在表里的值会列出来，交由人工决定（不猜）。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WRITE = process.argv.includes("--write");
const VERBOSE = process.argv.includes("--verbose");

/**
 * 字面量 → 令牌。**精确档位一律精确映射**（10/12/13/14/16/18/20/24 等），
 * 离格值按「就近且不改变语义层级」映射，并在文档 §2.1 记录理由：
 *   15px（10 处，全是标题/输入）→ --fs-lg(16)：标题档
 *   17px（1 处，.dialog-title）→ --fs-xl(18)：§3 规定弹窗标题用 --fs-xl
 *   48px（3 处，空态大图标）→ var(--icon-3xl)（48px，空态/欢迎页插画档）
 */
const FS_MAP = {
  // 密集元信息
  "9px": "var(--fs-xs)",
  "10px": "var(--fs-xs)",
  "11px": "var(--fs-2xs)",
  "0.625rem": "var(--fs-xs)",
  "0.6875rem": "var(--fs-2xs)",
  // 次要文本
  "12px": "var(--fs-sm)",
  "0.75rem": "var(--fs-sm)",
  // 正文基准
  "13px": "var(--fs-base)",
  "0.8125rem": "var(--fs-base)",
  // 主要文本 / 输入框
  "14px": "var(--fs-md)",
  "0.875rem": "var(--fs-md)",
  // 区块标题 / 面板标题
  "15px": "var(--fs-lg)",
  "16px": "var(--fs-lg)",
  "1rem": "var(--fs-lg)",
  "1em": "var(--fs-lg)",
  // 页面标题 / 弹窗标题
  "17px": "var(--fs-xl)",
  "18px": "var(--fs-xl)",
  "1.125rem": "var(--fs-xl)",
  // 大标题
  "19px": "var(--fs-2xl)",
  "20px": "var(--fs-2xl)",
  "1.25rem": "var(--fs-2xl)",
  // Hero 标题
  "24px": "var(--fs-3xl)",
  "1.5rem": "var(--fs-3xl)",
  // 展示型
  "28px": "var(--fs-display)",
  "1.75rem": "var(--fs-display)",
  "32px": "var(--fs-hero)",
  "2rem": "var(--fs-hero)",
  // 空态大字形（48px 及以上归 --icon-3xl 一档）
  "48px": "var(--icon-3xl)",
  "3rem": "var(--icon-3xl)",
};

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

const unmapped = new Map();
let touchedFiles = 0;
let replaced = 0;

for (const full of listCss(join(ROOT, "src"))) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  const lines = readFileSync(full, "utf8").split("\n");
  let inRoot = false;
  let n = 0;
  const out = lines.map((raw) => {
    const line = raw.replace(/\/\*.*?\*\//g, "");
    if (/^\s*:root|^\s*\[data-theme|^\s*\[data-skin/.test(line)) inRoot = true;
    const isRoot = inRoot;
    if (inRoot && /^\s*\}/.test(line)) inRoot = false;
    if (isRoot || raw.includes("var(--")) return raw;
    return raw.replace(/font-size:\s*([0-9.]+(?:px|rem|em|pt)?)/g, (whole, value) => {
      const token = FS_MAP[value];
      if (!token) {
        unmapped.set(value, (unmapped.get(value) ?? 0) + 1);
        return whole;
      }
      n++;
      replaced++;
      return `font-size: ${token}`;
    });
  });
  if (n > 0) {
    touchedFiles++;
    if (WRITE) writeFileSync(full, out.join("\n"));
    if (VERBOSE) console.log(`  ${rel}  ${n} 处`);
  }
}

console.log(`${WRITE ? "已写入" : "预览"}：${touchedFiles} 个文件 / ${replaced} 处 font-size 令牌化`);
if (unmapped.size) {
  console.log("未映射（需人工判断）：");
  for (const [k, v] of [...unmapped.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
}
if (!WRITE) console.log("（加 --write 落地）");

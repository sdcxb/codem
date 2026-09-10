/**
 * 内联样式 → 具名类 codemod（第 19 波起）。
 *
 * 用途：把**完全相同的**内联样式对象批量换成共享具名类 —— 这类重复形态在项目里
 * 出现几十次（`display:inline + verticalAlign:middle` 26 次、`fs-sm + text-muted` 30+ 次…），
 * 每个文件手改一遍没有意义，也不该让「统一」靠人工记忆。
 *
 * 用法：
 *   node tools/ui-audit/codemod-inline-to-class.mjs            # 预览
 *   node tools/ui-audit/codemod-inline-to-class.mjs --write    # 落地
 *   node tools/ui-audit/codemod-inline-to-class.mjs --verbose
 *
 * 只处理**单行** `style={{ … }}` 且属性完全匹配映射表的情况；多行对象、含动态表达式的
 * 对象一律不动（交给人工），避免把条件样式改坏。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WRITE = process.argv.includes("--write");
const VERBOSE = process.argv.includes("--verbose");

/** 归一化签名（属性=值，按属性名排序、去掉引号与空格）→ 共享类名 */
const SIG_MAP = {
  // 行内图标（与文字同基线）
  "display=inline verticalalign=middle": "icon-inline",
  // 行内图标 + 与右侧文字留 4px（丢掉这个 margin 会让文字贴住图标，所以单列一档）
  "display=inline marginright=4 verticalalign=middle": "icon-inline-gap",
  // 次要说明文字
  "color=var(--text-muted) fontsize=var(--fs-sm)": "hint-sm",
};

function listTsx(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (["node_modules", "dist", "test", "__snapshots__"].includes(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...listTsx(full));
    else if (extname(e) === ".tsx") out.push(full);
  }
  return out;
}

/** 把一段 style 对象体归一化成签名 */
function signature(body) {
  const pairs = [...body.matchAll(/([a-zA-Z-]+)\s*:\s*("[^"]*"|'[^']*'|[^,}]+)/g)]
    .map((m) => `${m[1].toLowerCase()}=${m[2].trim().replace(/^['"]|['"]$/g, "").toLowerCase()}`);
  return pairs.sort().join(" ");
}

const stats = new Map();
let changedFiles = 0;
let replaced = 0;

for (const full of listTsx(join(ROOT, "src"))) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  const src = readFileSync(full, "utf8");
  let n = 0;
  /** 逐行处理；同一行可能有多个元素（例如一行里两个图标），所以是全局替换 */
  const out = src.split("\n").map((line) => {
    if (!line.includes("style={{")) return line;
    let result = line;
    // 从后往前替换，避免前面替换后偏移量失效
    const matches = [...result.matchAll(/style=\{\{([^{}]*)\}\}/g)];
    for (let k = matches.length - 1; k >= 0; k--) {
      const m = matches[k];
      const cls = SIG_MAP[signature(m[1])];
      if (!cls) continue;
      const idx = m.index;
      const before = result.slice(Math.max(0, idx - 200), idx);
      const cm = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/.exec(before);
      const absStart = Math.max(0, idx - 200) + (cm?.index ?? 0);
      let head = result.slice(0, idx);
      let tail = result.slice(idx + m[0].length);
      if (cm && absStart + cm[0].length > idx - 40) {
        // className 紧邻 style 之前：合并类名，并把它和 style 之间的空白一并清掉
        const merged = [...(cm[1] ?? cm[2] ?? cm[3] ?? "").split(/\s+/).filter(Boolean), cls].join(" ");
        head = result.slice(0, absStart) + `className="${merged}"` + result.slice(absStart + cm[0].length, idx);
        head = head.replace(/[ \t]+$/, "");
      } else {
        head = result.slice(0, idx);
        head = head.replace(/[ \t]+$/, " ") + `className="${cls}"`;
      }
      result = head + tail;
      n++;
      replaced++;
      stats.set(cls, (stats.get(cls) ?? 0) + 1);
      if (VERBOSE) console.log(`  ${rel}  → ${cls}`);
    }
    return result;
  });
  if (n > 0) {
    changedFiles++;
    if (WRITE) writeFileSync(full, out.join("\n"));
  }
}

console.log(`${WRITE ? "已写入" : "预览"}：${changedFiles} 个文件 / ${replaced} 处内联样式 → 具名类`);
for (const [cls, c] of [...stats.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  .${cls}`);
if (!WRITE) console.log("（加 --write 落地）");

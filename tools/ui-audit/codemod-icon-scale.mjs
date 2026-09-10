/**
 * 图标尺寸 codemod：把「无效的 Tailwind 风格工具类」改写成本项目的 --icon-* 刻度。
 *
 * 背景：tsx 里散落 ~100 处 `className="w-3 h-3"` / `w-3.5 h-3.5` / `animate-spin` /
 * `opacity-40` —— 本项目是纯 CSS、没有 Tailwind，这些类名没有任何样式定义，
 * 图标实际渲染成 lucide 默认 24px。审计规则 css-class-undefined 会把它们全部报出来。
 *
 * 用法：
 *   node tools/ui-audit/codemod-icon-scale.mjs            # 预览（默认）
 *   node tools/ui-audit/codemod-icon-scale.mjs --write    # 落地
 *   node tools/ui-audit/codemod-icon-scale.mjs --verbose  # 逐条打印
 *
 * 映射（像素 → 语义档位，见 docs/UI-DESIGN-SYSTEM.md §2.4）：
 *   2.5→icon-2xs(10)  3→icon-xs(12)  3.5→icon-sm(14)  4→icon-md(16)
 *   5→icon-lg(20)     6→icon-xl(24)  8→icon-2xl(32)   12→icon-3xl(48)
 *   16→icon-3xl(48)   animate-spin→spin   opacity-30/40→icon-dim
 *   flex-shrink-0→（图标工具类已含 flex-shrink:0，直接删除）
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WRITE = process.argv.includes("--write");
const VERBOSE = process.argv.includes("--verbose");

/** 像素档位 → 语义类名 */
const SIZE_MAP = {
  "2.5": "icon-2xs",
  "3": "icon-xs",
  "3.5": "icon-sm",
  "4": "icon-md",
  "5": "icon-lg",
  "6": "icon-xl",
  "8": "icon-2xl",
  "12": "icon-3xl",
  "16": "icon-3xl",
};
/** 其余工具类 → 项目类名（null = 删除该类名） */
const CLASS_MAP = {
  "animate-spin": "spin",
  "animate-pulse": "spin",
  "opacity-30": "icon-dim",
  "opacity-40": "icon-dim",
  "opacity-50": "icon-dim",
  "flex-shrink-0": null,
  "shrink-0": null,
};

function listTsx(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "test" || entry === "__snapshots__") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsx(full));
    else if (extname(entry) === ".tsx") out.push(full);
  }
  return out;
}

/** 把一段 className 字面量改写成统一类名列表 */
function rewriteClassList(raw) {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const sizes = new Set();
  const keep = [];
  for (const t of tokens) {
    const m = /^([wh])-(\d+(?:\.\d+)?)$/.exec(t);
    if (m) {
      if (SIZE_MAP[m[2]]) sizes.add(SIZE_MAP[m[2]]);
      continue;
    }
    if (t in CLASS_MAP) {
      const mapped = CLASS_MAP[t];
      if (mapped && !keep.includes(mapped)) keep.push(mapped);
      continue;
    }
    keep.push(t);
  }
  // 尺寸档位可能有多个（如 w-6 h-3）：取刻度里最大的那一档，避免把图标压扁
  const order = Object.values(SIZE_MAP).filter((v, i, a) => a.indexOf(v) === i);
  const picked = [...sizes].sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  const next = (picked ? [picked, ...keep] : keep).join(" ");
  return { next, changed: next !== raw };
}

const files = listTsx(join(ROOT, "src"));
let touched = 0;
let changes = 0;
const leftovers = new Map();

for (const full of files) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  const src = readFileSync(full, "utf8");
  let out = src;
  let n = 0;
  // 只处理静态字面量：className="..." 与 className={'...'} / className={"..."} / className={`...`}（无 ${}）
  const re = /className=(?:"([^"{}]*)"|\{(["'`])([^{}]*?)\2\})/g;
  out = out.replace(re, (whole, plain, q, wrapped) => {
    const raw = plain ?? wrapped;
    const { next, changed } = rewriteClassList(raw);
    if (!changed) return whole;
    if (!next) return ""; // 类名被删干净（如 className="flex-shrink-0"）
    n++;
    return plain != null ? `className="${next}"` : `className={${q}${next}${q}}`;
  });
  if (out !== src) {
    touched++;
    changes += n;
    if (WRITE) writeFileSync(full, out);
    if (VERBOSE) console.log(`  ${rel}  ${n} 处`);
  }
  // 统计仍未被映射的 tailwind 风格类名，供人工判断
  for (const m of out.matchAll(/className=(?:"([^"{}]*)"|\{(["'`])([^{}]*?)\2\})/g)) {
    for (const t of (m[1] ?? m[3] ?? "").split(/\s+/).filter(Boolean)) {
      if (/^([wh]-\d|opacity-\d|animate-|text-|bg-|p[xytblr]?-\d|m[xytblr]?-\d|gap-\d|rounded|font-|flex|grid)/.test(t)) {
        leftovers.set(t, (leftovers.get(t) ?? 0) + 1);
      }
    }
  }
}

console.log(`${WRITE ? "已写入" : "预览"}：${touched} 个文件 / ${changes} 处 className 改写`);
if (VERBOSE) console.log(`  文件：${files.length} 个 tsx`);
if (leftovers.size) {
  console.log("仍未映射的工具类（需人工判断）：");
  for (const [k, v] of [...leftovers.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
}
if (!WRITE) console.log("（加 --write 落地）");

#!/usr/bin/env node
/**
 * CSS 有效声明快照（第 54 波新增）—— 拦住「类名没错、但取值被悄悄改掉」这一整类事故。
 *
 * 为什么需要：第 51 波的批量合并连续造成了三次事故，而且每次都**一路绿灯**：
 *   ① `.settings-panel` 被并进 `.settings-sidebar` 的规则 → 设置弹窗宽 760px 变 160px（用户报的"狭长一条"）；
 *   ② `.titlebar-action-btn:hover` 的重复定义被删/留错 → 浅色主题悬停发黑；
 *   ③ 两个 font-weight 组被并成一条 → 区块标题 620 悄悄降成 560（破坏字重层次）。
 *   共同点：**类的有效性变了，但没有任何门禁在看"生效后的取值"** ——
 *   tsc 不看样式；`css-class-duplicate`/`css-class-cross-file` 只比"同名冲突"；
 *   `css-integrity` 只看语法；目录里的 CSS 契约测试只盯个别属性。
 *
 * 做法：把基础样式表里**顶层规则**（不含 @media 等条件块）解析成
 *   「每个类 → 生效后的声明集合」（按 加载顺序 + 单类特异度，后写者胜），
 * 存成 `css-contract.json`。取值一旦变化，测试就红，作者必须
 *   `node tools/ui-audit/css-contract.mjs --write`
 * 显式更新快照 —— 于是每次改动都会在 diff 里写出"哪些类的哪个属性从什么变成了什么"。
 *
 * 用法：
 *   node tools/ui-audit/css-contract.mjs            # 对比快照，打印差异（有差异时退出码 1）
 *   node tools/ui-audit/css-contract.mjs --write    # 更新快照
 *   node tools/ui-audit/css-contract.mjs --class=.settings-panel   # 只看某个类
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SNAPSHOT = join(HERE, "css-contract.json");

/** 与应用 main.tsx 相同的加载顺序（后加载者胜） */
const BASE_FILES = [
  "src/styles.css",
  "src/styles/codem-ui.css",
  "src/styles/notebook-workspace.css",
  "src/styles/task-center.css",
  "src/styles/pet-window.css",
  "src/components/ppt/ppt-editor.css",
];

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const ONLY = (argv.find((a) => a.startsWith("--class=")) || "").replace("--class=", "");

/** 去掉注释（等长空白，保留换行） */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/** 收集顶层纯类规则的声明：class -> { prop: { value, where } }（后写者胜） */
function collect() {
  const table = new Map();
  for (const rel of BASE_FILES) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const css = stripComments(readFileSync(abs, "utf8"));
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf("{", i);
      if (open < 0) break;
      // 找到与 open 匹配的右括号（整块）
      let depth = 0;
      let close = -1;
      for (let j = open; j < css.length; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") {
          depth--;
          if (depth === 0) { close = j; break; }
        }
      }
      if (close < 0) break;
      const prelude = css.slice(i, open).trim();
      // 条件块（@media/@supports/@layer…）整块跳过：里面的覆盖是有意的分层，不进快照
      if (!prelude.startsWith("@")) {
        const body = css.slice(open + 1, close);
        const line = css.slice(0, i).split("\n").length;
        const parts = prelude.split(",").map((s) => s.trim());
        const pure = parts.filter((s) => /^\.[a-zA-Z][\w-]*$/.test(s));
        if (parts.length > 0 && pure.length === parts.length) {
          for (const decl of body.split(";")) {
            const k = decl.indexOf(":");
            if (k <= 0) continue;
            const prop = decl.slice(0, k).trim();
            const value = decl.slice(k + 1).trim().replace(/\s+/g, " ");
            if (!prop || !value || prop.startsWith("--")) continue;
            for (const s of pure) {
              const cls = s.slice(1);
              if (!table.has(cls)) table.set(cls, {});
              table.get(cls)[prop] = { value, where: `${rel}:${line}` };
            }
          }
        }
      }
      i = close + 1;
    }
  }
  return table;
}

const current = collect();
const flat = {};
for (const [cls, props] of [...current.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  flat[cls] = {};
  for (const [p, v] of Object.entries(props).sort((a, b) => a[0].localeCompare(b[0]))) flat[cls][p] = v.value;
}

if (WRITE) {
  writeFileSync(SNAPSHOT, JSON.stringify(flat, null, 2) + "\n", "utf8");
  console.log(`快照已写入 ${SNAPSHOT}（${Object.keys(flat).length} 个类）`);
  process.exit(0);
}

if (!existsSync(SNAPSHOT)) {
  console.log("还没有快照，先跑：node tools/ui-audit/css-contract.mjs --write");
  process.exit(0);
}
const old = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

const changes = [];
for (const cls of new Set([...Object.keys(old), ...Object.keys(flat)])) {
  if (ONLY && cls !== ONLY.replace(/^\./, "")) continue;
  const o = old[cls] || {};
  const n = flat[cls] || {};
  for (const prop of new Set([...Object.keys(o), ...Object.keys(n)])) {
    const ov = typeof o[prop] === "string" ? o[prop] : o[prop]?.value;
    const nv = typeof n[prop] === "string" ? n[prop] : n[prop]?.value;
    if (ov !== nv) {
      const where = current.get(cls)?.[prop]?.where ?? "（已删除）";
      changes.push(`  .${cls}  ${prop}: ${ov ?? "（无）"}  →  ${nv ?? "（无）"}    @ ${where}`);
    }
  }
}

console.log(`CSS 有效声明快照 —— 比对 ${Object.keys(flat).length} 个类（顶层规则，不含条件块）`);
if (changes.length === 0) {
  console.log("✅ 无变化");
  process.exit(0);
}
console.log(`\n⚠ ${changes.length} 处生效取值发生变化（类名没错、取值被改了）：`);
for (const c of changes) console.log(c);
console.log("\n如果这些变化是有意的，跑 `node tools/ui-audit/css-contract.mjs --write` 更新快照并一起提交。");
process.exit(1);

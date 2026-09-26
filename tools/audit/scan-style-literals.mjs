/**
 * 样式"写死值"**棘轮**门禁（第 155 轮 P0-4，audit 第 19 道）。
 *
 * ## 为什么是棘轮而不是"必须为 0"
 *
 * 我们和 OpenBitFun 的差距不是"有没有写死"，而是"写死的量能不能只降不升"：
 * 实测（本工具默认口径）`src/styles.css` 的**裸颜色字面量只有 7 处**（0.1%），
 * 但 `line-height` 100 条里 100 条写死、`font-weight` 里九成写死、皮肤文件里
 * 裸颜色字面量 135 处 —— 这些数字必须**可见且只许降**，否则下一轮又会漂回去。
 *
 * ⚠️ 口径说明（这一条踩过坑，第 155 轮自查）：
 * 第一版用 `font-size:\s*(?!var\()` 这种负向断言，而 `\s*` 能匹配零字符，
 * 于是 `font-size: var(--fs-sm)` 也被算成"写死"，报出"字号写死 917 处"——
 * 真实值只有十几个。**现在的判据**：一条声明算写死 ⇔ 它的值里**完全没有 `var(--…)`**；
 * 颜色另有一条更严格的口径：值里没有 `var()` **且**含真实的颜色字面量（`#hex` / `rgb()` / `hsl()`），
 * `var(--x, #fallback)` 里的兜底**不算写死**（那是正当做法，单独计数）。
 *
 * ## 用法
 *
 *   node tools/audit/scan-style-literals.mjs              # 打印当前读数
 *   node tools/audit/scan-style-literals.mjs --check      # 闸门：任一族超过基线就红
 *   node tools/audit/scan-style-literals.mjs --update     # 收紧基线（**只许降**；要升得显式 --force）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : path.join(HERE, "..", ".."));
const BASELINE_FILE = path.join(HERE, "style-literals-baseline.json");

export const DEFAULT_FILES = [
  "src/styles.css",
  "src/styles/codem-ui.css",
  "src/styles/notebook-workspace.css",
  "src/styles/task-center.css",
  "src/styles/skin-hub.css",
  "src/styles/skin-dream.css",
];

/** 颜色字面量（含 3/4/6/8 位 hex 与 rgb()/rgba()/hsl()/hsla()） */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
/** 哪些属性算"颜色族" */
const COLOR_PROPS = /^(color|background|background-color|border|border-[a-z-]+|outline|outline-color|fill|stroke|box-shadow|text-shadow|accent-color|caret-color|text-decoration-color|scrollbar-color|column-rule)$/;

/** 其余各族：属性 → 说明。判据统一为"该声明值里没有任何 var()" */
export const PLAIN_FAMILIES = {
  "line-height": /^line-height$/,
  "letter-spacing": /^letter-spacing$/,
  "font-weight": /^font-weight$/,
  "font-size": /^font-size$/,
  "z-index": /^z-index$/,
  "border-radius": /^border(-[a-z]+)?-radius$/,
  "box-shadow": /^box-shadow$/,
  "animation/transition": /^(transition|animation)(-duration|-delay|-timing-function)?$/,
};

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[\w-]+\s*:\s*[^;]+;/g, "");

/**
 * **取消/继承类关键字 ≠ 写死值**（第 156 轮口径修正，与"字号 917"那次同类）。
 *
 * 起因是具体的一件事：玻璃表面的降级块需要 `box-shadow: none`（把 `@supports` 里加的内高光撤掉），
 * 而按老口径它算"写死了一个阴影"⇒ 正确做法反被判成违规、棘轮被推高 2 处。
 * `none`/`inherit`/`initial`/`unset`/`revert` 都不携带任何设计取值：
 * 门禁要守的是"高度/字号/线宽**用了令牌没有**"，不是"这个属性有没有被还原"。
 *
 * ⚠️ 明确**不**放进这个白名单的：`bold`（那是真实字重 700）、`auto`、`normal`、`transparent` ——
 * 它们是取值，照旧算写死（`font-weight: bold` 该走 `--weight-*`）。
 * 这些不计入 raw，但单独统计进 `keyword`，报告里列出来（可见性不降）。
 *
 * ## 第十族：`accent-tint`（品牌色手写混色，第 156 轮 D5）
 *
 * 判据与其它九族不同：它数的是 `color-mix(in srgb, var(--accent…) N%, …)` 里的 **N** ——
 * 也就是"绕过 --accent-surface/-border 阶梯、自己现编一个百分比"的次数。
 * 这类值里没有 hex，颜色族看不见它；而它正是"同一个品牌色在不同组件里深浅不一"的来源。
 * 它同样进棘轮（raw 只许降），基线里已有该族。
 */
const NON_VALUE_KEYWORDS = /^(none|inherit|initial|unset|revert)$/i;

/**
 * 扫描一批文件。`files` 形如 `[{ path, css }]`（便于用例注入夹具）。
 * 返回 { files, totals, perFile }
 */
export function scanStyleLiterals({ files }) {
  const totals = {};
  const perFile = {};
  const bump = (bag, family, kind) => {
    bag[family] = bag[family] ?? { raw: 0, fallback: 0, keyword: 0 };
    bag[family][kind]++;
  };

  for (const f of files) {
    const css = strip(f.css);
    const bag = {};
    for (const d of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g)) {
      const prop = d[1];
      const value = d[2].trim();
      const hasVar = /var\(--/.test(value);
      const isFallback = /var\(\s*--[\w-]+\s*,/.test(value);
      /**
       * ⚠️ 顺序有讲究：**先判"具名族"再判"颜色族"**，两者不能互斥跳过。
       * 第一版在颜色族分支里 `continue`，于是 `border-radius`（它匹配 `border-[a-z-]+`）
       * 与 `box-shadow` 被颜色族吃掉、永远不进各自的族 —— 实测少报了 20 + 6 处。
       * `box-shadow` 刻意**两边都算**：它既是一条"高度令牌有没有走"的判据，
       * 也是一个真的颜色载体（`0 1px 3px rgba(...)`）。
       */
      for (const [family, re] of Object.entries(PLAIN_FAMILIES)) {
        if (!re.test(prop)) continue;
        if (hasVar) {
          if (isFallback) bump(bag, family, "fallback");
        } else if (NON_VALUE_KEYWORDS.test(value)) {
          bump(bag, family, "keyword");
        } else {
          bump(bag, family, "raw");
        }
      }
      if (COLOR_PROPS.test(prop)) {
        if (!hasVar && COLOR_LITERAL.test(value)) bump(bag, "color", "raw");
        else if (isFallback && COLOR_LITERAL.test(value)) bump(bag, "color", "fallback");
      }
      /* 品牌色**手写混色**（第 156 轮 D5）：`color-mix(in srgb, var(--accent…) N%, …)` 里
         那 N 个百分比是"绕过阶梯现编一档"。它躲过了颜色族（值里没有 hex），但正是 D5 说的那个毛病：
         实测曾经有 **20 种百分比**、64 处。收敛成四档令牌后，剩下的每一处都由这一族盯着，只许降。 */
      if (/color-mix\(in srgb,/i.test(value) && /var\(--accent[\w-]*(?:,[^)]*)?\)\s*[\d.]+%/i.test(value)) {
        bump(bag, "accent-tint", "raw");
      }
    }
    perFile[f.path] = bag;
    for (const [family, c] of Object.entries(bag)) {
      totals[family] = totals[family] ?? { raw: 0, fallback: 0, keyword: 0 };
      totals[family].raw += c.raw;
      totals[family].fallback += c.fallback;
      totals[family].keyword += c.keyword;
    }
  }
  return { files: files.map((f) => f.path), totals, perFile };
}

export function loadDefaultFiles(root = ROOT) {
  return DEFAULT_FILES.filter((rel) => fs.existsSync(path.join(root, rel))).map((rel) => ({
    path: rel,
    css: fs.readFileSync(path.join(root, rel), "utf8"),
  }));
}

export function readBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
}

/**
 * 棘轮判定（抽出来给用例注入夹具，也便于变异自证）：
 * 返回 { over, tighten, families } —— over 非空即"有族涨了"。
 */
export function evaluateRatchet(totals, baseline) {
  const base = baseline?.raw ?? {};
  const families = [...new Set([...Object.keys(totals), ...Object.keys(base)])].sort();
  const over = families.filter((f) => (totals[f]?.raw ?? 0) > (base[f] ?? 0));
  const tighten = families.filter((f) => (totals[f]?.raw ?? 0) < (base[f] ?? 0));
  return { over, tighten, families };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const { totals, perFile } = scanStyleLiterals({ files: loadDefaultFiles() });
  const baseline = readBaseline();
  const families = [...new Set([...Object.keys(totals), ...Object.keys(baseline?.raw ?? {})])].sort();

  console.log("家族".padEnd(22) + "写死".padStart(7) + "基线".padStart(7) + "兜底".padStart(7) + "关键字".padStart(8) + "  说明");
  for (const fam of families) {
    const raw = totals[fam]?.raw ?? 0;
    const base = baseline?.raw?.[fam];
    const fb = totals[fam]?.fallback ?? 0;
    const kw = totals[fam]?.keyword ?? 0;
    const mark = base === undefined ? "（新族）" : raw > base ? `🔴 超 ${raw - base}` : raw < base ? `✅ 可收紧 ${base - raw}` : "✅";
    console.log(fam.padEnd(22) + String(raw).padStart(7) + String(base ?? "-").padStart(7) + String(fb).padStart(7) + String(kw).padStart(8) + "  " + mark);
  }
  console.log("\n逐文件（写死数）：");
  for (const [f, bag] of Object.entries(perFile)) {
    const parts = Object.entries(bag).filter(([, v]) => v.raw > 0).map(([k, v]) => `${k}=${v.raw}`).sort();
    console.log(`  ${f.padEnd(30)} ${parts.join("  ") || "（无）"}`);
  }

  if (process.argv.includes("--update")) {
    const next = {};
    for (const fam of families) {
      const raw = totals[fam]?.raw ?? 0;
      const base = baseline?.raw?.[fam];
      if (base !== undefined && raw > base && !process.argv.includes("--force")) {
        console.error(`\n❌ 拒绝收紧：${fam} 从 ${base} 涨到 ${raw}。棘轮只许降；确实要放宽请显式加 --force。`);
        process.exit(1);
      }
      next[fam] = raw;
    }
    fs.writeFileSync(
      BASELINE_FILE,
      JSON.stringify(
        {
          _note: "样式写死值棘轮（第 155 轮 P0-4）。判据与口径见 tools/audit/scan-style-literals.mjs 文件头。只许降：--update 会拒绝变大的族，除非显式 --force。",
          _measuredAt: new Date().toISOString(),
          raw: next,
        },
        null,
        1,
      ) + "\n",
      "utf8",
    );
    console.log(`\n已写基线：${path.relative(ROOT, BASELINE_FILE)}`);
    process.exit(0);
  }

  if (process.argv.includes("--check")) {
    if (!baseline) {
      console.error("❌ 没有基线文件；先跑一次 `node tools/audit/scan-style-literals.mjs --update`。");
      process.exit(1);
    }
    const over = families.filter((fam) => (totals[fam]?.raw ?? 0) > (baseline.raw[fam] ?? 0));    if (over.length > 0) {
      console.error(`🔴 有 ${over.length} 个族的写死值超过基线（棘轮只许降）：`);
      for (const fam of over) console.error(`   ${fam}: ${baseline.raw[fam] ?? 0} → ${totals[fam].raw}（+${totals[fam].raw - (baseline.raw[fam] ?? 0)}）`);
      console.error("处置：把新增的写死值换成令牌（颜色/行高/字距/字重/圆角/层级都有对应令牌），或在确实必要时显式 --update --force 并说明理由。");
      process.exit(1);
    }
    const tighten = families.filter((fam) => (totals[fam]?.raw ?? 0) < (baseline.raw[fam] ?? 0));
    console.log(`✅ 棘轮通过：${families.length} 个族全部不超过基线` + (tighten.length ? `（其中 ${tighten.length} 个族已下降，可跑 --update 收紧：${tighten.join(", ")}）` : ""));
    process.exit(0);
  }
  process.exit(0);
}

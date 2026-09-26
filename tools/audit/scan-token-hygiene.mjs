/**
 * 设计令牌**卫生**门禁（第 155 轮 P0-1，audit 第 18 道）。
 *
 * ## 它解决的问题（真机取证）
 *
 * `--radius-xs` 在 `src/styles.css` 里被**定义过两次**：
 * `:79` 写 `0.25rem`（注释："4px：细条、滚动条滑块、极密集内联块"），
 * 而文件后半段另一个 `:root` 又写 `8px`（注释却写"补齐 6px 这一档"）。
 * 同特异度、后写者胜 ⇒ 装机版运行时实测 **8px**，与 `--radius` 完全重复，
 * **81 处** `var(--radius-xs)` 全都比设计意图更圆，而且没人发现（它不报错、不告警）。
 *
 * ## 四条判据（都对着"能被机器判"的形态）
 *
 * | # | 判据 | 为什么 |
 * | --- | --- | --- |
 * | H1 | 同一个令牌不得在**同一档作用域**里定义两次 | 就是上面那个 bug：重复定义 = 静默覆盖 |
 * | H2 | 几何刻度（radius 家族 / space 家族）**要么不定义、要么整套定义** | 皮肤只改一半会让阶梯断裂（半套覆盖最难查） |
 * | H3 | 刻度必须**非递减**（xs ≤ sm ≤ radius ≤ md ≤ lg ≤ xl） | 第 34 波踩过"xs 比 sm 还大"的命名反转 |
 * | H4 | 几何令牌的值必须是**长度/数字**（px/rem/单位less），别名只能是 `var()` | 防止把颜色/百分比误写进几何刻度 |
 *
 * ## 边界（如实写）
 *
 * - 只检查**几何/刻度**类令牌（radius / space / control / z / lh / ls / icon / fs / motion）：
 *   颜色令牌本来就允许在各档之间自由覆盖（那正是"主题"的定义）。
 * - "作用域"按选择器字符串归一化：`:root` 与 `:root, [data-theme="light"]` 视为同档默认作用域，
 *   `[data-skin="hub"]` 各自一档。
 * - 不解析 `@media` / `@supports` 嵌套（本仓库的令牌块都在顶层）。
 *
 * 用法：
 *   node tools/audit/scan-token-hygiene.mjs            # 列问题
 *   node tools/audit/scan-token-hygiene.mjs --json
 *   node tools/audit/scan-token-hygiene.mjs --check    # 闸门（有问题退出码 1）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : path.join(HERE, "..", ".."));

/** 默认扫这些文件（皮肤的覆盖是**允许**的，但必须成套 —— 见 H2） */
export const DEFAULT_FILES = [
  "src/styles.css",
  "src/styles/codem-ui.css",
  "src/styles/skin-hub.css",
  "src/styles/skin-dream.css",
];

const GEOMETRY_PREFIXES = ["--radius", "--space", "--control", "--z-", "--lh-", "--ls-", "--icon", "--fs-", "--weight", "--duration", "--ease"];

/** 刻度家族：家族名 → 成员（按阶梯顺序） */
export const SCALE_FAMILIES = {
  radius: ["--radius-xs", "--radius-sm", "--radius", "--radius-md", "--radius-lg", "--radius-xl", "--radius-full"],
  space: Array.from({ length: 15 }, (_, i) => `--space-${i + 1}`),
};

const isGeometry = (name) => GEOMETRY_PREFIXES.some((p) => name.startsWith(p));

/** 归一化作用域名：`:root` / `:root, [data-theme=…]` → "default"；`[data-skin="hub"]` → 它自己 */
export function scopeOf(selector) {
  const s = selector.replace(/\s+/g, " ").trim();
  if (/^:root(\s*,|$)/.test(s)) return "default";
  const skin = s.match(/\[data-skin="?([\w-]+)"?\]/);
  if (skin) return `skin:${skin[1]}`;
  const theme = s.match(/\[data-theme="?([\w-]+)"?\]/);
  if (theme) return `theme:${theme[1]}`;
  return s.slice(0, 60);
}

/** 从 CSS 文本里抠出所有形如 `选择器 { --x: 值; }` 的令牌定义 */
export function collectTokenDefs(css, file) {
  const defs = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    const body = m[2];
    const bodyStart = m.index + m[0].indexOf("{");
    for (const t of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      const name = t[1];
      const value = t[2].trim();
      const line = clean.slice(0, bodyStart + t.index).split("\n").length;
      defs.push({ file, selector, scope: scopeOf(selector), name, value, line });
    }
  }
  return defs;
}

const toPx = (value) => {
  const v = value.trim();
  if (/^var\(/.test(v)) return null; // 别名，交给被引用的令牌判
  if (/^-?\d*\.?\d+px$/.test(v)) return parseFloat(v);
  if (/^-?\d*\.?\d+rem$/.test(v)) return parseFloat(v) * 16;
  if (/^-?\d*\.?\d+$/.test(v)) return parseFloat(v); // 无单位（z / lh / weight）
  return NaN; // 不可解析（颜色、百分比…）
};

/**
 * 扫一批文件，返回 { files, defs, problems }。
 * `files` 参数便于用例注入夹具：`[{ path, css }]`。
 */
export function scanTokenHygiene({ files }) {
  const defs = files.flatMap((f) => collectTokenDefs(f.css, f.path));
  const problems = [];

  /* H1：同一作用域里重复定义同一令牌 */
  const byScopeName = new Map();
  for (const d of defs) {
    if (!isGeometry(d.name)) continue;
    const key = `${d.scope}\u0000${d.name}`;
    if (!byScopeName.has(key)) byScopeName.set(key, []);
    byScopeName.get(key).push(d);
  }
  for (const [key, list] of byScopeName) {
    if (list.length < 2) continue;
    const [scope, name] = key.split("\u0000");
    const values = new Set(list.map((d) => d.value));
    problems.push({
      rule: "H1",
      file: list[0].file,
      lines: list.map((d) => d.line),
      message:
        `同一作用域（${scope}）里 \`${name}\` 被定义了 ${list.length} 次` +
        (values.size > 1 ? `、且取值不同（${list.map((d) => d.value).join(" / ")}）⇒ 后写者静默覆盖前者` : "（取值相同，但仍是重复来源）"),
    });
  }

  /* H2/H3/H4：按作用域检查刻度家族 */
  for (const [family, members] of Object.entries(SCALE_FAMILIES)) {
    const scopes = new Set(defs.filter((d) => members.includes(d.name)).map((d) => d.scope));
    for (const scope of scopes) {
      const present = members
        .map((name) => defs.find((d) => d.scope === scope && d.name === name))
        .filter(Boolean);
      const missing = members.filter((name) => !present.some((d) => d.name === name));
      if (missing.length > 0 && present.length > 0) {
        problems.push({
          rule: "H2",
          file: present[0].file,
          lines: present.map((d) => d.line),
          message: `作用域 ${scope} 的 ${family} 刻度不完整：定义了 ${present.length}/${members.length}，缺 ${missing.join(", ")}（阶梯断裂最难排查）`,
        });
      }
      /* H3/H4：只对本作用域**全部**成员都给出字面量值时才判单调（有别名就跳过单调） */
      const values = present.map((d) => ({ name: d.name, px: toPx(d.value), raw: d.value, line: d.line }));
      for (const v of values) {
        if (v.px === null) continue; // var() 别名
        if (Number.isNaN(v.px)) {
          problems.push({
            rule: "H4",
            file: present[0].file,
            lines: [v.line],
            message: `刻度令牌 \`${v.name}\`（作用域 ${scope}）的值 \`${v.raw}\` 不是长度/数字 —— 几何刻度不接受颜色/百分比`,
          });
        }
      }
      const numeric = values.filter((v) => typeof v.px === "number" && !Number.isNaN(v.px));
      if (numeric.length === values.length && numeric.length > 1) {
        for (let i = 1; i < numeric.length; i++) {
          if (numeric[i].px < numeric[i - 1].px) {
            problems.push({
              rule: "H3",
              file: present[0].file,
              lines: [numeric[i - 1].line, numeric[i].line],
              message: `${family} 刻度在该作用域不是非递减：\`${numeric[i - 1].name}\`=${numeric[i - 1].raw} > \`${numeric[i].name}\`=${numeric[i].raw}`,
            });
          }
        }
      }
    }
  }

  return { defs, problems };
}

export function loadDefaultFiles(root = ROOT) {
  return DEFAULT_FILES.filter((rel) => fs.existsSync(path.join(root, rel))).map((rel) => ({
    path: rel,
    css: fs.readFileSync(path.join(root, rel), "utf8"),
  }));
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const files = loadDefaultFiles();
  const { defs, problems } = scanTokenHygiene({ files });
  const geometry = defs.filter((d) => isGeometry(d.name));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ files: files.map((f) => f.path), geometryDefs: geometry.length, problems }, null, 1));
  } else {
    console.log(`令牌卫生：扫了 ${files.length} 个文件、几何/刻度令牌定义 ${geometry.length} 条`);
    console.log(`按作用域：${[...new Set(defs.map((d) => d.scope))].join(", ")}`);
    if (problems.length === 0) {
      console.log("H1 重复定义 0、H2 刻度成套 ✅、H3 单调 ✅、H4 类型 ✅");
    } else {
      for (const p of problems) console.log(`  🔴 [${p.rule}] ${p.file}:${p.lines.join(",")}  ${p.message}`);
    }
  }
  if (process.argv.includes("--check") && problems.length > 0) process.exit(1);
  process.exit(0);
}

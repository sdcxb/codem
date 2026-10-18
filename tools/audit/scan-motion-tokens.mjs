/**
 * 动效棘轮：**除 `--ease-*` 令牌定义处外，CSS 里不许出现裸 `cubic-bezier(...)`**。
 *
 * ## 为什么（对标 open-claude-ui 的命名 ease 集）
 *
 * 同一类交互（幽灵按钮 / 展开 / 入场 / 回弹）在不同面板里用不同曲线，手感就会不一致；
 * 而这个仓库的既有纪律是"口径只许有一处"（字号/圆角/间距/颜色都有棘轮）。
 * 动效此前是唯一没有令牌化的维度 —— 本脚本把它补上：
 *
 * - 令牌定义：`src/styles.css` 里 `--ease-*: cubic-bezier(...)`（允许）
 * - 其它任何 CSS 规则里出现裸 `cubic-bezier(...)`（不允许，基线为 0）
 *
 * 用法：
 *   node tools/audit/scan-motion-tokens.mjs          # 校验（超基线即红）
 *   node tools/audit/scan-motion-tokens.mjs --json   # 机器可读
 *   node tools/audit/scan-motion-tokens.mjs --update # 重算基线（只应在上限下调时用）
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const BASELINE = path.join(ROOT, "tools", "audit", "motion-baseline.json");
const CSS_ROOT = path.join(ROOT, "src");
const TOKEN_LINE_RE = /^\s*--ease-[a-z0-9-]+\s*:/i;

function collectCssFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "test") continue;
      out.push(...collectCssFiles(full));
    } else if (entry.name.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

export function scanMotion() {
  const files = collectCssFiles(CSS_ROOT);
  const violations = [];
  let rawCount = 0;
  for (const file of files) {
    const rel = path.relative(ROOT, file).replaceAll("\\", "/");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("cubic-bezier(")) return;
      if (TOKEN_LINE_RE.test(line)) return; // 令牌定义：允许
      // 注释里提到不算
      const code = line.replace(/\/\*[\s\S]*?\*\//g, "");
      if (!code.includes("cubic-bezier(")) return;
      rawCount++;
      violations.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160) });
    });
  }
  const baseline = fs.existsSync(BASELINE)
    ? JSON.parse(fs.readFileSync(BASELINE, "utf8"))
    : { rawCubicBezier: 0 };
  return { rawCount, baseline: baseline.rawCubicBezier ?? 0, violations, files: files.length };
}

const isMain = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (isMain) {
  const result = scanMotion();
  if (process.argv.includes("--update")) {
    fs.writeFileSync(BASELINE, JSON.stringify({ rawCubicBezier: result.rawCount }, null, 2) + "\n", "utf8");
    console.log(`基线已写入 ${path.relative(ROOT, BASELINE)}（rawCubicBezier=${result.rawCount}）`);
    process.exit(0);
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.rawCount > result.baseline ? 1 : 0);
  }
  if (result.rawCount > result.baseline) {
    console.error(`❌ 裸 cubic-bezier：${result.rawCount} 处 > 基线 ${result.baseline}`);
    for (const v of result.violations.slice(0, 20)) console.error(`   ${v.file}:${v.line}  ${v.text}`);
    console.error("修法：改用 --ease-* 令牌（src/styles.css 顶部）");
    process.exit(1);
  }
  console.log(`✅ 动效棘轮通过：裸 cubic-bezier ${result.rawCount} 处 ≤ 基线 ${result.baseline}（扫描 ${result.files} 个 CSS）`);
}

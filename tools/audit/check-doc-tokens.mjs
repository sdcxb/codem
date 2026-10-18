/**
 * 文档 ↔ 令牌对账：`docs/ui-spec.md` 里引用的每个 `--token` 必须在 CSS 里真的定义。
 *
 * ## 为什么需要（对标 open-claude-ui 的 `scripts/check-tokens.mjs`）
 *
 * UI 文档最容易腐化的方式是"文档里写着 `--surface-pressed`，代码里早就改名/删了" ——
 * 读者照着文档写，写出来的是**无效声明**（CSS 静默忽略）。对方把这条做成了 CI 检查；
 * 我们把它做成判据，并且额外要求：动效令牌必须**全部**在文档里出现（防止新增令牌不写文档）。
 *
 * 用法：
 *   node tools/audit/check-doc-tokens.mjs          # 校验
 *   node tools/audit/check-doc-tokens.mjs --json   # 机器可读
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const DOC = path.join(ROOT, "docs", "ui-spec.md");
const CSS_DIRS = [path.join(ROOT, "src")];

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

/** 收集所有 CSS 里定义过的自定义属性名（`--x:` 形式） */
export function definedTokens() {
  const defined = new Set();
  for (const file of CSS_DIRS.flatMap(collectCssFiles)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/(--[a-z0-9][a-z0-9-]*)\s*:/gi)) defined.add(m[1]);
  }
  return defined;
}

export function scanDocTokens() {
  const doc = fs.readFileSync(DOC, "utf8");
  const referenced = [...new Set([...doc.matchAll(/`(--[a-z0-9][a-z0-9-]*)`/gi)].map((m) => m[1]))];
  const defined = definedTokens();
  const missing = referenced.filter((t) => !defined.has(t));

  // 反方向：`:root` 里声明的 --ease-* / --duration-* 必须在文档里出现
  const rootCss = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
  const motionTokens = [...new Set([...rootCss.matchAll(/^\s*(--(?:ease|duration)-[a-z0-9-]+)\s*:/gim)].map((m) => m[1]))];
  const undocumented = motionTokens.filter((t) => !referenced.includes(t));

  return { referenced, missing, motionTokens, undocumented };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const result = scanDocTokens();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.missing.length === 0 && result.undocumented.length === 0 ? 0 : 1);
  }
  if (result.missing.length > 0) {
    console.error(`❌ 文档引用了未定义的令牌（${result.missing.length}）：`);
    for (const t of result.missing) console.error(`   ${t}`);
    process.exit(1);
  }
  if (result.undocumented.length > 0) {
    console.error(`❌ 动效令牌未写进文档（${result.undocumented.length}）：`);
    for (const t of result.undocumented) console.error(`   ${t}`);
    process.exit(1);
  }
  console.log(`✅ 文档令牌对账通过：引用 ${result.referenced.length} 个令牌全部有定义，动效令牌 ${result.motionTokens.length} 个全部已记录`);
}

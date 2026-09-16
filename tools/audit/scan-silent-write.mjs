/**
 * 审计门禁 #2 —— A 类「静默空写」扫描器（第 88 波：从一次性脚本升级为门禁）
 *
 * ## 判据
 *
 * 全项目搜索带 id 定向的写语句：`db.run(`UPDATE <table> SET … WHERE id = ?`, …)`。
 * 这类语句"应该改到某一行"，因此**必须**走 `runGuarded()`（第 83 波引入的静默空写探测器：
 * 影响 0 行时记账 + 告警一次），否则"写了一条不存在的记录"在运行期完全不可见。
 *
 * ## 有意排除
 *
 * - `DELETE … WHERE id = ?` / `DELETE … WHERE <col> = ?`：删一个本来就不存在的行是正常语义，
 *   报出来只会训练出"看什么都像 bug"的噪声（本次扫描把它们作为 info 列在报告里，不计违规）。
 * - `INSERT`：新建行不看影响行数（写失败会抛异常）。
 *
 * ## 退出码
 *
 * 无违规 → 0；有违规 → 1。允许清单（`allowlist.json` 的 `silentWrites`）每条须写明理由。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAllowlist, isAllowed, stripComments } from "./scan-false-success.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..", "..", "src");

function listTsFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  })(root);
  return out;
}

/**
 * 执行扫描。
 * @param {{root?: string, allowlist?: object}} opts
 */
export function scanSilentWrites(opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  const allow = opts.allowlist ?? loadAllowlist();
  const repoRoot = path.resolve(__dirname, "..", "..");
  const updates = [];
  const deletes = [];

  for (const file of listTsFiles(root)) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    const lines = src.split("\n");
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");

    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("db.run(")) return;
      // 兼容三种引用风格：模板串 ``、单引号、双引号（真实代码以模板串为主）
      if (/WHERE\s+id\s*=\s*\?/i.test(trimmed) && /^\s*db\.run\(\s*[`'"]UPDATE/i.test(line)) {
        updates.push({ file: rel, line: i + 1, code: trimmed.slice(0, 160) });
      } else if (/^\s*db\.run\(\s*[`'"]DELETE/i.test(line)) {
        deletes.push({ file: rel, line: i + 1, code: trimmed.slice(0, 160) });
      }
    });
  }

  const violations = updates.filter((u) => !isAllowed(u, allow.silentWrites ?? []));
  return { updates, deletes, violations, scannedFiles: listTsFiles(root).length };
}

// ========== CLI ==========

function main() {
  const json = process.argv.includes("--json");
  const result = scanSilentWrites({});
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`A 类（静默空写）扫描：${result.scannedFiles} 个文件`);
    console.log(`  未走 runGuarded 的 UPDATE … WHERE id = ?：${result.updates.length}`);
    console.log(`  DELETE（正常语义，仅列出）：${result.deletes.length}`);
    for (const v of result.violations) console.log(`  ✗ ${v.file}:${v.line}  ${v.code}`);
    console.log(
      result.violations.length === 0
        ? "✅ 无未豁免的命中"
        : `❌ ${result.violations.length} 处未豁免（要么接 runGuarded，要么在 allowlist.json 写明理由）`,
    );
  }
  process.exit(result.violations.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

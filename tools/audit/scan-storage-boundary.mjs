/**
 * 审计门禁 #4 —— D 类「存储边界」（第 92 波）
 *
 * ## 为什么需要
 *
 * 迁移 SQLite 到 Rust 的整个意义在于**渲染进程不再持有 WASM 数据库、不再写 SQL、不再整库导出**。
 * 但"迁移"是一次跨几十个文件的大改：没有机器约束的话，改完还会被新代码悄悄加回去
 * （一句 `import SqlJs from "sql.js"`、一处 `db.export()`、一段内联 `SELECT` 就够了）。
 * 所以这条门禁把"边界"变成可执行的规则，并**分阶段收紧**（迁移期允许清单，切换完成后清零）。
 *
 * ## 规则（`level` 表示当前是硬失败还是仅报告）
 *
 * - **D1** 渲染侧不得直接依赖 sql.js（`from "sql.js"` / `sql-wasm`），
 *   例外：`src/core/storage/database.ts`（迁移期的 WASM 实现本体）。
 * - **D2** 渲染侧不得出现 `db.export()`（整库导出 —— 越界第一嫌疑）。
 * - **D3** 渲染侧不得出现**裸 SQL 字面量**（`SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE|PRAGMA`），
 *   例外：迁移期的 storage 实现与 schema 定义文件。
 * - **D4** 渲染侧不得出现 `BEGIN TRANSACTION` / `COMMIT`（事务归 Rust；异步化后跨 await 必然交错）。
 * - **D5** 仓储访问必须经端口（`getStoragePort()` / `SqlitePort`）——
 *   在 P3 完成前以 allowlist 记录"待迁移文件"，切换一个模块就删一条。
 *
 * ## 为什么这些规则"可证明"
 *
 * 它们都是**字面量/结构**级判定（不猜语义）：命中就是命中，可逐条复核；
 * 允许清单每条必须写明理由（由 `src/test/audit-gates.test.ts` 强制）。
 *
 * 用法：
 *   node tools/audit/scan-storage-boundary.mjs          # 报告 + 未豁免命中 → exit 1
 *   node tools/audit/scan-storage-boundary.mjs --json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAllowlist, isAllowed, stripComments } from "./scan-false-success.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  })(dir);
  return out;
}

const RULES = [
  {
    id: "D1",
    why: "渲染侧直接依赖 sql.js/WASM 数据库（迁移目标：只用 Rust 引擎）",
    re: /from\s+["']sql\.js[^"']*["']|from\s+["'][^"']*sql-wasm[^"']*["']/,
  },
  {
    id: "D2",
    why: "整库导出（db.export）——单次 O(库大小) 的 WASM 分配，越界第一嫌疑",
    re: /\bdb\.export\s*\(|\.export\(\)\s*;?\s*$|\bexport\(\)\s*(?:as|\))/,
  },
  {
    id: "D3",
    why: "裸 SQL 字面量（SQL 只应存在于 Rust 侧；渲染侧走仓储命令）",
    /**
     * 只匹配"看起来是 SQL 语句"的字符串：关键字后**必须跟空白**（`SELECT\s+`、`INSERT\s+INTO`…）。
     * 为什么必须这样：`"selected"` / `"selectedIds"` 这类 CSS 类名与变量名会以 `select` 开头，
     * 不做这个约束会报出几百条噪声（第一版就踩了：638 条命中里绝大多数是 className）。
     */
    re: /["'`]\s*(?:SELECT\s+[\s\S]{0,40}?\sFROM\b|INSERT\s+INTO\b|UPDATE\s+[A-Za-z_]\w*\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:VIRTUAL\s+)?TABLE\b|ALTER\s+TABLE\b|PRAGMA\s+[a-z_]+\b)/i,
  },
  {
    id: "D4",
    why: "渲染侧自己做事务（BEGIN/COMMIT 归 Rust；异步化后跨 await 必然交错）",
    re: /["'`]\s*(?:BEGIN\s+TRANSACTION|COMMIT|ROLLBACK)\s*["'`]/i,
  },
  {
    id: "D5",
    why: "绕过存储端口直接拿数据库句柄（getDatabase()）",
    re: /\bgetDatabase\s*\(\s*\)/,
  },
];

export function scanStorageBoundary(opts = {}) {
  const root = opts.root ?? SRC;
  const allow = opts.allowlist ?? loadAllowlist();
  const entries = allow.storageBoundary ?? [];
  const findings = [];

  for (const file of listFiles(root)) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    src.split("\n").forEach((line, i) => {
      for (const rule of RULES) {
        if (!rule.re.test(line)) continue;
        const finding = { file: rel, line: i + 1, rule: rule.id, why: rule.why, preview: line.trim().slice(0, 140) };
        findings.push(finding);
        break; // 一行只记一条（避免同一行被多条规则重复计）
      }
    });
  }

  const violations = findings.filter((f) => !isAllowed(f, entries));
  return { findings, violations, scannedFiles: listFiles(root).length };
}

// ========== CLI ==========

function main() {
  const json = process.argv.includes("--json");
  const result = scanStorageBoundary({});
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`D 类（存储边界）扫描：${result.scannedFiles} 个渲染侧文件`);
    console.log(`  命中：${result.findings.length}（允许清单内 ${result.findings.length - result.violations.length}）`);
    for (const v of result.violations.slice(0, 40)) {
      console.log(`  ✗ ${v.file}:${v.line}  [${v.rule}] ${v.preview}`);
      console.log(`      ${v.why}`);
    }
    if (result.violations.length > 40) console.log(`  … 其余 ${result.violations.length - 40} 条省略`);
    console.log(
      result.violations.length === 0
        ? "✅ 无未豁免的命中（迁移期基线以内）"
        : `❌ ${result.violations.length} 处未豁免（迁移未完成或出现回退）`,
    );
  }
  process.exit(result.violations.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

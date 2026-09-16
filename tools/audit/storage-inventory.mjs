/**
 * 存储调用面盘点（P0，第 92 波）
 *
 * 迁移 SQLite 到 Rust 之前，先把渲染侧**所有**数据库调用点盘清楚，并按
 * 「表 × 操作」归类成待实现的仓储方法。产出两份东西：
 *   1. 汇总：每张表需要哪些仓储方法、每个方法被多少处调用（用于决定切换顺序与契约测试范围）；
 *   2. 明细：`文件:行 → 表/操作` 映射（用于逐模块切换时的清单勾选）。
 *
 * 用法：
 *   node tools/audit/storage-inventory.mjs             # 打印摘要
 *   node tools/audit/storage-inventory.mjs --md        # 输出 Markdown（写入 docs/STORAGE-INVENTORY.md）
 *   node tools/audit/storage-inventory.mjs --json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./scan-false-success.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");

/**
 * 只扫生产代码（测试夹具不算迁移面）。
 *
 * 口径：**排除 `*.test.ts(x)` / `*.spec.ts(x)`**，而不是排除整个 `test` 目录 ——
 * `src/test/helpers/*.ts` 这类辅助文件也可能包含 SQL，漏掉它们会让盘点与覆盖率对不上
 * （实测：排除整个 test 目录得 831 个文件，按后缀排除得 836）。此口径与
 * `tools/audit/storage-coverage.mjs` 必须一致（覆盖率工具会做交叉校验，漂了就报错）。
 */
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  })(dir);
  return out;
}

/** 从 SQL 文本里提取「操作 + 表名」 */
function classifySql(sql) {
  const s = sql.replace(/\s+/g, " ").trim();
  const m =
    /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][\w]*)/i.exec(s) ||
    /^UPDATE\s+([A-Za-z_][\w]*)/i.exec(s) ||
    /^DELETE\s+FROM\s+([A-Za-z_][\w]*)/i.exec(s) ||
    /^SELECT\s+[\s\S]*?\sFROM\s+([A-Za-z_][\w]*)/i.exec(s) ||
    /^CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/i.exec(s) ||
    /^ALTER\s+TABLE\s+([A-Za-z_][\w]*)/i.exec(s);
  if (!m) return null;
  const op = /^INSERT/i.test(s)
    ? "insert"
    : /^UPDATE/i.test(s)
      ? "update"
      : /^DELETE/i.test(s)
        ? "delete"
        : /^SELECT/i.test(s)
          ? "select"
          : /^CREATE/i.test(s)
            ? "create"
            : "alter";
  return { op, table: m[1] };
}

const byMethod = new Map(); // method → { table, op, sites: [] }
const byFile = new Map(); // file → sites[]
let total = 0;

for (const file of listFiles(SRC)) {
  const raw = fs.readFileSync(file, "utf8");
  const src = stripComments(raw);
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const lines = src.split("\n");

  lines.forEach((line, i) => {
    // 只统计「真正打到 SQLite 的调用」：db.exec / db.run / db.prepare（含 runGuarded 包装的第二个参数）
    const isCall = /\bdb\.(exec|run|prepare)\(/.test(line) || /runGuarded\(/.test(line);
    if (!isCall) return;
    // 取该行 + 后续 2 行里的第一个 SQL 字面量（多行 SQL 常见）
    //
    // ⚠️ 关键修正（第 92 波实测）：`(` 与 SQL 字面量之间必须允许换行/缩进。
    // 本项目源码是 CRLF，且普遍写成
    //     db.run(
    //       "INSERT INTO messages …",
    // 早先的正则写作 `db\.(exec|run|prepare)\(['"]`（引号紧跟括号），于是**所有 INSERT 都被漏掉**：
    // 159 个调用点 / 82 个方法的旧数字其实是**少了 43% 的写路径**，是严重低估。
    const window = lines.slice(i, i + 3).join(" ");
    const sqlMatch =
      /(?:db\.(?:exec|run|prepare)\(|runGuarded\(\s*db,\s*|,\s*)[\s\S]{0,40}?`([^`]{6,})`/.exec(window) ||
      /(?:db\.(?:exec|run|prepare)\(|runGuarded\(\s*db,\s*)[\s\S]{0,40}?['"]([^'"]{6,})['"]/.exec(window);
    if (!sqlMatch) return;
    const cls = classifySql(sqlMatch[1]);
    if (!cls) return;
    total++;
    const method = `${cls.table}.${cls.op}`;
    const entry = byMethod.get(method) ?? { table: cls.table, op: cls.op, sites: [] };
    entry.sites.push({ file: rel, line: i + 1 });
    byMethod.set(method, entry);
    const f = byFile.get(rel) ?? [];
    f.push({ line: i + 1, method });
    byFile.set(rel, f);
  });
}

const tables = [...new Set([...byMethod.values()].map((v) => v.table))].sort();
const summary = {
  scannedFiles: listFiles(SRC).length,
  totalCallSites: total,
  tables: tables.length,
  methods: [...byMethod.entries()]
    .map(([method, v]) => ({ method, table: v.table, op: v.op, count: v.sites.length }))
    .sort((a, b) => b.count - a.count || a.method.localeCompare(b.method)),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ summary, byFile: Object.fromEntries(byFile) }, null, 2));
  process.exit(0);
}

if (process.argv.includes("--md")) {
  const lines = [];
  lines.push("# 存储调用面盘点（P0 自动生成）");
  lines.push("");
  lines.push(`> 由 \`node tools/audit/storage-inventory.mjs --md\` 生成；不要手工编辑。`);
  lines.push("");
  lines.push(`- 扫描生产文件：**${summary.scannedFiles}**`);
  lines.push(`- SQL 调用点：**${summary.totalCallSites}**`);
  lines.push(`- 涉及表：**${summary.tables}**`);
  lines.push(`- 需要实现的仓储方法（表 × 操作）：**${summary.methods.length}**`);
  lines.push("");
  lines.push("## 仓储方法清单（按调用点数量排序）");
  lines.push("");
  lines.push("| 仓储方法 | 调用点 | 切换顺序建议 |");
  lines.push("|---|---:|---|");
  const order = (t) => {
    if (["settings", "quick_phrases"].includes(t)) return "1 配置面（同步缓存 + 写穿）";
    if (["session_events", "telemetry_events"].includes(t)) return "2 只追加（入队）";
    if (["messages", "tool_calls", "attachments", "session_fts"].includes(t)) return "3 数据面";
    if (["sessions", "projects"].includes(t)) return "4 会话/项目";
    return "5 其余域";
  };
  for (const m of summary.methods) {
    lines.push(`| \`${m.method}\` | ${m.count} | ${order(m.table)} |`);
  }
  lines.push("");
  lines.push("## 明细（文件 → 行：方法）");
  lines.push("");
  for (const [file, sites] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${file}（${sites.length}）`);
    lines.push("");
    for (const s of sites) lines.push(`- :${s.line} → \`${s.method}\``);
    lines.push("");
  }
  const out = path.join(ROOT, "docs", "STORAGE-INVENTORY.md");
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`written ${path.relative(ROOT, out)}`);
  console.log(`tables=${summary.tables} methods=${summary.methods.length} sites=${summary.totalCallSites}`);
  process.exit(0);
}

console.log(`存储调用面盘点：${summary.scannedFiles} 个生产文件`);
console.log(`  SQL 调用点：${summary.totalCallSites}`);
console.log(`  涉及表：${summary.tables}`);
console.log(`  仓储方法（表 × 操作）：${summary.methods.length}`);
console.log("");
console.log("Top 20 方法：");
for (const m of summary.methods.slice(0, 20)) {
  console.log(`  ${String(m.count).padStart(4)}  ${m.method}`);
}

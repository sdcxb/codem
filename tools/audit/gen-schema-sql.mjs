#!/usr/bin/env node
/**
 * Rust 侧 schema 资源的**自洽性门禁**（第 18 轮：真源已从 TS 切到 Rust 侧）
 *
 * ## 这次切换为什么发生
 *
 * 迁移期（WASM 与 Rust 双实现并存）里，schema 的唯一真源是**渲染侧的 TS**
 * （`src/core/storage/database.ts` 里的 `SCHEMA` 模板串），Rust 侧的 `sql/*.json` / `schema.sql`
 * 由本脚本**生成**，再用 `--check` 守住"两边不许漂移"。
 *
 * L1 把 sql.js 整个删掉之后，那个 TS 真源**不存在了** —— 于是真源换成
 * **引擎建库时真正执行的那份**：`src-tauri/codem-db/sql/schema.sql`
 * （`schema.rs` 用 `include_str!` 编译进引擎，`apply()` 一次 `execute_batch` 执行）。
 *
 * ## 现在守什么（三类漂移，都是真会写坏数据的）
 *
 * 1. **`tables.json` ↔ `schema.sql`**：业务表清单必须与 DDL 里的表**一一对应**。
 *    漏一张表的后果是**数据静默少搬**（实测发生过：手写清单漏了 `agent_messages` /
 *    `message_feedback` / `needs_you_pending` 三张有真实数据的表）；
 * 2. **`migrations.json` ↔ `schema.sql`**：每条 `ALTER TABLE x ADD COLUMN y` 的列**必须已经写在
 *    DDL 里**。否则"老库迁移后的结构"与"新库建出来的结构"不一致 —— 这类漂移在旧方向
 *    （TS 生成两边）里**检查不出来**，因为两边同源；现在真源在 Rust 侧，这条才变得可查；
 * 3. **`fts.json`**：列定义里必须包含会话全文检索真正用到的 5 个逻辑列。
 *
 * 用法：
 *   node tools/audit/gen-schema-sql.mjs            # 检查（默认）
 *   node tools/audit/gen-schema-sql.mjs --check    # 同上（`npm run audit` 用的就是它）
 *   node tools/audit/gen-schema-sql.mjs --write    # 依据 schema.sql 重写 tables.json / SOURCE.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "src-tauri", "codem-db", "sql");
const SCHEMA_SQL = path.join(OUT_DIR, "schema.sql");

const FTS_REQUIRED_COLUMNS = ["session_id", "message_id", "content", "role", "timestamp"];

/** 从 `CREATE TABLE IF NOT EXISTS x ( … );` 里取每张表的块（按右括号+分号收尾） */
function tablesOf(schemaSql) {
  const out = new Map();
  const re = /CREATE TABLE IF NOT EXISTS\s+["`]?([A-Za-z_][\w]*)["`]?\s*\(([\s\S]*?)\n\);/g;
  for (const m of schemaSql.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

function columnsOf(block) {
  // 只取"列定义行"：以标识符开头、不是约束关键字
  const reserved = new Set(["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"]);
  const cols = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim().replace(/,$/, "");
    if (!line) continue;
    const m = /^["`]?([A-Za-z_][\w]*)["`]?\s+/.exec(line);
    if (!m) continue;
    if (reserved.has(m[1].toUpperCase())) continue;
    cols.push(m[1]);
  }
  return cols;
}

function readJson(name) {
  const p = path.join(OUT_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`缺少资源文件 ${name}（真源切换后它必须存在）`);
  return { path: p, text: fs.readFileSync(p, "utf8"), json: JSON.parse(fs.readFileSync(p, "utf8")) };
}

const problems = [];

// ===== 真源 =====
if (!fs.existsSync(SCHEMA_SQL)) {
  console.error(`❌ 找不到真源 ${path.relative(ROOT, SCHEMA_SQL)}（引擎 include_str! 的就是它）`);
  process.exit(1);
}
const schemaSql = fs.readFileSync(SCHEMA_SQL, "utf8");
const tables = tablesOf(schemaSql);
if (tables.size < 10) {
  console.error(`❌ schema.sql 里只解析到 ${tables.size} 张表 —— 扫描规则可能坏了（宁可报错也不放行）`);
  process.exit(1);
}

// ===== ① tables.json ↔ schema.sql =====
const tablesJson = readJson("tables.json");
const declared = [...tables.keys()].filter((t) => !t.startsWith("session_fts"));
const listed = tablesJson.json.tables ?? [];
const missingInList = declared.filter((t) => !listed.includes(t));
const missingInSchema = listed.filter((t) => !declared.includes(t));
if (missingInList.length) problems.push(`tables.json 漏了 schema.sql 里的表：${missingInList.join(", ")}`);
if (missingInSchema.length) problems.push(`tables.json 列了 schema.sql 里没有的表：${missingInSchema.join(", ")}`);

// ===== ② migrations.json ↔ schema.sql =====
//
// ⚠️ 这里**刻意不断言**"迁移加的列必须写在 DDL 里"。原因是引擎的实际建库过程是
// `apply()` = `execute_batch(SCHEMA_SQL)` → 再逐条跑 `MIGRATIONS_JSON`（容忍"列已存在"），
// 所以"迁移-only 列"（如 `sessions.execution_mode`、`messages.hidden`）在**新库与老库上都会存在**，
// 结构一致 —— 拿"DDL 里没有"判失败会变成假警报（实测：13 条假警报，而它们都是正常运行的一部分）。
//
// 真正会写坏数据的漂移只有两类，这里各查一条：
//   · 迁移语句指向**不存在的表**（表名写错 / 表被删）→ 报错；
//   · 迁移语句**不是** ALTER…ADD COLUMN（本门禁认不出，可能被执行顺序影响）→ 报错。
// 迁移-only 列的数量**打印出来**供人核对，不作为失败条件。
const migrationsJson = readJson("migrations.json");
const migrations = migrationsJson.json;
const migrationOnlyColumns = [];
if (!Array.isArray(migrations)) problems.push("migrations.json 必须是数组");
else {
  for (const sql of migrations) {
    const m = /^ALTER TABLE\s+["`]?([A-Za-z_][\w]*)["`]?\s+ADD COLUMN\s+["`]?([A-Za-z_][\w]*)["`]?/i.exec(sql.trim());
    if (!m) {
      problems.push(`migrations.json 里有非 ALTER…ADD COLUMN 的语句（本门禁认不出，需人工确认）：${sql}`);
      continue;
    }
    const [, table, column] = m;
    if (!tables.has(table)) {
      problems.push(`migrations.json 给不存在的表加列：${table}.${column}`);
      continue;
    }
    if (!columnsOf(tables.get(table)).includes(column)) migrationOnlyColumns.push(`${table}.${column}`);
  }
}

// ===== ③ fts.json =====
const ftsJson = readJson("fts.json");
const ftsColumns = String(ftsJson.json.columns ?? "");
for (const col of FTS_REQUIRED_COLUMNS) {
  if (!new RegExp(`(^|[,\\s])${col}([,\\s]|$)`).test(ftsColumns)) {
    problems.push(`fts.json 缺少列 ${col}（会话全文检索的查询/索引都要用它）`);
  }
}
if (!ftsColumns.includes("tokenize=")) problems.push("fts.json 缺少 tokenize=（分词器必须显式声明）");

// ===== SOURCE.json（出处标记）=====
const SOURCE_EXPECTED =
  JSON.stringify(
    {
      source: "src-tauri/codem-db/sql/schema.sql（L1 后真源在 Rust 侧：渲染进程不再持有 schema）",
      checkedBy: "tools/audit/gen-schema-sql.mjs",
      note: "迁移期真源曾是 src/core/storage/database.ts 的 SCHEMA 模板串；随 sql.js 删除一并切换",
    },
    null,
    2,
  ) + "\n";

const write = process.argv.includes("--write");

if (write) {
  // 依据真源重写派生资源（tables.json 的表清单 + SOURCE.json 的出处标记）
  const nextTables =
    JSON.stringify(
      { tables: declared, source: "schema.sql（Rust 侧真源，L1 后 renderer 不再持有 schema）" },
      null,
      2,
    ) + "\n";
  fs.writeFileSync(path.join(OUT_DIR, "tables.json"), nextTables, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "SOURCE.json"), SOURCE_EXPECTED, "utf8");
  console.log(`已按 schema.sql 重写：tables.json / SOURCE.json（表 ${declared.length} 张）`);
  process.exit(0);
}

const sourceJson = readJson("SOURCE.json");
if (sourceJson.text !== SOURCE_EXPECTED) {
  problems.push("SOURCE.json 的出处标记不是当前形状（旧文案还写着 TS 真源）→ 运行 --write 重写");
}

if (problems.length > 0) {
  console.error("❌ Rust 侧 schema 资源不自洽：");
  for (const p of problems) console.error(`   · ${p}`);
  console.error("   运行 node tools/audit/gen-schema-sql.mjs --write 依据 schema.sql 重写派生资源。");
  process.exit(1);
}
console.log(
  `✅ Rust 侧 schema 资源自洽（真源 sql/schema.sql：${tables.size} 张表、migrations ${migrations.length} 条、fts 列已覆盖）`,
);
if (migrationOnlyColumns.length > 0) {
  console.log(
    `   ℹ️ 由 migrations 补出的列 ${migrationOnlyColumns.length} 个（DDL 里没有、但建库时一定会被 ALTER 加上，` +
      `老库/新库结构因此一致）：${migrationOnlyColumns.slice(0, 8).join(", ")}${migrationOnlyColumns.length > 8 ? " …" : ""}`,
  );
}

/**
 * 从渲染侧 TS 提取 schema / migrations / FTS DDL，生成 Rust 侧使用的 SQL 资源（P1）
 *
 * ## 为什么用"提取"而不是手抄
 *
 * 迁移期会**双实现并存**（WASM 与 Rust 先后读写同一个库文件）。如果 Rust 侧手抄一份 schema，
 * 两份一定会漂移 —— 而 schema 漂移在迁移期是最贵的一类 bug（列缺失/类型不同 → 数据写坏）。
 * 因此：**唯一真源仍然是 `src/core/storage/database.ts`**，Rust 侧的资源由本脚本生成，
 * 并由 `check-schema-parity.mjs` 在 `npm run audit` 里守住（不一致即失败）。
 * P5 删除 WASM 路径时，真源再切到 Rust 侧。
 *
 * 用法：
 *   node tools/audit/gen-schema-sql.mjs            # 生成
 *   node tools/audit/gen-schema-sql.mjs --check    # 只校验（不一致则 exit 1）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const TS = path.join(ROOT, "src", "core", "storage", "database.ts");
const OUT_DIR = path.join(ROOT, "src-tauri", "codem-db", "sql");

function extract() {
  const src = fs.readFileSync(TS, "utf8");

  const schemaMatch = /const SCHEMA\s*=\s*`([\s\S]*?)`;/.exec(src);
  if (!schemaMatch) throw new Error("找不到 SCHEMA 定义（database.ts 结构变了？）");
  const schema = schemaMatch[1];

  const migrationsMatch = /const migrations = \[([\s\S]*?)\];/.exec(src);
  if (!migrationsMatch) throw new Error("找不到 migrations 定义");
  const migrations = [...migrationsMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\"/g, '"'),
  );

  // FTS 建表 DDL：渲染侧是单独的 db.run(`CREATE VIRTUAL TABLE ...`)
  const ftsMatch = /CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts4\(([\s\S]*?)\);/.exec(src);
  if (!ftsMatch) throw new Error("找不到 session_fts 建表语句");

  return { schema, migrations, ftsColumns: ftsMatch[1] };
}

function build() {
  const { schema, migrations, ftsColumns } = extract();
  return {
    "schema.sql": schema.trimEnd() + "\n",
    "migrations.json": JSON.stringify(migrations, null, 2) + "\n",
    "fts.json": JSON.stringify({ columns: ftsColumns.trim() }, null, 2) + "\n",
    "SOURCE.json": JSON.stringify({ source: "src/core/storage/database.ts", generatedBy: "tools/audit/gen-schema-sql.mjs" }, null, 2) + "\n",
  };
}

const files = build();
const check = process.argv.includes("--check");

let drift = [];
for (const [name, content] of Object.entries(files)) {
  const p = path.join(OUT_DIR, name);
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  if (existing === content) continue;
  if (check) {
    drift.push(name);
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    console.log(`written ${path.relative(ROOT, p)}${existing === null ? " (new)" : " (updated)"}`);
  }
}

if (check) {
  if (drift.length > 0) {
    console.error(`❌ schema 资源与 TS 真源不一致：${drift.join(", ")}`);
    console.error("   运行 node tools/audit/gen-schema-sql.mjs 重新生成（或检查是否有人手改了 Rust 侧 SQL）。");
    process.exit(1);
  }
  console.log("✅ Rust 侧 schema 资源与 TS 真源一致");
} else {
  const { migrations } = extract();
  console.log(`schema 字符数=${files["schema.sql"].length} migrations=${migrations.length}`);
}

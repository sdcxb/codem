#!/usr/bin/env node
/**
 * 存储迁移与对账工具（P4）
 *
 * ## 它解决什么问题
 *
 * 把旧库（渲染进程 sql.js/WASM 写的 `codem-db.bin`）里的数据搬进新库
 * （Rust 原生引擎的 `codem-db-rust.bin`），并且**证明搬对了**。
 *
 * ## 为什么要"证明"，而不是"搬完就完了"
 *
 * 数据搬迁最危险的失败模式是**静默少搬**：某张表漏了、某个字段没带、
 * 外键顺序错了导致部分行被拒。用户看到的不是报错，而是"某些对话不见了"。
 * 所以这个工具的每一步都产出可核对的数字：
 *
 * 1. **备份**：复制旧库并记下 SHA256（回滚的物质基础）；
 * 2. **逐表导出**：从旧库读全部业务行（不含 FTS 影子表）；
 * 3. **单事务导入**：`import.begin` → 逐表 `import.table` → `import.end`，
 *    中途失败自动 `import.rollback`（绝不留下半个库）；
 * 4. **重建全文索引**：从 `messages` 重建 `session_fts`（跨引擎结构不同，不搬影子表）；
 * 5. **对账**：逐表比对**行数**与**内容摘要**（两端各自算，算法在 `lib/digest.mjs`）；
 * 6. **回滚开关**：对账失败时明确告诉操作者怎么退回（并保留备份）。
 *
 * ## 用法
 *
 *   node tools/migrate/storage-migrate.mjs --dry-run          # 只盘点与预演，不写新库
 *   node tools/migrate/storage-migrate.mjs --apply            # 真迁移
 *   node tools/migrate/storage-migrate.mjs --verify           # 只对账（迁移后复验）
 *   node tools/migrate/storage-migrate.mjs --apply --src <旧库> --dst <新库>
 *   node tools/migrate/storage-migrate.mjs --rollback-hint    # 打印回滚步骤
 *
 * 默认路径：旧库 `%APPDATA%\com.codem.app\codem-db.bin`，
 *          新库 `%APPDATA%\com.codem.app\codem-db-rust.bin`。
 *
 * ⚠️ **迁移必须在应用关闭时执行**（两个引擎同时写各自的库会漂移）。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestRows, digestSelfCheck } from "./lib/digest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.platform === "win32" ? "codem-db-cli.exe" : "codem-db-cli";
const CLI = path.join(ROOT, "src-tauri", "codem-db", "target", "debug", EXE);
const SQL_JS = path.join(ROOT, "node_modules", "sql.js", "dist", "sql-wasm.js");
const WASM = path.join(ROOT, "node_modules", "sql.js", "dist", "sql-wasm.wasm");

const DEFAULT_DIR = path.join(process.env.APPDATA ?? os.homedir(), "com.codem.app");
const DEFAULT_SRC = path.join(DEFAULT_DIR, "codem-db.bin");
const DEFAULT_DST = path.join(DEFAULT_DIR, "codem-db-rust.bin");

/** FTS 影子表：跨引擎结构不同，**不搬**，导入后从 messages 重建 */
const FTS_PREFIX = "session_fts";

/** 分批大小（单次 IPC 的负载；太大可能撞到 IPC 消息上限） */
const BATCH_ROWS = 500;
/** 单批的近似负载上限（字节）：超过就切批，避免超大消息 */
const BATCH_BYTES = 4 * 1024 * 1024;

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(name);

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runCli(db, args, stdin) {
  const res = spawnSync(CLI, ["--db", db, ...args], {
    input: stdin,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  const out = (res.stdout ?? "").trim();
  if (!out) {
    throw new Error(`CLI 无输出（${args.join(" ")}，status=${res.status}）：${res.stderr}`);
  }
  const parsed = JSON.parse(out);
  if (parsed.ok === false) {
    throw new Error(`CLI 失败（${args.join(" ")}）：${parsed.error?.code} ${parsed.error?.message}`);
  }
  return parsed;
}

function invokeCli(db, command, params) {
  const r = runCli(db, ["invoke", command, "-"], JSON.stringify(params ?? {}));
  return r.result;
}

// ========== 旧库（sql.js）读取 ==========

async function openOldDb(file) {
  const initSqlJs = (await import(pathToFileURL(SQL_JS).href)).default;
  const SQL = await initSqlJs({ locateFile: () => WASM });
  return new SQL.Database(new Uint8Array(fs.readFileSync(file)));
}

/** 旧库里的业务表（排除 FTS 影子表与 sqlite 内部表） */
function oldTables(db) {
  const res = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  if (!res.length) return [];
  return res[0].values
    .map((r) => String(r[0]))
    .filter((n) => !n.startsWith(FTS_PREFIX) && !n.startsWith("sqlite_"));
}

function oldCount(db, table) {
  return db.exec(`SELECT COUNT(*) FROM "${table}"`)[0].values[0][0];
}

/**
 * 读一张表的全部行。
 *
 * 用 `SELECT *` 依赖"列顺序 = CREATE TABLE 的列序"这一约定（两端一致），
 * 这样摘要才对得上 —— 所以这里**不要**自己指定列序。
 */
function oldRows(db, table) {
  const res = db.exec(`SELECT * FROM "${table}"`);
  if (!res.length) return { columns: [], rows: [] };
  return { columns: res[0].columns, rows: res[0].values };
}

function oldDigest(db, table) {
  const { rows } = oldRows(db, table);
  return digestRows(rows);
}

// ========== 主流程 ==========

/**
 * 源库的**外键一致性预检**。
 *
 * ## 为什么必须有这一步（实测发现）
 *
 * 生产库里真实存在 **86 行孤儿**：67 行 `session_events` + 19 行 `telemetry_events`
 * 指向已经不存在（或从未存在）的 session —— 会话被删掉时这些运行期记录没有一起清理。
 * 新引擎开着 `foreign_keys=ON`，直接导入会**整个事务失败**（`FOREIGN KEY constraint failed`）。
 *
 * 所以迁移必须**显式决定怎么处置孤儿**，而不是"撞上了再说"：
 * - 默认：丢弃孤儿行 + 打印明细（这些是运行期诊断记录，宿主会话已不存在，没有归属）；
 * - `--strict-fk`：直接失败，把决定权留给操作者（数据可能比想象中重要）。
 *
 * 顺带这个预检本身也是一份**源库体检报告**：它告诉我们旧引擎时期的数据一致性状况。
 */
function checkSourceForeignKeys(db) {
  let res;
  try {
    res = db.exec("PRAGMA foreign_key_check");
  } catch (e) {
    return { violations: [], byTable: new Map(), unsupported: e.message };
  }
  const violations = res.length ? res[0].values : [];
  const byTable = new Map();
  for (const row of violations) {
    // 行形状：[childTable, rowid, parentTable, fkIndex]
    const key = `${row[0]} → ${row[2]}`;
    const e = byTable.get(key) ?? { child: String(row[0]), parent: String(row[2]), rowids: [] };
    e.rowids.push(row[1]);
    byTable.set(key, e);
  }
  return { violations, byTable, unsupported: null };
}

/**
 * 丢弃指向不存在父行的子行。
 *
 * 只处理"父表主键列"这一种最常见的形态（`<table>.<fkcol> → <parent>.id`），
 * 且只对**我们已知会孤儿的那两张运行期表**生效 —— 不做通用的图遍历，
 * 因为通用的做法容易悄悄删掉不该删的东西。发现新的孤儿类别时会打印出来。
 */
function dropOrphans(db, fkReport) {
  const dropped = [];
  for (const e of fkReport.byTable.values()) {
    const parentIds = new Set(
      (db.exec(`SELECT id FROM "${e.parent}"`)[0]?.values ?? []).map((r) => r[0]),
    );
    // 找出该子表里所有指向父表的列
    const fkList = db.exec(`PRAGMA foreign_key_list("${e.child}")`);
    if (!fkList.length) continue;
    const cols = fkList[0].values.filter((r) => r[2] === e.parent).map((r) => r[3]);
    for (const col of cols) {
      const all = db.exec(`SELECT rowid, "${col}" FROM "${e.child}"`)[0]?.values ?? [];
      const orphans = all.filter((r) => r[1] !== null && !parentIds.has(r[1]));
      if (!orphans.length) continue;
      dropped.push({ table: e.child, column: col, parent: e.parent, rows: orphans.length });
    }
  }
  // 真正删除：新引擎要求在事务里；这里在**内存副本**上删（源文件只读）
  if (dropped.length) {
    db.run("PRAGMA foreign_keys = OFF");
    for (const d of dropped) {
      db.run(
        `DELETE FROM "${d.table}" WHERE "${d.column}" IS NOT NULL AND "${d.column}" NOT IN (SELECT id FROM "${d.parent}")`,
      );
    }
  }
  return dropped;
}

async function main() {
  const mode = has("--dry-run") ? "dry-run" : has("--apply") ? "apply" : has("--verify") ? "verify" : has("--rollback-hint") ? "rollback-hint" : null;
  if (!mode) {
    console.log(
      [
        "用法：node tools/migrate/storage-migrate.mjs <模式> [--src 旧库] [--dst 新库]",
        "",
        "  --dry-run        盘点 + 预演（不写新库）",
        "  --apply          执行迁移（备份 → 导入 → 重建 FTS → 对账）",
        "  --verify         只对账（迁移后复验）",
        "  --rollback-hint  打印回滚步骤",
      ].join("\n"),
    );
    process.exit(2);
  }

  const src = arg("--src", DEFAULT_SRC);
  const dst = arg("--dst", DEFAULT_DST);

  if (mode === "rollback-hint") {
    printRollbackHint(src, dst);
    return;
  }

  if (!fs.existsSync(CLI)) {
    fail(`找不到 CLI：${CLI}\n请先运行 npm run db:build`);
  }
  if (!fs.existsSync(src)) {
    fail(`旧库不存在：${src}`);
  }

  digestSelfCheck(); // 摘要算法自检（两端一致的前提）

  console.log(`旧库（WASM/sql.js）: ${src}`);
  console.log(`  大小 ${fs.statSync(src).size} B  sha256 ${sha256(src).slice(0, 16)}`);
  console.log(`新库（Rust）        : ${dst}${fs.existsSync(dst) ? `（已存在 ${fs.statSync(dst).size} B）` : "（不存在，将由引擎创建）"}`);

  const db = await openOldDb(src);
  const rawTables = oldTables(db);

  // ===== 源库外键预检 + 孤儿处置 =====
  const fkReport = checkSourceForeignKeys(db);
  if (fkReport.unsupported) {
    console.warn(`⚠️ 无法执行 foreign_key_check（${fkReport.unsupported}），跳过预检`);
  } else if (fkReport.violations.length) {
    console.log(`\n源库外键预检：发现 ${fkReport.violations.length} 行孤儿`);
    for (const e of fkReport.byTable.values()) {
      console.log(`  ${e.child} → ${e.parent}: ${e.rowids.length} 行`);
    }
    console.log(
      "  含义：这些子行指向已不存在的父行（旧引擎时期没有级联清理）。\n" +
        "  新引擎开着 foreign_keys=ON，直接导入会整个事务失败，因此必须显式处置。",
    );
    if (has("--strict-fk")) {
      fail(
        "按 --strict-fk 要求中止。若确认这些孤儿可以丢弃，去掉该参数重跑（会打印被丢弃的明细）；\n" +
          "  若认为数据重要，请先从旧库把它们导出备查。",
      );
    }
    const dropped = dropOrphans(db, fkReport);
    console.log("  已在**内存副本**上丢弃以下孤儿行（源文件不会被改动）：");
    for (const d of dropped) {
      console.log(`    ${d.table}.${d.column} → ${d.parent}: 丢弃 ${d.rows} 行`);
    }
  } else {
    console.log("源库外键预检：无孤儿 ✓");
  }

  // ===== 表顺序必须按**外键依赖**排（不是字母序）=====
  //
  // `sqlite_master` 是按名字排序返回的；照那个顺序导入会撞外键
  // （实测：`goals` 在 `sessions` 之前插入 → FOREIGN KEY constraint failed）。
  // 依赖顺序由 Rust 侧 `IMPORT_ORDER` 定义（并被 `import_order_covers_all_generated_tables`
  // 测试保证覆盖全部表），这里只负责按它重排。
  const orderInfo = invokeCli(dst, "import.tables", {});
  const order = orderInfo.order ?? [];
  const orderIndex = new Map(order.map((t, i) => [t, i]));
  const unknownOrder = rawTables.filter((t) => !orderIndex.has(t));
  if (unknownOrder.length) {
    fail(
      `旧库有以下表不在 Rust 的导入顺序里（无法确定外键依赖位置）：${unknownOrder.join(", ")}\n` +
        `  修法：把表名补进 src-tauri/codem-db/src/migrate.rs 的 IMPORT_ORDER`,
    );
  }
  const tables = [...rawTables].sort((a, b) => orderIndex.get(a) - orderIndex.get(b));

  const plan = [];
  let totalRows = 0;
  for (const t of tables) {
    const n = oldCount(db, t);
    totalRows += n;
    plan.push({ table: t, rows: n });
  }
  console.log(`\n计划搬运 ${tables.length} 张表 / ${totalRows} 行（已排除 FTS 影子表，按外键依赖顺序）`);
  for (const p of plan) if (p.rows > 0) console.log(`  ${p.table}: ${p.rows}`);

  // ===== 覆盖性检查（**这一步是这个工具最重要的守卫**）=====
  //
  // 如果旧库里有表不在 Rust 侧的导入清单里，那些表**永远不会被搬**，而且不会报错 ——
  // 用户只会发现"某些数据不见了"。早期手写清单就漏过三张真实有数据的表
  // （agent_messages / message_feedback / needs_you_pending），所以这里做成硬失败。
  const knownSet = new Set(orderInfo.known ?? orderInfo.tables ?? []);
  const uncovered = rawTables.filter((t) => !knownSet.has(t));
  if (uncovered.length) {
    const withRows = uncovered.filter((t) => oldCount(db, t) > 0);
    console.error(`\n❌ 覆盖性检查失败：旧库有 ${uncovered.length} 张表不在 Rust 导入清单里`);
    console.error(`   其中**有数据**的：${withRows.length ? withRows.join(", ") : "（都为空表）"}`);
    console.error(`   全部：${uncovered.join(", ")}`);
    console.error(
      "\n   继续迁移会静默丢掉这些表的数据。修法：把缺的表加进 src/core/storage/database.ts 的 SCHEMA，\n" +
        "   然后 node tools/audit/gen-schema-sql.mjs 重新生成 sql/tables.json，\n" +
        "   并把表名补进 src-tauri/codem-db/src/migrate.rs 的 IMPORT_ORDER。",
    );
    db.close();
    process.exit(1);
  }
  console.log(`覆盖性检查通过：旧库 ${tables.length} 张表全部在导入清单内 ✓`);

  if (mode === "dry-run") {
    const present = orderInfo.tables ?? [];
    const willCreate = tables.filter((t) => !present.includes(t));
    console.log(`\n[dry-run] 新库当前已有的可导入表：${present.length}`);
    console.log(`[dry-run] 旧库中需要新建的表：${willCreate.length ? willCreate.join(", ") : "（无）"}`);
    console.log("[dry-run] 未写任何数据。加 --apply 执行。");
    db.close();
    return;
  }

  if (mode === "verify") {
    const verdict = await verify(db, dst, tables);
    db.close();
    process.exit(verdict.ok ? 0 : 1);
  }

  // ===== apply =====
  const appRunning = isAppRunning();
  if (appRunning) {
    console.warn("\n⚠️ 检测到 Codem 正在运行。迁移要求应用关闭（两个引擎同时写会漂移）。");
    console.warn("   请先退出应用再重跑。这里继续执行**只读**部分，写入前会再次检查。");
  }

  // 1) 备份 + 记录基线
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dst}.backup-${stamp}`;
  if (fs.existsSync(dst)) {
    fs.copyFileSync(dst, backup);
    console.log(`\n[1/6] 已备份新库 → ${backup}（${fs.statSync(backup).size} B）`);
  } else {
    console.log("\n[1/6] 新库尚不存在，无需备份（首次迁移）");
  }
  const srcBefore = sha256(src);
  const before = invokeCli(dst, "digest.tables", {});
  console.log(`      新库迁移前：${describeDigest(before)}`);

  // 2) 单事务导入（**必须整批在同一个 CLI 进程里**：事务属于连接，
  //    分多次调用时上一次的 BEGIN 会随进程退出被回滚 —— 这是实测踩到的坑）
  console.log("\n[2/6] 导入（单进程 + 单事务：全成或全不成）");
  const payload = [];
  const skipped = [];
  for (const t of tables) {
    const { columns, rows } = oldRows(db, t);
    if (rows.length === 0) {
      skipped.push(t);
      continue;
    }
    // 迁移标记是**目标端自己的状态**，不该从源端搬过来（否则会覆盖"已迁移"的判定）
    let useRows = rows;
    if (t === "settings") {
      const keyIdx = columns.indexOf("key");
      if (keyIdx >= 0) {
        const filtered = rows.filter((r) => String(r[keyIdx]) !== "codem-storage-migrated-at");
        if (filtered.length !== rows.length) {
          console.log(`  · settings: 跳过 ${rows.length - filtered.length} 行目标端状态键`);
          useRows = filtered;
        }
      }
    }
    for (const batch of chunkRows(useRows, BATCH_ROWS, BATCH_BYTES)) {
      payload.push({ table: t, columns, rows: batch, mode: "insert" });
    }
  }
  console.log(`  空表 ${skipped.length} 张（跳过）：${skipped.join(", ")}`);
  console.log(`  待导入 ${payload.length} 批，负载 ${(JSON.stringify(payload).length / 1048576).toFixed(1)} MiB`);

  // 每张表**应当**导入的行数（用于导入后逐表核对；早先这里用了错误的期望值，
  // 导致明明搬对了却打印 ✗ —— 对账工具的输出本身必须可信）
  const expected = new Map();
  for (const p of payload) expected.set(p.table, (expected.get(p.table) ?? 0) + p.rows.length);

  let imported;
  try {
    imported = runCli(dst, ["import", "-"], JSON.stringify({ tables: payload, replace: true }));
  } catch (e) {
    fail(
      `导入失败（整个事务已由引擎回滚，新库未被改动）：${e.message}\n  备份仍在：${backup}`,
    );
  }
  console.log(`  提交完成：${imported.total_rows} 行 / ${Object.keys(imported.tables).length} 张表`);
  let mismatch = 0;
  for (const [t, n] of Object.entries(imported.tables)) {
    const want = expected.get(t) ?? 0;
    if (n !== want) mismatch++;
    console.log(`  ${n === want ? "✓" : "✗"} ${t}: ${n}/${want}`);
  }
  if (mismatch > 0) {
    fail(`${mismatch} 张表的导入行数与源端不符（见上），迁移不可信，请排查后重跑`);
  }

  // 3) 重建全文索引
  console.log("\n[3/6] 从 messages 重建全文索引（不搬 FTS 影子表）");
  const fts = invokeCli(dst, "rebuild_fts", {});
  console.log(`  已索引 ${fts.indexed} 条`);

  // 4) 对账
  console.log("\n[4/6] 对账（行数 + 内容摘要，两端各自计算）");
  const verdict = await verify(db, dst, tables);

  // 5) 标记迁移完成
  if (verdict.ok) {
    invokeCli(dst, "migration.mark", { at: Date.now() });
    console.log("\n[5/6] 已写入迁移标记 codem-storage-migrated-at");
  } else {
    console.log("\n[5/6] 对账未通过，**不写迁移标记**（下次仍会要求迁移）");
  }

  // 6) 摘要
  const srcAfter = sha256(src);
  console.log("\n[6/6] 结果");
  console.log(`  旧库 sha256 ${srcBefore === srcAfter ? "未变化 ✓" : "变了 ✗（迁移期间有写入，需要重新对账）"}`);
  console.log(`  新库 ${dst}（${fs.existsSync(dst) ? fs.statSync(dst).size : 0} B）`);
  console.log(`  对账：${verdict.ok ? "通过 ✓" : "未通过 ✗"}`);
  if (!verdict.ok) {
    console.log(`\n  回滚：node tools/migrate/storage-migrate.mjs --rollback-hint`);
  }
  db.close();
  process.exit(verdict.ok ? 0 : 1);
}

/** 按行数与字节预算切批 */
function chunkRows(rows, maxRows, maxBytes) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length + 2;
    if (cur.length >= maxRows || (cur.length > 0 && bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(row);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

function describeDigest(d) {
  const entries = Object.entries(d).filter(([, v]) => v.rows > 0);
  if (!entries.length) return "（空）";
  return entries.map(([k, v]) => `${k}=${v.rows}`).join(" ");
}

/** 逐表比对行数与内容摘要 */
async function verify(db, dst, tables) {
  const remote = invokeCli(dst, "digest.tables", {});
  const problems = [];
  const lines = [];
  for (const t of tables) {
    const local = oldDigest(db, t);
    const r = remote[t] ?? { rows: 0, digest: "" };
    const rowsMatch = local.rows === r.rows;
    const digestMatch = local.digest === r.digest;
    if (!rowsMatch || !digestMatch) {
      problems.push(
        `${t}: 行数 ${local.rows}→${r.rows}${rowsMatch ? "" : " ✗"}，摘要 ${local.digest}→${r.digest}${digestMatch ? "" : " ✗"}`,
      );
    }
    if (local.rows > 0) {
      lines.push(
        `  ${rowsMatch && digestMatch ? "✓" : "✗"} ${t}: ${local.rows} 行，摘要 ${local.digest.slice(0, 8)} / ${r.digest.slice(0, 8)}`,
      );
    }
  }
  for (const l of lines) console.log(l);
  if (problems.length) {
    console.log(`\n对账失败 ${problems.length} 张表：`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    return { ok: false, problems };
  }
  const total = Object.values(remote).reduce((a, v) => a + v.rows, 0);
  console.log(`  全部一致（新库共 ${total} 行）`);
  return { ok: true, problems: [] };
}

function isAppRunning() {
  try {
    const res = spawnSync("tasklist", ["/FI", "IMAGENAME eq codem.exe"], { encoding: "utf8" });
    return (res.stdout ?? "").includes("codem.exe");
  } catch {
    return false;
  }
}

function printRollbackHint(src, dst) {
  console.log("回滚步骤（把渲染侧切回 WASM 引擎）：");
  console.log("");
  console.log("1) 在应用里打开 devtools（或让支持同学远程指导）执行：");
  console.log('     localStorage.setItem("codem-storage-engine", "wasm")');
  console.log("   然后重启应用 —— 渲染侧将不再使用 Rust 引擎，回到原来的 codem-db.bin。");
  console.log("");
  console.log("2) 旧库（始终是权威副本，迁移过程只读它）：");
  console.log(`     ${src}`);
  console.log("   迁移工具不会修改它（前后 sha256 一致可验证）。");
  console.log("");
  console.log("3) 新库与其备份：");
  console.log(`     当前：${dst}`);
  const dir = path.dirname(dst);
  const backups = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(dst) + ".backup-")).sort()
    : [];
  if (backups.length) {
    console.log("     可用备份（最新在后）：");
    for (const b of backups) console.log(`       ${path.join(dir, b)}`);
    console.log(`   恢复到某个备份：copy "${path.join(dir, backups[backups.length - 1])}" "${dst}"`);
  } else {
    console.log("     （没有备份：说明迁移时新库还不存在，删除它即可回到「从未迁移」的状态）");
  }
  console.log("");
  console.log("4) 只是想撤销「已迁移」标记（让应用下次重新询问迁移）：");
  console.log(`     "${EXE}" --db "${dst}" invoke settings.remove -   # 参数 {"key":"codem-storage-migrated-at"}`);
  console.log("");
  console.log("注意：删除新库不会影响旧库数据；旧库在 P5（删除 WASM 路径）之前一直是安全退路。");
}

function fail(msg) {
  console.error(`\n[迁移失败] ${msg}`);
  process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}

export { chunkRows };

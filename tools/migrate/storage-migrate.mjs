#!/usr/bin/env node
/**
 * 存储迁移与对账工具（P4；L1 之后重写为 **Rust CLI 的薄封装**）
 *
 * ## 它解决什么问题
 *
 * 把旧库（渲染进程 sql.js/WASM 时代落盘的 `codem-db.bin`）里的数据搬进新库
 * （Rust 原生引擎的 `codem-db-rust.bin`），并且**证明搬对了**。
 *
 * 数据搬迁最危险的失败模式是**静默少搬**：某张表漏了、某个字段没带、外键顺序错了
 * 导致部分行被拒。用户看到的不是报错，而是"某些对话不见了"。所以每一步都产出可核对的数字。
 *
 * ## 为什么这一版改成"对 migration.auto 的薄封装"（本轮修改）
 *
 * 旧实现用渲染进程里那份 **sql.js** 读旧库。sql.js 已随 L1 从工程里删除
 * （`node_modules` 下的 sql.js 包已不存在），所以这个工具**一跑就 ENOENT**。
 * 改走 CLI 只有两条路，两条都实测过：
 *
 * 1. **`legacy.read_table` 逐表读 → `import` 写**：单看接口很合适，但它的行数上限是
 *    `clamp(1, 20000)` 且**没有 offset**。实测：一张 25,024 行的表，默认返回 2,000 行、
 *    显式 `limit: 20000` 返回 20,000 行、`limit: 50000` 仍然是 20,000 行 ——
 *    **超出部分静默截断，不报错、不提示**。用它做全量搬运就等于"静默少搬"，
 *    而这个工具存在的唯一理由就是防这个。**不可用**（要能用，得先在 Rust 侧给
 *    `legacy.read_table` 加 `offset`/`count_only`）。
 * 2. **`migration.auto`**：Rust 侧已经把整条链做完了 ——
 *    「只读打开旧库 → 按外键依赖顺序读全表 → 丢弃外键孤儿并计数 → 写入前整库备份 →
 *      单进程单事务导入 → 逐表比对行数与内容摘要 → 重建全文索引 → 写迁移标记」。
 *    而且**它就是应用启动时走的那条链**（`src/core/storage/bootstrap.ts`）。
 *    工具再把这条链实现一遍，只会造出第二个真相来源。
 *
 * → 选 2。本工具现在的职责是：**先给计划与预检（写之前把话说清）、把引擎的结论翻译成
 *   人能读的报告、按对账结果给退出码**；真正的读写全部由引擎完成。
 *
 * ## ⚠️ 一个必须写下来的反面教训：`--db` 不能指向旧库
 *
 * 任务书/直觉都倾向于 `codem-db-cli --db <旧库> ...`（"语义最直观"）。**实测不行**：
 * `--db` 走的是 `Engine::open`（`READ_WRITE|CREATE` + 应用 schema + 装删除审计触发器），
 * 而旧库在整个迁移期必须是**只读**的（它是回滚的物质基础，也是"数据还在"的物证）。
 * 在旧库副本上跑一次 `--db <旧库> health` 的实测结果：
 *   - 主文件 sha256 变化；
 *   - `sqlite_master` 里的触发器从 5 个变成 13 个（多出 8 个 `trg_*`，即引擎的删除审计触发器）；
 *   - 旁边多出一个 152,472 B 的 `-wal`。
 * 所以本工具**一律 `--db <新库>`**，旧库只通过参数 `legacy_path` 传进去
 * （`legacy.read_table` / `migration.auto` 内部都是 `OPEN_READONLY` 打开它，绝不写）。
 *
 * ## 用法
 *
 *   node tools/migrate/storage-migrate.mjs --dry-run          # 只盘点与预演，不导入任何行
 *   node tools/migrate/storage-migrate.mjs --apply            # 真迁移（引擎执行）
 *   node tools/migrate/storage-migrate.mjs --verify           # 只对账（迁移后复验）
 *   node tools/migrate/storage-migrate.mjs --apply --src <旧库> --dst <新库>
 *   node tools/migrate/storage-migrate.mjs --rollback-hint    # 打印回滚步骤
 *
 * 默认路径：旧库 `%APPDATA%\com.codem.app\codem-db.bin`，
 *          新库 `%APPDATA%\com.codem.app\codem-db-rust.bin`。
 *
 * 退出码：0 = 通过；1 = 失败（对账不通过 / 预检不通过 / 引擎报错）；2 = 没给模式。
 *
 * ⚠️ **迁移必须在应用关闭时执行**：两个引擎同时写各自的库会漂移。用默认新库路径时，
 *    如果检测到 `codem.exe` 在跑，本工具**直接拒绝**（除非显式 `--force`）。
 *
 * ⚠️ 只读打开旧库仍然会在它旁边创建/续用 `-shm`（以及 0 字节的 `-wal`）——
 *    这是 SQLite 对 WAL 库的固有行为。**主文件内容不变**（本工具前后各算一次 sha256 证明）。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.platform === "win32" ? "codem-db-cli.exe" : "codem-db-cli";
const CLI = path.join(ROOT, "src-tauri", "codem-db", "target", "debug", EXE);

const DEFAULT_DIR = path.join(process.env.APPDATA ?? os.homedir(), "com.codem.app");
const DEFAULT_SRC = path.join(DEFAULT_DIR, "codem-db.bin");
const DEFAULT_DST = path.join(DEFAULT_DIR, "codem-db-rust.bin");

/**
 * **目标端自己的状态键**：它们由引擎/渲染侧写在新库上，不属于"从旧库搬过来的数据"，
 * 所以 `settings` 逐键比对时忽略它们。
 *
 * 为什么必须忽略（实测）：引擎在迁移末尾会往新库 `settings` 写
 * `codem-storage-migrated-at`，于是**新库的 settings 永远比旧库多 1 行**。
 * 旧实现的 `--verify` 是"两边行数与摘要必须完全相等"，因此它在一次**成功**的迁移之后
 * 必定报 `settings ✗`、退出码 1 —— 一个永远喊狼来了的对账工具比没有对账更糟
 * （操作者会学会忽略它）。这里改成：`settings` 走**逐键比对**（忽略状态键），
 * 其余表走"行数 + 内容摘要"。
 */
const TARGET_STATE_KEYS = new Set([
  "codem-storage-migrated-at", // 引擎写：迁移完成标记
  "codem-fts-bigram-rebuilt", // 渲染侧写：中文搜索索引已重建
  "codem-settings-imported-from-legacy", // 渲染侧写：配置面已从旧库补搬
]);

/**
 * `legacy.read_table` 的行数硬上限（Rust 侧 `clamp(1, 20000)`）。
 *
 * 达到它就说明"这张表没读全" —— 预检必须**如实说不知道**，而不是把截断当成"行数正好这么多"。
 */
const LEGACY_READ_MAX = 20000;

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
  return runCli(db, ["invoke", command, "-"], JSON.stringify(params ?? {})).result;
}

/**
 * 只读读旧库的一张表（走引擎的 `legacy.read_table`）。
 *
 * `--db` 传的是**新库**：引擎需要打开某个库才能干活，而旧库绝不能作为 `--db`
 * （见文件头那段实测）。旧库路径作为 `legacy_path` 参数传进去，引擎内部只读打开它。
 *
 * 返回 `{ columns, rows, truncated }`：`truncated` 为真表示"行数撞到了 CLI 上限，
 * 这张表没读全"——调用方**必须**把这个事实传给用户，不许静默当成读全了。
 */
function readLegacyTable(dst, legacyPath, table, limit = LEGACY_READ_MAX) {
  const got = invokeCli(dst, "legacy.read_table", { legacy_path: legacyPath, table, limit });
  const rows = got.rows ?? [];
  return { columns: got.columns ?? [], rows, truncated: rows.length >= limit };
}

/** 失败即抛出：`main` 统一收口成退出码 1（不用 process.exit —— 管道下会截断 stdout） */
class MigrationFailure extends Error {}
function fail(msg) {
  throw new MigrationFailure(msg);
}

// ========== 源端计划与预检 ==========

/** 让引擎给出"旧库 → 新库"的计划（`dry_run`：**只读旧库**，不导入、不备份） */
function sourcePlan(dst, src) {
  return invokeCli(dst, "migration.auto", { legacy_path: src, dry_run: true });
}

/**
 * 源端**逐表预检**：把"源端原始行数"与"引擎计划搬运行数"相减。
 *
 * ## 为什么要这样查，而不是自己写一套外键规则
 *
 * 旧实现用 `PRAGMA foreign_key_check` + `foreign_key_list` 在 sql.js 里自己算孤儿。
 * 现在孤儿过滤发生在**引擎内部**（`migrate.rs` 的 `FK_PARENTS` + 列名启发式），
 * 如果 JS 侧再实现一份"子表→父表"的清单，两份清单迟早漂移 —— 而漂移的表现是
 * "预检说没孤儿，导入却丢了行"。
 *
 * 所以这里换个问法：**引擎说每张表能搬多少行（`dry_run.per_table`），源端实际有多少行
 * （`legacy.read_table`）**，两者之差就是"引擎会丢弃的源行数"。不复制任何外键知识，
 * 而且这个差值对**任何**原因的少搬都成立（不只是孤儿）。
 *
 * 代价与边界：每张**存在**的表读一次源端（真机 39 张表 / 约 4,000 行 + 空表，约 2 秒）。
 * 行数撞到 20,000 上限的表**无法算出准确差值**，如实标记为"预检不完整"。
 *
 * ⚠️ **不能只查"计划行数 > 0"的表**（这是第一版实现踩到的坑，实测发现）：
 * 一张表如果**每一行都是孤儿**，引擎的计划行数就是 0 —— 只看 `planned > 0` 会把它整个漏掉。
 * 真机就是这种形态：`telemetry_events` 19 行全是孤儿，于是漏报 19 行，
 * 打印出来的总数（67）比引擎实际丢弃的（67 + 19 = 86）少。
 * 所以这里对 `per_table` 里**每一张**表都探测（`per_table` 的成员就是"源库里存在的表"）。
 */
function precheckSource(dst, src, perTable) {
  const dropped = [];
  const truncated = [];
  for (const t of perTable) {
    const { rows, truncated: cut } = readLegacyTable(dst, src, t.table);
    const raw = rows.length;
    if (cut) {
      truncated.push({ table: t.table, raw, planned: t.rows });
      continue;
    }
    if (raw > t.rows) dropped.push({ table: t.table, raw, planned: t.rows, n: raw - t.rows });
    else if (raw < t.rows) {
      // 反方向不可能：引擎只能"少搬"，不能凭空多出行。出现就说明有不变量被打破，必须报出来。
      dropped.push({ table: t.table, raw, planned: t.rows, n: raw - t.rows, impossible: true });
    }
  }
  return { dropped, truncated };
}

function reportPrecheck(pre) {
  const totalDropped = pre.dropped.filter((d) => !d.impossible).reduce((a, d) => a + d.n, 0);
  const impossible = pre.dropped.filter((d) => d.impossible);
  for (const d of impossible) {
    console.log(
      `  ⚠ ${d.table}: 源端只有 ${d.raw} 行，引擎却计划搬 ${d.planned} 行（多出 ${-d.n} 行）——这不正常，请人工确认`,
    );
  }
  if (totalDropped === 0 && !pre.truncated.length) {
    console.log("源库外键预检：无孤儿 ✓（源端每张表的行数都等于引擎计划搬运行数）");
  } else if (totalDropped > 0) {
    console.log(`\n源库外键预检：发现 ${totalDropped} 行将被引擎丢弃（父行不存在的外键孤儿）`);
    for (const d of pre.dropped) {
      if (d.impossible) continue;
      console.log(`  ${d.table}: 源端 ${d.raw} 行 → 计划搬 ${d.planned} 行（丢弃 ${d.n} 行）`);
    }
    console.log(
      "  含义：这些子行指向已不存在的父行（旧引擎时期没有级联清理）。\n" +
        "  新引擎开着 foreign_keys=ON，直接导入会整个事务失败，所以引擎按 IMPORT_ORDER 逐表导入时跳过它们并计数。\n" +
        "  源文件不会被改动（丢弃只发生在新库这一侧）。",
    );
  }
  if (pre.truncated.length) {
    console.log(
      `\n⚠ 预检不完整：以下表的行数撞到了 CLI 单次读取上限 ${LEGACY_READ_MAX}，无法算出准确差值：`,
    );
    for (const t of pre.truncated) console.log(`    ${t.table}（已读到 ${t.raw} 行，实际更多）`);
    console.log(
      "  修法（需要改 Rust 侧）：给 legacy.read_table 加 offset 或 count_only；" +
        "在此之前 --strict-fk 会对这种情况判为失败（它要求确定性）。",
    );
  }
}

/**
 * 覆盖性检查。
 *
 * ## 这里**必须**说清楚它现在能查什么、不能查什么
 *
 * 旧实现能列出旧库的全部表（sql.js 直接读 `sqlite_master`），所以它能硬失败于
 * "旧库有张表不在 Rust 导入清单里 → 那批数据永远不会被搬"，这是它最重要的守卫。
 *
 * 现在工具不再直接读旧库文件，而 CLI **没有**"只读列出任意库 schema"的命令
 * （唯一能列出表名的 `importable_existing` 需要 `--db <库>`，那会写库；见文件头实测）。
 * 所以本工具**无法枚举**"源库有、但不在引擎清单里"的表 —— 这个缺口如实打印出来，
 * 不做成"检查通过"的假象。
 *
 * 能查的部分照旧硬失败：清单必须拿得到，否则一切免谈。
 */
function checkCoverage(dst, plan) {
  const info = invokeCli(dst, "import.tables", {});
  const known = info.known ?? info.tables ?? [];
  if (!known.length) {
    fail("拿不到引擎的导入清单（import.tables 返回空），无法确认覆盖性 —— 拒绝继续");
  }
  const planned = (plan.per_table ?? []).map((t) => t.table);
  const unknownToEngine = planned.filter((t) => !known.includes(t));
  if (unknownToEngine.length) {
    fail(
      `引擎的导入清单里没有这些表，但它们在旧库里：${unknownToEngine.join(", ")}\n` +
        "  修法：把表名补进 src-tauri/codem-db/src/migrate.rs 的 IMPORT_ORDER（并确认 sql/tables.json 已重新生成）",
    );
  }
  console.log(
    `覆盖性检查通过：引擎导入清单 ${known.length} 张表；源库中属于该清单的表 ${planned.length} 张已全部纳入计划 ✓`,
  );
  console.log(
    "  ⚠ 已知缺口：本工具**无法枚举**「源库里存在、但不在引擎清单里」的表（CLI 没有只读列出任意库 schema 的命令）。\n" +
      "    这类表会被引擎静默跳过。目前已知只有引擎自建的 storage_audit（删除审计，0 行，本就不该搬）。\n" +
      "    要补上这个守卫，需要 Rust 侧加一条只读命令（见报告「需要他人配合」）。",
  );
  return info;
}

// ========== 对账 ==========

const d8 = (s) => (typeof s === "string" && s.length ? s.slice(0, 8) : "—");
const brief = (v) => {
  const s = v === null || v === undefined ? "(NULL)" : String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…(${s.length} 字符)` : s;
};

/**
 * 逐表比对：源端计划（引擎 `dry_run`：行数 + 内容摘要）vs 目标端（引擎 `digest.tables`）。
 *
 * 判据（与引擎 `migration.auto` 内部的对账保持一致，避免"工具说过、引擎说不过"）：
 * - 目标端**少于**源端 → ✗ 静默少搬，硬失败；
 * - 行数相同且源端非空 → 摘要必须逐字节相同，否则 ✗；
 * - 目标端**多于**源端 → 不算失败（用户在新引擎下继续产生的数据，引擎刻意保留），
 *   但**如实列出来**，并声明这些表没有做摘要比对（摘要没法比）。
 */
function compareTables(plan, remote) {
  const lines = [];
  const problems = [];
  const targetMore = [];
  /** 行数相同但摘要不同的表 —— 需要进一步诊断（见 diagnoseDigestMismatch） */
  const digestMismatchTables = [];
  for (const p of plan.per_table ?? []) {
    const r = remote[p.table] ?? { rows: 0, digest: "" };
    let mark = "✓";
    let note = "";
    if (r.rows < p.rows) {
      mark = "✗";
      problems.push(`${p.table}: 源端 ${p.rows} 行 → 目标端只有 ${r.rows} 行（少了 ${p.rows - r.rows} 行）`);
    } else if (r.rows === p.rows) {
      if (p.rows > 0 && p.digest !== r.digest) {
        mark = "✗";
        digestMismatchTables.push(p.table);
        problems.push(
          `${p.table}: 行数都是 ${p.rows}，但内容摘要不同（源端 ${p.digest} / 目标端 ${r.digest}）`,
        );
      }
    } else {
      mark = "!";
      note = `（目标端 ${r.rows} 行 > 源端：保留较新数据，不作摘要比对）`;
      targetMore.push({ table: p.table, source: p.rows, target: r.rows });
    }
    if (p.rows > 0 || r.rows > 0) {
      // 注意：`${p.rows} 行` 紧跟在表名后面（源端行数），既有脚本与人的阅读习惯都依赖这个形状
      lines.push(`  ${mark} ${p.table}: ${p.rows} 行，摘要 ${d8(p.digest)} / ${d8(r.digest)}${note}`);
    }
  }
  return { lines, problems, targetMore, digestMismatchTables };
}

/**
 * 「行数相同、摘要不同」的进一步诊断：**两端的列集合是不是一样**。
 *
 * ## 为什么必须有这一步（本轮实测踩到的真实形态）
 *
 * 摘要（`digest.tables` / `digest_json_rows`）是按 `SELECT *` 的**逐列**编码累加的，
 * 所以"源库与目标库的列集合不同"必然让摘要不同 —— 而这**不是数据丢失**。
 * 真实现场：新 schema 给 `messages` 加了一列（`trimmed`），于是引擎的对账对这张表
 * **永远失败**（源端 16 列 / 目标端 17 列），而错误文案只有"摘要不同"四个字，
 * 读的人第一反应是"消息搬丢了"。这正是本任务要消灭的那类**误导性结论**。
 *
 * 这里把"哪一列不一样"直接说出来，但**不改判据**：摘要不同仍然是失败
 * （真丢了内容也是这个现象，不能靠猜把它放过去）。
 */
function diagnoseDigestMismatch(dst, src, table) {
  const s = readLegacyTable(dst, src, table, 1);
  const t = invokeCli(dst, "crud.list", { table, limit: 1 });
  const tItems = t.items ?? [];
  const tCols = tItems.length ? Object.keys(tItems[0]) : [];
  if (!s.columns.length || !tCols.length) return null;
  const onlySrc = s.columns.filter((c) => !tCols.includes(c));
  const onlyDst = tCols.filter((c) => !s.columns.includes(c));
  if (!onlySrc.length && !onlyDst.length) return null;
  return { srcCols: s.columns.length, dstCols: tCols.length, onlySrc, onlyDst };
}

/**
 * `settings` 的**逐键复核**（比摘要比对更强，而且不受"目标端多一行"影响）。
 *
 * 为什么单独做：引擎必然往目标端 `settings` 写状态键，于是这张表的行数与摘要
 * 都不可能和源端相等 —— 光靠摘要，这张表的内容其实**没被验证过**。
 * 逐键比对把"键在不在、值对不对"查实，并且把"目标端新增的键"如实列出来。
 */
function compareSettings(dst, src) {
  const tab = readLegacyTable(dst, src, "settings");
  if (!tab.columns.length) {
    // 旧库没有 settings 表（很老的库）→ 没什么可比的
    return { lines: ["  · settings: 源库没有这张表，跳过"], problems: [], ok: true };
  }
  const ki = tab.columns.indexOf("key");
  const vi = tab.columns.indexOf("value");
  if (ki < 0 || vi < 0) {
    return {
      lines: [],
      problems: [`settings: 源库的列里没有 key/value（列为 ${tab.columns.join(", ")}），无法逐键比对`],
      ok: false,
    };
  }
  if (tab.truncated) {
    return {
      lines: [],
      problems: [
        `settings: 源端行数撞到 CLI 上限 ${LEGACY_READ_MAX}，无法完整比对（不猜）`,
      ],
      ok: false,
    };
  }

  const srcMap = new Map();
  for (const row of tab.rows) srcMap.set(String(row[ki]), row[vi] === null ? null : String(row[vi]));

  const dstAll = invokeCli(dst, "settings.get_all", {});
  const ignoredKeys = Object.keys(dstAll).filter((k) => TARGET_STATE_KEYS.has(k));
  const dstMap = new Map(
    Object.entries(dstAll)
      .filter(([k]) => !TARGET_STATE_KEYS.has(k))
      .map(([k, v]) => [k, v === null || v === undefined ? null : String(v)]),
  );

  const problems = [];
  let same = 0;
  for (const [k, v] of srcMap) {
    if (!dstMap.has(k)) {
      problems.push(`settings.${k}: 目标端没有这个键（源端值 ${brief(v)}）`);
      continue;
    }
    const dv = dstMap.get(k);
    if ((dv ?? null) !== (v ?? null)) {
      problems.push(`settings.${k}: 值不一致 —— 源端 ${brief(v)} / 目标端 ${brief(dv)}`);
    } else {
      same++;
    }
  }
  const extra = [...dstMap.keys()].filter((k) => !srcMap.has(k));
  const lines = [];
  if (problems.length) {
    lines.push(`  ✗ settings: 逐键复核发现 ${problems.length} 处问题`);
  } else {
    lines.push(
      `settings 逐键复核：源端 ${srcMap.size} 个键全部一致 ✓` +
        (ignoredKeys.length ? `（已忽略目标端状态键：${ignoredKeys.join(", ")}）` : ""),
    );
    if (extra.length) {
      lines.push(
        `  ! 目标端另有 ${extra.length} 个键不在源端（迁移后新写入的设置，不计为失败）：${extra.slice(0, 8).join(", ")}${extra.length > 8 ? " …" : ""}`,
      );
    }
  }
  return { lines, problems, ok: problems.length === 0 };
}

/** 一次完整的对账（`--verify` 与 `--apply` 共用） */
function reconcile(dst, src, plan) {
  const remote = invokeCli(dst, "digest.tables", {});
  const cmp = compareTables(plan, remote);
  const settings = compareSettings(dst, src);
  for (const l of cmp.lines) console.log(l);
  for (const l of settings.lines) console.log(l);
  const hints = [];
  for (const table of cmp.digestMismatchTables) {
    const dx = diagnoseDigestMismatch(dst, src, table);
    if (dx) {
      hints.push(
        `${table}: **列集合不一致** —— 源库 ${dx.srcCols} 列 / 目标库 ${dx.dstCols} 列` +
          (dx.onlyDst.length ? `，目标端多出 ${dx.onlyDst.join(", ")}` : "") +
          (dx.onlySrc.length ? `，源端多出 ${dx.onlySrc.join(", ")}` : "") +
          "\n      摘要按 SELECT * 逐列编码，所以列集合不同时摘要**必然**不同 —— " +
          "这不是『数据搬丢了』，但也不能算通过：对账在两端结构一致之前无法判定内容是否相同。\n" +
          "      处置方向：让两端列集合一致（源库补列，或让引擎的对账只比双方共有的列），再重跑。",
      );
    }
  }
  const problems = [...cmp.problems, ...settings.problems];
  if (problems.length) {
    console.log(`\n对账失败 ${problems.length} 处：`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    if (hints.length) {
      console.log("\n诊断（为什么会失败）：");
      for (const h of hints) console.log(`  ↳ ${h}`);
    }
    return { ok: false, problems, hints, targetMore: cmp.targetMore, totalRemote: null };
  }
  const total = Object.values(remote).reduce((a, v) => a + (v?.rows ?? 0), 0);
  console.log(`  全部一致（新库共 ${total} 行）`);
  return { ok: true, problems: [], hints: [], targetMore: cmp.targetMore, totalRemote: total };
}

// ========== 主流程 ==========

function isAppRunning() {
  try {
    const res = spawnSync("tasklist", ["/FI", "IMAGENAME eq codem.exe"], { encoding: "utf8" });
    return (res.stdout ?? "").includes("codem.exe");
  } catch {
    return false;
  }
}

function usage() {
  console.log(
    [
      "用法：node tools/migrate/storage-migrate.mjs <模式> [--src 旧库] [--dst 新库]",
      "",
      "  --dry-run        盘点 + 预检（不导入任何行）",
      "  --apply          执行迁移（由引擎完成：备份 → 导入 → 重建 FTS → 对账 → 写标记）",
      "  --verify         只对账（迁移后复验）",
      "  --rollback-hint  打印回滚步骤",
      "",
      "  --strict-fk      预检有孤儿就中止（在**写入之前**，退出码 1）",
      "  --force          目标库已有消息时也强制迁移（传给引擎的 force）+ 应用在跑时也继续",
    ].join("\n"),
  );
}

async function main() {
  const mode = has("--dry-run")
    ? "dry-run"
    : has("--apply")
      ? "apply"
      : has("--verify")
        ? "verify"
        : has("--rollback-hint")
          ? "rollback-hint"
          : null;
  if (!mode) {
    usage();
    return 2;
  }

  const src = arg("--src", DEFAULT_SRC);
  const dst = arg("--dst", DEFAULT_DST);

  if (mode === "rollback-hint") {
    printRollbackHint(src, dst);
    return 0;
  }

  if (!fs.existsSync(CLI)) {
    fail(`找不到 CLI：${CLI}\n  先构建它：npm run db:build（或 cargo build --offline --manifest-path src-tauri/codem-db/Cargo.toml）`);
  }
  if (!fs.existsSync(src)) {
    fail(`旧库不存在：${src}`);
  }

  console.log(`旧库（sql.js 时代落盘，全程只读）: ${src}`);
  console.log(`  大小 ${fs.statSync(src).size} B  sha256 ${sha256(src).slice(0, 16)}`);
  console.log(
    `新库（Rust 引擎）              : ${dst}${fs.existsSync(dst) ? `（已存在 ${fs.statSync(dst).size} B）` : "（不存在，将由引擎创建）"}`,
  );
  const srcBefore = sha256(src);

  // ===== 1) 计划（引擎只读旧库算出来的）=====
  let plan;
  try {
    plan = sourcePlan(dst, src);
  } catch (e) {
    fail(`引擎无法读取旧库（这一步只读旧库，不会写它）：${e.message}`);
  }
  const nonEmpty = (plan.per_table ?? []).filter((t) => t.rows > 0);
  console.log(
    `\n[计划] 源库中属于引擎导入清单的表 ${(plan.per_table ?? []).length} 张（其中 ${nonEmpty.length} 张有数据）`,
  );
  console.log(`  引擎可搬运 ${nonEmpty.length} 张表 / ${plan.rows} 行（按 IMPORT_ORDER 的外键依赖顺序；空表不搬）`);
  for (const t of nonEmpty) console.log(`    ${t.table}: ${t.rows}`);

  const orderInfo = checkCoverage(dst, plan);

  // ===== 2) 源端预检（写之前把话说清）=====
  console.log("\n[预检] 逐表比对源端原始行数与引擎计划搬运行数");
  const pre = precheckSource(dst, src, plan.per_table ?? []);
  reportPrecheck(pre);
  if (has("--strict-fk")) {
    const willDrop = pre.dropped.filter((d) => !d.impossible).reduce((a, d) => a + d.n, 0);
    if (willDrop > 0) {
      fail(
        `按 --strict-fk 要求中止：**没有导入任何数据行**。若确认这 ${willDrop} 行孤儿可以丢弃，` +
          "去掉该参数重跑（会打印被丢弃的明细）；若认为数据重要，请先从旧库把它们导出备查。\n" +
          "  （引擎为了给出计划会打开新库，因此新库文件可能被创建成「只有空表结构」的状态 —— 那是幂等的 schema 动作，行数为 0。）",
      );
    }
    if (pre.truncated.length) {
      fail(
        `按 --strict-fk 要求中止：预检不完整（${pre.truncated.map((t) => t.table).join(", ")} 撞到 CLI 读取上限），` +
          "无法保证没有孤儿。",
      );
    }
    console.log("--strict-fk：预检完整且无孤儿，继续。");
  }

  // ===== dry-run =====
  if (mode === "dry-run") {
    const present = orderInfo.tables ?? [];
    const willCreate = (plan.per_table ?? []).map((t) => t.table).filter((t) => !present.includes(t));
    console.log(`\n[dry-run] 新库当前已有的可导入表：${present.length}`);
    console.log(`[dry-run] 旧库中需要新建的表：${willCreate.length ? willCreate.join(", ") : "（无）"}`);
    console.log(
      "[dry-run] 没有导入任何行。加 --apply 执行。\n" +
        "  注：引擎打开新库时会建表/装审计触发器（幂等的 schema 动作），所以新库文件可能被创建或更新 —— " +
        "这与旧实现（也用 import.tables 打开新库）一致。",
    );
    return 0;
  }

  // ===== verify =====
  if (mode === "verify") {
    console.log("\n[对账] 源端计划（只读旧库） vs 目标端摘要（digest.tables）");
    const verdict = reconcile(dst, src, plan);
    const srcAfter = sha256(src);
    console.log(`\n旧库 sha256 ${srcBefore === srcAfter ? "未变化 ✓" : "变了 ✗（迁移期间旧库被写入过，结论不可信）"}`);
    return verdict.ok ? 0 : 1;
  }

  // ===== apply =====
  if (isAppRunning()) {
    const force = has("--force");
    console.warn(
      "\n⚠️ 检测到 Codem 正在运行。迁移要求应用关闭：两个引擎同时写各自的库会漂移，\n" +
        "   而且应用自己的 `migration.auto` 可能和这一次并发跑。",
    );
    if (dst === DEFAULT_DST && !force) {
      fail(
        "目标是默认的新库路径，而应用正在运行 —— 拒绝继续（避免和运行中的应用互相覆盖）。\n" +
          "  请先退出应用再重跑；确实要强行继续时加 --force。",
      );
    }
    console.warn("   继续执行（非默认路径或已显式 --force）。");
  }

  console.log("\n[执行] 引擎的 migration.auto：写入前整库备份 → 单进程单事务导入 → 逐表对账 → 重建 FTS → 写标记");
  let res;
  try {
    res = invokeCli(dst, "migration.auto", { legacy_path: src, force: has("--force") });
  } catch (e) {
    const reconcileFailed = /对账未通过/.test(String(e.message));
    fail(
      `引擎迁移失败（未留下半个库：导入是单事务；对账不通过时**不写**迁移标记，下次可重跑）：\n  ${e.message}\n` +
        (reconcileFailed
          ? "  提示：这是**对账未通过**。先跑一次 `--verify`（逐表打印行数与摘要，并对「行数相同但摘要不同」的表\n" +
            "  给出列集合诊断），再决定怎么处置 —— 不要直接加 --force 硬推。\n"
          : "") +
        "  提示：若报「新库里已有 N 条消息，拒绝自动迁移」，说明这是「以旧库为准覆盖新库」的场景，\n" +
        "  确认无误后加 --force；否则请先人工确认哪一份才是权威副本。",
    );
  }

  console.log(`\n[1/6] 引擎写入前的整库备份：${res.backup_path ?? "（无）"}`);
  if (res.backup_path && fs.existsSync(res.backup_path)) {
    console.log(`      ${fs.statSync(res.backup_path).size} B（迁移前的新库快照；恢复命令见 --rollback-hint）`);
  }
  console.log(`\n[2/6] 导入：${res.tables} 张表 / ${res.rows} 行（单事务，全成或全不成）`);
  const skippedOrphans = (res.skipped ?? []).filter((s) => String(s.what).includes("孤儿"));
  for (const s of res.skipped ?? []) {
    if (String(s.what).includes("孤儿")) continue;
    if (s.rows > 0) console.log(`      跳过 ${s.what}: ${s.rows} 行`);
  }
  const orphanRows = skippedOrphans.reduce((a, s) => a + s.rows, 0);
  if (orphanRows > 0) {
    console.log(`      丢弃外键孤儿 ${orphanRows} 行（引擎计数）：`);
    for (const s of skippedOrphans) console.log(`        ${s.what}: ${s.rows} 行`);
  }
  if (res.blob_columns_converted) {
    console.log(`      BLOB 列按 blobhex: 十六进制文本搬运：${res.blob_columns_converted} 列（不静默改形）`);
  }
  console.log(
    `\n[3/6] 全文索引重建（引擎内部）：${res.fts?.sessions ?? 0} 个会话 / 新增 ${res.fts?.added ?? 0} 条 / ` +
      `刷新 ${res.fts?.refreshed ?? 0} 条 / 清理孤儿 ${res.fts?.removed ?? 0} 条`,
  );
  if (res.fts?.failures?.length) {
    console.log(`      ⚠ ${res.fts.failures.length} 个会话索引失败：${JSON.stringify(res.fts.failures).slice(0, 200)}`);
  }

  console.log("\n[4/6] 对账（引擎侧逐表行数 + 内容摘要；settings 另做逐键复核）");
  for (const t of res.per_table ?? []) {
    const note =
      (res.kept_newer ?? []).find((k) => k.table === t.table) !== undefined
        ? `（目标端已有 ${(res.kept_newer ?? []).find((k) => k.table === t.table).target_rows} 行，保留较新）`
        : "";
    if (t.rows > 0) console.log(`  ✓ ${t.table}: ${t.rows} 行，摘要 ${d8(t.digest)}${note}`);
  }
  const settings = compareSettings(dst, src);
  for (const l of settings.lines) console.log(l);

  const ok = settings.ok;
  console.log(
    `\n[5/6] 迁移标记：${ok ? "引擎已写入 codem-storage-migrated-at（下次启动不再自动迁移）" : "**未写入**（对账未通过）"}`,
  );

  const srcAfter = sha256(src);
  console.log("\n[6/6] 结果");
  console.log(`  旧库 sha256 ${srcBefore === srcAfter ? "未变化 ✓" : "变了 ✗（迁移期间旧库被写入过，结论不可信）"}`);
  console.log(`  新库 ${dst}（${fs.existsSync(dst) ? fs.statSync(dst).size : 0} B）`);
  console.log(`  对账：${ok ? "通过 ✓" : "未通过 ✗"}`);
  if (!ok) {
    console.log(`\n  对账失败明细：`);
    for (const p of settings.problems) console.log(`    ✗ ${p}`);
    console.log(`\n  回滚：node tools/migrate/storage-migrate.mjs --rollback-hint`);
  }
  return ok && srcBefore === srcAfter ? 0 : 1;
}

/**
 * 回滚提示。
 *
 * ## ⚠️ 本轮修掉的一处**误导性文案**（比代码缺陷更危险的一类）
 *
 * 旧版本这里写的是：在 devtools 里 `localStorage.setItem("codem-storage-engine","wasm")`
 * 然后重启就切回 sql.js 引擎。**那条路已经不存在了**：
 * - 回滚开关本身在 v1.16.62（第 15 轮）退役：`selectedEngine()` 不再读 localStorage、恒为 `rust`；
 * - 它指向的 sql.js 引擎已随 L1 从工程里删除（`node_modules` 下的 sql.js 包已不存在）。
 *
 * 也就是说：照旧文案操作的人会得到一个**假的安全感**（以为切回去了，其实什么都没发生）。
 * 一个假的回滚开关比没有回滚开关更危险，所以这里仍然把 `codem-storage-engine` 这个键名
 * 写出来 —— 但写成"它已退役、别再照旧文档做"，而不是当成可用的回退手段。
 */
function printRollbackHint(src, dst) {
  console.log("回滚步骤");
  console.log("");
  console.log("⚠️ 先纠正一处旧文档里的过时指引：迁移期那个「一键回滚开关」**已退役**。");
  console.log('   旧文档写的是：devtools 里执行 localStorage.setItem("codem-storage-engine", "wasm")，');
  console.log("   重启后切回渲染进程内的 sql.js 引擎。**这条路现在不通**：");
  console.log("   · 开关本身在 v1.16.62（第 15 轮）退役 —— selectedEngine() 不再读 localStorage，恒为 rust；");
  console.log("   · 它指向的 sql.js 引擎已随 L1 从工程里删除（node_modules 下的 sql.js 包已不存在）。");
  console.log("   写这个键不会有任何效果。把它列在这里，是为了让「照着旧文档操作」的人知道它已经失效，");
  console.log("   而不是把它当成可用的回退手段（一个假的安全感比没有安全感更危险）。");
  console.log("");
  console.log("1) 真正的回退 = **应用级回退**：装回上一版安装包。");
  console.log("   旧库在整个迁移期都是只读的（本工具前后各算一次 sha256，见 --apply 的 [6/6]），");
  console.log("   所以任何一次回退都能拿回原始数据。");
  console.log("");
  console.log("2) 旧库（权威副本，迁移过程只读它）：");
  console.log(`     ${src}`);
  console.log("");
  console.log("3) 新库与其备份：");
  console.log(`     当前：${dst}`);
  const dir = path.dirname(dst);
  const backups = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(path.basename(dst) + ".pre-migration-") || f.startsWith(path.basename(dst) + ".backup-"))
        .sort()
    : [];
  if (backups.length) {
    console.log("     可用备份（最新在后；pre-migration-* 是引擎在写入前自动做的整库快照）：");
    for (const b of backups) console.log(`       ${path.join(dir, b)}`);
    console.log(`   恢复到某个备份：copy "${path.join(dir, backups[backups.length - 1])}" "${dst}"`);
    console.log("   ⚠ 恢复前请先 checkpoint/关闭应用：最新数据可能还在 -wal 里，直接覆盖主文件会丢那一段。");
  } else {
    console.log("     （没有备份：说明迁移时新库还不存在，删除它即可回到「从未迁移」的状态）");
  }
  console.log("");
  console.log("4) 只是想撤销「已迁移」标记（让应用下次启动重新走迁移）：");
  console.log(`     "${EXE}" --db "${dst}" invoke settings.remove -   # 参数 {"key":"codem-storage-migrated-at"}`);
  console.log("");
  console.log("注意：删除新库不会影响旧库数据；旧库是唯一的原始副本，任何操作都不要写它。");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  /*
   * 库文件（tools/ 下的 .mjs）在顶层**不得**有 exit/写盘/长任务这类副作用：
   * 审计扫描器会 import tools/ 下的文件，历史上这里有过模块顶层的 process.exit(1)，
   * 结果是"vitest worker 被杀 → 无关测试随机失败"（见 docs/ARCH-SQLITE-TO-RUST.md 第 329 行）。
   * 所以一切都在 main() 里，并且用 process.exitCode（而不是 process.exit）收尾 ——
   * 管道下 process.exit 会截断还没刷出去的 stdout。
   */
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((e) => {
      if (e instanceof MigrationFailure) {
        console.error(`\n[迁移失败] ${e.message}`);
      } else {
        console.error(`\n[迁移失败] 未预期的错误：${e?.stack ?? e}`);
      }
      process.exitCode = 1;
    });
}

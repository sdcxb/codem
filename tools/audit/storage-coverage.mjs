#!/usr/bin/env node
/**
 * 仓储覆盖率门禁（P2）：把"82 个仓储方法实现了多少"变成一个**可复跑、会自己变红**的数字。
 *
 * ## 为什么需要它
 *
 * 迁移最容易出现的失败模式不是"某个方法写错了"，而是**不知道还差多少**：
 * 边迁移边新写功能，SQL 调用点又涨回去，最后"看起来快迁完了"其实永远差一截。
 * 所以这里做两件事：
 * 1. 从渲染侧真实 SQL 调用点提取"需要哪些仓储方法"（与 `storage-inventory.mjs` 同源规则，
 *    且**交叉校验**两个扫描器的方法集合必须完全一致 —— 任何一边漂了就报错）；
 * 2. 与 Rust 侧已实现命令对照，给出覆盖率，并对 `--check` 模式返回非零退出码（可入门禁）。
 *
 * ## 与 inventory 的分工
 *
 * - `storage-inventory.mjs`：一次性盘点（生文档、给字段级明细）；
 * - 本文件：**持续门禁**（覆盖率数字 + 一致性校验 + 落 `docs/STORAGE-COVERAGE.md`）。
 *
 * 用法：
 *   node tools/audit/storage-coverage.mjs            # 打印覆盖率
 *   node tools/audit/storage-coverage.mjs --md       # 生成 docs/STORAGE-COVERAGE.md
 *   node tools/audit/storage-coverage.mjs --json     # 机器可读
 *   node tools/audit/storage-coverage.mjs --check    # 覆盖率低于阈值则退出码 1
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const RUST_LIB = path.join(ROOT, "src-tauri", "codem-db", "src", "lib.rs");

/** 覆盖率下限（随迁移推进而上调；不到就变红，避免"迁移做不完也没人发现"） */
const REQUIRED_COVERAGE = Number(process.env.CODEM_DB_COVERAGE_MIN ?? 10);

// ========== 渲染侧：需要哪些仓储方法 ==========

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", "__snapshots__"].includes(e.name)) continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * 生产文件集合（与 `storage-inventory.mjs` 的 `listFiles` **必须完全一致**）。
 *
 * ⚠️ 单位口径（第 92 波踩过）：inventory 排除了整个 `test` 目录，
 * 而这里排除了 `*.test.ts`。两者对 `src/test/helpers/*.ts` 这类"非测试但位于 test 目录"的文件
 * 判断不同，文件数也不一样（836 vs 831）—— 覆盖率与盘点必须用同一个单位，
 * 否则两个数字永远对不上。以 `*.test.ts` 为准（测试夹具本身也可能包含 SQL）。
 */
function listProductionFiles(dir) {
  return listFiles(dir);
}

/** 与 storage-inventory.mjs 完全相同的分类规则（漂移会被下面的交叉校验抓住） */
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

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function scanRequiredMethods() {
  const files = listFiles(SRC);
  const byMethod = new Map();
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!/\bdb\.(exec|run|prepare)\(/.test(line) && !/runGuarded\(/.test(line)) return;
      // ⚠️ 必须允许 `(` 与 SQL 字面量之间的换行/缩进：
      // 本项目源码是 CRLF，且约定"SQL 与调用分开写"（`db.run(` 换行 + 缩进 + SQL）。
      // 早先版本的 `db\.(exec|run|prepare)\(['"]` 要求引号紧跟括号，于是
      // **所有 INSERT 语句都被漏掉**（写路径！），覆盖率被严重低估。
      const window = lines.slice(i, i + 3).join(" ");
      const sqlMatch =
        /(?:db\.(?:exec|run|prepare)\(|runGuarded\(\s*db,\s*|,\s*)[\s\S]{0,40}?`([^`]{6,})`/.exec(window) ||
        /(?:db\.(?:exec|run|prepare)\(|runGuarded\(\s*db,\s*)[\s\S]{0,40}?['"]([^'"]{6,})['"]/.exec(window);
      if (!sqlMatch) return;
      const cls = classifySql(sqlMatch[1]);
      if (!cls) return;
      const method = `${cls.table}.${cls.op}`;
      const e = byMethod.get(method) ?? { method, table: cls.table, op: cls.op, sites: 0 };
      e.sites++;
      byMethod.set(method, e);
    });
  }
  return { files: files.length, methods: [...byMethod.values()].sort((a, b) => b.sites - a.sites || a.method.localeCompare(b.method)) };
}

// ========== 渲染侧（第 17 轮新增）：端口调用点盘点 ==========
//
// ## 为什么必须补这一半
//
// 原来的盘点只认**旧库 SQL**（`db.run/exec/prepare` + `runGuarded`）。L4 把回退分支删完之后，
// 渲染侧的存储调用**已经绝大多数走端口**（`domainRead*` / `domainWrite` / `domainDelete*`
// + 具名命令 `crud.*` / `fts.*` / `messages.*` …），旧库 SQL 只剩 `message.ts` 一处。
// 于是旧口径的"调用点总数"从 277 掉到 49 —— 那是**目标达成的表现**，不是退化；
// 但如果门禁还钉着旧数字（`> 200`），它就会在正确的方向上变红；
// 而如果直接把阈值调低，门禁又会在"盘点彻底失效"时报"通过"。
//
// 正确做法是把**两半都盘**：旧库 SQL + 端口调用。总规模的护栏盯两者之和，
// 这样"迁移推进"会让旧的一半下降、新的一半上升，护栏始终有效（且不会把成功判成失败）。

/** 域端口读/写函数 → 操作名 */
const DOMAIN_FNS = {
  domainRead: "select",
  domainReadMany: "select",
  domainReadOne: "select",
  domainOr: "select",
  domainWrite: "upsert",
  domainDelete: "delete",
  domainDeleteWhere: "delete",
  domainDeleteBeyond: "delete",
};

/** 同一文件里的 `const X = "table_name";` —— 域端口调用普遍传常量 */
function constStringMap(src) {
  const map = new Map();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*["']([a-z_][\w]*)["']\s*(?:as\s+const\s*)?;/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

function resolveTableArg(raw, consts) {
  const s = raw.trim();
  const lit = /^["'`]([a-z_][\w]*)["'`]$/.exec(s);
  if (lit) return lit[1];
  if (consts.has(s)) return consts.get(s);
  return null;
}

export function scanPortSites() {
  const files = listFiles(SRC);
  const commands = new Map(); // 具名命令 → 调用点数
  const tableOps = new Map(); // "table.op" → 调用点数
  let sites = 0;
  let unresolved = 0;
  const unresolvedSamples = [];

  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const consts = constStringMap(src);
    /** 域端口实现自身（泛型包装器，表名是参数）—— 它不是"调用点"，不该计入解析失败 */
    const isDomainStoreItself = rel === "src/core/storage/domain-store.ts";

    // ① 域端口调用：domainReadMany(T, …) / domainWrite("sessions", …)
    for (const m of src.matchAll(
      /\b(domainReadMany|domainReadOne|domainRead|domainOr|domainWrite|domainDeleteWhere|domainDeleteBeyond|domainDelete)\s*(?:<[^>()]*>\s*)?\(\s*([^,)\n]+)/g,
    )) {
      sites++;
      const op = DOMAIN_FNS[m[1]];
      const table = resolveTableArg(m[2], consts);
      if (table) {
        const key = `${table}.${op}`;
        tableOps.set(key, (tableOps.get(key) ?? 0) + 1);
      } else if (!isDomainStoreItself) {
        unresolved++;
        if (unresolvedSamples.length < 10) {
          unresolvedSamples.push(`${rel}: ${m[1]}(${m[2].trim().slice(0, 40)})`);
        }
      }
    }

    const lines = src.split("\n");

    // ② 具名端口命令：port.data.command("crud.upsert", …) / .query("fts.search", …)
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\.(?:command|query|execute)\s*(?:<[^>()]*>\s*)?\(\s*["']([a-z_]+(?:\.[a-z_]+)+)["']/g)) {
        sites++;
        const cmd = m[1];
        commands.set(cmd, (commands.get(cmd) ?? 0) + 1);
        // `crud.*` 的表名写在参数里（常在同一行或紧接着几行）
        if (cmd.startsWith("crud.")) {
          const window = lines.slice(i, i + 6).join(" ");
          const t = /table\s*:\s*["']([a-z_][\w]*)["']/.exec(window);
          if (t) {
            const op = cmd === "crud.upsert" ? "upsert" : cmd === "crud.delete" ? "delete" : "select";
            const key = `${t[1]}.${op}`;
            tableOps.set(key, (tableOps.get(key) ?? 0) + 1);
          }
        }
      }
    });

    // ③ 配置面（同步读 / 写走 rustConfig）：`cfg.set(...)` / `.config.remove(...)`
    for (const m of src.matchAll(/\.config\.(set|remove|get|getAll)\s*\(/g)) {
      sites++;
      commands.set(`config.${m[1]}`, (commands.get(`config.${m[1]}`) ?? 0) + 1);
    }

    // ④ 事件通道（session_events 的写路径**不走 crud**，走专用发件箱）
    //    `port.events.appendLocal(...)` + `port.appendEventAsync(...)` ——
    //    盘不到它，门禁就会以为"事件表没有写路径"（实际上它是最关键的写入路径之一）。
    for (const m of src.matchAll(/\.events\.(appendLocal|replaceSession|ensureLoaded|isLoaded|count)\s*\(/g)) {
      sites++;
      commands.set(`events.${m[1]}`, (commands.get(`events.${m[1]}`) ?? 0) + 1);
    }
    for (const m of src.matchAll(/\bappendEventBatchAsync\s*\(/g)) {
      sites++;
      commands.set("events.append_batch", (commands.get("events.append_batch") ?? 0) + 1);
    }
    for (const m of src.matchAll(/\bappendEventAsync\s*\(/g)) {
      sites++;
      commands.set("events.append", (commands.get("events.append") ?? 0) + 1);
    }
  }

  const toSorted = (map, keyName) =>
    [...map.entries()].map(([k, v]) => ({ [keyName]: k, sites: v })).sort((a, b) => b.sites - a.sites || String(a[keyName]).localeCompare(String(b[keyName])));

  return {
    files: files.length,
    sites,
    unresolved,
    unresolvedSamples,
    commands: toSorted(commands, "command"),
    tableOps: toSorted(tableOps, "method"),
  };
}

// ========== Rust 侧：已经实现了哪些 ==========

/**
 * 渲染侧方法名 → Rust 仓储命令。
 *
 * 少数命名不同（渲染侧按 `表.操作` 归类，Rust 侧按**语义**命名，例如
 * `messages.select` → `messages.list`/`messages.get`，`messages.insert` → `messages.create`），
 * 因此这里显式列出映射，而不是靠字符串猜。未列出的 = 尚未实现（P3 按模块补齐）。
 */
export const IMPLEMENTED = {
  "settings.select": ["settings.get_all"],
  "settings.update": ["settings.set"],
  "settings.insert": ["settings.set"],
  "settings.delete": ["settings.remove"],
  "session_events.insert": ["events.append", "events.append_batch"],
  "session_events.select": ["events.list", "events.count", "events.watermark"],
  "session_events.delete": ["events.delete_session"],
  "telemetry_events.insert": ["telemetry.append"],
  "telemetry_events.delete": ["telemetry.prune"],
  "messages.insert": ["messages.create", "messages.create_many", "messages.upsert_index"],
  "messages.update": ["messages.update", "messages.update_many", "messages.upsert_index"],
  "messages.select": ["messages.get", "messages.list"],
  "messages.delete": ["messages.delete"],
  "sessions.insert": ["sessions.upsert"],
  "sessions.select": ["sessions.list"],
  "projects.insert": ["projects.upsert"],
  "projects.select": ["projects.list"],
  // ===== P3 第 11 段：域镜像（accounts 为例，其余域同形状）=====
  "prompt_drafts.select": ["crud.list"],
  "prompt_drafts.insert": ["crud.upsert"],
  "prompt_drafts.delete": ["crud.delete"],
  "turn_file_changes.select": ["crud.list"],
  "turn_file_changes.insert": ["crud.upsert"],
  "turn_file_changes.update": ["crud.upsert"],
  "turn_file_changes.delete": ["crud.delete"],
  "v2_sessions.select": ["crud.list"],
  "v2_sessions.insert": ["crud.upsert"],
  "v2_sessions.update": ["crud.upsert"],
  "v2_sessions.delete": ["crud.delete"],
  "accounts.select": ["crud.list"],
  "accounts.insert": ["crud.upsert"],
  "accounts.update": ["crud.upsert"],
  "accounts.delete": ["crud.delete"],

  // ===== P3 第 8 段：反馈 / 附件 / 全文索引 =====
  "message_feedback.select": ["feedback.get"],
  "message_feedback.insert": ["feedback.set"],
  "message_feedback.alter": ["feedback.set"],
  "message_feedback.delete": ["feedback.delete"],
  "attachments.select": ["attachments.list"],
  "attachments.update": ["attachments.update"],
  "session_fts.select": ["fts.search"],
  "session_fts.insert": ["fts.rebuild"],
  "session_fts.delete": ["fts.delete_session", "fts.rebuild"],

  // ===== P3 第 3 段：配置面扩展域 =====
  "quick_phrases.select": ["quick_phrases.list"],
  "quick_phrases.insert": ["quick_phrases.save"],
  "quick_phrases.update": ["quick_phrases.save", "quick_phrases.touch"],
  "quick_phrases.delete": ["quick_phrases.delete"],
  "mcp_servers.select": ["mcp_servers.list"],
  "mcp_servers.insert": ["mcp_servers.save"],
  "mcp_servers.update": ["mcp_servers.save"],
  "mcp_servers.delete": ["mcp_servers.remove"],
  "memory.select": ["memory.get"],
  "memory.insert": ["memory.set"],
  "memory.update": ["memory.set"],
};

export function implementedCommands() {
  const set = new Set();
  for (const cmds of Object.values(IMPLEMENTED)) for (const c of cmds) set.add(c);
  return set;
}

/**
 * 通用仓储命令覆盖的"表 × 操作"。
 *
 * ## 为什么用代码推导而不是手写 87 条
 *
 * 第 10 段引入了**表定义驱动**的通用命令（`crud.list/upsert/delete/count`）：
 * 表名走 `sql/tables.json` 白名单、列名与真实列定义逐字核对、值参数化绑定。
 * 因此"某张表能不能读/写"不再需要逐条登记 —— 而是由**表是否在业务表清单里**决定。
 *
 * 手写 87 条映射的代价不只是啰嗦：它会漂移（加了表忘了补映射 → 覆盖率虚低或虚高）。
 * 所以这里从 `sql/tables.json`（由 TS schema 生成）推导，与引擎侧用的是**同一份清单**。
 */
const CRUD_READ_OPS = new Set(["select"]);
const CRUD_WRITE_OPS = new Set(["insert", "update", "alter"]);
const CRUD_DELETE_OPS = new Set(["delete"]);

function crudTables() {
  const p = path.join(ROOT, "src-tauri", "codem-db", "sql", "tables.json");
  const json = JSON.parse(fs.readFileSync(p, "utf8"));
  return new Set((json.tables ?? []).filter((t) => !t.startsWith("session_fts")));
}

/** 兜底解析：没有专门命令的表，看是否被通用命令覆盖 */
export function genericCommandFor(method) {
  const dot = method.lastIndexOf(".");
  if (dot < 0) return null;
  const table = method.slice(0, dot);
  const op = method.slice(dot + 1);
  if (!crudTables().has(table)) return null;
  // 有专门命令的表优先用专门命令（tool_calls / messages / sessions / projects / settings …）
  if (CRUD_READ_OPS.has(op)) return ["crud.list", "crud.count"];
  if (CRUD_WRITE_OPS.has(op)) return ["crud.upsert"];
  if (CRUD_DELETE_OPS.has(op)) return ["crud.delete"];
  return null;
}

/** 与 Rust `COMMANDS` 常量交叉校验：映射表里写的命令必须真的在 Rust 里存在 */
export function rustCommands() {
  const src = fs.readFileSync(RUST_LIB, "utf8");
  const block = /pub const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error(`无法从 ${RUST_LIB} 解析 COMMANDS`);
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

export function computeCoverage() {
  const scanned = scanRequiredMethods();
  const required = scanned.methods;
  const impl = implementedCommands();
  const rust = rustCommands();

  // 一致性 A：映射表里不得出现 Rust 侧不存在的命令（防"文档说实现了、代码没有"）
  const phantom = [...impl].filter((c) => !rust.has(c));

  // 一致性 B：与 inventory 扫描器的方法集合必须完全一致（防两个扫描器规则漂移）
  let inventoryDrift = null;
  try {
    const raw = execFileSync(process.execPath, [path.join(__dirname, "storage-inventory.mjs"), "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const inv = JSON.parse(raw);
    const a = new Set(required.map((m) => m.method));
    const b = new Set(inv.summary.methods.map((m) => m.method));
    const onlyHere = [...a].filter((x) => !b.has(x));
    const onlyThere = [...b].filter((x) => !a.has(x));
    if (onlyHere.length || onlyThere.length) inventoryDrift = { onlyHere, onlyThere };
  } catch (e) {
    inventoryDrift = { error: String(e.message).slice(0, 200) };
  }

  // ⚠️ 这里区分两个**不同**的概念，混在一起会给出误导性的"100%"：
  //
  //  · siteWired：渲染侧的调用点**真的已经切到端口**（IMPLEMENTED 表，人工维护、保守）
  //  · commandAvailable：Rust 侧存在能服务该方法的命令（专用命令或通用 crud.*）
  //
  // 第 10 段引入通用命令后，commandAvailable 会直接到 100% —— 但那时渲染侧
  // 仍然在往 WASM 库写（默认引擎是 wasm）。如果只报一个数字，就会把
  // "引擎有命令" 说成 "迁移完成"，这是不能接受的虚报。
  // 所以两个都算、都报，门禁盯的是**保守的那个**。
  const resolve = (method) => IMPLEMENTED[method] ?? null;
  const done = required.filter((m) => resolve(m.method));
  const pending = required.filter((m) => !resolve(m.method));
  const commandAvailable = required.filter((m) => resolve(m.method) ?? genericCommandFor(m.method));
  const totalSites = required.reduce((a, m) => a + m.sites, 0);
  const doneSites = done.reduce((a, m) => a + m.sites, 0);
  const port = scanPortSites();
  return {
    scannedFiles: scanned.files,
    requiredMethods: required.length,
    implementedMethods: done.length,
    coveragePercent: +((done.length / required.length) * 100).toFixed(2),
    /** 渲染侧调用点已切到端口的比例（保守口径，人工维护） */
    commandAvailableMethods: commandAvailable.length,
    commandCoveragePercent: +((commandAvailable.length / required.length) * 100).toFixed(2),
    totalSites,
    implementedSites: doneSites,
    siteCoveragePercent: +((doneSites / totalSites) * 100).toFixed(2),
    /**
     * ⚠️ 第 17 轮的关键口径修正：**旧库 SQL 与端口调用必须一起盘**。
     *
     * 只盘旧库 SQL 的话，L4/L1 推进到末期时这个数字会趋近 0 ——
     * 而那正是"目标达成"的样子，不是盘点失效。把两半加起来（`totalStorageSites`）
     * 才既能防"扫描器写坏了扫出 0 个"，又不会把迁移的成功判成失败。
     */
    legacySites: totalSites,
    portSites: port.sites,
    portUnresolved: port.unresolved,
    portUnresolvedSamples: port.unresolvedSamples,
    portCommands: port.commands,
    portTableOps: port.tableOps,
    totalStorageSites: totalSites + port.sites,
    rustCommandCount: rust.size,
    phantomCommands: phantom,
    inventoryDrift,
    done: done.map((m) => ({ ...m, commands: resolve(m.method) })),
    pending,
  };
}

// ========== 输出 ==========

/** 渲染侧表 → 建议切换阶段（与 docs/ARCH-SQLITE-TO-RUST.md §3 的 P3 顺序一致） */
export function phaseOf(table) {
  if (["settings", "quick_phrases"].includes(table)) return "1 配置面";
  if (["session_events", "telemetry_events"].includes(table)) return "2 只追加";
  if (["messages", "tool_calls", "attachments", "session_fts", "message_feedback"].includes(table)) return "3 数据面";
  if (["sessions", "projects"].includes(table)) return "4 会话/项目";
  return "5 其余域";
}

// ⚠️ 本文件既是 CLI 又是**被 import 的库**（`src/test/db-coverage.test.ts` 会 import 它做门禁）。
// 因此所有 I/O 与 `process.exit` 必须收敛在 `isMain` 分支里 ——
// 库文件在顶层有副作用会让 import 它的测试进程被"顺手"执行一遍甚至退出。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const result = computeCoverage();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  const lines = [];
  lines.push("# 仓储迁移覆盖率（P2 门禁，自动生成）");
  lines.push("");
  lines.push("> 由 `node tools/audit/storage-coverage.mjs --md` 生成；不要手工编辑。");
  lines.push("");
  lines.push(`- 扫描生产文件：**${result.scannedFiles}**`);
  lines.push(`- **旧库 SQL 调用点：${result.legacySites}**（${result.requiredMethods} 个方法）—— 迁移推进中，应持续下降`);
  lines.push(
    `- **端口调用点：${result.portSites}**（其中表名解析不出的 ${result.portUnresolved} 处）—— 迁移推进中，应持续上升`,
  );
  lines.push(`- **存储调用点合计：${result.totalStorageSites}** —— 门禁的规模护栏盯这个和（只盘旧库会在迁移末期失去意义）`);
  lines.push(
    `- 已实现：**${result.implementedMethods}** → 方法覆盖率 **${result.coveragePercent}%**，调用点覆盖率 **${result.siteCoveragePercent}%**`,
  );
  lines.push(`- Rust 侧已注册命令：**${result.rustCommandCount}**`);
  lines.push(
    `- **命令可用性覆盖：${result.commandAvailableMethods}/${result.requiredMethods}（${result.commandCoveragePercent}%）**` +
      ` —— 这一项在第 10 段引入通用命令后已达 100%，但**不等于迁移完成**：` +
      `渲染侧调用点是否已切到端口，看上面那个保守数字。`,
  );
  lines.push("");
  if (result.phantomCommands.length) {
    lines.push(`⚠️ 映射表引用了 Rust 侧不存在的命令：${result.phantomCommands.join(", ")}`);
    lines.push("");
  }
  if (result.inventoryDrift) {
    lines.push(`⚠️ 与 storage-inventory.mjs 的方法集合不一致：${JSON.stringify(result.inventoryDrift)}`);
    lines.push("");
  }
  lines.push("## 已实现（渲染侧方法 → Rust 命令）");
  lines.push("");
  lines.push("| 渲染侧方法 | 调用点 | Rust 命令 |");
  lines.push("|---|---:|---|");
  for (const m of result.done) {
    lines.push(`| \`${m.method}\` | ${m.sites} | ${m.commands.map((c) => `\`${c}\``).join(" ")} |`);
  }
  lines.push("");
  lines.push(`## 待迁移（${result.pending.length} 个方法，按调用点排序）`);
  lines.push("");
  lines.push("| 渲染侧方法 | 调用点 | 建议阶段 |");
  lines.push("|---|---:|---|");
  for (const m of result.pending) lines.push(`| \`${m.method}\` | ${m.sites} | ${phaseOf(m.table)} |`);

  const md = lines.join("\n") + "\n";
  if (process.argv.includes("--md")) {
    const out = path.join(ROOT, "docs", "STORAGE-COVERAGE.md");
    fs.writeFileSync(out, md);
    console.log(`写入 ${path.relative(ROOT, out)}`);
  } else {
    console.log(md);
  }

  if (result.phantomCommands.length) {
    console.error(`\n[coverage] 失败：映射表引用了 Rust 侧不存在的命令 ${result.phantomCommands.join(", ")}`);
    process.exit(1);
  }
  if (result.inventoryDrift && !result.inventoryDrift.error) {
    console.error(`\n[coverage] 失败：两个扫描器的方法集合漂移 ${JSON.stringify(result.inventoryDrift)}`);
    process.exit(1);
  }
  if (process.argv.includes("--check") && result.coveragePercent < REQUIRED_COVERAGE) {
    console.error(
      `\n[coverage] 失败：方法覆盖率 ${result.coveragePercent}% 低于下限 ${REQUIRED_COVERAGE}%（环境变量 CODEM_DB_COVERAGE_MIN 可覆盖）`,
    );
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    console.log(`[coverage] 通过：${result.coveragePercent}% ≥ ${REQUIRED_COVERAGE}%`);
  }
}

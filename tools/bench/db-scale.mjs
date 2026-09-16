#!/usr/bin/env node
/**
 * 规模基准：Rust 引擎 vs sql.js(WASM) 引擎
 *
 * ## 为什么要两个都测
 *
 * 判断标准是"批量大文档必须非常强"。只报新实现的数字说明不了**改善**，
 * 所以这里用**同一份数据形状、同一套操作**压两个实现：
 * - **rust**：codem-db-cli（生产实现：原生 sqlite3 + WAL 页级增量落盘）
 * - **wasm**：渲染侧真实使用的 sql.js（`db.exec/run` + `db.export()` 整库序列化落盘）
 *
 * ## 怎么比才公平（这一点比数字本身更重要）
 *
 * CLI 每次调用都要**启动进程 + 打开数据库**（这正是未来 IPC 边界的成本形态），
 * 而 WASM 是在同一进程里直接调用。所以：
 * 1. 先单独测出 `cliPerCallOverhead`（一条只读 `counts` 的往返耗时）；
 * 2. 报告里同时给出**含开销**与**扣除开销**的解读，并把每次操作的平均耗时列出来；
 * 3. 关注量级差异，而不是零点几毫秒：真正要看的是
 *    - 每条写入是否 O(1)（Rust/WAL）还是 O(语料)（WASM 整库导出）；
 *    - 分页是否只读需要的页（Rust 索引）还是把全表读进渲染进程（WASM 堆）。
 *
 * 用法：
 *   node tools/bench/db-scale.mjs                      # 默认 1k / 10k / 100k
 *   node tools/bench/db-scale.mjs --rows 1000,10000
 *   node tools/bench/db-scale.mjs --keep               # 保留临时库
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.platform === "win32" ? "codem-db-cli.exe" : "codem-db-cli";
const CLI = path.join(ROOT, "src-tauri", "codem-db", "target", "debug", EXE);
const SQL_JS = path.join(ROOT, "node_modules", "sql.js", "dist", "sql-wasm.js");
const WASM = path.join(ROOT, "node_modules", "sql.js", "dist", "sql-wasm.wasm");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const KEEP = argv.includes("--keep");
const SIZES = argOf("--rows", "1000,10000,100000")
  .split(",")
  .map((x) => parseInt(x.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

/**
 * 只有在**被直接执行**时才跑基准。
 *
 * 教训：这个文件原先在模块顶层写了 `process.exit(1)`（找不到 CLI 时），
 * 结果审计扫描器一旦 import 本文件（仓储扫描会遍历 tools/），
 * 就会把 vitest 的 worker 进程直接杀掉 —— 表现为"无关测试随机失败"。
 * 库文件（tools/ 下的 .mjs）在顶层**不得**有 exit/写盘/长任务这类副作用。
 */
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

const tmpRoot = isMain ? fs.mkdtempSync(path.join(os.tmpdir(), "codem-db-bench-")) : "";
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n));

function runCli(dbPath, args, stdin) {
  const t0 = process.hrtime.bigint();
  const res = spawnSync(CLI, ["--db", dbPath, ...args], {
    input: stdin,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  const took = ms(t0);
  if (res.status !== 0) {
    throw new Error(`CLI 失败（${args.join(" ")}）：${res.stdout}\n${res.stderr}`);
  }
  return { json: res.stdout.trim() ? JSON.parse(res.stdout) : null, took };
}

/** 与生产形状一致的消息（中文 + emoji + 不均匀长度） */
function makeMessage(i, sessionId, contentBytes) {
  const filler = "中文段落🙂 这是一段用于测试存储边界的内容。\n".repeat(
    Math.max(1, Math.floor(contentBytes / 60)),
  );
  return {
    id: `bench-${String(i).padStart(8, "0")}`,
    session_id: sessionId,
    role: i % 3 === 0 ? "user" : "assistant",
    content: `#${i} ${filler}`,
    reasoning: i % 5 === 0 ? `推理 ${i}：` + "思考".repeat(20) : null,
    timestamp: 1_700_000_000_000 + i,
    model: "deepseek-v4.1-flash",
    status: "done",
  };
}

async function benchRust(rows, contentBytes) {
  const db = path.join(tmpRoot, `rust-${rows}.bin`);
  const sessionId = "bench-session";
  const out = { impl: "rust", rows, contentBytes, steps: {} };

  out.steps.openFirstTime = runCli(db, ["init"]).took;
  // 每次调用的固定开销 = 进程启动 + 打开库 + 一条只读查询。
  // 这是**未来 IPC 边界的成本形态**：真实运行是"进程内 IPC 往返 + 打开连接"（更便宜），
  // 但用它把"查询本身"的成本从"每次调用总耗时"里分离出来，避免把开销误读成查询慢。
  const overheads = [];
  for (let i = 0; i < 7; i++) overheads.push(runCli(db, ["counts", "sessions"]).took);
  overheads.sort((a, b) => a - b);
  out.steps.cliPerCallOverhead = overheads[Math.floor(overheads.length / 2)]; // 中位数
  // 纯进程启动 + 参数解析（不打开库）：用来确认开销主要来自进程，而不是 SQLite 打开
  const pureSpawns = [];
  for (let i = 0; i < 5; i++) {
    const t = process.hrtime.bigint();
    spawnSync(CLI, ["--help"], { encoding: "utf8" });
    pureSpawns.push(ms(t));
  }
  pureSpawns.sort((a, b) => a - b);
  out.steps.bareProcessSpawn = pureSpawns[Math.floor(pureSpawns.length / 2)];

  runCli(db, ["invoke", "projects.upsert", "-"], JSON.stringify({ id: "bench-proj", name: "基准" }));
  runCli(db, ["invoke", "sessions.upsert", "-"], JSON.stringify({ id: sessionId, project_id: "bench-proj", title: "基准会话" }));

  // 批量写入：每批 1000 条 = 一次单事务（与渲染侧 saveMessages 的批次形态对应）
  const batch = 1000;
  const batches = Math.ceil(rows / batch);
  let t0 = process.hrtime.bigint();
  for (let start = 0; start < rows; start += batch) {
    const items = [];
    for (let i = start; i < Math.min(start + batch, rows); i++) items.push(makeMessage(i, sessionId, contentBytes));
    runCli(db, ["invoke", "messages.create_many", "-"], JSON.stringify({ items }));
  }
  out.steps.insertAll = ms(t0);
  out.steps.insertBatches = batches;
  out.steps.insertPerRow = +(out.steps.insertAll / rows).toFixed(3);

  // 逐条写入 200 条（对照：每条一次事务 + 一次 IPC 往返的历史形态）
  const singles = 200;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < singles; i++) {
    runCli(db, ["invoke", "messages.create", "-"], JSON.stringify(makeMessage(rows + i, sessionId, 200)));
  }
  out.steps.insertSingles200 = ms(t0);
  out.steps.insertSinglePerRow = +(out.steps.insertSingles200 / singles).toFixed(3);

  // 全量分页读（每页 100 条）
  const pageLoop = (limit) => {
    let offset = 0;
    let n = 0;
    const t = process.hrtime.bigint();
    for (;;) {
      const r = runCli(db, ["invoke", "messages.list", "-"], JSON.stringify({ session_id: sessionId, limit, offset, include_hidden: true }));
      const got = r.json.result.items.length;
      n += got;
      if (!r.json.result.has_more) break;
      offset += got;
      if (offset > rows + 1_000_000) throw new Error("分页未收敛");
    }
    return { took: ms(t), n };
  };
  out.steps.readAllPages100 = pageLoop(100);
  out.steps.readFirstPage500 = runCli(db, ["invoke", "messages.list", "-"], JSON.stringify({ session_id: sessionId, limit: 500, include_hidden: true })).took;
  out.steps.count = runCli(db, ["invoke", "messages.count", "-"], JSON.stringify({ session_id: sessionId })).json.result.count;
  // 扣除"每次调用固定开销"后的分页读成本（每页 + 总计），用于把查询本身与进程开销分离
  const pages = Math.ceil(out.steps.readAllPages100.n / 100);
  out.steps.readAllPages100MinusOverhead = Math.max(0, out.steps.readAllPages100.took - pages * out.steps.cliPerCallOverhead);
  out.steps.readPerPageMinusOverhead = +(out.steps.readAllPages100MinusOverhead / Math.max(1, pages)).toFixed(2);

  // 批量改写 10000 条（上下文压缩/批量隐藏的真实形态）
  const updRows = Math.min(rows, 10000);
  t0 = process.hrtime.bigint();
  for (let start = 0; start < updRows; start += batch) {
    const items = [];
    for (let i = start; i < Math.min(start + batch, updRows); i++) items.push({ id: `bench-${String(i).padStart(8, "0")}`, hidden: 1 });
    runCli(db, ["invoke", "messages.update_many", "-"], JSON.stringify({ items }));
  }
  out.steps.updateMany = ms(t0);
  out.steps.updateManyRows = updRows;

  out.steps.checkpoint = runCli(db, ["checkpoint"]).took;
  out.fileBytes = fs.statSync(db).size;
  out.walBytes = runCli(db, ["health"]).json.health.wal_size_bytes;
  out.integrity = runCli(db, ["integrity"]).json.ok;
  out.tables = runCli(db, ["health"]).json.health.tables;
  if (!KEEP) {
    for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
  }
  return out;
}

async function benchWasm(rows, contentBytes) {
  const initSqlJs = (await import(`file://${SQL_JS.replace(/\\/g, "/")}`)).default;
  const SQL = await initSqlJs({ locateFile: () => WASM });
  const out = { impl: "wasm(sql.js)", rows, contentBytes, steps: {} };
  const dbPath = path.join(tmpRoot, `wasm-${rows}.bin`);
  const sessionId = "bench-session";

  let t0 = process.hrtime.bigint();
  const db = new SQL.Database();
  db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, description TEXT, pinned INTEGER DEFAULT 0, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL);
          CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL, message_count INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0);
          CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT, timestamp INTEGER NOT NULL, model TEXT, status TEXT DEFAULT 'done', hidden INTEGER DEFAULT 0);`);
  out.steps.openFirstTime = ms(t0);
  out.steps.cliPerCallOverhead = 0; // 同进程调用：没有进程/IPC 往返

  db.run("INSERT INTO projects VALUES ('bench-proj','基准','','',0,1,1)");
  db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,0)", [sessionId, "bench-proj", "基准会话", 1, 1, 0]);

  const INS =
    "INSERT OR REPLACE INTO messages (id, session_id, role, content, reasoning, timestamp, model, status) VALUES (?,?,?,?,?,?,?,?)";
  const batch = 1000;
  const flushes = [];
  t0 = process.hrtime.bigint();
  for (let start = 0; start < rows; start += batch) {
    for (let i = start; i < Math.min(start + batch, rows); i++) {
      const m = makeMessage(i, sessionId, contentBytes);
      db.run(INS, [m.id, m.session_id, m.role, m.content, m.reasoning, m.timestamp, m.model, m.status]);
    }
    // 渲染侧持久化 = db.export()（整库序列化）+ 写文件
    const tf = process.hrtime.bigint();
    fs.writeFileSync(dbPath, db.export());
    flushes.push(ms(tf));
  }
  out.steps.insertAll = ms(t0);
  out.steps.insertBatches = flushes.length;
  out.steps.insertPerRow = +(out.steps.insertAll / rows).toFixed(3);
  out.steps.flushTotalMs = flushes.reduce((a, b) => a + b, 0);
  out.steps.flushMaxMs = Math.max(...flushes);
  out.exportBytes = fs.statSync(dbPath).size;

  t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) {
    const m = makeMessage(rows + i, sessionId, 200);
    db.run(INS, [m.id, m.session_id, m.role, m.content, m.reasoning, m.timestamp, m.model, m.status]);
    db.export(); // 每条都整库序列化 —— 这是要证明的放大效应
  }
  out.steps.insertSingles200 = ms(t0);
  out.steps.insertSinglePerRow = +(out.steps.insertSingles200 / 200).toFixed(3);

  const pageLoop = (limit) => {
    let offset = 0;
    let n = 0;
    const t = process.hrtime.bigint();
    for (;;) {
      const st = db.prepare(
        "SELECT id, session_id, role, content, reasoning, timestamp, model, status FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?",
      );
      st.bind([sessionId, limit, offset]);
      let got = 0;
      while (st.step()) {
        st.getAsObject();
        got++;
      }
      st.free();
      n += got;
      if (got === 0) break;
      offset += got;
      if (offset > rows + 1_000_000) throw new Error("分页未收敛");
    }
    return { took: ms(t), n };
  };
  out.steps.readAllPages100 = pageLoop(100);

  t0 = process.hrtime.bigint();
  {
    const st = db.prepare(
      "SELECT id, session_id, role, content, reasoning, timestamp, model, status FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?",
    );
    st.bind([sessionId, 500, 0]);
    while (st.step()) st.getAsObject();
    st.free();
  }
  out.steps.readFirstPage500 = ms(t0);
  out.steps.count = db.exec("SELECT COUNT(*) FROM messages WHERE session_id = ?", [sessionId])[0].values[0][0];
  const pages = Math.ceil(out.steps.readAllPages100.n / 100);
  out.steps.readAllPages100MinusOverhead = out.steps.readAllPages100.took; // 同进程：无每次调用开销
  out.steps.readPerPageMinusOverhead = +(out.steps.readAllPages100.took / Math.max(1, pages)).toFixed(2);

  // 批量改写 10000 条（对应 rust 侧 update_many）
  const updRows = Math.min(rows, 10000);
  t0 = process.hrtime.bigint();
  db.run("BEGIN");
  for (let i = 0; i < updRows; i++) {
    db.run("UPDATE messages SET hidden = 1 WHERE id = ?", [`bench-${String(i).padStart(8, "0")}`]);
  }
  db.run("COMMIT");
  out.steps.updateMany = ms(t0);
  out.steps.updateManyRows = updRows;

  // WASM 堆规模（渲染进程里就是这块内存）
  out.wasmHeapTotalBytes = SQL.HEAPU8 ? SQL.HEAPU8.length : null;
  out.exportBytesAfterUpdate = db.export().length;
  db.close();
  fs.rmSync(dbPath, { force: true });
  return out;
}

const results = [];
for (const rows of SIZES) {
  if (!isMain) break;
  const contentBytes = rows >= 100000 ? 400 : 1200;
  process.stdout.write(`\n[bench] rows=${rows} contentBytes≈${contentBytes}\n`);
  const r1 = await benchRust(rows, contentBytes);
  results.push(r1);
  process.stdout.write(
    `  rust : 写入=${fmt(r1.steps.insertAll)}ms(${r1.steps.insertPerRow}ms/条, ${r1.steps.insertBatches}批)  单条=${r1.steps.insertSinglePerRow}ms/条  全量读=${fmt(r1.steps.readAllPages100.took)}ms(每页${(r1.steps.readAllPages100.took / Math.ceil(r1.steps.readAllPages100.n / 100)).toFixed(1)}ms, 扣启动后每页${r1.steps.readPerPageMinusOverhead}ms)  改写1万=${fmt(r1.steps.updateMany)}ms  文件=${fmt(r1.fileBytes)}B  进程启动=${r1.steps.bareProcessSpawn}ms 调用开销=${r1.steps.cliPerCallOverhead}ms\n`,
  );
  try {
    const r2 = await benchWasm(rows, contentBytes);
    results.push(r2);
    process.stdout.write(
      `  wasm : 写入=${fmt(r2.steps.insertAll)}ms(${r2.steps.insertPerRow}ms/条, ${r2.steps.insertBatches}批)  单条=${r2.steps.insertSinglePerRow}ms/条  全量读=${fmt(r2.steps.readAllPages100.took)}ms(每页${(r2.steps.readAllPages100.took / Math.ceil(r2.steps.readAllPages100.n / 100)).toFixed(1)}ms)  改写1万=${fmt(r2.steps.updateMany)}ms  整库导出=${fmt(r2.exportBytes)}B\n`,
    );
  } catch (e) {
    const msg = String(e.message).split("\n")[0];
    process.stdout.write(`  wasm : **失败**（这正是要证明的问题）：${msg}\n`);
    results.push({ impl: "wasm(sql.js)", rows, contentBytes, error: msg });
  }
}

const summary = results.map((r) => {
  if (r.error) return { impl: r.impl, rows: r.rows, error: r.error };
  const calls = (r.steps.insertBatches ?? 0) + (r.impl === "rust" ? 200 : 0);
  const overheadMs = r.impl === "rust" ? calls * (r.steps.cliPerCallOverhead ?? 0) : 0;
  return {
    impl: r.impl,
    rows: r.rows,
    insertAllMs: r.steps.insertAll,
    insertPerRowMs: r.steps.insertPerRow,
    insertAllMsMinusProcessOverhead:
      r.impl === "rust" ? Math.max(0, r.steps.insertAll - overheadMs) : r.steps.insertAll,
    insertSinglePerRowMs: r.steps.insertSinglePerRow,
      readAllPages100Ms: r.steps.readAllPages100.took,
      readAllPages100PerRowMs: +(r.steps.readAllPages100.took / Math.max(1, r.steps.readAllPages100.n)).toFixed(4),
      readPerPageMs: +(r.steps.readAllPages100.took / Math.max(1, Math.ceil(r.steps.readAllPages100.n / 100))).toFixed(2),
      readAllPages100MinusOverheadMs: Math.round(r.steps.readAllPages100MinusOverhead ?? r.steps.readAllPages100.took),
      readPerPageMinusOverheadMs: r.steps.readPerPageMinusOverhead ?? null,
      updateManyMs: r.steps.updateMany,
      persistedBytes: r.fileBytes ?? r.exportBytes,
      wasmHeapBytes: r.wasmHeapTotalBytes ?? null,
      perCallOverheadMs: r.steps.cliPerCallOverhead ?? 0,
      bareProcessSpawnMs: r.steps.bareProcessSpawn ?? 0,
    };
  });

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cli: CLI,
  rssMbAtEnd: rssMb(),
  notes: [
    "rust 侧每次 invoke 都是一次进程启动 + 打开库（未来 IPC 边界的成本形态）；wasm 侧是同进程调用。",
    "因此 wasm 的『每秒操作数』天然占优，本基准关注的是**随语料规模增长的量级行为**：写入是否 O(1) vs O(语料)、分页是否只读需要的页。",
    "wasm 侧的 schema 是最小可对照结构（3 张表），未包含生产库的全部索引与 FTS 表；其 export 字节数因此偏小，仍足以体现 O(语料) 的放大效应。",
  ],
  results,
  summary,
};

if (isMain) {
  if (!fs.existsSync(CLI)) {
    console.error(`找不到 CLI：${CLI}\n请先运行 npm run db:build`);
    process.exitCode = 1;
  } else {
    fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
    const outFile = path.join(ROOT, "docs", "DB-SCALE-BENCH.json");
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`\n[bench] 报告写入 ${path.relative(ROOT, outFile)}`);
    if (KEEP) console.log(`[bench] 临时库保留在 ${tmpRoot}`);
    else fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

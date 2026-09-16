#!/usr/bin/env node
/**
 * 大文档批处理的**内存**基准：Rust 引擎 vs sql.js(WASM)
 *
 * ## 为什么必须单独测内存
 *
 * `db-scale.mjs` 比的是**耗时**，但历史事故的形态不是"慢"，是
 * `RuntimeError: memory access out of bounds` —— WASM 线性内存是**固定上限**的，
 * 而 sql.js 的两件事会同时顶上去：
 * 1. 整个语料常驻渲染进程堆；
 * 2. `persistDatabase()` 走 `db.export()`，**再复制一整份**数据库字节。
 *
 * 所以判定标准必须是**峰值内存**，不是耗时。这里把两个实现各自放进**子进程**测量：
 * - 子进程里跑真实的"插入 N 条大文档 → 立刻导出/落盘"；
 * - 父进程采样子进程的峰值工作集（Windows `tasklist`，Linux 读 `/proc/<pid>/status`）；
 * - 子进程崩溃/被杀也算结果（`oomOrCrash: true`）—— 那正是要复现的现象。
 *
 * ## 用法
 *
 *   node tools/bench/memory-bound.mjs                 # 默认 2000 条 × 200KB
 *   node tools/bench/memory-bound.mjs --rows 4000 --kb 200
 *   node tools/bench/memory-bound.mjs --only wasm
 *
 * 库文件（tools/ 下的 .mjs）在顶层**不得**有 exit/写盘/长任务这类副作用，
 * 因此一切都在 `main()` 里、并有 `isMain` 守卫。
 */

import { spawn, spawnSync } from "node:child_process";
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
const ROWS = parseInt(argOf("--rows", "2000"), 10);
const KB = parseInt(argOf("--kb", "200"), 10);
const ONLY = argOf("--only", "both");
const KEEP = argv.includes("--keep");

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

const ms = (t0) => +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1);

/** 采样子进程的峰值工作集（KB）。取不到就返回 null（不猜）。 */
function peakRssKb(pid) {
  if (process.platform === "win32") {
    // Windows 的 tasklist 用**千位分隔符**输出内存（"59,384 K"），
    // 所以正则必须允许逗号，取值时再去掉 —— 写成 \d+ 会静默拿到 0。
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
    });
    const m = /"([^"]*?)","(\d+)","[^"]*","\d+","([\d,]+) K"/.exec(r.stdout ?? "");
    return m ? parseInt(m[3].replace(/,/g, ""), 10) : null;
  }
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /VmRSS:\s+(\d+) kB/.exec(s);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/** 跑一个子进程，一边等它结束一边轮询峰值内存 */
function runChild(scriptPath, args, env = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let peak = 0;
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    const timer = setInterval(() => {
      const kb = peakRssKb(child.pid);
      if (kb && kb > peak) peak = kb;
    }, 40);
    child.on("close", (code, signal) => {
      clearInterval(timer);
      const kb = peakRssKb(child.pid);
      if (kb && kb > peak) peak = kb;
      resolve({
        code,
        signal,
        tookMs: ms(t0),
        peakRssKb: peak || null,
        oomOrCrash: code !== 0,
        stdout: out.trim().slice(0, 300),
        // 崩溃时把**首行**错误留下（栈尾全是 node 内部帧，看不出去哪一步挂的）
        stderr: err.trim().split("\n").filter((l) => l.trim() && !/^\s+at /.test(l)).slice(-2).join(" | ").slice(0, 400),
      });
    });
  });
}

function writeWorkerFiles(dir) {
  const wasmWorker = path.join(dir, "wasm-worker.mjs");
  fs.writeFileSync(
    wasmWorker,
    `
import fs from "node:fs";
const [rows, kb, dbPath, sqlJsPath, wasmPath] = process.argv.slice(2);
const N = parseInt(rows, 10), KB = parseInt(kb, 10);
const initSqlJs = (await import("file://" + sqlJsPath.replace(/\\\\/g, "/"))).default;
const SQL = await initSqlJs({ locateFile: () => wasmPath });
const db = new SQL.Database();
db.run(\`CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, timestamp INTEGER NOT NULL, hidden INTEGER DEFAULT 0);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL, message_count INTEGER DEFAULT 0);
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);\`);
db.run("INSERT INTO projects VALUES ('p','基准','',1)");
db.run("INSERT INTO sessions VALUES ('s','p','会话',1,1,0)");
// 一份大文档：KB 级别的正文（真实形态：粘贴进来的长文/代码）
const body = "x".repeat(KB * 1024);
const INS = "INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp, hidden) VALUES (?,?,?,?,?,0)";
for (let i = 0; i < N; i++) db.run(INS, ["m" + i, "s", "user", body, i]);
// 这一步就是历史事故点：整库导出 = 再复制一整份字节
const bytes = db.export();
fs.writeFileSync(dbPath, Buffer.from(bytes));
// 读回来（模拟渲染进程持有语料）
const again = new SQL.Database(bytes);
const r = again.exec("SELECT COUNT(*) FROM messages");
console.log(JSON.stringify({ rows: r[0].values[0][0], fileBytes: bytes.length }));
`,
    "utf8",
  );

  const rustWorker = path.join(dir, "rust-worker.mjs");
  fs.writeFileSync(
    rustWorker,
    `
import { spawnSync } from "node:child_process";
const [rows, kb, dbPath, cliPath] = process.argv.slice(2);
const N = parseInt(rows, 10), KB = parseInt(kb, 10);
const call = (args, stdin) => {
  const r = spawnSync(cliPath, ["--db", dbPath, ...args], { input: stdin, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("CLI 失败: " + String(r.stderr || r.stdout).slice(0, 200));
  return JSON.parse(r.stdout);
};
call(["init"]);
call(["invoke", "projects.upsert", "-"], JSON.stringify({ id: "p", name: "基准", path: "" }));
call(["invoke", "sessions.upsert", "-"], JSON.stringify({ id: "s", project_id: "p", title: "会话", created_at: 1, last_message_at: 1 }));
const body = "x".repeat(KB * 1024);
const batch = 200;
for (let start = 0; start < N; start += batch) {
  const items = [];
  for (let i = start; i < Math.min(start + batch, N); i++) items.push({ id: "m" + i, session_id: "s", role: "user", content: body, timestamp: i });
  call(["invoke", "messages.create_many", "-"], JSON.stringify({ items }));
}
// 分页读**一页**（每页 5 条大文档）：证明"读一页只搬一页"，
// 而不是像 WASM 那样整库导出/整表进堆。返回体体积也要报出来。
const page = call(["invoke", "messages.list", "-"], JSON.stringify({ session_id: "s", limit: 5, offset: 0, include_hidden: true }));
const pageBytes = JSON.stringify(page).length;
// 只回元数据 + 计数，绝不把正文回显到 stdout（那会让"基准自身"变成内存大户）
const counts = call(["counts", "messages"]);
console.log(JSON.stringify({ rows: counts.messages, firstPage: page.result.items.length, pageBytes, perRowBytes: Math.round(pageBytes / 5) }));
`,
    "utf8",
  );
  return { wasmWorker, rustWorker };
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codem-mem-"));
  const workers = writeWorkerFiles(tmpRoot);
  const report = { rows: ROWS, contentKB: KB, totalMB: +((ROWS * KB) / 1024).toFixed(1), impls: {} };

  if (ONLY !== "rust") {
    const dbPath = path.join(tmpRoot, "wasm.bin");
    const r = await runChild(workers.wasmWorker, [String(ROWS), String(KB), dbPath, SQL_JS, WASM]);
    report.impls["wasm(sql.js)"] = {
      ...r,
      dbBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : null,
    };
  }

  if (ONLY !== "wasm") {
    const dbPath = path.join(tmpRoot, "rust.bin");
    const r = await runChild(workers.rustWorker, [String(ROWS), String(KB), dbPath, CLI]);
    report.impls.rust = {
      ...r,
      dbBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : null,
      walBytes: fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0,
    };
  }

  // 结论表
  console.log(`\n# 大文档批处理内存基准 —— ${ROWS} 条 × ${KB}KB = ${report.totalMB}MB 正文\n`);
  const rows = [];
  for (const [name, v] of Object.entries(report.impls)) {
    rows.push({
      实现: name,
      峰值内存MB: v.peakRssKb ? +(v.peakRssKb / 1024).toFixed(0) : "取样失败",
      崩溃: v.oomOrCrash ? "是" : "否",
      耗时s: +(v.tookMs / 1000).toFixed(1),
      库文件MB: v.dbBytes ? +(v.dbBytes / 1048576).toFixed(1) : "-",
      WAL_MB: v.walBytes ? +(v.walBytes / 1048576).toFixed(1) : 0,
    });
  }
  const keys = Object.keys(rows[0] ?? {});
  console.log(`| ${keys.join(" | ")} |`);
  console.log(`|${keys.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| ${keys.map((k) => r[k]).join(" | ")} |`);
  for (const [name, v] of Object.entries(report.impls)) {
    console.log(`\n${name}: ${v.stdout || "(无输出)"}`);
    if (v.oomOrCrash) console.log(`  ⚠ 退出码 ${v.code}${v.signal ? ` / 信号 ${v.signal}` : ""}: ${v.stderr}`);
  }

  if (!KEEP) fs.rmSync(tmpRoot, { recursive: true, force: true });
  else console.log(`\n临时目录保留：${tmpRoot}`);
  return report;
}

if (isMain) {
  main().catch((e) => {
    console.error("基准失败：", e?.message ?? e);
    process.exitCode = 1;
  });
}

export { main };

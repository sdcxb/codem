#!/usr/bin/env node
/**
 * 规模基准：Rust 引擎（codem-db-cli）
 *
 * ## 历史上的对比基线已经不存在了（本轮修改，这一段是重点）
 *
 * 这个基准原来同时压两个实现：
 * - **rust**：codem-db-cli（生产实现：原生 sqlite3 + WAL 页级增量落盘）
 * - **wasm**：渲染侧当时真实使用的 sql.js（`db.exec/run` + `db.export()` 整库序列化落盘）
 *
 * 「删掉渲染进程里的 sql.js 引擎」（L1）之后，`node_modules` 下的 **sql.js 包已经不在工程里**，
 * 于是那段基线只剩一个**必定失败**的 `import`；更糟的是它的 catch 分支会打印
 * `wasm : **失败**（这正是要证明的问题）` —— 也就是说：
 * **「依赖不存在」会被读成「我们证明了 wasm 更差」**。
 * 那是最坏的一种结论形态：数据不支持，文案却在暗示它支持。
 * 所以这里把 wasm 那一侧**整段删掉**，只保留 Rust 侧的档位与指标。
 *
 * 历史数字仍在 `docs/DB-SCALE-BENCH.json`（**保留**：它是历史记录，本基准不再默认覆盖它）。
 * 本基准默认写到 `.preview-shot/DB-SCALE-BENCH.json`（该目录已 gitignore），
 * 要更新历史文件得显式 `--out docs/DB-SCALE-BENCH.json`。
 *
 * ## 现在测什么
 *
 * "批量大文档必须非常强"这个判定标准没变，只是没有第二个实现可比了，所以看的是
 * **随语料规模增长的量级行为**：
 * - 每条写入是否 O(1)（WAL 页级落盘）还是随语料放大；
 * - 分页是否只读需要的页（走索引），以及**每次 CLI 调用的固定开销**（进程启动 + 打开库）
 *   在总耗时里占多少 —— 后者正是未来 IPC 边界的成本形态。
 *
 * ⚠️ 文案提示：这里刻意写「`node_modules` 下的 sql.js 包」而不是那条字面路径
 * （`node_modules` + 斜杠 + 包名）。验收门禁会全文 grep 那条字面路径，工程里除了
 * "某处仍在 import 它"这种真命中之外，不该再出现它 —— 说明性文字也算命中，会淹掉真信号。
 *
 * 所以：
 * 1. 先单独测出 `cliPerCallOverhead`（一条只读 `counts` 的往返耗时中位数）与
 *    `bareProcessSpawn`（只 `--help`，不打开库）；
 * 2. 报告里同时给出**含开销**与**扣除开销**的解读，并把每次操作的平均耗时列出来；
 * 3. 关注量级差异，而不是零点几毫秒。
 *
 * 用法：
 *   node tools/bench/db-scale.mjs                      # 默认 1k / 10k / 100k
 *   node tools/bench/db-scale.mjs --rows 1000,10000
 *   node tools/bench/db-scale.mjs --out .preview-shot/my-bench.json   # 显式指定报告路径
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

/**
 * 报告落点。
 *
 * ⚠️ 这里曾经硬编码 `docs/DB-SCALE-BENCH.json`，那是**被 git 跟踪**的文件：
 * 跑一次基准就改动仓库内容，于是"跑个基准"会在 `git status` 里混进一个 8 KB 的 diff，
 * 还容易被人顺手提交。默认改成已 gitignore 的 `.preview-shot/`，
 * 需要更新历史文件时显式 `--out`。
 */
const DEFAULT_OUT = path.join(ROOT, ".preview-shot", "DB-SCALE-BENCH.json");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const KEEP = argv.includes("--keep");
const OUT = path.resolve(process.cwd(), argOf("--out", DEFAULT_OUT));
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
}

const summary = results.map((r) => {
  const calls = (r.steps.insertBatches ?? 0) + 200;
  const overheadMs = calls * (r.steps.cliPerCallOverhead ?? 0);
  return {
    impl: r.impl,
    rows: r.rows,
    insertAllMs: r.steps.insertAll,
    insertPerRowMs: r.steps.insertPerRow,
    insertAllMsMinusProcessOverhead: Math.max(0, r.steps.insertAll - overheadMs),
    insertSinglePerRowMs: r.steps.insertSinglePerRow,
    readAllPages100Ms: r.steps.readAllPages100.took,
    readAllPages100PerRowMs: +(r.steps.readAllPages100.took / Math.max(1, r.steps.readAllPages100.n)).toFixed(4),
    readPerPageMs: +(r.steps.readAllPages100.took / Math.max(1, Math.ceil(r.steps.readAllPages100.n / 100))).toFixed(2),
    readAllPages100MinusOverheadMs: Math.round(r.steps.readAllPages100MinusOverhead ?? r.steps.readAllPages100.took),
    readPerPageMinusOverheadMs: r.steps.readPerPageMinusOverhead ?? null,
    updateManyMs: r.steps.updateMany,
    persistedBytes: r.fileBytes,
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
    "历史上这里同时压 rust 与 wasm(sql.js) 两个实现；sql.js 已随 L1 从工程里删除，所以只剩 Rust 一侧。",
    "历史对比数字仍保留在 docs/DB-SCALE-BENCH.json（本基准不再默认覆盖它）。",
    "rust 侧每次 invoke 都是一次进程启动 + 打开库（未来 IPC 边界的成本形态）；报告同时给出「扣除每次调用固定开销」后的读成本。",
    "关注随语料规模增长的量级行为（写入是否 O(1)、分页是否只读需要的页），而不是零点几毫秒的差异。",
  ],
  results,
  summary,
};

if (isMain) {
  if (!fs.existsSync(CLI)) {
    console.error(`找不到 CLI：${CLI}\n请先运行 npm run db:build`);
    process.exitCode = 1;
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\n[bench] 报告写入 ${path.relative(ROOT, OUT)}`);
    if (KEEP) console.log(`[bench] 临时库保留在 ${tmpRoot}`);
    else fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

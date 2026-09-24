/**
 * 冷启动 / 稳态基准（第 124 轮，O-7 口径补强）：**N 次取中位数**，绝不拿单次读数当基线。
 *
 * ## 为什么必须 N 次
 *
 * 第 120 轮第一次量到 JS 堆 **109MB**，差点写成"2.6 倍内存回归"；连跑五次才看清它是离群值
 * （109 / 41 / 49 / 49 / 49）—— `performance.memory.usedJSHeapSize` 在不强制 GC 时由"还没回收的垃圾"主导，
 * 而启动阶段正是垃圾最多的时候。**单次读数不算基线**这条写进了 GAP-LIST，这个工具就是它的落地。
 *
 * ## 口径
 *
 * - 默认 **3 次**（`--runs N` 可调），每次都是"杀干净 → 带 CDP 拉起 → 等界面有内容 → 静置 → 读数"；
 * - 报 **中位数 + 最小/最大**（离散度一起报，避免用中位数掩盖抖动）；
 * - `--baseline tools/bench/coldstart-baseline.json`：有基线时**对比中位数**，超过阈值倍数则退出码 1；
 * - `--write-baseline`：把本次中位数写进基线（**只允许在阈值内收紧/记录**，由人审）。
 *
 * 会重启用户的窗口；结束**不自动重启**（由调用方决定）。
 *
 * 用法：
 *   node tools/bench/coldstart-median.mjs                       # 量一次（3 轮）
 *   node tools/bench/coldstart-median.mjs --runs 5 --write-baseline
 *   node tools/bench/coldstart-median.mjs --baseline tools/bench/coldstart-baseline.json
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const RUNS = Number(argOf("--runs", "3"));
const SETTLE = Number(argOf("--settle", "25"));
const BASELINE = argOf("--baseline", "tools/bench/coldstart-baseline.json");
const WRITE = args.includes("--write-baseline");
const GC = !args.includes("--no-gc"); // 第 126 轮：读之前强制一次 GC（默认开；要对比"不 GC 的口径"加 --no-gc）
const EXE = `${process.env.LOCALAPPDATA}\\Codem\\codem.exe`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const kill = () => {
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process codem -ErrorAction SilentlyContinue | Stop-Process -Force"], { encoding: "utf8" });
  } catch {
    /* 没进程也算正常 */
  }
};

async function oneRun(runIndex) {
  kill();
  await sleep(3000);
  const t0 = Date.now();
  const child = spawn(EXE, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" } });
  child.unref();
  let list = [];
  while (Date.now() - t0 < 60000) {
    try {
      list = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {
      list = [];
    }
    if (list.length) break;
    await sleep(200);
  }
  const spawnToTargetMs = Date.now() - t0;
  if (!list.length) throw new Error(`第 ${runIndex} 轮：60 秒内没有 CDP 目标`);
  const { connect } = await import("../../.preview-shot/audit-walk-lib.mjs");
  const cdp = await connect();
  const { evaluate, consoleRec, mark, sliceSince, sleep: cs } = cdp;
  const m = mark();
  let spawnToReadyMs = null;
  while (Date.now() - t0 < 90000) {
    const ready = await evaluate(`(() => { const r = document.querySelector('#root'); return !!r && r.children.length > 0 && (document.body.innerText || '').trim().length > 20; })()`);
    if (ready) {
      spawnToReadyMs = Date.now() - t0;
      break;
    }
    await cs(200);
  }
  await cs(SETTLE * 1000);
  /*
   * 第 126 轮：**读之前先强制一次 GC**。
   * 第 124 轮量到同一个构建的 JS 堆离散 49–73MB（历史区间 41–109）—— 这个数字由"还没回收的垃圾"主导，
   * 而启动阶段正是垃圾最多的时候 ⇒ 不 GC 就在量垃圾，不是在量占用。
   * 默认开；要对比"不 GC 的口径"加 --no-gc。
   */
  let gcOk = null;
  if (GC) {
    try {
      await cdp.send("HeapProfiler.enable", {});
      await cdp.send("HeapProfiler.collectGarbage", {});
      gcOk = true;
      await cs(400);
    } catch (e) {
      gcOk = false;
      console.log(`  （第 ${runIndex} 轮：强制 GC 失败，读数仍是"含垃圾"口径：${String(e).slice(0, 80)}）`);
    }
  }
  const during = sliceSince(m);
  const jsHeapMB = await evaluate(`(performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)`);
  const domNodes = await evaluate(`document.querySelectorAll('*').length`);
  await cdp.close?.();
  return { run: runIndex, spawnToTargetMs, spawnToReadyMs, jsHeapMB, domNodes, gc: gcOk, console: { error: during.error ?? 0, warning: during.warning ?? 0, exception: during.exception ?? 0 } };
}

const runs = [];
for (let i = 1; i <= RUNS; i += 1) {
  const r = await oneRun(i);
  runs.push(r);
  console.log(`第 ${i} 轮：拉起→目标 ${r.spawnToTargetMs}ms、→界面 ${r.spawnToReadyMs}ms、JS 堆 ${r.jsHeapMB}MB、DOM ${r.domNodes}、控制台 ${r.console.error}/${r.console.warning}/${r.console.exception}`);
}

const summary = {
  version: execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item '${EXE}').VersionInfo.ProductVersion`], { encoding: "utf8" }).trim(),
  runs: RUNS,
  settleSeconds: SETTLE,
  measuredAt: new Date().toISOString(),
  median: {
    spawnToTargetMs: median(runs.map((r) => r.spawnToTargetMs)),
    spawnToReadyMs: median(runs.map((r) => r.spawnToReadyMs)),
    jsHeapMB: median(runs.map((r) => r.jsHeapMB)),
    domNodes: median(runs.map((r) => r.domNodes)),
  },
  spread: {
    jsHeapMB: [Math.min(...runs.map((r) => r.jsHeapMB)), Math.max(...runs.map((r) => r.jsHeapMB))],
    spawnToReadyMs: [Math.min(...runs.map((r) => r.spawnToReadyMs)), Math.max(...runs.map((r) => r.spawnToReadyMs))],
  },
  consoleTotals: runs.reduce((s, r) => ({ error: s.error + r.console.error, warning: s.warning + r.console.warning, exception: s.exception + r.console.exception }), { error: 0, warning: 0, exception: 0 }),
  runsDetail: runs,
};
console.log("\n" + JSON.stringify({ median: summary.median, spread: summary.spread, consoleTotals: summary.consoleTotals }, null, 1));

if (WRITE) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(`基线已写入 ${BASELINE}`);
  process.exit(0);
}

if (fs.existsSync(BASELINE)) {
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const problems = [];
  const cmp = (key, factor, label) => {
    const now = summary.median[key];
    const want = base.median[key];
    if (now > want * factor) problems.push(`${label}：中位数 ${want} → ${now}（超过 ${factor} 倍阈值）`);
  };
  cmp("jsHeapMB", 1.5, "冷启动稳态 JS 堆");
  cmp("spawnToReadyMs", 2, "拉起→界面可读");
  if (summary.consoleTotals.error > 0 || summary.consoleTotals.exception > 0) {
    problems.push(`控制台 error/exception 合计 ${summary.consoleTotals.error}/${summary.consoleTotals.exception}（期望 0）`);
  }
  console.log(`\n对比基线（${base.measuredAt?.slice(0, 10)}，版本 ${base.version}）：`);
  console.log(`  JS 堆 中位数 ${base.median.jsHeapMB} → ${summary.median.jsHeapMB}MB`);
  console.log(`  拉起→界面 中位数 ${base.median.spawnToReadyMs} → ${summary.median.spawnToReadyMs}ms`);
  if (problems.length) {
    console.log("\n❌ 超阈值：");
    for (const p of problems) console.log(`   - ${p}`);
    process.exit(1);
  }
  console.log("✅ 在阈值内");
} else {
  console.log(`\n（没有基线文件 ${BASELINE}；要记录就加 --write-baseline）`);
}

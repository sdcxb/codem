#!/usr/bin/env node
/**
 * 全仓扫描：**生产模块**里"还在直接读旧库、且完全没有接端口"的文件。
 *
 * ## 为什么需要这道门禁（它是被一次真机事故逼出来的）
 *
 * P5 第 4 段把启动路径改成"引擎为 rust 时不加载 WASM 库"之后，真机复验发现
 * `core/storage/session.ts` **一个端口调用都没有** —— 创建会话、改标题、置顶、
 * 删除、fork、拖拽排序全都还在打旧库。旧库不加载之后，这些操作会直接失败，
 * 而这是最核心的一条用户路径。
 *
 * 关键点：**完整测试套件当时是全绿的**（5192 项通过）。原因是那些测试自己
 * `initDatabase()` 起一个 WASM 库，于是模块的旧路径"看起来正常工作"。
 * 单元测试**结构上**看不见"这个模块在生产启动路径下会没有库可用"。
 *
 * 所以这道门禁做的事很简单，但正是测试探测不到的那一半：
 * 看**模块层面的接线**，而不是运行结果。
 *
 * ## 规则（刻意保守，避免噪声）
 *
 * 一个生产模块如果满足**全部**下列条件，就记为"未接线":
 *   1. 调用 `getDatabase()` **≥ 2 次**（1 次的多半只是回退分支，噪声太大）；
 *   2. 完全没有 `domainRead*` / `domainWrite` / `domainDelete*` / `domainOr` /
 *      `hasStoragePort` / `getStoragePort` 这些端口符号。
 *
 * 允许清单里的文件必须是**明确的**、并写明理由 —— 不允许"因为现在通过"就放进去。
 *
 * 用法：
 *   node tools/audit/scan-unrouted-db.mjs            # 人类可读
 *   node tools/audit/scan-unrouted-db.mjs --json     # 机器可读
 *   node tools/audit/scan-unrouted-db.mjs --check    # 门禁：有新增即 exit 1
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");

/**
 * 允许清单：**每一条都要能说清"为什么它不该被要求接端口"**。
 *
 * 不加"数量上限"式的软规则 —— 那样只会让清单慢慢膨胀而没人看。
 */
const ALLOWLIST = {
  "core/storage/database.ts": "它自己就是旧库实现（查询引擎本体）",
  "core/storage/bootstrap.ts": "它负责判定用哪个引擎（在决定之前必然要能拿到旧库句柄）",
  "core/storage/session-log-bridge.ts": "只在端口不可用时回退；主路径已走 messages.rebuild_index",
  "components/PerformanceDashboard.tsx": "只有一处「端口未接手」的回退分支（clearAll 返回 null 时）",
};

/** 端口符号：出现任意一个就算"已接线" */
const PORT_SYMBOLS = [
  "domainRead",
  "domainWrite",
  "domainDelete",
  "domainOr",
  "domainPort",
  "hasStoragePort",
  "getStoragePort",
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

export function scan() {
  const files = walk(SRC);
  const findings = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    if (rel.startsWith("src/test/")) continue;
    const text = fs.readFileSync(file, "utf8");
    const dbCalls = (text.match(/getDatabase\(\)/g) ?? []).length;
    if (dbCalls < 2) continue;
    const wired = PORT_SYMBOLS.some((s) => text.includes(s));
    if (wired) continue;
    findings.push({ file: rel, dbCalls, allowed: rel in ALLOWLIST ? ALLOWLIST[rel] : null });
  }
  return { scanned: files.length, findings };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const result = scan();
  const unexpected = result.findings.filter((f) => !f.allowed);

  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`未接线扫描：检查 ${result.scanned} 个生产文件`);
    console.log(`  getDatabase() ≥2 次且无端口符号：${result.findings.length}`);
    for (const f of result.findings) {
      console.log(`    ${f.allowed ? "·" : "✗"} ${f.file}（getDatabase ${f.dbCalls} 次）${f.allowed ? ` — ${f.allowed}` : ""}`);
    }
  }

  if (argv.includes("--check")) {
    if (unexpected.length > 0) {
      console.error(
        `\n❌ 发现 ${unexpected.length} 个「还在直接读旧库、且没接端口」的生产模块：\n` +
          unexpected.map((f) => `   ${f.file}（getDatabase ${f.dbCalls} 次）`).join("\n") +
          `\n\n修法二选一：\n` +
          `  1) 把它接到域端口（domainRead*/domainWrite/domainDelete*）；\n` +
          `  2) 若确实不该接，加进本文件的 ALLOWLIST **并写明理由**。\n` +
          `\n背景：这类模块在"引擎为 rust、不加载 WASM 库"的启动路径下会整体失效，\n` +
          `而单元测试因为自己起了 WASM 库，**结构上**看不见这个问题（踩过一次）。`,
      );
      process.exit(1);
    }
    console.log("✅ 没有未接线的生产模块（允许清单内的条目均写明理由）");
  }
}

export { ALLOWLIST };

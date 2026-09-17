#!/usr/bin/env node
/**
 * **"WASM 引擎可删除性"评估**（第 27 轮）。
 *
 * ## 为什么需要它
 *
 * 目标是"渲染进程不再持有 WASM 数据库"。现在默认已经不加载了，但**代码与依赖都还在** ——
 * 也就是说这件事只完成了一半。要往下走，得先知道**到底是什么挡住了删除**，
 * 而不是凭印象猜"大概还有几十处"。
 *
 * 这个脚本按"阻挡层级"分类列出全部残留，并给出每类的处理代价：
 *
 * - **L1 依赖**：`sql.js` 的 import / wasm 资源引用；
 * - **L2 引擎本体**：`database.ts` 里那套 sql.js 建库/导出/落盘逻辑；
 * - **L3 回退分支**：各模块里"端口没接手就回退旧库"的第二条路径
 *   （`const db = getDatabase()` 之后紧跟旧库调用的形态）；
 * - **L4 开关与引导**：`DEFAULT_ENGINE` / 回滚开关 / 启动时的引擎选择。
 *
 * 用法：
 *   node tools/audit/wasm-removal-readiness.mjs           # 人类可读
 *   node tools/audit/wasm-removal-readiness.mjs --json    # 机器可读
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(p);
    }
  }
  return acc;
}

export function assess() {
  const files = walk(SRC);
  const prod = files.filter((f) => !f.includes(`${path.sep}test${path.sep}`));

  const l1 = []; // 依赖引用
  const l2 = []; // 引擎本体
  const l3 = []; // 回退分支（按文件聚合）
  const l4 = []; // 开关 / 引导

  for (const abs of prod) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    const text = fs.readFileSync(abs, "utf8");

    // L1：sql.js 依赖与 wasm 资源
    for (const m of text.matchAll(/from\s+["']sql\.js[^"']*["']/g)) {
      l1.push({ file: rel, what: m[0] });
    }
    if (/sql-wasm\.wasm/.test(text)) l1.push({ file: rel, what: "sql-wasm.wasm 资源引用" });

    // L2：引擎本体（只有 database.ts 该有）
    //
    // ⚠️ 判定前先**剥掉注释**：注释里提到 "sql.js"（例如"不再依赖 sql.js"）不是真的 API 引用。
    // 实测踩到：我自己写的一句注释让这个扫描器报了假阳性，而假阳性会让这份清单失去可信度。
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    if (/\binitSqlJs\b|\bSqlJsDatabase\b/.test(code) && rel !== "src/core/storage/database.ts" && rel !== "src/types/sql.js.d.ts") {
      l2.push({ file: rel, what: "引用了 sql.js API（应只出现在 database.ts）" });
    }

    // L3：回退分支 —— 端口判断之后的旧库调用
    //
    // ⚠️ 与 L2 同样的教训：**必须剥掉注释再计数**。
    // 实测踩到两次：我在注释里写"原来的旧库读取会抛错"，扫描器就把注释里的函数名
    // 当成一处真实回退 —— 于是"改了代码但清单数字反而涨了"。
    // 这份清单是后续 20+ 轮的主要进度指标，假数字会让整个判断失真。
    //
    // 另加指标 `gated`：这些旧库调用里有多少处已被
    // `shouldFallbackToLegacy()` / `writeShouldFallBackToLegacy()` 门控
    // （即 B 态下不会执行）。字面量要等回滚开关退役才清零，`gated` 才反映真实进度。
    const dbCalls = (code.match(/getDatabase\(\)/g) ?? []).length;
    const portSymbols = (code.match(/domainRead|domainWrite|domainDelete|domainOr|hasStoragePort|getStoragePort|tryGetDatabase|shouldFallbackToLegacy|writeShouldFallBackToLegacy|domainPortRegistered|domainEnsureLoaded/g) ?? []).length;
    const gated = (code.match(/shouldFallbackToLegacy\(\)|writeShouldFallBackToLegacy\(/g) ?? []).length;
    /**
     * ⚠️ **L3 口径的已知盲区**（第 17 轮实测）：有些文件不用
     * `if (!shouldFallbackToLegacy()) …; const db = getDatabase();` 这个形态，而是
     * `const db = tryGetDatabase(); if (!db) return X;` —— 语义同样是"端口没接手就回退旧库"，
     * 但**一个字面量都不落在 L3 计数器里**（实测：`prompt-draft.ts` 6 处、`session.ts` 9 处）。
     * 所以这里单列一列，避免"清单没动 = 没干活"这种误判。
     */
    const tryNull = (code.match(/tryGetDatabase\(\)/g) ?? []).length;
    if ((dbCalls > 0 || tryNull > 0) && portSymbols > 0 && rel !== "src/core/storage/database.ts") {
      l3.push({ file: rel, dbCalls, portSymbols, gated, tryNull });
    }

    // L4：开关与引导
    if (/DEFAULT_ENGINE|STORAGE_ENGINE_KEY|selectedEngine/.test(text)) {
      l4.push({ file: rel });
    }
  }

  return {
    scanned: prod.length,
    L1_dependency: l1,
    L2_engineBody: l2,
    L3_fallbackBranches: l3.sort((a, b) => b.dbCalls - a.dbCalls),
    L4_switch: l4,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const r = assess();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`WASM 可删除性评估：扫描 ${r.scanned} 个生产文件\n`);
    console.log(`L1 依赖引用（${r.L1_dependency.length}）—— 删依赖前必须清零`);
    for (const x of r.L1_dependency) console.log(`   ${x.file}: ${x.what}`);
    console.log(`\nL2 引擎本体外泄（${r.L2_engineBody.length}）—— 应为 0（sql.js 只许出现在 database.ts）`);
    for (const x of r.L2_engineBody) console.log(`   ${x.file}: ${x.what}`);
    const l3Total = r.L3_fallbackBranches.reduce((n, x) => n + x.dbCalls, 0);
const l3Gated = r.L3_fallbackBranches.reduce((n, x) => n + (x.gated ?? 0), 0);
const l3TryNull = r.L3_fallbackBranches.reduce((n, x) => n + (x.tryNull ?? 0), 0);
console.log(`\nL3 回退分支（${r.L3_fallbackBranches.length} 个文件 / ${l3Total} 处旧库调用，其中 ${l3Gated} 处已门控）—— 字面量要等回滚开关退役才清零，gate 计数才反映真实进度`);
    console.log(`   ⚠️ 另有 ${l3TryNull} 处走 tryGetDatabase() 判空回退（同一语义，不落在这个字面量口径里，别当成没干活）`);
    for (const x of r.L3_fallbackBranches) {
      console.log(`   ${String(x.dbCalls).padStart(2)} 处旧库调用 · 已门控 ${String(x.gated ?? 0).padStart(2)} · tryGet ${String(x.tryNull ?? 0).padStart(2)} · 端口符号 ${x.portSymbols} · ${x.file}`);
    }
    console.log(`\nL4 引擎开关 / 引导（${r.L4_switch.length}）`);
    for (const x of r.L4_switch) console.log(`   ${x.file}`);
  }
}

export { walk };

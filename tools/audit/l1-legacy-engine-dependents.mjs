#!/usr/bin/env node
/**
 * **L1（删 sql.js）依赖面测量**（第 17 轮）。
 *
 * ## 为什么需要它
 *
 * `wasm-removal-readiness.mjs` 只扫**生产文件**，它的 L1 只看"还有没有
 * `from "sql.js"` 与 `sql-wasm.wasm` 引用"。但真正决定"能不能删掉这个依赖"的，
 * 不是那两行 import，而是**谁还在用旧引擎的 API**：
 *
 * - 生产侧：还 import `getDatabase` / `tryGetDatabase` / `persistDatabase` 的模块
 *   （L3 分支删完后应全部消失）；
 * - 测试侧：`src/test/**` 里直接 `initDatabase()` / `getDatabase()` 并跑**裸 SQL**
 *   的用例 —— 这些用例把旧库当**夹具**（fixture）。删引擎会让它们全红，
 *   而在删之前必须先把它们分成两类：
 *
 *   | 类 | 特征 | 处置 |
 *   | --- | --- | --- |
 *   | **删** | 断言的是**旧引擎自身**的语义（OOM 防御、致命闩锁、整库导出上限、保存失败可见性、损坏恢复、`runGuarded` 静默空写探测） | 与引擎**一起删**：它们覆盖的组件不再存在，等价覆盖在 Rust 侧（`codem-db` 的 101 条测试） |
 *   | **迁** | 把旧库当**夹具**用（裸 SQL 塞几行，再断言产品行为） | 改成端口播种（`crud.upsert`），断言不动 |
 *
 * 这份清单就是 L1 的工作量，也是"删引擎"这件事的**前置条件**：数字不降到 0，
 * 删掉的就不是死代码，而是别人正在用的东西。
 *
 * ## 判定口径（防假数字）
 *
 * - **剥注释**：与 `wasm-removal-readiness.mjs` 同样的教训 —— 注释里提到 `getDatabase`
 *   不是一处调用。实测踩过：注释让清单数字"改了代码反而涨"。
 * - 区分**符号 import**（这行 import 会不会在删引擎时炸）与**真实调用点**。
 * - `fake-storage-port.ts` / `setup.ts` 单独标注：它们是**基座**，不是用例。
 *
 * 用法：
 *   node tools/audit/l1-legacy-engine-dependents.mjs           # 人类可读
 *   node tools/audit/l1-legacy-engine-dependents.mjs --json    # 机器可读
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const TEST_DIR = path.join(SRC, "test");

/** 旧引擎（`src/core/storage/database.ts`）的 API 名 —— 删引擎会一起消失的符号。 */
const ENGINE_SYMBOLS = [
  "initDatabase",
  "resetDatabase",
  "getDatabase",
  "tryGetDatabase",
  "persistDatabase",
  "flushDatabase",
  "exportDatabase",
  "importDatabase",
  "closeDatabase",
  "isFts5Available",
  "getDatabaseEngine",
  "__installFatalGuardForTests",
  "isWholeFileExportSuspended",
];

/** 只服务旧引擎测试基建（不直接返回 DB 句柄）的符号。 */
const ENGINE_INFRA_SYMBOLS = [
  "resetDatabaseFatalState",
  "resetSaveFailureState",
  "isDatabaseFatal",
  "isLastSaveFailed",
  "indexRebuildNeeded",
  "clearIndexRebuildMarker",
  "isCompactionInProgress",
  "setCompactionInProgress",
  "noteDatabaseError",
  "isFatalDbError",
  "encodeBytesToBase64",
  "__resetDirtyForTests",
];

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

/** 剥掉注释（块注释 + 行注释）—— 注释里的名字不是引用。 */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * 剥掉**字符串/模板字面量**（第 18 轮补）。
 *
 * 为什么需要：`src/test/audit-gates.test.ts` 这类**扫描器夹具**会把
 * `import { getDatabase } from "../core/storage/database";` 当作**样本字符串**写进临时文件，
 * 用来验证门禁规则本身能咬到它。不剥字符串时，本脚本会把样本当成真实 import ——
 * 实测就是这么一个假阳性（清单里长期挂着一个"用旧引擎 API"的文件，实际它一行都不用）。
 */
export function stripStringLiterals(text) {
  return text
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/**
 * ⚠️ 第 18 轮补上的**漏网形态**（实测漏掉了 `src/core/llm/tool-pipeline.ts` 与 App.tsx 的两处监听）：
 *
 * 1. **动态 import**：`const { isDatabaseFatal } = await import("../storage/database")`
 *    —— 只匹配静态 import 的正则完全看不见它；
 * 2. **经 `storage/index.ts` 再导出**：`import { getDatabase } from "../storage"`
 *    —— 路径里没有 `database` 字样，按路径匹配同样漏掉；
 * 3. **事件名字面量**：`window.addEventListener("codem:db-fatal", …)` 消费的是引擎模块的语义，
 *    却一个符号都不 import。这类"间接依赖"按字面量兜（见 ENGINE_EVENT_LITERALS）。
 */
const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']*storage\/database["']|import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']\.\/database["']/g;
const DYNAMIC_IMPORT_RE = /(?:await\s+)?import\s*\(\s*["'](?:[^"']*\/)?(?:database|storage)["']\s*\)[^\n]*|\{\s*([A-Za-z_$][\w$]*)[^}]*\}\s*=\s*await\s+import\s*\(\s*["'][^"']*(?:database|storage)["']/g;
const ENGINE_EVENT_LITERALS = ["codem:db-fatal", "codem:db-save-failed", "codem:db-save-recovered"];

function importedEngineSymbols(code) {
  const found = new Set();
  for (const m of code.matchAll(IMPORT_RE)) {
    const list = (m[1] ?? m[2] ?? "").split(",");
    for (const raw of list) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (ENGINE_SYMBOLS.includes(name) || ENGINE_INFRA_SYMBOLS.includes(name)) found.add(name);
    }
  }
  // 动态 import：`const { a, b } = await import("…/database")`
  for (const m of code.matchAll(/\{\s*([^}]*)\}\s*=\s*await\s+import\s*\(\s*["'][^"']*(?:database|storage)["']/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/[\s:]+/)[0].trim();
      if (!name) continue;
      if (ENGINE_SYMBOLS.includes(name) || ENGINE_INFRA_SYMBOLS.includes(name)) found.add(name);
    }
  }
  return [...found].sort();
}

function callCount(code, name) {
  // 排除 `tryGetDatabase(` 被 `getDatabase(` 的正则命中
  const re = new RegExp(`(?<![\\w$])${name}\\s*\\(`, "g");
  return (code.match(re) ?? []).length;
}

/**
 * **扫描器夹具白名单**（第 18 轮）。
 *
 * `src/test/audit-gates.test.ts` 会把"含 `getDatabase()` / `import { getDatabase } from "./database"`
 * 的**样本源码字符串**写进临时目录，用来验证门禁规则本身能不能咬到它 —— 文件里**没有任何真实调用**。
 * 任何按文本扫的脚本都会被它骗到（实测它长期挂在"用旧引擎 API 的文件"清单里）。
 *
 * 这类误报的代价不是"多一条噪音"，而是**清单失去可信度**：清理引擎时你会去改一个本来就没问题的文件。
 * 所以这里显式列出并写明理由 —— 宁可白名单，也不要让脚本去猜"这段文本是不是代码"。
 */
const SCANNER_FIXTURE_FILES = new Set(["src/test/audit-gates.test.ts"]);

export function assess() {
  const files = walk(SRC);
  const prodFiles = files.filter((f) => !f.includes(`${path.sep}test${path.sep}`));
  const testFiles = files.filter((f) => f.includes(`${path.sep}test${path.sep}`));

  const prod = [];
  const idiom = { gated: 0, tryNull: 0, raw: 0 };
  const rawSites = [];
  for (const abs of prodFiles) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    if (SCANNER_FIXTURE_FILES.has(rel)) continue;
    const isEngine = rel === "src/core/storage/database.ts"; // 引擎自身
    const rawLines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    const code = stripComments(rawLines.join("\n"));
    const syms = isEngine ? [] : importedEngineSymbols(code);
    /** 事件名字面量依赖（`codem:db-fatal` 等）—— 一个符号都不 import 的间接依赖。⚠️ 只看代码，注释里提到不算 */
    const eventDeps = isEngine ? [] : ENGINE_EVENT_LITERALS.filter((ev) => code.includes(ev));

    // 逐站点分类（只看代码行，注释行跳过）
    const codeLines = stripComments(rawLines.join("\n")).split("\n");
    let gated = 0;
    let tryNull = 0;
    let raw = 0;
    for (let i = 0; i < codeLines.length; i++) {
      const line = codeLines[i];
      if (/\btryGetDatabase\s*\(/.test(line)) {
        tryNull++;
        continue;
      }
      if (!/getDatabase\(\)/.test(line)) continue;
      // 往上找最近的非空行：是门控 → 已门控，否则是"裸调用"
      let prev = "";
      for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
        if (codeLines[k].trim() !== "") {
          prev = codeLines[k];
          break;
        }
      }
      if (/shouldFallbackToLegacy|writeShouldFallBackToLegacy/.test(prev)) gated++;
      else {
        raw++;
        if (!isEngine) rawSites.push({ file: rel, line: i + 1, text: line.trim().slice(0, 100), prev: prev.trim().slice(0, 100) });
      }
    }

    if (syms.length === 0 && raw === 0 && tryNull === 0 && gated === 0 && (eventDeps?.length ?? 0) === 0) continue;
    const calls = {};
    for (const s of syms) {
      const n = callCount(code, s);
      if (n > 0) calls[s] = n;
    }
    prod.push({ file: rel, isEngine, imports: syms, eventDeps, calls, idiom: { gated, tryNull, raw } });
    if (!isEngine) {
      idiom.gated += gated;
      idiom.tryNull += tryNull;
      idiom.raw += raw;
    }
  }
  const totalCalls = (p) => Object.values(p.calls).reduce((x, y) => x + y, 0);
  prod.sort((a, b) => totalCalls(b) - totalCalls(a));


  const tests = [];
  for (const abs of testFiles) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    if (SCANNER_FIXTURE_FILES.has(rel)) continue; // 扫描器夹具（样本字符串，不是真实调用）
    const base = path.basename(abs);
    const code = stripComments(fs.readFileSync(abs, "utf8"));
    const syms = importedEngineSymbols(code);
    if (syms.length === 0) continue;
    const rawSql = (code.match(/\.(exec|run|prepare)\s*\(/g) ?? []).length;
    // `getDatabase()` 的绑定形态：`const db = getDatabase()` —— 夹具播种的典型特征
    const bindings = (code.match(/(?:const|let)\s+\w+\s*=\s*(?:try)?getDatabase\s*\(/g) ?? []).length;
    tests.push({
      file: rel,
      isHarness: base === "setup.ts" || base === "fake-storage-port.ts",
      imports: syms,
      calls: Object.fromEntries(syms.map((s) => [s, callCount(code, s)]).filter(([, n]) => n > 0)),
      rawSql,
      bindings,
    });
  }
  tests.sort((a, b) => b.rawSql - a.rawSql || b.bindings - a.bindings);

  const cases = tests.filter((t) => !t.isHarness);
  return {
    prod,
    rawSites,
    tests,
    summary: {
      prodFilesWithEngineApi: prod.length,
      prodCallSites: prod.reduce((n, p) => n + Object.values(p.calls).reduce((x, y) => x + y, 0), 0),
      prodIdiom: idiom,
      rawSiteCount: rawSites.length,
      testFilesWithEngineApi: cases.length,
      testHarnessFiles: tests.length - cases.length,
      testRawSqlFiles: cases.filter((t) => t.rawSql > 0).length,
      testRawSqlSites: cases.reduce((n, t) => n + t.rawSql, 0),
      testBindings: cases.reduce((n, t) => n + t.bindings, 0),
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const r = assess();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const s = r.summary;
    console.log("L1（删 sql.js）依赖面测量\n");
    console.log(
      `生产侧：${s.prodFilesWithEngineApi} 个模块仍在 import 旧引擎 API，共 ${s.prodCallSites} 处调用 —— 这部分应由 L3/L4 消除，删引擎前必须为 0`,
    );
    for (const p of r.prod) {
      console.log(`   ${String(Object.values(p.calls).reduce((x, y) => x + y, 0)).padStart(3)} 处 · ${p.file}`);
      console.log(`         import: ${p.imports.join(", ") || "（无符号 import）"}`);
      if (p.eventDeps?.length) console.log(`         事件字面量依赖: ${p.eventDeps.join(", ")}（间接依赖，删引擎时必须一起处置）`);
    }
    console.log(
      `\n测试侧：${s.testFilesWithEngineApi} 个用例文件用旧引擎 API（另有 ${s.testHarnessFiles} 个基座文件），裸 SQL ${s.testRawSqlSites} 处 / ${s.testRawSqlFiles} 个文件，getDatabase 绑定 ${s.testBindings} 处`,
    );
    console.log("   判据：rawSql>0 或 bindings>0 = 把旧库当夹具（要迁到端口播种）；其余多为引擎自身语义（随引擎一起删）");
    for (const t of r.tests) {
      const tag = t.isHarness ? "基座" : t.rawSql > 0 || t.bindings > 0 ? "夹具" : "待定";
      console.log(
        `   [${tag}] ${t.file} — 裸SQL ${t.rawSql} · 绑定 ${t.bindings} · import ${t.imports.join(",")}`,
      );
    }
    console.log(
      "\nL1 清零的完整判据（三项都要为 0）：\n" +
        "   ① wasm-removal-readiness.mjs 的 L1 = 0（生产侧无 sql.js / wasm 资源引用）\n" +
        "   ② 生产侧 import 旧引擎 API 的模块 = 0（本脚本第 1 段）\n" +
        "   ③ 测试侧用旧引擎 API 的用例文件 = 0（本脚本第 2 段：夹具迁完、引擎语义随引擎删）",
    );
  }
}

export { walk };

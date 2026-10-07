#!/usr/bin/env node
/**
 * `scan-control-bytes.mjs`：**源码/文档里不许出现 ASCII 控制字节** ✓（第 46 波 ✓）。
 *
 * ## 为什么要它（**真机事故，7 处** ✗）
 *
 * 第 46 波清理时发现：`_batch-readout.mjs` 里有一个 **NUL（0x00）** ✓，
 * `src/core/storage/maintenance.ts` 与归档文档里还各有一个 **0x08 / 0x07** ✗ ——
 * 而且后两处**不是"多了个字符"，是"吃掉了一个字母"** ✗：
 * ```
 * src/core/storage/maintenance.ts  （与 <0x08>ackfillSkippedUnreadable 不同 …）   ← 本该是 backfill…
 * docs/HANDOFF-….md                （<0x07>gentic-loop.ts:2962                 ← 本该是 agentic-loop
 * ```
 * ★ 根因是**写文件的方式**：PowerShell 双引号串里的 `\b`（退格）与 `\a`（响铃）会被解释成控制字节 ✗
 * ⇒ 一旦落到文件里，**读文件的工具（含编辑器的 read/diff）会把它当二进制拒读** ✗、
 * 字符串里则悄悄少一个字母 ✓（这种错**没有任何编译器会报** ✗）。
 *
 * ## 口径
 *
 * - 按**字节**扫 ✓（不看编码 ✓）：`< 9`、`> 13 且 < 32`、`== 127` 都算 ✗
 *   （`\t \n \v \f \r` 是允许的 ✓）；
 * - 只扫**文本类**扩展名 ✓（`.ts .tsx .js .jsx .mjs .cjs .rs .json .md .css .html .toml .yml .yaml` ✓）；
 * - 命中就**印出文件名 + 字节偏移 + 上下文**（并把控制字节显示成 `<0xNN>` ✓），退出码 1 ✓。
 *
 * 用法：
 * ```
 * node tools/audit/scan-control-bytes.mjs                 # 扫默认根（src/tools/scripts/docs/src-tauri/src）
 * node tools/audit/scan-control-bytes.mjs --root <目录>    # 扫指定根（判据/自证用 ✓）
 * ```
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DEFAULT_ROOTS = ["src", "tools", "scripts", "docs", join("src-tauri", "src")];
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".json", ".md", ".css", ".html", ".toml", ".yml", ".yaml"]);
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", ".git", "coverage"]);

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const roots = rootIdx >= 0 ? [args[rootIdx + 1]] : DEFAULT_ROOTS;

/** 允许的控制字节：\t(9) \n(10) \v(11) \f(12) \r(13) */
const isBad = (b) => b < 9 || (b > 13 && b < 32) || b === 127;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(p);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      if (dot >= 0 && EXTS.has(e.name.slice(dot).toLowerCase())) yield p;
    }
  }
}

const hits = [];
let scanned = 0;
for (const root of roots) {
  try {
    statSync(root);
  } catch {
    continue;
  }
  for (const file of walk(root)) {
    scanned++;
    const buf = readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      if (!isBad(buf[i])) continue;
      /** 上下文：前后各 25 字节（UTF-8 解码后把控制字节显式标出来 ✓） */
      const lo = Math.max(0, i - 25);
      const hi = Math.min(buf.length - 1, i + 25);
      let ctx = "";
      for (const c of buf.subarray(lo, hi + 1).toString("utf8")) {
        const code = c.charCodeAt(0);
        ctx += code < 32 ? `<0x${code.toString(16).toUpperCase().padStart(2, "0")}>` : c;
      }
      hits.push({ file: relative(process.cwd(), file), offset: i, byte: buf[i], ctx: ctx.replace(/\r?\n/g, " / ") });
      break; // 一个文件只报第一处（够定位 ✓，避免刷屏 ✗）
    }
  }
}

console.log(`扫描 ${scanned} 个文件（根：${roots.join(", ")}）`);
if (hits.length === 0) {
  console.log("✅ 没有 ASCII 控制字节 ✓");
  process.exit(0);
}
console.error(`\n✗ ${hits.length} 个文件含 ASCII 控制字节（写文件时 ` + "`\\b`/`\\a`" + ` 这类转义落到盘上就会这样 ✗）：\n`);
for (const h of hits) {
  console.error(`  ${h.file} @${h.offset} = 0x${h.byte.toString(16).toUpperCase().padStart(2, "0")}`);
  console.error(`      …${h.ctx}…`);
}
process.exit(1);

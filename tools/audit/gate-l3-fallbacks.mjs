/**
 * L3 两态门控插入器（B0-2 批处理工具，长期保留）
 *
 * ## 为什么需要它（而不是手改）
 *
 * L3 剩余 20 个文件、177 处 `const db = getDatabase();` 回退点，需要统一改成：
 *
 * ```ts
 * const rust = domainReadMany(T, ...);
 * if (rust !== undefined) return ...;
 * if (!shouldFallbackToLegacy()) return <该域空结果>;   // ← B 态：不碰旧库
 * const db = getDatabase();                              // ← 只有 A 态才走到这里
 * ```
 *
 * 手改的风险实测发生过两次：
 * 1. 同一文件里 `const db = getDatabase();` 文本**完全相同**，整串替换会把门控
 *    误插到全部位置（包括读函数，返回类型都不对）；
 * 2. 注释里提到函数名会被扫描器计成真实回退。
 *
 * 所以这里按**结构**定位：给定"所属函数签名 + 该函数内的门控语句"，逐处插入；
 * 每处插入后校验"该签名之后确实有一处旧库调用"，找不到就报错退出（绝不猜）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/audit/gate-l3-fallbacks.mjs plan.json          # 预演（不写文件）
 * node tools/audit/gate-l3-fallbacks.mjs plan.json --write  # 实际写入
 * ```
 *
 * plan.json：
 * ```json
 * {
 *   "file": "src/core/xxx.ts",
 *   "importFrom": "../storage/domain-store",
 *   "sites": [
 *     { "anchor": "create(x:", "kind": "write", "scope": "x.create", "note": "未保存" },
 *     { "anchor": "getById(id:", "kind": "readNull" }
 *   ]
 * }
 * ```
 *
 * `kind` 取值：`readNull` / `readEmptyArray` / `readZero` / `readEmptyObject` /
 * `write`（写用 writeShouldFallBackToLegacy）/ `readCustom`（带 `statement` 字段）。
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , planPath, ...flags] = process.argv;
const WRITE = flags.includes("--write");
if (!planPath) {
  console.error("用法：node tools/audit/gate-l3-fallbacks.mjs <plan.json> [--write]");
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, "utf8"));
const plans = Array.isArray(plan) ? plan : [plan];

/** 按 kind 生成门控语句 */
function statementFor(site) {
  switch (site.kind) {
    case "readNull":
      return "if (!shouldFallbackToLegacy()) return null;";
    case "readEmptyArray":
      return "if (!shouldFallbackToLegacy()) return [];";
    case "readZero":
      return "if (!shouldFallbackToLegacy()) return 0;";
    case "readEmptyObject":
      return `if (!shouldFallbackToLegacy()) return ${site.cast ?? "{} as Record<string, never>"};`;
    case "readCustom":
      if (!site.statement) throw new Error(`readCustom 需要 statement 字段（anchor=${site.anchor}）`);
      return site.statement;
    case "write":
      if (!site.scope || !site.note) throw new Error(`write 需要 scope/note（anchor=${site.anchor}）`);
      return `if (!writeShouldFallBackToLegacy("${site.scope}", "${site.note}")) return${site.returnValue ? ` ${site.returnValue}` : ""};`;
    default:
      throw new Error(`未知 kind: ${site.kind}`);
  }
}

let totalDone = 0;
for (const p of plans) {
  const text = readFileSync(p.file, "utf8");
  const NL = text.includes("\r\n") ? "\r\n" : "\n";
  let out = text;
  const done = [];
  const bad = [];

  for (const site of p.sites) {
    const at = out.indexOf(site.anchor);
    if (at < 0) {
      bad.push(`锚点未找到: ${site.anchor}`);
      continue;
    }
    if (out.indexOf(site.anchor, at + 1) >= 0 && !site.allowMultiple) {
      bad.push(`锚点不唯一（必须唯一，否则无法确定插哪里）: ${site.anchor}`);
      continue;
    }
    const dbAt = out.indexOf("const db = getDatabase();", at);
    if (dbAt < 0) {
      bad.push(`该锚点之后找不到旧库调用: ${site.anchor}`);
      continue;
    }
    // 该锚点之后、旧库调用之前不能再有下一个函数签名（否则说明 anchor 太宽）
    const lineStart = out.lastIndexOf("\n", dbAt) + 1;
    const indent = out.slice(lineStart, dbAt).match(/^\s*/)?.[0] ?? "  ";
    out = out.slice(0, dbAt) + indent + statementFor(site) + NL + out.slice(dbAt);
    done.push(site.anchor);
  }

  if (p.importFrom && !out.includes("shouldFallbackToLegacy")) {
    const re = new RegExp(`import \\{([\\s\\S]*?)\\} from "${p.importFrom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";`);
    out = out.replace(re, (m, inner) => {
      const trimmed = inner.trimEnd().replace(/,$/, "");
      return `import {${trimmed},\n  shouldFallbackToLegacy,\n  writeShouldFallBackToLegacy,\n} from "${p.importFrom}";`;
    });
  }

  console.log(`\n${p.file}`);
  console.log(`  已处理 ${done.length} 处: ${done.join(" | ")}`);
  if (bad.length) {
    console.log(`  未处理 ${bad.length} 处:`);
    for (const b of bad) console.log("    " + b);
  }
  if (WRITE && bad.length === 0) {
    writeFileSync(p.file, out);
    console.log("  已写入");
  } else if (!WRITE) {
    console.log("  （预演模式，未写文件）");
  }
  totalDone += done.length;
  if (bad.length) process.exitCode = 1;
}
console.log(`\n合计处理 ${totalDone} 处`);

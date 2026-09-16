/**
 * 审计门禁 #1 —— B 类「假成功」扫描器（第 88 波：从一次性脚本升级为门禁）
 *
 * ## 为什么要有门禁
 *
 * 第 87 波用一次性脚本扫出 31 处"写/动作路径在 catch 里只打一行日志"的缺陷。
 * 但一次性脚本的结论会随时间失效：**新写的代码可以再次引入同样的模式**。
 * 所以这里把它做成可重复执行的扫描器，并由 `src/test/audit-gates.test.ts` 在
 * `npx vitest run` 里强制执行 —— 新引入的假成功会在测试阶段就红。
 *
 * ## 判据（两级，只报"可证明"的，不做语义猜测）
 *
 * - **P1**：`catch` 块里直接 `return true` / `return { success: true }` / `{ ok: true }`
 *   —— 吞掉异常并上报成功。
 * - **P2**：`catch` 块**只有日志**（没有任何 return / throw / 状态写入），
 *   且所在函数名属写/动作类（update/save/create/delete/set/send/write/apply/install/
 *   enable/disable/commit/run/start/stop/retry/cancel/persist/register/add/remove/clear/
 *   reset/import/export）—— 失败被吞、调用方以为动作完成了。
 *
 * ## 减少误报
 *
 * 匹配前**先剥掉注释**（`//`、`/* *​/`）：本仓库大量注释里就写着这些模式（例如
 * "原来 `db.run(UPDATE …)`"），不剥会把文档当成代码报出来。
 *
 * ## 退出码
 *
 * CLI 模式：无违规 → 0；有违规 → 1（并逐条打印）。允许清单见 `allowlist.json`
 * （每条必须写明理由，且只对"复核过确实不是缺陷"的命中生效）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..", "..", "src");

const ACTOR_RE =
  /\b(update|save|create|delete|set|send|write|apply|install|enable|disable|commit|run|start|stop|retry|cancel|persist|register|add|remove|clear|reset|import|export)[A-Za-z]*\s*\(/;

/** 剥掉注释（保留长度结构，便于按行定位） */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
}

function listTsFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  })(root);
  return out;
}

/** 从 `catch` 关键字位置取出块体（花括号配对） */
function catchBody(src, idx) {
  const open = src.indexOf("{", idx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), start: open + 1, end: i };
    }
  }
  return null;
}

/** 向前找最近的函数名（best effort，够用即可） */
function enclosingName(src, idx) {
  const before = src.slice(Math.max(0, idx - 4000), idx);
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g,
    /(?:async\s+)?(\w+)\s*\([^()]*\)\s*(?::[^{;]+)?\{/g,
    /(\w+)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*=>/g,
  ];
  let best = null;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(before)) !== null) {
      if (!best || m.index + m[0].length > best.at) best = { name: m[1], at: m.index + m[0].length };
    }
  }
  return best?.name ?? "(anon)";
}

/**
 * 执行扫描。
 * @param {{root?: string, allowlist?: object}} opts
 * @returns {{p1: Array, p2: Array, violations: Array, scannedFiles: number}}
 */
export function scanFalseSuccess(opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  const allow = opts.allowlist ?? loadAllowlist();
  const p1 = [];
  const p2 = [];

  for (const file of listTsFiles(root)) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    let idx = -1;
    while ((idx = src.indexOf("catch", idx + 1)) !== -1) {
      /**
       * ⚠️ 必须确认这是 **catch 子句**，而不是 `.catch(...)` **方法调用**。
       *
       * 早期实现只看"`catch` 后面跟 `(` 或 `{`"，于是 `.catch((e) => …)` 被当成
       * catch 块解析：它会向下配对到一个**不相干**的 `}`，把整段代码误判成 P1
       * （第 92 波实测：`domain-store.ts` 的写穿失败上报被误报为"catch 里 return true"）。
       *
       * 判据：`catch` 前面若是 `.`（属性访问）或标识符字符（如 `xxcatch`），就不是子句。
       */
      const prev = idx > 0 ? src[idx - 1] : "";
      if (prev === "." || /[\w$]/.test(prev)) continue;
      const after = src.slice(idx + 5).replace(/^\s*/, "");
      if (!/^[({]/.test(after)) continue;
      const found = catchBody(src, idx);
      if (!found) continue;
      const code = found.body.replace(/\s+/g, " ").trim();
      const line = src.slice(0, idx).split("\n").length;
      const fn = enclosingName(src, idx);
      const rel = path.relative(path.resolve(__dirname, "..", ".."), file).replace(/\\/g, "/");

      if (/return\s+(true|\{\s*(success|ok)\s*:\s*true\s*\})/.test(code)) {
        // code 保留**完整**块体（允许清单按片段特征匹配，截断会让豁免失效）；
        // 展示用 preview 截断。
        p1.push({ file: rel, line, fn, kind: "P1", code, preview: code.slice(0, 160) });
        continue;
      }
      const onlyLogs =
        code.length > 0 && /^(console\.(warn|error|log|info|debug)\([^;]*\);?\s*)+$/.test(code);
      if (onlyLogs && ACTOR_RE.test(fn + "(")) {
        p2.push({ file: rel, line, fn, kind: "P2", code, preview: code.slice(0, 160) });
      }
    }
  }

  const violations = [...p1, ...p2].filter((h) => !isAllowed(h, allow.falseSuccess ?? []));
  return { p1, p2, violations, scannedFiles: listTsFiles(root).length };
}

export function loadAllowlist() {
  try {
    const p = path.join(__dirname, "allowlist.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { falseSuccess: [], silentWrites: [] };
  }
}

/** 命中是否在允许清单里（按 文件 + 片段特征 匹配，避免行号漂移） */
export function isAllowed(finding, entries) {
  return entries.some(
    (e) => e.file === finding.file && (!e.contains || (finding.code ?? "").includes(e.contains)),
  );
}

// ========== CLI ==========

function main() {
  const json = process.argv.includes("--json");
  const result = scanFalseSuccess({});
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`B 类（假成功）扫描：${result.scannedFiles} 个文件`);
    console.log(`  P1（catch 里 return true/success）：${result.p1.length}`);
    console.log(`  P2（写/动作类函数里 catch 只有日志）：${result.p2.length}`);
    for (const v of result.violations) {
      console.log(`  ✗ ${v.file}:${v.line}  [${v.kind}] ${v.fn}  →  ${v.preview}`);
    }
    console.log(
      result.violations.length === 0
        ? "✅ 无未豁免的命中"
        : `❌ ${result.violations.length} 处未豁免（要么修，要么在 tools/audit/allowlist.json 里写明理由）`,
    );
  }
  process.exit(result.violations.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

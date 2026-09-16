/**
 * 审计门禁 #3 —— C 类「守卫被绕过」扫描器（第 89 波）
 *
 * ## 为什么单列一类
 *
 * A 类（静默空写）看的是"写没写到"，B 类（假成功）看的是"失败有没有被当成成功"，
 * 而 C 类问的是更关键的一件事：**安全阀自己失效时，代码往哪边倒**。
 * 本仓库历史事故里最贵的几条都在这一类：
 *   · 权限层 `action === "ask"` 但没接审批回调 → 落到默认放行（"ask" 等于 "full"）；
 *   · PowerShell 危险命令整段跳过分析（Windows 下 auto 模式等于没闸门）；
 *   · 计划模式的写工具名单里没有 shell（计划模式只读的承诺被绕过）；
 *   · 钩子执行失败/退出码非 0 → 静默放行（守卫没生效却当成通过）。
 *
 * ## 判据（只报"可证明"的）
 *
 * - **C1 fail-open 返回**：`catch` 里返回放行语义（`return true` / `"allow"` /
 *   `{ allowed: true }` / `{ action: "allow" }` / `proceed`）——把"判定失败"当成"判定通过"。
 * - **C2 守卫调用被吞**：`catch` 块里调用了守卫/权限类函数
 *   （`analyzeBashCommand` / `isAutoApprovable` / `checkPermission` / `modeGate` /
 *   `getEffectiveSecurityMode` / `isProtectedPath` / `PlanModeGuard` / `SandboxGuard` /
 *   `evaluateWithBashAnalysis` / `isPathWithinWorkspace` …），
 *   但块内既没有 `throw`、也没有拒绝路径、也没有走统一失败上报 —— 判定失败被静默忽略。
 * - **C3 审批缺省放行**：同一个函数体里出现 `"ask"` 分支判断与 `catch`，
 *   且该 catch 返回放行 —— 与 `PLAN-5` 源码契约同源，这里做全项目版本。
 *
 * ## 有意不做的事
 *
 * 不判断"守卫该不该存在"、"阈值合不合理"——那需要人读语义。这里只负责把
 * **"守卫失败时沉默地放行"**这种可证明的结构报出来。
 *
 * ## 退出码
 *
 * 无违规 → 0；有违规 → 1。豁免见 `allowlist.json` 的 `guardBypass`（每条须写明理由）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAllowlist, isAllowed, stripComments } from "./scan-false-success.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..", "..", "src");

/** 守卫/权限判定类调用的名字（出现即说明"这里在做安全判定"） */
const GUARD_CALLS = [
  "analyzeBashCommand",
  "evaluateWithBashAnalysis",
  "isAutoApprovable",
  "checkPermission",
  "modeGate",
  "getEffectiveSecurityMode",
  "getGlobalSecurityMode",
  "isProtectedPath",
  "isPathWithinWorkspace",
  "isSandboxAclEnabled",
  "isPlanMode",
  "isSessionApproved",
  "PlanModeGuard",
  "SandboxGuard",
  "shouldFireHook",
  "executePreToolHooks",
];

/** 放行语义（fail-open 返回） */
const ALLOW_RETURN_RE =
  /return\s+(true\b|"allow"|'allow'|\{\s*allowed\s*:\s*true|\{\s*action\s*:\s*["']allow["']|proceed\b)/;

/** "这行不是静默放行"的证据：抛出、拒绝、或走了统一失败上报 */
const NOT_SILENT_RE =
  /throw\b|deny|Denied|拒绝|reportPersistFailure|reportActionFailure|reportFailure|console\.error/;

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

function catchBody(src, idx) {
  const open = src.indexOf("{", idx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), start: open + 1 };
    }
  }
  return null;
}

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

/** 包含 catch 的整个函数体（用于 C3：同函数内是否出现 "ask" 分支） */
function enclosingFunctionBody(src, idx) {
  // 向前找最近的函数起始花括号，再做括号配对（best effort）
  const before = src.slice(0, idx);
  const candidates = [];
  const re = /(?:function\s+\w+|\)\s*(?::[^{;]+)?\{|\b=>\s*\{)/g;
  let m;
  while ((m = re.exec(before)) !== null) candidates.push(m.index + m[0].length - 1);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const open = candidates[i];
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) {
          if (j >= idx) return src.slice(open + 1, j);
          break;
        }
      }
    }
  }
  return "";
}

export function scanGuardBypass(opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  const allow = opts.allowlist ?? loadAllowlist();
  const repoRoot = path.resolve(__dirname, "..", "..");
  const findings = [];

  for (const file of listTsFiles(root)) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
    let idx = -1;
    while ((idx = src.indexOf("catch", idx + 1)) !== -1) {
      const after = src.slice(idx + 5).replace(/^\s*/, "");
      if (!/^[({]/.test(after)) continue;
      const found = catchBody(src, idx);
      if (!found) continue;
      const code = found.body.replace(/\s+/g, " ").trim();
      const line = src.slice(0, idx).split("\n").length;
      const fn = enclosingName(src, idx);
      const guardHit = GUARD_CALLS.find((g) => new RegExp(`\\b${g}\\s*[.(]`).test(code));

      /**
       * C1 只报**无条件**放行，或者"有放行返回、却没有任何拒绝路径"的块。
       * 形如 `if (hook.allowOnError) { warn; return { action: "allow" }; } return deny…`
       * 是用户显式选择的 fail-open 开关（默认仍 fail-closed），不能一刀切成缺陷。
       */
      if (ALLOW_RETURN_RE.test(code)) {
        const unconditional = /^return\s/.test(code);
        const hasDenyPath = /deny/i.test(code);
        if (unconditional || !hasDenyPath) {
          findings.push({
            file: rel, line, fn, kind: "C1", guard: guardHit ?? "",
            code,
            preview: code.slice(0, 150),
            why: unconditional
              ? "catch 里**无条件**返回放行语义：判定失败被当成通过"
              : "catch 里有放行返回但没有任何拒绝路径（fail-open）",
          });
          continue;
        }
        // 有拒绝路径的条件放行：作为 info 记录，不计违规
        findings.push({
          file: rel, line, fn, kind: "C1-info", guard: guardHit ?? "",
          code,
          preview: code.slice(0, 150),
          why: "catch 里有条件放行（存在拒绝路径）—— 需人工确认该开关是显式选择",
          informational: true,
        });
        continue;
      }

      if (guardHit && !NOT_SILENT_RE.test(code)) {
        findings.push({
          file: rel, line, fn, kind: "C2", guard: guardHit,
          code,
          preview: code.slice(0, 150),
          why: `守卫调用 ${guardHit}() 失败被静默忽略（块内没有 throw / 拒绝 / 失败上报）`,
        });
        continue;
      }

      /**
       * C3 收紧：只有"空 catch"、**且**它就在审批判断附近（前 25 行内出现 "ask"），
       * 或者所在函数名本身就是权限/守卫语义时才报 —— 否则 `"ask"` 在三五百行的
       * 大函数里出现一次，会把一堆无关的 `catch {}` 全拖进来。
       */
      if (code.length === 0) {
        const window = src.slice(Math.max(0, idx - 25 * 80), idx);
        const nearAsk = /"ask"/.test(window) || /'ask'/.test(window);
        const guardishFn = /(permission|approve|guard|security|sandbox|consent|deny|hook)/i.test(fn);
        if (nearAsk || guardishFn) {
          findings.push({
            file: rel, line, fn, kind: "C3", guard: "",
            code,
            preview: "(注释/空 catch)",
            why: nearAsk
              ? '空 catch 紧邻 "ask" 审批判断 —— 需确认失败时不会落到默认放行'
              : "空 catch 位于权限/守卫语义的函数里",
          });
        }
      }
    }
  }

  const violations = findings.filter((f) => !f.informational).filter((f) => !isAllowed(f, allow.guardBypass ?? []));
  const info = findings.filter((f) => f.informational);
  return { findings, violations, info, scannedFiles: listTsFiles(root).length };
}

// ========== CLI ==========

function main() {
  const json = process.argv.includes("--json");
  const result = scanGuardBypass({});
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`C 类（守卫被绕过）扫描：${result.scannedFiles} 个文件`);
    console.log(`  命中：${result.findings.length}（其中 ${result.info.length} 条为"需人工确认"的信息项）`);
    for (const v of result.violations) {
      console.log(`  ✗ ${v.file}:${v.line}  [${v.kind}] ${v.fn}  →  ${v.preview}`);
      console.log(`      ${v.why}`);
    }
    console.log(
      result.violations.length === 0
        ? "✅ 无未豁免的命中"
        : `❌ ${result.violations.length} 处未豁免（要么改成 fail-closed，要么在 allowlist.json 写明理由）`,
    );
  }
  process.exit(result.violations.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

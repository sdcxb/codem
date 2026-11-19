/**
 * IPC-ARGS：`invoke` 的参数键必须与 Rust 命令的参数**同名（camelCase）**。
 *
 * ## 为什么要有这条判据
 *
 * Tauri v2 默认按 **camelCase** 从 JS 对象里取键、再映射到 Rust 的 snake_case 参数
 * （本仓没有任何 `rename_all` 覆盖）。传错大小写**不会报错**：`Option<T>` 参数拿到 `None`、
 * 多出来的键被 serde 静默忽略。于是出现最坏的一类 bug —— **开关看起来设置了，其实没生效**：
 *
 * - `write_file` 传 `sandbox_enabled` / `allowed_roots` ⇒ Rust 收到 `None`
 *   ⇒ 沙箱按"开着"处理（用户关掉沙箱仍被拒），且白名单完全不生效；
 * - `execute_command` 传 `timeout_ms` / `bash_path` ⇒ 超时回落到 Rust 默认 600s
 *   （卡死命令挂 10 分钟）、自定义 bash 路径失效。
 *
 * 这些在界面上全是"静默"的，只有读两侧源码才发现 —— 所以把它变成判据。
 *
 * ## 口径
 *
 * - Rust 侧：抓 `#[tauri::command]` 之后最近的 `fn <name>(…)`，取参数名，转成 camelCase；
 * - TS 侧：抓 `invoke("cmd", { … })` / `tauriInvoke("cmd", { … })` 的**字面量对象**，
 *   用括号配平取整段，只取顶层键（跳过展开 `...x` 的对象：无法静态判定）；
 * - 违规判定：键里含 `_` 且它不是该命令的合法参数（即"蛇形写法"），或键不在参数表里
 *   （后者可能是拼错/命令改名，同样静默失败）。
 *
 * 允许在行内用 `// ipc-args-allow: 理由` 豁免单条（本仓目前 0 条，保持 0）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function walk(dir: string, out: string[], filter: (f: string) => boolean) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "target" || name === ".git") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out, filter);
    else if (filter(full)) out.push(full);
  }
}

const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Rust: 命令名 → 合法参数键集合（camelCase） */
function readRustCommands(): Map<string, Set<string>> {
  const files: string[] = [];
  walk(path.join(ROOT, "src-tauri", "src"), files, (f) => f.endsWith(".rs"));
  const commands = new Map<string, Set<string>>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/#\[tauri::command/.test(lines[i])) continue;
      /* 注释里也可能出现 `#[tauri::command]`（例如文件头说明），必须紧跟 fn 才算 */
      let j = i + 1;
      while (j < lines.length && j < i + 40 && !/^\s*(pub\s+)?(async\s+)?fn\s+[A-Za-z0-9_]+/.test(lines[j])) {
        if (/#\[tauri::command/.test(lines[j])) break;
        j += 1;
      }
      const fnLine = lines[j] ?? "";
      const nameMatch = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*[<(]/.exec(fnLine);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      /* 参数列表：从 fn 行开始，括号配平到 `)` 后遇到 `->` */
      let text = lines.slice(j, Math.min(lines.length, j + 40)).join("\n");
      const open = text.indexOf("(");
      let depth = 0;
      let close = -1;
      for (let k = open; k < text.length; k++) {
        if (text[k] === "(") depth += 1;
        else if (text[k] === ")") {
          depth -= 1;
          if (depth === 0) {
            close = k;
            break;
          }
        }
      }
      if (close < 0) continue;
      const params = text.slice(open + 1, close);
      const keys = new Set<string>();
      /* 顶层参数：按逗号切，跳过尖括号/元组/注释里的逗号 */
      let buf = "";
      let d = 0;
      for (const ch of params) {
        if ("<([".includes(ch)) d += 1;
        if (">)]".includes(ch)) d -= 1;
        if (ch === "," && d === 0) {
          addParam(buf);
          buf = "";
        } else buf += ch;
      }
      addParam(buf);
      function addParam(chunk: string) {
        const clean = chunk
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/\/\/.*$/gm, " ")
          .trim();
        const m = /^([a-z_][a-z0-9_]*)\s*:/.exec(clean);
        if (m) keys.add(snakeToCamel(m[1]));
      }
      if (keys.size > 0 || /\)\s*->/.test(text)) commands.set(name, keys);
    }
  }
  return commands;
}

interface Violation {
  file: string;
  line: number;
  command: string;
  key: string;
  reason: string;
}

function scanTs(commands: Map<string, Set<string>>): { violations: Violation[]; missing: string[]; scanned: number; skipped: number } {
  const files: string[] = [];
  walk(path.join(ROOT, "src"), files, (f) => /\.(ts|tsx)$/.test(f) && !f.includes(`${path.sep}test${path.sep}`));
  const violations: Violation[] = [];
  const missing: string[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const callRe = /\b(?:invoke|tauriInvoke)\s*(?:<[^>]*>)?\s*\(\s*["']([A-Za-z0-9_]+)["']\s*,\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src))) {
      const command = m[1];
      const allowed = commands.get(command);
      const bodyStart = m.index + m[0].length - 1; // 指向 `{`
      let depth = 0;
      let end = -1;
      let inStr: string | null = null;
      for (let k = bodyStart; k < src.length; k++) {
        const ch = src[k];
        if (inStr) {
          if (ch === "\\") k += 1;
          else if (ch === inStr) inStr = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
          continue;
        }
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            end = k;
            break;
          }
        }
      }
      if (end < 0) {
        skipped += 1;
        continue;
      }
      const body = src.slice(bodyStart + 1, end);
      if (body.includes("...")) {
        skipped += 1;
        continue;
      }
      /* 顶层键：depth 0 的 `name:`；跳过嵌套对象/函数体 */
      const keys: Array<{ key: string; at: number }> = [];
      let d = 0;
      let str: string | null = null;
      for (let k = 0; k < body.length; k++) {
        const ch = body[k];
        if (str) {
          if (ch === "\\") k += 1;
          else if (ch === str) str = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          str = ch;
          continue;
        }
        if ("{[(".includes(ch)) d += 1;
        else if ("}])".includes(ch)) d -= 1;
        else if (ch === ":" && d === 0) {
          const before = body.slice(0, k);
          const km = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
          if (km) keys.push({ key: km[1], at: bodyStart + 1 + (before.length - km[1].length) });
        }
      }
      if (!allowed) {
        /* 插件命令（plugin:dialog|save 等）不在 Rust 的 generate_handler! 里，跳过 */
        if (!command.includes(":")) {
          const line = src.slice(0, m.index).split("\n").length;
          const entry = `${path.relative(ROOT, file).replace(/\\/g, "/")}:${line} invoke("${command}")`;
          if (!missing.includes(entry)) missing.push(entry);
        }
        continue;
      }
      scanned += 1;
      for (const { key, at } of keys) {
        if (!key.includes("_")) {
          if (!allowed.has(key)) {
            const line = src.slice(0, at).split("\n").length;
            violations.push({ file: path.relative(ROOT, file).replace(/\\/g, "/"), line, command, key, reason: `不是 ${command} 的参数` });
          }
          continue;
        }
        const camel = snakeToCamel(key);
        const line = src.slice(0, at).split("\n").length;
        if (allowed.has(camel) || allowed.has(key)) {
          violations.push({
            file: path.relative(ROOT, file).replace(/\\/g, "/"),
            line,
            command,
            key,
            reason: `应写成 ${camel}（Tauri 按 camelCase 取键；蛇形键会被静默丢弃）`,
          });
        } else {
          violations.push({ file: path.relative(ROOT, file).replace(/\\/g, "/"), line, command, key, reason: `不是 ${command} 的参数` });
        }
      }
    }
  }
  return { violations, missing, scanned, skipped };
}

describe("IPC-ARGS：invoke 参数键必须是 Rust 参数的 camelCase", () => {
  it("全仓扫描：没有蛇形/拼错的参数键", () => {
    const commands = readRustCommands();
    expect(commands.size, "没能从 Rust 侧解析出命令（判据本身失效）").toBeGreaterThan(50);
    const { violations, scanned } = scanTs(commands);
    expect(scanned, "没扫到任何 invoke 字面量（判据本身失效）").toBeGreaterThan(50);
    const report = violations.map((v) => `${v.file}:${v.line} ${v.command}.${v.key} —— ${v.reason}`).join("\n  ");
    expect(violations, `以下调用点的参数键会 Rust 侧被静默丢弃：\n  ${report}`).toEqual([]);
  });

  it("全仓扫描：invoke 的命令名都真的存在于 Rust（否则 100% 失败）", () => {
    const commands = readRustCommands();
    const { missing } = scanTs(commands);
    expect(missing, `以下命令在 Rust 的 generate_handler! 里找不到（调用必失败）：\n  ${missing.join("\n  ")}`).toEqual([]);
  });
});

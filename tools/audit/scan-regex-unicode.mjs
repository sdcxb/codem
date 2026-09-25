/**
 * 正则 Unicode 安全扫描（第 98 轮新增）：**字符类里含非 BMP 字符却没有 `u` 标志**。
 *
 * ## 为什么要有这条
 *
 * `src/core/knowledge/importer.ts` 里那句「把 📝/📊 剥掉」原来是：一个**没有 `u` 标志**的
 * 字符类正则（`^[📝📊]` 后面跟 `\s` 星号），写法上就是"把两个 emoji 塞进方括号"。
 *
 * 没有 `u` 的正则按 UTF-16 **码元**匹配，而 📝(U+1F4DD)/📊(U+1F4CA) 都是代理对
 * ⇒ 字符类只吃掉高位代理，留下一个孤立低位代理 ⇒ 标题里就多出一个替换字符（U+FFFD）。
 * 它**能过 tsc、能过 lint、能在测试里"导入成功"**，只在真机导入时才现形。
 *
 * ## 判据（`--strict` 时非零退出）
 *
 * 逐文件找**真正的正则字面量**（跳过字符串/模板/注释；`/` 只有在"可以开始一个表达式"的位置
 * 才算正则），再看其中每个 `[...]` 字符类：
 *   - 类里出现码点 > U+FFFF 的字符，且该正则的 flags 里既没有 `u` 也没有 `v` ⇒ **报告**。
 *
 * ⚠️ 已知边界（如实写）：模板字符串里 `${}` 中的代码、`new RegExp("...")` 的字符串形式
 * 都不在扫描范围内（前者整段跳过、后者是字符串）—— 这条工具是"发现线索"，不是完备证明。
 *
 * 用法：node tools/audit/scan-regex-unicode.mjs [--strict] [--json]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STRICT = process.argv.includes("--strict");
const JSON_OUT = process.argv.includes("--json");

export function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** 跳过字符串/模板（含转义）；返回结束位置之后的下标 */
function skipString(code, start) {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length) {
    const c = code[i];
    if (c === "\\") { i += 2; continue; }
    if (c === quote) return i + 1;
    if (quote !== "`" && c === "\n") return i; // 未闭合的普通字符串：不要越过行尾
    i++;
  }
  return i;
}

/** `/` 前面最近的非空白字符 */
function prevSignificant(code, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = code[j];
    if (!/\s/.test(c)) return c;
  }
  return "";
}

/** `/` 前面最近的标识符（用于 return / typeof / case …） */
function wordBefore(code, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  let end = j;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(code[j])) j--;
  return code.slice(j + 1, end + 1);
}

/** `/` 出现在这些字符之后 ⇒ 它开始的是一个正则字面量（而不是除号） */
const REGEX_ALLOWED_AFTER = new Set(",=:[!&|?{};+-*%~^<>()".split(""));
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "do", "else", "yield", "await", "instanceof"]);

/** 读一个正则字面量；失败（其实是除号）返回 null */
function readRegex(code, start) {
  let i = start + 1;
  let inClass = false;
  while (i < code.length) {
    const c = code[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "\n") return null;
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") { inClass = true; i++; continue; }
    if (c === "/") {
      const source = code.slice(start + 1, i);
      let j = i + 1;
      while (j < code.length && /[a-z]/i.test(code[j])) j++;
      return { source, flags: code.slice(i + 1, j), end: j };
    }
    i++;
  }
  return null;
}

export function findRegexLiterals(code) {
  const out = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(code, i); continue; }
    if (c === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i);
      i = nl < 0 ? code.length : nl + 1;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (c === "/") {
      const p = prevSignificant(code, i);
      const allowed = p === "" || REGEX_ALLOWED_AFTER.has(p) || KEYWORDS_BEFORE_REGEX.has(wordBefore(code, i));
      if (allowed) {
        const r = readRegex(code, i);
        if (r) {
          out.push({ index: i, ...r, line: code.slice(0, i).split("\n").length });
          i = r.end;
          continue;
        }
      }
    }
    i++;
  }
  return out;
}

/** 字符类里有没有非 BMP 字符 */
export function nonBmpIn(text) {
  for (const ch of text) {
    if (ch.codePointAt(0) > 0xffff) return ch;
  }
  return null;
}

/**
 * 扫一段源码：返回"字符类含非 BMP 字符且正则无 u/v 标志"的位置。
 * 导出给门禁直接调用（`src/test/regex-unicode-safety.test.ts`）。
 */
export function scanSource(code, relPath = "(inline)") {
  const normalized = code.replace(/\r\n/g, "\n");
  const findings = [];
  let regexCount = 0;
  let classCount = 0;
  for (const re of findRegexLiterals(normalized)) {
    regexCount++;
    const flagsOk = /[uv]/.test(re.flags);
    for (const m of re.source.matchAll(/\[[^\]]*\]/g)) {
      classCount++;
      const bad = nonBmpIn(m[0]);
      if (bad && !flagsOk) {
        findings.push({
          file: relPath,
          line: re.line,
          cls: m[0],
          ch: bad,
          cp: `U+${bad.codePointAt(0).toString(16).toUpperCase()}`,
          regex: `/${re.source}/${re.flags}`,
        });
      }
    }
  }
  return { regexCount, classCount, findings };
}

/**
 * 扫整棵树（只扫 `src` 与 `tools` 的**生产代码**）。
 *
 * ⚠️ 必须排除测试目录：门禁自己的**反向对照**里就故意写着修复前那行坏写法
 * （见 `src/test/regex-unicode-safety.test.ts` 的 REGEX-2/REGEX-4），
 * 不排除的话这条门禁会被自己弄红 —— 第一版就是这样。
 */
export function scanTree(root) {
  const all = walk(path.join(root, "src")).concat(walk(path.join(root, "tools")));
  const files = all.filter((f) => {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    return !rel.startsWith("src/test/") && !/\.test\.(ts|tsx|mjs|js)$/.test(rel);
  });
  const findings = [];
  let regexCount = 0;
  let classCount = 0;
  /**
   * 扫到一半**消失**的文件（第 154 轮实测的偶发假红）。
   *
   * 现场：全量跑（并行 worker）时这条门禁红了，报
   * `ENOENT: no such file or directory, open 'C:\mimo-gui\src\__etw_probe__.ts'`。
   * 那个文件不是产品源码，而是 `src/test/event-type-write-sites.test.ts` 的
   * EVENT-TYPE-WRITES-3 **临时写出来验证解析能力**的探针文件（用完 `finally` 删掉）——
   * 它在 `src/` 下，于是与"扫整棵 src 树"的这条门禁撞上了：枚举到它时还在、读它时已经删掉。
   *
   * 处置：**枚举后被删掉的文件跳过并计数**（它已经不是文件了，没有任何东西可扫），
   * 但要把跳过数**打出来** —— 静默跳过会让"为什么少扫了一个文件"变成新的谜。
   * 判据没有被放宽：真源码文件不会自己消失，findings 的规则一个字没动。
   */
  const vanished = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") {
        vanished.push(rel);
        continue;
      }
      throw e;
    }
    const r = scanSource(text, rel);
    regexCount += r.regexCount;
    classCount += r.classCount;
    findings.push(...r.findings);
  }
  return { files: files.length - vanished.length, regexCount, classCount, findings, vanished };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isCli) {
  const { files, regexCount, classCount, findings, vanished } = scanTree(ROOT);
  if (JSON_OUT) {
    console.log(JSON.stringify({ files, regexCount, classCount, findings, vanished }, null, 1));
  } else {
    console.log(`扫了 ${files} 个文件 / ${regexCount} 个正则字面量 / ${classCount} 个字符类`);
    if (vanished.length > 0) {
      console.log(`（扫描期间被删掉、已跳过 ${vanished.length} 个：${vanished.slice(0, 5).join("、")} —— 并发用例的临时文件）`);
    }
    console.log(`非 BMP 字符类且无 u/v 标志：${findings.length} 处`);
    for (const f of findings) {
      console.log(`  🔴 ${f.file}:${f.line}  ${f.cp} ${JSON.stringify(f.ch)}  正则=${f.regex}`);
    }
  }
  if (STRICT && findings.length > 0) process.exit(1);
  process.exit(0);
}

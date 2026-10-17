/**
 * 第 230 波 · **命令签名与 Rust 侧调用点必须同步**（判据 `TAURI-ARITY-1`）。
 *
 * ## 被守的缺陷（本轮实测抓到的真缺陷）
 *
 * `execute_command` 后来加了 `shell` / `bash_path` 两个形参（5 参），而 `lib.rs` 里
 * **三条 `#[tokio::test]` 用例**还按 3 参调用 ⇒ 编译期 `E0061 ×3` ⇒
 * **`cargo test --lib` 在 HEAD 上根本编译不过**。平时的门禁（`tsc` / `vitest` /
 * `cargo check --release`）**一条都看不见**它：`cargo check` 不编译 `#[cfg(test)]`
 * 里的调用（那三条在 test 模块里，但 `cargo check --release` 不展开 test cfg），
 * 而 TS 判据完全不读 Rust。
 *
 * 后果不是"少跑几条测试"，而是**整个 Rust 单测面静默消失**：谁都没发现，直到有人真的去跑
 * `cargo test --lib`（本轮为了跑隔离开关的判据才撞上）。
 *
 * ## 为什么用静态判据而不是"把 cargo test 加进门禁"
 *
 * `cargo test --lib` 要链接整个 Tauri 依赖树（分钟级），加进每次门禁不现实；而"形参个数
 * 与调用实参个数"是**纯文本可判定**的（本文件就是这么做的）。两者不冲突：
 * 静态判据当**快闸门**，真跑 `cargo test --lib` 仍由发版/交接时执行。
 *
 * ## 判据怎么算（刻意保守，宁可漏报也不误报）
 *
 * 1. 先从 `lib.rs` 里找出每个 `#[tauri::command]` 函数的**形参个数**（括号配对 + 顶层逗号）；
 * 2. 再找同文件里对该函数的**每一处调用**（`名字(` 形式，排除定义处与宏注册处的裸名字），
 *    同样算顶层逗号；
 * 3. 逐个比对：**任何一处不一致就红**，并把不一致的 `名字: 形参N ≠ 实参M @偏移` 报出来；
 * 4. 另有一条"别空跑"的护栏：必须真的检查到足够多的命令与调用点（否则解析器坏掉也会绿）。
 *
 * 已知边界（如实写在判据里，不假装全知）：只扫 `lib.rs` 一个文件 —— 跨模块调用
 * （`ilink` / `phone` / `ofm` 里对命令的调用）不在这条判据的覆盖内；那些地方今天没有
 * "把命令当普通函数调"的用法，将来若出现，`cargo test --lib`（或者这条判据的扩展）仍然要红。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const LIB_RS = path.join(ROOT, "src-tauri/src/lib.rs");

/**
 * 把注释与字符串字面量换成空白（**保留长度与换行**），这样括号/逗号扫描不会被
 * 文档注释里的 `execute_command(…)` 或字符串里的 `(` 骗到；同时偏移量与原文一一对应，
 * 报错信息可以直接给原文位置。
 */
export function blankOutCommentsAndStrings(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (i: number) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 行注释
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        blank(i);
        i++;
      }
      continue;
    }
    // 块注释（Rust 可嵌套）
    if (c === "/" && c2 === "*") {
      let depth = 0;
      while (i < n) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          blank(i);
          blank(i + 1);
          i += 2;
          continue;
        }
        if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          blank(i);
          blank(i + 1);
          i += 2;
          if (depth === 0) break;
          continue;
        }
        blank(i);
        i++;
      }
      continue;
    }
    // 原始字符串 r"…" / r#"…"# / br"…"
    if (c === "r" || (c === "b" && src[i + 1] === "r")) {
      const rAt = c === "r" ? i : i + 1;
      let j = rAt + 1;
      let hashes = 0;
      while (src[j] === "#") {
        hashes++;
        j++;
      }
      if (src[j] === '"') {
        // 起点到开引号都算字符串
        for (let k = i; k <= j; k++) blank(k);
        let k = j + 1;
        const closer = '"' + "#".repeat(hashes);
        while (k < n) {
          if (src.startsWith(closer, k)) {
            for (let m = k; m < k + closer.length; m++) blank(m);
            k += closer.length;
            break;
          }
          blank(k);
          k++;
        }
        i = k;
        continue;
      }
    }
    // 普通字符串
    if (c === '"') {
      blank(i);
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          blank(i);
          blank(i + 1);
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          blank(i);
          i++;
          break;
        }
        blank(i);
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 从 `open`（指向 `(`）开始，返回配对括号内文本与右括号下标 */
export function parenSpan(clean: string, open: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    const c = clean[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return { inner: clean.slice(open + 1, i), end: i };
    }
  }
  throw new Error("括号没有配对（判据自己的解析器出错了）");
}

/** 顶层逗号切分（忽略嵌套括号里的逗号）；空文本 ⇒ 0 段 */
export function topLevelArgs(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of inner) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "" || parts.length > 0) parts.push(cur);
  return parts.filter((p, idx) => !(idx === parts.length - 1 && p.trim() === ""));
}

export interface CmdDef {
  name: string;
  params: number;
  defAt: number;
}
export interface CallSite {
  name: string;
  args: number;
  at: number;
}

/** 解析出所有 `#[tauri::command]` 函数定义 */
export function commandDefs(clean: string): CmdDef[] {
  const defs: CmdDef[] = [];
  const marker = "#[tauri::command]";
  let at = clean.indexOf(marker);
  while (at >= 0) {
    const fnAt = clean.indexOf("fn ", at);
    expect(fnAt, "`#[tauri::command]` 之后必须紧跟一个 fn").toBeGreaterThan(at);
    const nameMatch = clean.slice(fnAt).match(/^fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/);
    expect(nameMatch, "解析不出命令名").toBeTruthy();
    const name = nameMatch![1]!;
    const openParen = fnAt + nameMatch![0].length - 1;
    const { inner } = parenSpan(clean, openParen);
    defs.push({ name, params: topLevelArgs(inner).length, defAt: openParen });
    at = clean.indexOf(marker, at + marker.length);
  }
  return defs;
}

/** 找出某个函数名在文件里的所有调用点（`名字(`，排除定义处） */
export function callSites(clean: string, def: CmdDef): CallSite[] {
  const re = new RegExp("\\b" + def.name + "\\s*(?:<[^>]*>)?\\s*\\(", "g");
  const out: CallSite[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const openParen = m.index + m[0].length - 1;
    if (openParen === def.defAt) continue; // 定义处
    const { inner } = parenSpan(clean, openParen);
    out.push({ name: def.name, args: topLevelArgs(inner).length, at: m.index });
  }
  return out;
}

const raw = fs.readFileSync(LIB_RS, "utf8");
const clean = blankOutCommentsAndStrings(raw);
const defs = commandDefs(clean);

describe("TAURI-ARITY：命令签名与 Rust 侧调用点必须同步", () => {
  it("TAURI-ARITY-1：每一处调用命令的实参个数都必须等于它自己的形参个数", () => {
    const mismatches: string[] = [];
    let checkedCalls = 0;
    for (const def of defs) {
      for (const site of callSites(clean, def)) {
        checkedCalls++;
        if (site.args !== def.params) {
          const line = clean.slice(0, site.at).split("\n").length;
          mismatches.push(
            `${def.name}: 形参 ${def.params} ≠ 实参 ${site.args}（lib.rs:${line}）—— ` +
              "改了函数签名就要同步这里的调用（本轮 `execute_command` 就是这么炸的：E0061 ⇒ `cargo test --lib` 编不过）",
          );
        }
      }
    }
    expect(mismatches, "命令调用点的实参个数与签名不一致：" + mismatches.join("；")).toEqual([]);
    /*
     * 护栏：**不许空跑**。解析器一旦坏掉（比如 `#[tauri::command]` 的写法变了），
     * 上面那条 `toEqual([])` 会对着一片空白永远绿 —— 那才是最容易发生的假绿。
     */
    expect(defs.length, "至少要解析出 10 个 `#[tauri::command]` 函数（否则解析器坏了）").toBeGreaterThanOrEqual(10);
    expect(checkedCalls, "至少要检查到 3 处 Rust 侧调用（否则这条判据是空跑）").toBeGreaterThanOrEqual(3);
  });

  it("TAURI-ARITY-2：`execute_command` 这条真缺陷被点名守着（5 形参 / 3 处用例都按 5 参调）", () => {
    const def = defs.find((d) => d.name === "execute_command");
    expect(def, "前提：`execute_command` 必须是 `#[tauri::command]`").toBeTruthy();
    expect(def!.params, "它是 5 参（command/cwd/timeout_ms/shell/bash_path）").toBe(5);
    const sites = callSites(clean, def!);
    expect(sites.length, "lib.rs 里那三条用例必须都被看到").toBeGreaterThanOrEqual(3);
    expect(sites.map((s) => s.args), "每一处都必须传满 5 个实参").toEqual(sites.map(() => 5));
  });
});

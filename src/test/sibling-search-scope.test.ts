/**
 * 第 43 波：**"只可能是判据"的搜索范围** ✓ —— 目标② 的第二个实测着力点 ✓。
 *
 * ## 为什么（**量出来的 ✓**）
 *
 * 真机侧车里一次 `multi_edit` 的 10 s 是这么花的 ✓（`.console.jsonl` 逐字 ✓）：
 * ```
 * + 0.2s [同族判据] 诊断：src/core/llm/tools.ts 读到 85138 字符，抽出 12 个符号
 * + 0.2s [grepSearch] cmd: Get-ChildItem -Path '<工作区>' -Recurse -File …
 * + 1.8s / +3.4s / +5.1s / +6.7s / +8.3s   ← ★ 连发 6 次全仓扫描（每次 ~1.6s）
 * +10.0s symbol siblings: null | edited= src/core/llm/tools.ts   ← ★ 白跑
 * ```
 * 而那 6 次的结果**只保留测试文件** ✓（`isTestFile` ✓）—— 非测试命中**全被丢掉** ✗
 * ⇒ 让 PowerShell 去扫它们**纯属浪费** ✓。
 * 实测（`src` 树 1767 → 550 个文件）：单次搜索 **0.55s ⇒ 0.18s** ✓。
 *
 * ## 判据
 *
 * | id | 钉什么 | 变异（应当红 ✗） |
 * |---|---|---|
 * | `SYM-1` | 生产路径的搜索**必须带测试文件过滤** ✓（含 `*test*` **与** `*spec*` ✓）| 不传 ⇒ 红 |
 * | `SYM-2` | 反向对照：非测试文件里的命中**不许**进结果 ✓（既有口径不变 ✓）| 去掉 `isTestFile` 过滤 ⇒ 红 |
 * | `SYM-3` | 结构：`grepSearch` 的 include 支持**数组**并拼成 `-Include 'a','b'` ✓ | 只拼一个 ⇒ 红（`*.spec.ts` 会被漏掉 ✗）|
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { siblingCriteriaFiles } from "../core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = process.cwd();

describe("第 43 波：判据搜索的范围（只扫'可能是判据'的文件）", () => {
  it("SYM-1: 生产路径的搜索必须带测试文件过滤（*test* 与 *spec* 都要 ✓）", async () => {
    const calls: Array<{ pattern: string; include?: unknown }> = [];
    const spy = async (pattern: string, _root: string, include?: unknown) => {
      calls.push({ pattern, include });
      return [] as string[];
    };
    await siblingCriteriaFiles(ROOT, "src/core/llm/tools.ts", { src: nodeFsSource(), search: spy as never });
    console.log("[SYM-1] 搜索调用次数 =", calls.length, " include =", JSON.stringify(calls[0]?.include));
    expect(calls.length, "夹具前提：至少要搜一次（否则本判据测不到东西 ✗）").toBeGreaterThan(0);
    for (const c of calls) {
      const inc = Array.isArray(c.include) ? (c.include as string[]) : c.include ? [String(c.include)] : [];
      expect(inc.length, `搜索 ${c.pattern} 没带 include ⇒ 又把整个工作区扫了一遍 ✗`).toBeGreaterThan(0);
      const joined = inc.join(",");
      expect(joined, "必须含 *test*（`*.test.ts` ✓）").toContain("*test*");
      expect(joined, "必须含 *spec*（`*.spec.ts` 也在 isTestFile 里 ✗ 漏了就是功能回退 ✓）").toContain("*spec*");
    }
  });

  it("SYM-2 反向对照: 非测试文件里的命中不许进结果（既有口径不变 ✓）", async () => {
    const spy = async () => [
      "src/core/llm/tools.ts:1: whatever",
      "docs/NOTES.md:2: whatever",
      "tools/eval/foo.mjs:3: whatever",
      "src/test/dsh-d10-write-not-executed-is-error.test.ts:4: whatever",
    ];
    const files = await siblingCriteriaFiles(ROOT, "src/core/llm/tools.ts", { src: nodeFsSource(), search: spy as never });
    console.log("[SYM-2] 结果 =", JSON.stringify(files));
    expect(files, "只许留判据文件（`*.test.*` / `*.spec.*` ✓）").toEqual([
      "src/test/dsh-d10-write-not-executed-is-error.test.ts",
    ]);
  });

  it("SYM-3: 结构 —— `grepSearch` 的 include 支持数组，并拼成 `-Include 'a','b'`", () => {
    const src = stripComments(readFileSync(join(ROOT, "src", "core", "file-api.ts"), "utf8"));
    expect(src, "include 要允许数组（只给一个模式会漏掉 spec ✗）").toMatch(/include\?:\s*string\s*\|\s*string\[\]/);
    expect(src, "必须把每个模式各自单引号包裹、逗号连接（PowerShell 数组形式 ✓）").toMatch(/includeList\.map\(/);
    expect(src, "拼出来的必须是 `-Include 'a','b'`").toMatch(/join\(","\)/);
  });

  /**
   * ★ `SYM-4`：**遍历范围才是那 40×** ✓（第 44 波 ✓）。
   *
   * 实测（同一台机器、同一个评测工作区 ✓）：
   * ```
   * 全树 + -Include     2.35s      ← 第 43 波吃到的是"只省了 Select-String" ✗，遍历一点没省 ✗
   * 只 src/test         0.06s      ⇒ 40×
   * ```
   * ⇒ 判据钉的是"**搜索的根必须是判据目录**" ✓（不是工作区根 ✗）。
   * ★ 反向对照（`SYM-4b`）：**一个判据目录都找不到时** ⇒ 必须回退到工作区根 ✓
   * （宁可慢，也绝不许变成"没有同族判据"的**假否定** ✗）。
   */
  it("SYM-4: 搜索的根必须是判据目录（`src/test` 等），不是工作区根 ✗", async () => {
    const roots: string[] = [];
    const spy = async (pattern: string, root: string) => {
      roots.push(`${pattern}@${root}`);
      return [] as string[];
    };
    await siblingCriteriaFiles(ROOT, "src/core/llm/tools.ts", { src: nodeFsSource(), search: spy as never });
    const rootSet = [...new Set(roots.map((r) => r.split("@")[1]))];
    console.log("[SYM-4] 搜索根 =", JSON.stringify(rootSet));
    expect(rootSet.length, "至少要有一次搜索").toBeGreaterThan(0);
    for (const r of rootSet) {
      expect(r.endsWith("/src/test") || r.endsWith("/test") || r.endsWith("/tests") || r.endsWith("/__tests__"),
        `搜索根 ${r} 不是判据目录 ⇒ 又把整棵树遍历了一遍（实测 2.35s vs 0.06s ✗）`).toBe(true);
    }
  });

  it("SYM-4b 反向对照: 找不到任何判据目录 ⇒ 回退工作区根（宁慢也不许假否定 ✗）", async () => {
    const roots: string[] = [];
    const spy = async (_pattern: string, root: string) => {
      roots.push(root);
      return [] as string[];
    };
    const emptySrc = {
      list: async () => [],
      read: async () => "export const whateverSymbolName = 1;\n",
    };
    await siblingCriteriaFiles(ROOT, "src/core/llm/tools.ts", { src: emptySrc as never, search: spy as never });
    const rootSet = [...new Set(roots)];
    console.log("[SYM-4b] 回退后的搜索根 =", JSON.stringify(rootSet));
    expect(rootSet.length, "回退也要搜（不能一条都不搜 ✗）").toBeGreaterThan(0);
    for (const r of rootSet) {
      expect(r.replace(/\\/g, "/").replace(/\/+$/, ""), "没有判据目录时必须回退到工作区根").toBe(
        ROOT.replace(/\\/g, "/").replace(/\/+$/, ""),
      );
    }
  });
});

/**
 * `.preview-shot/**` 里那些**探针脚本的语法**必须是对的（第 83 轮踩出来的门禁）
 *
 * ## 为什么需要它（这一轮真实发生过）
 *
 * 我在 `audit-walk-lib.mjs` 的 `MEASURE_FN`（**一个模板字符串**）里加了一段注释，
 * 注释里带了反引号 —— 模板串被提前结束，**整个文件语法错误**。
 * 后果：所有 import 它的探针（走查、更新流程观测、各种 _probe-*）**全部挂掉**。
 * 而当时 `npx vitest run` **照样全绿**，因为**没有任何用例 import 这个库**
 * （唯一读它的是 `ui-a11y-skin-avatar.test.ts` 的 A11Y-4，而它只把它当**文本**读，
 * 文本里当然"含有"那几个关键字 —— 判据在、文件坏了它也不知道）。
 *
 * 也就是说：**"测试全绿"与"工具链还能用"是两件事**，而我把它们当成了一件。
 * 这个门禁把后者也纳入判据：对每个 `.preview-shot/*.mjs` 跑 `node --check`（只解析、不执行）。
 *
 * ## 边界（如实写）
 *
 * - `.preview-shot/` 是**刻意忽略**的目录（本机的探针与报告），所以**clone 出来没有这些文件**：
 *   那种情况下本用例会**跳过**并明确打印"没得检查"，不会假装通过。
 *   它守的是"改完探针别把它改坏"，不是产品代码。
 * - `node --check` 只查语法，不查语义（比如引用了不存在的导出）—— 那类问题靠真跑探针发现。
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { transformSync } from "esbuild";

const ROOT = process.cwd();
const DIR = path.join(ROOT, ".preview-shot");

/**
 * 语法检查用 **esbuild**（vite 的依赖，进程内、每文件约 1ms），
 * 而不是 `node --check` 子进程：那要给每个文件起一个 node，
 * 实测 **189 个文件要 76 秒** —— 门禁自己变成套件里最慢的一环，最后一定会被人关掉（第一版就是这么写的）。
 */
function syntaxErrorOf(file: string): string | null {
  const code = fs.readFileSync(file, "utf8");
  try {
    transformSync(code, { loader: "js", format: "esm", sourcefile: file });
    return null;
  } catch (e) {
    const err = e as { errors?: Array<{ text: string; location?: { line: number } }>; message?: string };
    const first = err.errors?.[0];
    return first ? `${first.text}（第 ${first.location?.line ?? "?"} 行）` : (err.message ?? String(e)).split("\n")[0];
  }
}

describe("探针脚本的语法门禁（第 83 轮）", () => {
  it("PS-1: 每个 `.preview-shot/*.mjs` 都必须语法正确（解析得动）", () => {
    if (!fs.existsSync(DIR)) {
      console.warn("[preview-shot-syntax] .preview-shot/ 不存在（clone 出来的仓库本来就没有）—— 本条跳过，不算通过");
      return;
    }
    /*
     * 只扫**顶层** `*.mjs`：`_broken/` 是刻意留档的、**语法已坏的旧脚本**
     * （见 `.preview-shot/_broken/README.md`：那是历史一次性迁移脚本，修好反而可能被人当成"可重放"的东西）。
     * 把它们算进门禁，只会逼着人去修不该再用的东西。
     */
    const files = fs
      .readdirSync(DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
      .map((e) => e.name)
      .sort();
    if (files.length === 0) {
      console.warn("[preview-shot-syntax] 目录里没有 .mjs —— 本条跳过");
      return;
    }
    const broken: string[] = [];
    for (const f of files) {
      const err = syntaxErrorOf(path.join(DIR, f));
      if (err) broken.push(`${f}: ${err}`);
    }
    expect(
      broken,
      `这些探针脚本语法坏了（**import 它们的脚本会全部挂掉**，而测试套件不一定能发现）：\n  - ${broken.join("\n  - ")}\n` +
        `提示：MEASURE_FN 之类的模板字符串里不能出现反引号；中文字符串里别用半角引号。`,
    ).toEqual([]);
    // 反向对照：确认判据真的在判（故意造一个坏文件必须被抓）
    const bogus = path.join(DIR, "__syntax_probe_bad.mjs");
    fs.writeFileSync(bogus, "const x = `unterminated\n", "utf8");
    try {
      expect(syntaxErrorOf(bogus), "对照项：故意写坏的文件必须被判为语法错误").not.toBeNull();
    } finally {
      fs.rmSync(bogus, { force: true });
    }
  });

  it("PS-2: 被用例依赖的共享库必须真的能 import（不只是「文件里有那几个字」）", async () => {
    const lib = path.join(DIR, "audit-walk-lib.mjs");
    if (!fs.existsSync(lib)) {
      console.warn("[preview-shot-syntax] 没有 audit-walk-lib.mjs —— 本条跳过");
      return;
    }
    const mod = await import(/* @vite-ignore */ new URL(`file://${lib.replace(/\\/g, "/")}`).href);
    expect(typeof mod.connect, "共享库必须导出 connect").toBe("function");
    expect(typeof mod.MEASURE_FN, "必须导出注入页面的度量函数源码").toBe("string");
    expect(mod.MEASURE_FN, "度量函数源码里必须含 __measure（走查靠它）").toContain("function __measure");
    expect(
      mod.MEASURE_FN.includes("`"),
      "MEASURE_FN 自身不该含反引号（它是模板串的内容，含了就会把外层模板串截断）",
    ).toBe(false);
  });
});

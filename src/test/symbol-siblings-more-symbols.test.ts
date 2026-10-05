/**
 * 第 133 波（再续）：**不能只试最长的 3 个符号**。
 *
 * ## 证据
 *
 * 1.16.249（已修好路径解析 ✓）的真机日志仍然是：
 * ```
 * [agent-loop] symbol siblings: null | edited= src/core/llm/tools.ts
 * ```
 * 而 `tools.ts` 里**确有**被 `dsh-d9` 引用的符号（`applyToolResultStatus` ✓）。
 *
 * 差别在**选哪几个符号去搜**：`extractSymbols` 按**长度倒序**取前 5 ✓，
 * 到 `buildSymbolSiblings` 里只拿**前 3 个**去 grep ✗ ⇒
 * 如果这 3 个恰好都**没有**任何测试文件提到（长名字常常是实现细节 ✗），
 * 函数就返回 null ✗ —— 与 `repo-02` 的真机现象完全一致 ✓。
 *
 * ## 本判据钉什么
 *
 * 一个文件里：**最长的 3 个符号都没被测到** ✓，但第 4/5 个**被测到** ✓ ⇒ 必须仍然产出提示 ✓。
 * 变异：把搜索符号数改回 3 ⇒ 本判据红 ✓。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSymbolSiblings, extractSymbols } from "../../src/core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";

/** 只对"被测到的那一个符号"返回命中（模拟真机里其余符号无人引用 ✓） */
function searchOnlyFor(root: string, onlySymbol: string) {
  return async (pattern: string, _root: string): Promise<string[]> => {
    if (pattern !== onlySymbol) return [];
    const abs = join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts");
    return [`${abs}:7: // ${pattern}`];
  };
}

describe("第 133 波：同族判据要试足够多的符号（别只试最长的三个）", () => {
  it("SSB-8: 最长的三个符号都没被测到、第四个被测到 ⇒ 仍然要产出提示", async () => {
    const root = mkdtempSync(join(tmpdir(), "codem-more-symbols-"));
    try {
      mkdirSync(join(root, "src", "core", "llm"), { recursive: true });
      mkdirSync(join(root, "src", "test"), { recursive: true });
      /**
       * 造一个文件：**五六个很长**的标识符（几乎不可能被测到 ✓）+ 一个较短但被测到的 ✓。
       * 数量要够多 —— 只放三个的话，"最短的那个"可能恰好挤进前三个 ✗（第一次就是这么写的 ✗）。
       */
      const noise = [
        "extremelyLongUnreferencedIdentifierAlpha",
        "anotherVeryLongUnreferencedIdentifierBeta",
        "thirdOverlyLongUnreferencedIdentifierGamma",
        "yetAnotherLongUnreferencedHelperDelta",
        "stillOneMoreLongUnreferencedEpsilonZeta",
        "seventhLongUnreferencedIdentifierEtaTheta",
      ];
      const targeted = "applyToolResultStatus";
      writeFileSync(
        join(root, "src", "core", "llm", "tools.ts"),
        noise.map((n) => `export function ${n}() {}`).join("\n") + `\nexport function ${targeted}() {}\n`,
      );
      writeFileSync(join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts"), `// ${targeted}\n`);

      // 夹具前提：被测到的那一个**确实排在**前三个之外（这才是本判据要覆盖的形状 ✓）
      const syms = extractSymbols(noise.map((n) => `export function ${n}() {}`).join("\n") + `\nexport function ${targeted}() {}`, 12);
      expect(syms.slice(0, 3), `夹具前提：${targeted} 不该出现在前三个里（实际前三个：${syms.slice(0, 3).join(", ")}）`).not.toContain(targeted);

      const text = await buildSymbolSiblings(root, "src/core/llm/tools.ts", {
        src: nodeFsSource(),
        search: searchOnlyFor(root, targeted),
      });
      expect(text, "第 4 个符号被测到 ⇒ 必须产出提示").toBeTruthy();
      expect(text!).toContain("dsh-d9-multi-edit-partial-failure.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

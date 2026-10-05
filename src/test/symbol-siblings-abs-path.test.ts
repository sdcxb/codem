/**
 * 第 133 波（续）：**`grepSearch` 返回的是 Windows 绝对路径，解析必须扛得住盘符**。
 *
 * ## 证据链
 *
 * - `core/file-api.ts::grepSearch` 的 PowerShell 是
 *   `$_.Path + ':' + $_.LineNumber + ':' + $_.Line` ⇒ 行形如
 *   `C:\...\src\test\dsh-d9-multi-edit-partial-failure.test.ts:12: …` ✓；
 * - `buildSymbolSiblings` 原来用 `String(row).split(":")[0]` 取路径 ✗ ⇒ 在 Windows 上得到 **`C`** ✗
 *   ⇒ `isTestFile("C")` 为假 ⇒ **所有命中都被过滤掉** ✗ ⇒ 函数**永远返回 null** ✗；
 * - 判据侧的 helper（`node-grep-source.ts`）返回的是**相对路径** ✓ ⇒ 判据全绿而真机全空 ✗
 *   —— 与 113/114 波同一类"夹具与现实不一致" ✓；
 * - 真机后果（1.16.248 采样，repo-02 连续三轮）：三轮都只编辑了 `tools.ts` ✓
 *   （那里的符号正被 `dsh-d9` 提到 ✓），但 `tool_calls.result` / `messages.content` /
 *   `session_events` 三张表里**都没有**"同族判据"字样 ✗ ⇒ 机制**从未产出过** ✓。
 *
 * ## 本判据钉什么
 *
 * **用真机的行格式**（绝对路径 + 盘符 + 行号 ✓）驱动，必须能认出测试文件并列出 ✓。
 * 变异：把解析改回 `split(":")[0]` ⇒ 本判据红 ✓。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSymbolSiblings } from "../../src/core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";

/** 模拟**应用自己的** grep 返回格式：绝对路径:行号: 内容（含盘符 ✗ 不能按 ':' 切 ✗） */
function windowsStyleSearch(root: string) {
  return async (pattern: string, _root: string): Promise<string[]> => {
    const abs = join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts");
    return [`${abs}:12: // ${pattern} 的判据`];
  };
}

describe("第 133 波：同族判据必须扛得住 Windows 绝对路径（grepSearch 的真实格式）", () => {
  it("SSB-7: 命中行是 `C:\\…\\x.test.ts:12: …` 时，仍要认出它是判据文件并列出", async () => {
    const root = mkdtempSync(join(tmpdir(), "codem-abs-path-"));
    try {
      mkdirSync(join(root, "src", "core", "llm"), { recursive: true });
      mkdirSync(join(root, "src", "test"), { recursive: true });
      writeFileSync(join(root, "src", "core", "llm", "tools.ts"), "export function applyToolResultStatus() {}\n");
      writeFileSync(join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts"), "// applyToolResultStatus\n");

      const text = await buildSymbolSiblings(root, "src/core/llm/tools.ts", {
        src: nodeFsSource(),
        search: windowsStyleSearch(root),
      });
      expect(text, "绝对路径的行也必须能产出提示（真机就是这个格式）").toBeTruthy();
      expect(text!).toContain("dsh-d9-multi-edit-partial-failure.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * 第 134 波：**"同族判据"的额度不该被 agent 自己写的临时脚本吃掉**。
 *
 * ## 证据（1.16.251 真机日志）
 *
 * 机制**已经能产出**了 ✓（`symbol siblings: 711 chars` ✓），但它产出的对象是：
 * ```
 * 诊断：tmp-inspect.mjs 读到 236 字符，抽出 1 个符号
 * 诊断：tmp-dump.mjs    读到 726 字符，抽出 11 个符号
 * 诊断：tmp-scan.mjs    读到 744 字符，抽出 5 个符号
 * 诊断：tmp-skel.mjs    读到 1176 字符，抽出 10 个符号
 * ```
 * —— 全是 agent **自己写在仓库根目录**的临时脚本 ✗（不是项目源码 ✗，
 * 它们当然不会"被任何判据提到" ✓，所以那 4 次里有几次其实空转 ✗）。
 * 而每回合的总额度只有 4 个文件 ✗ ⇒ **等它去编辑真正的 `src/core/llm/tools.ts` 时，额度已经用完** ✗。
 *
 * 真机后果：1.16.251 上 repo-02 连跑四轮 **0/4** ✗，diff 只有 1036–1445（改动很少 ✗）。
 *
 * ## 改法
 *
 * **根目录下的文件不参与**（相对路径里没有目录分隔 ✓）—— 它们几乎总是临时脚本/配置 ✓，
 * 既不会有同族判据 ✓，也不该占用额度 ✓。仍然只陈述事实 ✓、仍然有界 ✓。
 *
 * 变异自证：去掉这个跳过 ⇒ SSB-9 红。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSymbolSiblings } from "../../src/core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";

function rootWithScratch() {
  const root = mkdtempSync(join(tmpdir(), "codem-scratch-"));
  mkdirSync(join(root, "src", "core", "llm"), { recursive: true });
  mkdirSync(join(root, "src", "test"), { recursive: true });
  // 根目录的临时脚本（agent 自己写的那种 ✓）
  writeFileSync(join(root, "tmp-dump.mjs"), "// applyToolResultStatus 也出现在这里\n");
  // 项目源码
  writeFileSync(join(root, "src", "core", "llm", "tools.ts"), "export function applyToolResultStatus() {}\n");
  writeFileSync(join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts"), "// applyToolResultStatus 的判据\n");
  return root;
}

/** 无论搜什么，都返回同一条测试文件命中（用来单独检验"额度有没有被吃掉" ✓） */
function alwaysHit(root: string) {
  return async (_pattern: string, _root: string): Promise<string[]> => [
    `${join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts")}:3: hit`,
  ];
}

describe("第 134 波：临时脚本不该占用同族判据的额度", () => {
  it("SSB-9: 根目录文件（相对路径没有目录）不参与 ⇒ 返回 null，且不消耗额度", async () => {
    const root = rootWithScratch();
    try {
      const text = await buildSymbolSiblings(root, "tmp-dump.mjs", { src: nodeFsSource(), search: alwaysHit(root) });
      expect(text, "根目录的临时脚本不该产出同族判据（否则白占一个额度 ✗）").toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("SSB-10 反向对照: 项目源码（`src/…`）仍然照常产出 ⇒ 别把该给的也一起关掉", async () => {
    const root = rootWithScratch();
    try {
      const text = await buildSymbolSiblings(root, "src/core/llm/tools.ts", { src: nodeFsSource(), search: alwaysHit(root) });
      expect(text, "项目源码必须照常产出").toBeTruthy();
      expect(text!).toContain("dsh-d9-multi-edit-partial-failure.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

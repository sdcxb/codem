/**
 * 第 125 波：**"你刚改的符号，还有哪些判据文件提到"**（符号共享的同族判据）。
 *
 * ## 为什么它和前面四个机制不是一类（§13.47）
 *
 * 前四个（列全成员 / 红了重放 / 每族可跑命令 / 全仓库搜任务词）都是"把信息送到眼前" ✗，
 * 对 repo-02 全部无效 ✗。而对照臂赢的那次用的原语是：
 * **一次 grep（按符号）⇒ 匹配清单里同时出现源码与测试文件** ✓ ⇒ 它看见 `dsh-d9-…` 就去读 ✓。
 *
 * 本机制把**同一个原语**放在**它自己刚动作之后**：
 * 它编辑了 `tools.ts`（里面有多编辑/部分失败相关的符号 ✓）⇒ 我们拿这些**符号**去 grep 一次 ✓
 * ⇒ 把命中的**测试文件**（这些就是"同族判据" ✓）以**事实**形式列出来 ✓。
 *
 * 与"送信息"的区别：这条事实是**由它自己的编辑动作触发**的 ✓、内容与它**刚刚做的事直接相关** ✓，
 * 而且**不判断**（不说"你应该跑""你漏了" ✗），只是把"哪些判据文件也提到这些符号"摆出来 ✓。
 *
 * 变异自证：把"只保留测试文件"的过滤去掉 ⇒ SSB-3 红；把"没有命中就不追加"去掉 ⇒ SSB-2 红。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSymbolSiblings, extractSymbols } from "../../src/core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";
import { nodeGrepSource } from "./helpers/node-grep-source";

function ws() {
  const root = mkdtempSync(join(tmpdir(), "codem-symbol-siblings-"));
  mkdirSync(join(root, "src", "core", "llm"), { recursive: true });
  mkdirSync(join(root, "src", "test"), { recursive: true });
  writeFileSync(
    join(root, "src", "core", "llm", "tools.ts"),
    "export function applyToolResultStatus() {}\nexport function classifyToolResult() {}\n",
  );
  writeFileSync(
    join(root, "src", "test", "dsh-d9-multi-edit-partial-failure.test.ts"),
    "// 用到 applyToolResultStatus 与 classifyToolResult\n",
  );
  writeFileSync(join(root, "src", "test", "unrelated-thing.test.ts"), "// 与这两个符号无关\n");
  writeFileSync(join(root, "src", "core", "llm", "other.ts"), "// applyToolResultStatus 的另一处引用\n");
  return root;
}

describe("第 125 波：符号共享的同族判据（在它刚编辑之后给一条直接相关的事实）", () => {
  it("SSB-1: 编辑过的文件里的符号，被哪些**测试**文件提到 —— 要列出来", async () => {
    const root = ws();
    try {
      const text = await buildSymbolSiblings(root, "src/core/llm/tools.ts", {
        src: nodeFsSource(),
        search: nodeGrepSource(),
      });
      expect(text, "夹具前提：应当给出结果").toBeTruthy();
      expect(text!).toContain("dsh-d9-multi-edit-partial-failure.test.ts");
      expect(text!, "措辞要说明这是「也提到这些符号的判据文件」").toMatch(/判据|测试/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("SSB-2 反向对照: 符号没有被任何测试文件提到 ⇒ 不追加任何东西（不留噪声）", async () => {
    const root = mkdtempSync(join(tmpdir(), "codem-symbol-siblings2-"));
    try {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      mkdirSync(join(root, "src", "test"), { recursive: true });
      writeFileSync(join(root, "src", "core", "lonely.ts"), "export function totallyUnreferencedSymbol() {}\n");
      writeFileSync(join(root, "src", "test", "a.test.ts"), "// 什么也不提\n");
      const text = await buildSymbolSiblings(root, "src/core/lonely.ts", { src: nodeFsSource(), search: nodeGrepSource() });
      expect(text, "没有命中就该是 null").toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("SSB-3: **只列测试文件**（源码引用不是判据，别混进来）", async () => {
    const root = ws();
    try {
      const text = await buildSymbolSiblings(root, "src/core/llm/tools.ts", {
        src: nodeFsSource(),
        search: nodeGrepSource(),
      })!;
      expect(text).toContain(".test.ts");
      expect(text, `源码文件不该出现在这一节里：${text}`).not.toContain("src/core/llm/other.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("SSB-4: 抽符号的口径（≥6 字符的标识符，去掉关键字与语言内置）", () => {
    const syms = extractSymbols(
      "export function applyToolResultStatus(x) { const result = classifyToolResult(x); if (typeof result === 'function') return function () {} }",
    );
    expect(syms).toContain("applyToolResultStatus");
    expect(syms).toContain("classifyToolResult");
    expect(syms, "不要把 function/return/const 这类关键字当符号").not.toContain("function");
    expect(syms, "太短的标识符不算").not.toContain("result");
  });
});

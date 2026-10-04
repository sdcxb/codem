/**
 * 第 124 波（续）：**中文子短语**——让"按我的一次性要求改"这类整句也能命中。
 *
 * ## 依据（真实工作区实测）
 *
 * 抽出来的词是整句 ✗：`按我的一次性要求改 | 有个用户反馈 | 写入确认里选 | 文件根本没变 …`
 * ⇒ 在真实仓库里**逐条 0 命中** ✗（只有一条误撞到我自己模块的注释 ✓）⇒ 源码命中一节是空的 ✗。
 *
 * 而对照臂赢的那次真正 grep 的是 **「一次性要求」/「写入确认」** ✓ ——
 * 都是那些整句的**子串** ✓。所以抽词要补上 3–5 字的子串 ✓。
 *
 * 变异自证：把子串那一段去掉 ⇒ TSN-14/15 红。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractSearchTerms, buildTaskSearchNotice } from "../../src/core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";
import { nodeGrepSource } from "./helpers/node-grep-source";

const PROMPT =
  "有个用户反馈：他在写入确认里选「按我的一次性要求改」，也就是**不让 agent 直接覆盖**，结果 agent 说「已经写好了」，可是**文件根本没变**。你查一下哪里出的问题并修好。";

describe("第 124 波：中文子短语（整句在仓库里零命中，子串才有）", () => {
  it("TSN-14: 抽词要包含整句的**子串**（例如「写入确认」「一次性要求」）", () => {
    const terms = extractSearchTerms(PROMPT);
    expect(terms, `实际：${terms.join(" | ")}`).toContain("写入确认");
    expect(terms, `实际：${terms.join(" | ")}`).toContain("一次性要求");
  });

  it("TSN-15: 真实任务的形状 ⇒ 源码命中一节必须能找到实现文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "codem-subphrase-"));
    try {
      mkdirSync(join(root, "src", "core", "llm"), { recursive: true });
      mkdirSync(join(root, "src", "test"), { recursive: true });
      // 实现文件里出现的是**子串**（「写入确认」「一次性要求」），不是整句
      writeFileSync(
        join(root, "src", "core", "llm", "tools.ts"),
        '// 写入确认：用户选「按我的一次性要求改」时（action === "custom"）不得直接覆盖\n',
      );
      for (let i = 0; i < 60; i++) writeFileSync(join(root, "src", "test", `noise-${String(i).padStart(2, "0")}.test.ts`), "// n");

      // 把整句里的引号去掉一点，模拟真实提示的形状
      const notice = await buildTaskSearchNotice(root, PROMPT, { src: nodeFsSource(), search: nodeGrepSource() });
      expect(notice, "夹具前提：应当给出清单").toBeTruthy();
      expect(notice!, "必须通过子串命中到实现文件").toContain("src/core/llm/tools.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

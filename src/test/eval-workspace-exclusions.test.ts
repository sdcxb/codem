/**
 * 第 116 波：**评测工作区的排除清单 + 判定器**。
 *
 * ## 为什么要有判据（这一条是被事故逼出来的）
 *
 * 工作区是 `git archive HEAD` 造的 ⇒ **凡是进了 git 的东西都会进工作区**。
 * 第 116 波我误用 `git add -f` 把 `.preview-shot/`（里面有每次运行的 diff = **各任务的解**）
 * 整个塞进了 git（5527 个文件），而当时的删除逻辑与验证逻辑**都没有覆盖它** ——
 * 差一点让之后每个工作区都自带答案，且没有任何一道闸会拦住。
 *
 * 从那以后：清单 `EXCLUDED_FROM_WORKSPACE` 是**唯一真相**，
 * `removeAnswers()`（删）与 `verifyRepoWorkspace()`（查）都从它派生；
 * 这里的判据钉住"**哪些必须在清单里**"与"**哪些绝不能进清单**"。
 *
 * 变异自证：从清单里删掉 `CHANGELOG.md` ⇒ X-1 立刻红。
 */
import { describe, it, expect } from "vitest";

import { EXCLUDED_FROM_WORKSPACE, isExcludedFromWorkspace } from "../../tools/eval/repo-workspace.mjs";

describe("第 116 波：评测工作区的排除清单", () => {
  it("X-1: 评测自身的资料必须在排除清单里（任务集 / 运行产物 / 分析文档）", () => {
    const mustExclude = [
      "tools/eval", // 任务集：revertPaths、gradeCommand
      ".preview-shot", // 每次运行的 diff = 各任务的解；还有记录与探针
      "docs/HANDOFF-*", // 交接单：任务 ID、失败形态、修法线索
      "docs/DSH-ALIGNMENT-FIX-PLAN.md",
      "docs/PI-ALIGNMENT-FIX-PLAN.md",
      "docs/MEASUREMENT-PLAN-DSH-VS-CODEM.md",
      "CHANGELOG.md", // 发布说明里点名了评测任务与证据
      "docs/PROJECT-GUIDE.md",
    ];
    for (const entry of mustExclude) {
      expect(EXCLUDED_FROM_WORKSPACE, `排除清单里缺 ${entry}`).toContain(entry);
    }
  });

  it("X-2 反向对照: 判据文件与普通源码**绝不能**被排除（判据就是评分依据）", () => {
    for (const rel of [
      "src/test/dsh-d12-session-log-version.test.ts",
      "src/core/llm/tools.ts",
      "src/core/llm/agentic-loop.ts",
      "docs/README.md",
      "package.json",
    ]) {
      expect(isExcludedFromWorkspace(rel), `${rel} 不该被排除`).toBe(false);
    }
  });

  it("X-3: 判定器语义 —— 目录按其子树排除、`*` 只在本段通配", () => {
    // 目录：自身与子树都算
    expect(isExcludedFromWorkspace("tools/eval/tasks-repo.mjs")).toBe(true);
    expect(isExcludedFromWorkspace(".preview-shot/eval-records-codem-repo-v2.jsonl")).toBe(true);
    // 通配：只在 docs/ 下匹配 HANDOFF-*
    expect(isExcludedFromWorkspace("docs/HANDOFF-ANYTHING.md")).toBe(true);
    expect(isExcludedFromWorkspace("src/HANDOFF-x.md")).toBe(false);
    // 不能因为前缀相同就误伤
    expect(isExcludedFromWorkspace("tools/eval-notes/readme.md")).toBe(false);
    expect(isExcludedFromWorkspace("CHANGELOG.md.bak")).toBe(false);
  });
});

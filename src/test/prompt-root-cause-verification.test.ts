/**
 * 第 107 波：**"按根因修 + 验证覆盖面够"的提示词判据**。
 *
 * ## 为什么加这条（有测量证据，不是拍脑袋）
 *
 * 真实仓库档评测里，`repo-02`（"写文件被拒绝却报成功"）这一轮**只有 Codem 没过**。
 * 查会话发现差别很具体：
 *  · `repo-01`（过了）：跑了 **7** 条测试命令，包括判据文件本身；
 *  · `repo-02`（没过）：只跑了 **2** 条，其中一条正是它自己找到的那个判据文件
 *    （`dsh-d10-write-not-executed-is-error.test.ts`，跑绿了），**但没跑同一类缺陷的另一个判据**
 *    （`dsh-d9-multi-edit-partial-failure.test.ts`）—— 于是"只让手边那一个测试变绿"就收工了。
 *
 * 所以这条判据钉的是**提示词里必须有这两句要求**：
 *  ① 修缺陷按根因修，检查同一类缺陷的**其它位置**；
 *  ② 验证要跑**相关模块**的测试（必要时整个套件），不是只跑一个文件。
 *
 * ## 这条判据的边界（要诚实）
 *
 * 它只能钉"要求写进去了"，**钉不了"模型真的照做了"** —— 后者是行为判据，
 * 由真实仓库档评测（§13）承担。所以这里同时说明：**下一轮评测才有它的行为证据**。
 * 变异自证：删掉这两句 ⇒ 本判据立刻红（`_probe` 里跑过一次）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PROMPT_FILE = "src/core/prompt/i18n-templates.ts";

/** 只看真代码/真字符串（注释里提到不算） */
function promptSource(): string {
  return readFileSync(PROMPT_FILE, "utf8");
}

describe("第 107 波：根因修复与验证覆盖面的提示词要求", () => {
  it("PROMPT-ROOT-1: 中文模板要求「按根因修 + 检查同一类缺陷的别处」", () => {
    const src = promptSource();
    expect(src, "缺「按根因修」").toMatch(/修缺陷要按根因修/);
    expect(src, "缺「同一类缺陷在别处还有没有」").toMatch(/同一类缺陷在\*\*别处\*\*还有没有/);
  });

  it("PROMPT-ROOT-2: 中文模板要求「验证覆盖面够：跑相关模块/整个套件，不是只跑一个文件」", () => {
    const src = promptSource();
    expect(src, "缺「至少跑相关模块的测试文件」").toMatch(/至少跑\*\*相关模块\*\*的测试文件/);
    expect(src, "缺「不要只跑你刚找到的那一个文件」").toMatch(/不要只跑你刚找到的那一个文件/);
    expect(src, "缺「只让一个测试变绿不算修好」").toMatch(/只让一个测试变绿.*不算修好/);
  });

  it("PROMPT-ROOT-3: 英文模板有同样的要求（两种语言不能只改一边）", () => {
    const src = promptSource();
    expect(src).toMatch(/Fix defects at the root cause/);
    expect(src).toMatch(/the related module/);
    expect(src).toMatch(/One green test while sibling paths stay broken is not a fix/);
  });
});

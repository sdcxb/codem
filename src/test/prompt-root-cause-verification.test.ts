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

  /**
   * PROMPT-ROOT-4：**"跑过的红测试不许被『完成』盖过去"**。
   *
   * 证据（第 108 波，repo-03 那一轮）：agent 跑 `usage-normalize.test.ts` 等三个文件，
   * 输出 **4 failed**（其中就有最后让它没过的 D7-B/C 与"缺报不产出 cache 键"），
   * 它还专门 `git stash` 回基线又跑了一遍确认同样红 —— 然后只跑了另一组绿的（9 passed）
   * 就收工，回执写"已完成"。**它看见了红，还是把红说成了完成。**
   *
   * 这条规则钉的就是这个收场方式：红要么修掉，要么在回执里点名，不许被"完成"盖过去。
   */
  it("PROMPT-ROOT-4: 要求「跑过的红测试不许被完成盖过去」（中英）", () => {
    const src = promptSource();
    expect(src, "中文缺这条").toMatch(/你刚跑出来的红测试，不许被"完成"两个字盖过去/);
    expect(src, "中文缺收场二选一").toMatch(/要么把它修掉，要么在回执里\*\*点名这条红\*\*/);
    expect(src, "英文缺这条").toMatch(/A red test you just ran may not be papered over/);
    expect(src, "英文缺收场二选一").toMatch(/fix them, or name the failure in your receipt/);
  });

  /**
   * PROMPT-ROOT-5：**这些要求必须出现在真正组装出来的系统提示里**。
   *
   * 为什么单独有一条（本仓最贵的一类缺陷）：判据只断言"模板文件里有这句话"是不够的 ——
   * 如果组装系统提示的那条链路根本没把这个模板段拼进去，这句话就是**死代码**：
   * 判据全绿、模型永远看不到（本仓有过先例：`apiMessages[0]` 恒假，注入曾经是死代码）。
   *
   * 所以这里调用**真正的组装函数** `buildSystemPrompt`，在它的输出里找这三条要求。
   */
  /**
   * PROMPT-ROOT-6（第 116 波）：**动手之前先看到红**。
   *
   * 证据（把我们自己的失败逐条解剖）：四个没过的任务里，最常见的形态是
   * **"从头到尾没跑到那条真正红的判据"** —— repo-02/06 是"既没跑也没读"，
   * 而 repo-03/04 是"跑了、看见了红，却没读它（照症状猜）"。
   * 这条要求针对前者：先复现失败、亲眼看到红，再动手。
   *
   * 边界同 §13.16：判据只能钉"要求写进去了"，行为证据由真实仓库档评测承担。
   */
  it("PROMPT-ROOT-6: 中英都要求「动手前先跑相关测试、亲眼看到那条失败」", () => {
    const src = promptSource();
    expect(src, "中文缺这条要求").toMatch(/动手之前，先确认「现在到底什么在红」/);
    expect(src, "中文缺「先亲眼看到那条失败，再动手改」").toMatch(/先亲眼看到那条失败，再动手改/);
    expect(src, "英文缺这条要求").toMatch(/Before changing anything, see the failure with your own eyes/);
    expect(src, "英文缺「criterion that was actually red was never executed」").toMatch(
      /the criterion that was actually red was never executed/,
    );
  });

  it("PROMPT-ROOT-5: 三条要求真的进了组装出来的系统提示（不是只在模板文件里）", async () => {
    const { buildSystemPrompt } = await import("../core/prompt/prompt");
    // 传最小可用配置：`agent.prompt` 是必填（缺了直接 TypeError，这正是"接线断了会立刻炸"）
    const text = buildSystemPrompt({
      agent: { prompt: "（判据用的最小 agent 段）" },
      workingDirectory: "C:/workspace",
    } as never);
    expect(text.length, "系统提示不该为空").toBeGreaterThan(500);
    expect(text, "「按根因修」没进系统提示").toContain("修缺陷要按根因修");
    expect(text, "「验证覆盖面」没进系统提示").toContain("不要只跑你刚找到的那一个文件");
    expect(text, "「红测试不许被完成盖过去」没进系统提示").toContain("不许被");
    expect(text, "第 116 波那条「先看到红」也没进系统提示").toContain("先亲眼看到那条失败");
  });
});

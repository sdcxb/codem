/**
 * 第 171 波：**两个定稿点必须用同一套"钉住空助手行"的口径** ✓。
 *
 * ## 用户报的那条缺口的成因（真机取证 ✓）
 *
 * ```
 * 样例：1791213550307-9bdme57s6|VISIBLE_BUT_NOT_RECORDED|assistant-1791213671950-20
 * 只读查库：role=assistant  status=done  正文 0 字符  该会话无任何对应事件 ✗
 * ```
 *
 * id 里的 **`-20`** = 第 20 次迭代 ⇒ 它是**中途**定稿的行 ✗（不是收尾那条 ✓）。
 * 而 `executor.ts` 里：
 *
 * | 定稿点 | 空正文 + 零工具调用时 |
 * |---|---|
 * | **收尾**（`if (currentAssistantMsgId)` 分支） | 补一条空 `assistant_text` 把自己钉住 ✓（FWT-C1c ✓） |
 * | **中途**（`case "start"`，`iter > 1`） | **什么都不做** ✗ ⇒ 留下"空且无事件"的行 ✓ |
 *
 * ⇒ 同一个角落在两处用了**两种做法** ✓ —— 这正是本仓库反复吃亏的形态 ✓。
 * 这条门钉住"两处一致"：`case "start"` 里也必须出现同一段 `assistant_text` 补写 ✓。
 *
 * ⚠️ 这是**源码级**门（和 `tool-event-id-pairing.test.ts` 同一套路 ✓）：
 * 它不漂亮，但它能挡住"有人只改一处"这种**回归** ✓ —— 而那正是这次的真实成因 ✓。
 *
 * 变异：把 `case "start"` 里新增的那段 `assistant_text` 删掉 ⇒ **本判据红** ✓。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("第 171 波：中途定稿也要钉住空助手行（两处同口径 ✓）", () => {
  const code = stripComments(readFileSync("src/core/session/executor.ts", "utf8"));

  it("MDW-1: `case \"start\"` 的定稿块里必须有 assistant_text 补写（否则会留下空且无事件的行 ✗）", () => {
    /** 取出 `case "start"` 那一段（到下一个 `case "` 或 `break` 之后的右括号 ✓） */
    const startIdx = code.indexOf('case "start"');
    expect(startIdx, "必须能找到 case \"start\" 分支").toBeGreaterThan(0);
    const seg = code.slice(startIdx, startIdx + 4000);
    const endIdx = seg.indexOf("ensureAssistantMessage();");
    expect(endIdx, "该分支里应当有 ensureAssistantMessage()（第 83 波建行 ✓）").toBeGreaterThan(0);
    const block = seg.slice(0, endIdx);

    expect(
      /assistant_text/.test(block),
      "`case \"start\"` 定稿上一条助手行时，必须**同样**判一次「空正文 + 零工具调用 ⇒ 补空事件」✓\n" +
        "—— 收尾那处早就有这段（FWT-C1c）✓，中途这处漏了 ⇒ 用户两次报的 `assistant-…-20` 就是这么来的 ✗",
    ).toBe(true);
    expect(
      /toolCalls\?\.length \?\? 0\) === 0/.test(block),
      "补空事件的前置必须是「零工具调用」✓（有工具调用的空行由工具事件记账 ✓，不该重复补 ✗）",
    ).toBe(true);
  });

  it("MDW-2: 收尾那处仍然保留同一段（不许为新加的这处把老的删掉 ✗）", () => {
    const occurrences = [...code.matchAll(/assistant_text/g)].length;
    expect(occurrences, "两处都要有 assistant_text 补写 ⇒ 至少两处 ✓").toBeGreaterThanOrEqual(2);
  });
});


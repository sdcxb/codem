/**
 * 第 165 波：**钉住"`tool_call` 与 `tool_result` 必须同 id"** ✓ —— 补上 ORPH-1 没覆盖的那一半。
 *
 * ## 为什么必须有它（老孤儿的成因 ✓）
 *
 * 用户报过一处存量结构异常：
 * `tool_result at seq 13835 references unknown toolCallId: call_00_pLcrhU2XQ4TS09fnSMAV4802` ✗
 *
 * 查证结论 ✓：正常路径只有**一处**写入点（`tool-pipeline.ts` ✓），
 * 而该处在"第 71 轮"修过一次 **id 对齐** ✓ ——
 * `const toolCallId = result.id || ctx.toolCallId` ✓，**两条事件共用它** ✓。
 * 修之前两边 id 不同源（工具结果里的 `id` 一直是空串 ✓）⇒ 才会产出孤儿 ✗。
 *
 * ⇒ 这个性质**必须被守住** ✓：谁要是哪天把 `result.id` 直接写回事件里 ✗，
 * 老孤儿就会重演 ✓（而这种回归**不会**被 ORPH-1 抓到 ✗ —— 那条只测修复路径 ✓）。
 *
 * ## 判据（源码级 ✓，与本仓库既有的门同一套路 ✓）
 *
 * - **PAIR-1**：`tool-pipeline.ts` 里 `append(…, "tool_call", …)` 与 `append(…, "tool_result", …)`
 *   必须**都在**、且都必须用**同一个局部变量**作 `toolCallId` ✓（不许写 `result.id` 之类的表达式 ✗）。
 *
 * 变异：把其中一处改成 `toolCallId: result.id` ⇒ PAIR-1 红 ✓。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const PIPE = "src/core/llm/tool-pipeline.ts";

/** 剥注释再扫 ✓（注释里写着 `result.id` 的**历史**不能算违规 ✗ —— 本仓库吃过这个假阳性的亏 ✓）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("第 165 波：tool_call / tool_result 必须同 id（钉住第 71 轮那次修复 ✓）", () => {
  const code = stripComments(readFileSync(PIPE, "utf8"));

  it("PAIR-1: 两条事件都在，且都用同一个局部变量 toolCallId（不许用 result.id ✗）", () => {
    const callAppends = [...code.matchAll(/\.append\(\s*ctx\.sessionId\s*,\s*"tool_call"[\s\S]{0,400}?\}\s*\)/g)];
    const resultAppends = [...code.matchAll(/\.append\(\s*ctx\.sessionId\s*,\s*"tool_result"[\s\S]{0,400}?\}\s*\)/g)];

    expect(callAppends.length, "必须有一处写 tool_call 事件 ✓").toBeGreaterThan(0);
    expect(resultAppends.length, "必须有一处写 tool_result 事件 ✓").toBeGreaterThan(0);

    for (const m of [...callAppends, ...resultAppends]) {
      const body = m[0];
      expect(
        /toolCallId\s*,\s*\n/.test(body) || /toolCallId:\s*toolCallId\b/.test(body),
        `这条事件必须用**同一个局部变量** toolCallId ✓，而它是：\n${body.slice(0, 200)}\n` +
          `—— 直接写 result.id 之类的表达式会让两条事件不同源 ✗（老孤儿就是这么来的 ✓）`,
      ).toBe(true);
      expect(
        /toolCallId:\s*result\.id/.test(body),
        "不许把 result.id 直接写进事件 ✗（它在工具结果里一直是空串 ✓，正是第 71 轮修掉的形态 ✗）",
      ).toBe(false);
    }
  });

  it("PAIR-2: 那个变量必须来自 result.id || ctx.toolCallId（两边同源的证据 ✓）", () => {
    expect(
      /const\s+toolCallId\s*=\s*result\.id\s*\|\|\s*ctx\.toolCallId/.test(code),
      "id 的选取必须**显式**写成 `result.id || ctx.toolCallId` ✓ —— 这条表达式就是'两边同源'的证据 ✓",
    ).toBe(true);
  });
});

/**
 * `ToolExecuteResult.isError` 的**形状判据**（第 191 波从 `tool-result-status.test.ts` 拆出来）。
 *
 * ## 为什么必须单独一个文件（这不是洁癖，是评测任务能不能成立的问题）
 *
 * 原位置在 `tool-result-status.test.ts` 的 `T-1` 组里，内容是**读源码**断言
 * `src/core/llm/tools.ts` 里写的是 `isError: boolean;`（必填）。第 182 波把 `isError`
 * 改成必填修掉了"内容型工具真失败却被判成功"这个静默缺口，这条断言就是那次修复的钉子。
 *
 * 但 `tools.ts` 同时是 **repo-01 / repo-02 两个真实修复任务的 `revertPaths`** ——
 * 评测工作区会把它 `git checkout` 回修复前那一版（那里是 `isError?:`）⇒ 这条**源码形状**
 * 断言在 bug 状态下必然红。而 `tool-result-status.test.ts` 又被登记成这两个任务的
 * **回归子集**（`relatedTests`：bug 状态下必须**全绿**，否则任务变成"要求修题面没提的东西"）。
 *
 * 两件事直接矛盾，实测就是 `node tools/eval/run-repo-arm.mjs --verify-bug-tests` 报：
 *
 * ```
 * ❌ repo-01/repo-02：回归子集在 bug 状态下就是红的（src/test/tool-result-status.test.ts）
 * ```
 *
 * 处置：把这条**源码形状**判据搬到它自己的文件里 ——
 * ① 保护一点没少（全量测试照样跑它，退回可选照样红）；② `tool-result-status.test.ts`
 * 回到"纯行为回归文件"，在 bug 状态下确实全绿（实测）。
 *
 * 口径（写给下一个搬家的人）：**凡是"读 `revertPaths` 里那个文件的源码"的判据，
 * 都不许放进被它守的任务的 `relatedTests`。**
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("工具结果形状：`isError` 必须保持必填（静默缺口的钉子）", () => {
  it("T-1/TRS-4: `ToolExecuteResult.isError` 必须**必填** —— 退回可选会让静默缺口重新长出来", () => {
    const text = readFileSync("src/core/llm/tools.ts", "utf8");
    expect(
      /^ {2}isError: boolean;/m.test(text),
      "字段必须是必填（`isError: boolean`）。退回 `isError?:` 会让「内容型工具真失败却被判成功」" +
        "这个静默缺口重新出现 —— 那正是第 182 波花 187 处逐条判定修掉的东西。",
    ).toBe(true);
    expect(/isError\?:\s*boolean/.test(text), "不许同时留下可选版本（否则必填形同虚设）").toBe(false);
  });
});

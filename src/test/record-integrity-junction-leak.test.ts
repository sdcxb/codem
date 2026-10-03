/**
 * 第 113 波：**污染判定的盲区**（顺着 junction 走出工作区）。
 *
 * ## 为什么
 *
 * 第 110 波实测到的效度问题：早期评测工作区把 `node_modules` junction 到主仓库根下，
 * 于是 `node_modules\..` 会**解析到答案仓库** —— 而这条路径里**一个 `mimo-gui` 字符都没有**，
 * 老口径（"目标里找特征词"）**看不见它**，那次 run-1 因此无法证明干净、只能作废重跑。
 *
 * 现在判定收在 `codem-record-integrity.mjs` 的 `JUNCTION_ESCAPE_RE` 里，两个臂共用同一份
 * （`run-repo-arm.mjs` 也 import 它）—— **同一条规则只有一份**，免得两条臂各自演化。
 *
 * ## 判据
 *
 * · LK-1：`node_modules\..\src\core\llm\tools.ts` 且结果**成功** ⇒ 判成**泄漏**（作废该次成绩）；
 * · LK-2 反向对照：`src/../lib/util.ts` 这种**单级** `..` ⇒ **不许**判成泄漏（每天都有的正常写法）；
 * · LK-3：`%TEMP%\codem-eval-deps\...`（评测设施落地处）⇒ 判成泄漏；
 * · LK-4 回归：经典的 `C:\mimo-gui\...` ⇒ 仍然判成泄漏。
 *
 * 变异自证：把 `escapes` 从 `mentions` 里摘掉 ⇒ LK-1/LK-3 变红（LK-2/LK-4 仍绿）。
 */
import { describe, it, expect } from "vitest";

import {
  classifySessionAccess,
  JUNCTION_ESCAPE_RE,
  DEFAULT_ANSWER_REPO_RE,
} from "../../tools/eval/codem-record-integrity.mjs";

/** 造一次"调用 + 成功结果"的事件对 */
function callWithSuccess(tool: string, args: Record<string, unknown>) {
  return [
    { event_type: "tool_call", payload: { tool, args } },
    { event_type: "tool_result", payload: { tool, status: "completed", result: "ok" } },
  ];
}

describe("第 113 波：污染判定必须看得见 junction 逃逸", () => {
  it("LK-1: 顺着 node_modules\\.. 走到答案仓库且成功 ⇒ 判成泄漏", () => {
    const result = classifySessionAccess(
      callWithSuccess("read", { path: "node_modules\\..\\src\\core\\llm\\tools.ts" }) as never,
    );
    expect(result.leaks.length, `应当判成泄漏，实际：${JSON.stringify(result)}`).toBe(1);
    expect(result.leaks[0]).toContain("node_modules");
  });

  it("LK-2 反向对照: 单级 `..` 的正常写法不许判成泄漏（别把好成绩判死）", () => {
    const result = classifySessionAccess(callWithSuccess("read", { path: "src/lib/../util.ts" }) as never);
    expect(result.leaks.length, `不该判成泄漏：${JSON.stringify(result)}`).toBe(0);
    expect(result.blocked.length).toBe(0);
  });

  it("LK-3: 出现评测设施目录（codem-eval-deps）⇒ 判成泄漏", () => {
    const result = classifySessionAccess(
      callWithSuccess("bash", { command: "Get-ChildItem $env:TEMP\\codem-eval-deps\\node_modules" }) as never,
    );
    expect(result.leaks.length).toBe(1);
  });

  it("LK-4 回归: 直接写答案仓库路径 ⇒ 仍然判成泄漏（老口径不许退化）", () => {
    const result = classifySessionAccess(callWithSuccess("read", { path: "C:\\mimo-gui\\src\\core\\llm\\tools.ts" }) as never);
    expect(result.leaks.length).toBe(1);
  });

  it("LK-5: 两条规则本身（正则）覆盖与不覆盖的边界一目了然", () => {
    expect(JUNCTION_ESCAPE_RE.test("node_modules/../x")).toBe(true);
    expect(JUNCTION_ESCAPE_RE.test("a/../../b")).toBe(true);
    expect(JUNCTION_ESCAPE_RE.test("src/lib/../util.ts")).toBe(false);
    expect(DEFAULT_ANSWER_REPO_RE.test("C:\\mimo-gui\\x")).toBe(true);
  });
});

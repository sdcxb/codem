/**
 * 第 116 波：**workflow 的接线判据** —— 它必须走沙箱化的 runner，而不是 `new Function`。
 *
 * ## 为什么补这条（同一类缺口：里程碑的五个站点里，只有 workflow 没有判据钉住）
 *
 * "无 eval 运行时"这个里程碑点名了五处：`run_code`、`workflow`、动态插件、hooks、dynamic runner。
 * 前四处里，`run_code`（`js-vm-no-eval.test.ts`）、hooks（`hook-function-vm.test.ts`）、
 * 动态插件（`plugin-sandbox-session.test.ts`）都有"**eval 会抛**"的替身判据；
 * 而 **workflow 一条都没有** —— 它的源码里那个"仍在应用进程内跑（`new Function`）"的注释
 * 甚至是从迁移前一直留到现在的（本轮顺手改掉了那句过时注释）。
 *
 * 光靠"它 import 了 executeCode"不算判据：那是**读代码**，人一改就没人拦。
 * 这里钉的是**行为**：换掉 runner ⇒ workflow 必须走被换进去的那个；
 * 且整条路径不许出现 `new Function`/`eval`（用"eval 会抛"的替身把这条路堵死）。
 *
 * 变异自证：让 workflow 自己 `new Function(code)` 而不是 `executeCode` ⇒ 本判据红。
 */
import { describe, it, expect, afterEach } from "vitest";

import { createDefaultToolRegistry } from "../core/llm/tools";
import { __setScriptRunnerForTests } from "../core/llm/tools/run-code";

afterEach(() => {
  __setScriptRunnerForTests(null);
});

/** 一个最小的 ToolContext（workflow 只用得到 sessionId / 权限相关字段） */
function ctx(): any {
  return {
    sessionId: "workflow-wiring",
    cwd: process.cwd(),
    workspace: process.cwd(),
    abort: new AbortController().signal,
  };
}

describe("第 116 波：workflow 必须走沙箱 runner（无 eval 运行的接线判据）", () => {
  it("WF-1: workflow 执行用户代码时，必须调用被注入的 runner（而不是自己 eval）", async () => {
    const calls: Array<{ code: string }> = [];
    __setScriptRunnerForTests(async ({ code }) => {
      calls.push({ code });
      return { stdout: "stub-ran\n", stderr: "" };
    });

    const registry = createDefaultToolRegistry();
    const tool = registry.get("workflow")!;
    const result = await (tool as any).execute(
      {
        // 最小可用 workflow：只做一件事，不碰 sdk（免得判据依赖闸门行为）
        code: "console.log('hello from workflow');",
      },
      ctx(),
    );

    expect(calls.length, `workflow 必须把代码交给 runner，实际调用 ${calls.length} 次`).toBeGreaterThan(0);
    expect(calls[0].code).toContain("hello from workflow");
    // 结果里应当能看到 runner 的产出（证明走的是它，而不是被静默吞掉）
    expect(String((result as any).output ?? JSON.stringify(result))).toContain("stub-ran");
  });

  it("WF-2: 整条路径里 `new Function` / `eval` 一旦被调用就抛（替身把老路堵死）", async () => {
    const realFunction = globalThis.Function;
    /**
     * 与 `js-vm-no-eval.test.ts` / `plugin-sandbox-session.test.ts` 同款替身：
     * 真机 CSP 下 `new Function` 会直接抛违规，这里把同样的行为搬进判据。
     */
    // @ts-expect-error 判据里故意替换全局构造器
    globalThis.Function = function blocked(...args: unknown[]) {
      throw new Error("CSP: 'unsafe-eval' is not an allowed source of script —— 这条路径不许再用 eval 系");
    } as unknown as FunctionConstructor;
    try {
      __setScriptRunnerForTests(async ({ code }) => ({ stdout: `ran:${code.includes("x")}\n`, stderr: "" }));
      const registry = createDefaultToolRegistry();
      const tool = registry.get("workflow")!;
      const result = await (tool as any).execute({ code: "const x = 1; console.log(x);" }, ctx());
      const text = String((result as any).output ?? JSON.stringify(result));
      /**
       * ⚠️ 第一版只断言 `resolves.toBeTruthy()` —— **变异存活了**：
       * 工具内部会把执行异常**接住并渲染成结果文本**，所以"抛了"照样 resolves。
       * 判据必须看**结果的文本**：既要看到 runner 的产出，又**不许**出现 eval 违规那句。
       * （这正是"判据自己假绿"的典型：断言强度不够时，它挡不住任何东西。）
       */
      expect(text, `该路径触发了 eval 系：${text.slice(0, 200)}`).not.toMatch(/unsafe-eval is not an allowed source/);
      expect(text, "应当看到 runner 的产出，证明真的走通了").toContain("ran:true");
    } finally {
      globalThis.Function = realFunction;
    }
  });
});

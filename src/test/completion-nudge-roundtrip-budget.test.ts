/**
 * 第 175 波：**收尾提醒的"往返预算"** —— 判据先行 ✓（下一波实现 ✓）。
 *
 * ## 为什么要管这个（目标②的实测结论 ✓）
 *
 * 1.16.271 的抓取聚合（§13.69 ✓）：
 *
 * ```
 * v42 run-1：应用总时长 227.7s；模型侧 194.6s（TTFT 8.5s + 流式 186.1s）
 * ⇒ 模型占 85%，工具+每轮重建上下文+驱动等待合计仅 15%（每轮 ~1.5s）
 * ⇒ 单次迭代平均 ~10s（模型侧 ~8.5s）
 * ```
 *
 * ⇒ 时间是**模型在吐字** ✓，不是驱动等待、也不是每轮重建 ✗。
 * **而每次收尾提醒都要一整轮往返（~10s）** ✓ —— 一轮里三条守卫若各发一次，
 * 就是 **最多 3 次往返 ≈ 30s ≈ 慢轮的 13%** ✗。
 *
 * ⇒ 结论 ✓：**守卫是拿时延换可见性** ✓ ⇒ 该做的是让提醒**更便宜** ✓
 * （三条**合并成一次往返** ✓），而不是继续无限加守卫 ✓。
 *
 * ## 本判据要钉的行为
 *
 * **三条条件同时成立时，只能多要 `1` 轮** ✓（而不是 3 轮 ✓）：
 * 消息可以是一条把三条理由都写进去的 ✓，但**往返必须只有一次** ✓。
 *
 * ⚠️ **当前是 `it.skip`** ✓（判据先行 ✓）：现在的实现是三段各自 `continue` ✗。
 * 我第一次**临时打开**它实测过 ✓（第 175 波）：
 *
 * ```
 * AssertionError: 三条守卫同时成立也只许多要 1 轮（合并成一次往返 ✓）: expected 5 to be 4
 * ```
 *
 * ⇒ 那个夹具里**触发了 2 条**守卫 ⇒ 5 次请求（= 3 次迭代 + **2 次提醒往返** ✗）
 * ⇒ 按 ~10s/轮算，**多花约 20s** ✓（三条全中将更多 ✓；慢轮 230s 的约 9–13% ✗）。
 * 下一波做"合并成一次往返"时**打开它** ✓，并对"三段各 continue"做变异（应当立刻红 ✓）。
 */
import { describe, expect, it, vi } from "vitest";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { ScriptedProvider } from "./helpers/scripted-provider";

vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
  reportAdvisory: () => {},
}));

function bashIteration(id: string, command: string): any[] {
  return [
    { type: "tool_use_start", id, name: "bash" },
    { type: "tool_use_delta", id, input: JSON.stringify({ command }) },
    { type: "tool_use_end", id, input: { command } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function readIteration(id: string, path: string): any[] {
  return [
    { type: "tool_use_start", id, name: "read" },
    { type: "tool_use_delta", id, input: JSON.stringify({ path }) },
    { type: "tool_use_end", id, input: { path } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function finalIteration(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

/** 红判据输出（让"零产出"与"族判据"两条同时成立 ✓） */
const RED_OUTPUT = `
 ❯ src/test/dsh-d10-write-not-executed-is-error.test.ts (4 tests | 1 failed)
 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
`;

function registryWithFakeReadAndBash() {
  const registry = createDefaultToolRegistry();
  registry.register({
    id: "bash",
    description: "假 bash（测试输出由用例给）",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    contract: { sideEffectScope: "system", accessScope: "system" },
    async execute() {
      return { title: "bash", output: RED_OUTPUT };
    },
  } as any);
  registry.register({
    id: "read",
    description: "假 read",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    contract: { sideEffectScope: "none", accessScope: "system" },
    async execute() {
      return { title: "read", output: "// 源码内容" };
    },
  } as any);
  return { registry };
}

describe("第 175 波：收尾提醒的往返预算（判据先行 ✓）", () => {
  it.skip("NR-1（下一波实现后打开）: 三条守卫同时成立 ⇒ 只能多要 **1** 轮，不是 3 轮", async () => {
    const provider = new ScriptedProvider();
    provider.setScript([
      /** 读源码（让"读过源码"成立 ✓）+ 跑一条红判据（让"有红判据"成立 ✓） */
      readIteration("r1", `${process.cwd()}\\src\\core\\llm\\tools.ts`),
      bashIteration("b1", "npx vitest run src/test/dsh-d10-write-not-executed-is-error.test.ts"),
      /** 第一次收尾：三条守卫都会想说话 ✓ */
      finalIteration("我做完了。"),
      /** 合并之后的收尾 ✓ */
      finalIteration("说明：……"),
    ]);
    const { registry } = registryWithFakeReadAndBash();

    const loop = new AgenticLoop(provider as any, registry, { maxIterations: 20, model: "m", securityMode: "full" });
    for await (const _ of loop.run("nr-1", "修一下写盘失败的情况", process.cwd(), "system")) {
      /* 跑完即可 ✓ */
    }

    /**
     * 3 次工具/收尾迭代 + **1** 次提醒 = 4 ✓；
     * 现在（三段各 continue ✗）会变成 3 + N ✗ ⇒ 这条判据就是为此写的 ✓。
     */
    expect(provider.requests.length, "三条守卫同时成立也只许多要 1 轮（合并成一次往返 ✓）").toBe(4);
  });
});



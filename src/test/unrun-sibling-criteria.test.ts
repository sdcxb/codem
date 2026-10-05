/**
 * 第 154 波：**收尾判定"同族判据有没有跑过"**（目标①的正面突破点 ✓）。
 *
 * ## 依据（repo-02 的真机读数 ✓）
 *
 * | 轮次 | 结果 | 提到 d8/d9/d10 | **在 bash 里真跑过的** |
 * |---|---|---|---|
 * | run-2 | **通过** ✓ | 9 / 9 / 10 | **d8, d9, d10** ✓ |
 * | run-3 | 失败 ✗ | 0 / 0 / 21 | 只有 d10 ✗ |
 * | run-4 | 失败 ✗ | 2 / 2 / 6 | 只有 d10 ✗ |
 * | run-5 | 失败 ✗ | 9 / 7 / 14 | d8/d9/d10 ✓ **但最后一步是 write，之后再没验证** ✗ |
 *
 * ⇒ 决定成败的是「**该跑的判据有没有跑过**」✓，而不是「读没读到」✓。
 * 而本任务的缺陷形态正是"**补丁不完整**"✗（需要三处改动，失败轮只做了一两处 ✓）。
 *
 * ## 判据
 *
 * - **URC-1**：改过源码、同族两条判据**只跑过一条** ⇒ 必须点出**没跑的那条** ✓；
 * - **URC-2**：两条都跑过（不论红绿 ✓）⇒ **不许**点（别制造噪音 ✗）；
 * - **URC-3**：测试文件本身不算"改过源码"✓（改判据不用提醒跑别的判据 ✓）；
 * - **URC-4**：有上限 ✓（一次只点几条 ✓，免得把收尾提示写成清单 ✗）。
 *
 * 变异：把 `runStatus.has(file)` 的判断去掉 ⇒ URC-2 红 ✓。
 */
import { describe, expect, it } from "vitest";
import { unrunSiblingCriteria } from "../core/llm/task-keyword-search";

describe("第 154 波：收尾时点出'没跑过的同族判据'", () => {
  const siblingsOf = new Map<string, string[]>([
    ["src/core/llm/tools.ts", ["src/test/dsh-d8-edit-ambiguity.test.ts", "src/test/dsh-d9-multi-edit-partial-failure.test.ts"]],
  ]);

  it("URC-1: 只跑过一条 ⇒ 必须点出没跑的那条（run-3/run-4 的形状 ✓）", () => {
    const unrun = unrunSiblingCriteria({
      editedSources: ["src/core/llm/tools.ts"],
      siblingsOf,
      runStatus: new Map([["src/test/dsh-d9-multi-edit-partial-failure.test.ts", "green"]]),
    });
    expect(unrun, "同族里没跑过的判据必须被点出来").toEqual(["src/test/dsh-d8-edit-ambiguity.test.ts"]);
  });

  it("URC-2: 两条都跑过 ⇒ 不许点（红绿都算跑过 ✓，别制造噪音 ✗）", () => {
    const unrun = unrunSiblingCriteria({
      editedSources: ["src/core/llm/tools.ts"],
      siblingsOf,
      runStatus: new Map([
        ["src/test/dsh-d8-edit-ambiguity.test.ts", "red"],
        ["src/test/dsh-d9-multi-edit-partial-failure.test.ts", "green"],
      ]),
    });
    expect(unrun, "跑过就是跑过（红的也已经看见了 ✓）⇒ 这里不该再提醒").toEqual([]);
  });

  it("URC-3: 没改过源码（或改的是判据文件）⇒ 不点", () => {
    const unrun = unrunSiblingCriteria({
      editedSources: [],
      siblingsOf,
      runStatus: new Map(),
    });
    expect(unrun).toEqual([]);
  });

  it("URC-4: 有上限（一次只点几条 ✓）", () => {
    const many = new Map<string, string[]>([
      ["src/core/llm/tools.ts", Array.from({ length: 20 }, (_, i) => `src/test/x-${i}.test.ts`)],
    ]);
    const unrun = unrunSiblingCriteria({ editedSources: ["src/core/llm/tools.ts"], siblingsOf: many, runStatus: new Map(), max: 6 });
    expect(unrun.length, "再多也只点 6 条").toBe(6);
  });
});

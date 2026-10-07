/**
 * **回归判定**的行为判据（第 46 波 ✓）。
 *
 * 钉住三件事 ✓：
 *   · 只有"**基线绿 → 现在红**"才算回归 ✓（真机里 `repo-02`/`repo-06` 正是这个形态 ✓）
 *   · **既有红**（基线红 ✓）与**没见过**的文件**绝不算**回归 ✓（否则误伤 `repo-03/04` ✗）
 *   · 顺序与去重稳定 ✓（判据与正文都要可复现 ✓）
 */
import { describe, expect, it } from "vitest";
import { regressionRedFiles, type TestStatus } from "../core/llm/test-regression";

const m = (pairs: Array<[string, TestStatus]>) => new Map<string, TestStatus>(pairs);

describe("回归判定：只拦「基线绿 → 现在红」", () => {
  it("RG-1 基线绿、现在红 ⇒ 是回归 ✓（就是 repo-02/repo-06 的形态）", () => {
    const out = regressionRedFiles(m([["a.test.ts", "red"]]), m([["a.test.ts", "green"]]));
    expect(out).toEqual(["a.test.ts"]);
  });

  it("RG-2 基线红、现在红 ⇒ **不是**回归 ✓（既有红不许误伤）", () => {
    const out = regressionRedFiles(m([["a.test.ts", "red"]]), m([["a.test.ts", "red"]]));
    expect(out).toEqual([]);
  });

  it("RG-3 基线绿、现在绿 ⇒ 不是回归 ✓", () => {
    expect(regressionRedFiles(m([["a.test.ts", "green"]]), m([["a.test.ts", "green"]]))).toEqual([]);
  });

  it("RG-4 本轮没见过、现在红 ⇒ **不算**回归 ✓（保守：不拿「没见过」当「原来是绿的」）", () => {
    expect(regressionRedFiles(m([["new.test.ts", "red"]]), m([]))).toEqual([]);
  });

  it("RG-5 混合场景：只挑出回归那一条 ✓，顺序按 current 的插入序 ✓", () => {
    const current = m([
      ["was-red.test.ts", "red"],
      ["broke.test.ts", "red"],
      ["fine.test.ts", "green"],
      ["broke2.test.ts", "red"],
    ]);
    const baseline = m([
      ["was-red.test.ts", "red"],
      ["broke.test.ts", "green"],
      ["fine.test.ts", "green"],
      ["broke2.test.ts", "green"],
    ]);
    expect(regressionRedFiles(current, baseline)).toEqual(["broke.test.ts", "broke2.test.ts"]);
  });

  it("RG-6 空输入 ⇒ 空结果 ✓（不抛错 ✓）", () => {
    expect(regressionRedFiles(m([]), m([]))).toEqual([]);
  });

  it("RG-7 同一文件重复出现也不会重复计入 ✓", () => {
    // Map 本身不会重复键；本判据钉的是"实现里若改成数组/多次遍历也不会重复"✓
    const current = m([["a.test.ts", "red"]]);
    const baseline = m([["a.test.ts", "green"]]);
    expect(regressionRedFiles(current, baseline)).toEqual(["a.test.ts"]);
  });
});

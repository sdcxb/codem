/**
 * DiffViewer：大文件 diff 的**代价**与**渲染量**都要有界（第 233 轮审计 · P1 性能）。
 *
 * ## 缺陷形态
 *
 * `computeDiff` 是纯 LCS DP：
 *
 * ```ts
 * const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));  // 全矩阵
 * ...
 * result.unshift(...)                                                             // 逐行前插 O(L²)
 * ```
 *
 * - 两侧各 5000 行（守卫内的最坏值）= **2500 万格** + 10 万个数组 ≈ 100–200 MB，
 *   而右栏"改动"与每次写确认都会走它（`FileChangesList` / `App.tsx` 的写确认）；
 * - 逐行 `unshift` 在结果 1 万行时还要再搬 5000 万次元素；
 * - 更普遍的浪费：**一次只改 3 行**的大文件也要付整张矩阵的代价 ——
 *   而两端的公共前后缀本来就必然是 `unchanged`。
 * - 渲染侧没有行数上限（`InlineDiffReview` 有 200 行上限），>5000 行时
 *   还会退化成"全删 + 全增"= 2L 行**全部塞进 DOM**。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | DV-BIG-1 | 5000 行只改 1 行 ⇒ 结果必须是 4999 unchanged + 1 removed + 1 added，行号正确 |
 * | DV-BIG-2 | 同上的计算耗时有界（去掉前后缀裁剪后要跑 2500 万格，实测秒级） |
 * | DV-BIG-3 | 小样例的 diff **逐行等价**（反向对照：裁剪不许改变语义） |
 * | DV-CAP-1 | unified/split 视图渲染行数有上限，且**明确告知被截断** |
 *
 * 变异自证：去掉前后缀裁剪 ⇒ DV-BIG-2 超时；去掉行数上限 ⇒ DV-CAP-1 红。
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { computeDiff, DIFF_RENDER_ROW_CAP, DiffViewer } from "../components/DiffViewer";

function lines(count: number, fn: (i: number) => string): string[] {
  return Array.from({ length: count }, (_, i) => fn(i));
}

describe("DiffViewer：大文件 diff", () => {
  it("DV-BIG-1: 5000 行只改 1 行 ⇒ 结果正确（4999 unchanged + 1 removed + 1 added）", () => {
    const before = lines(5000, (i) => `line-${i + 1}`).join("\n");
    const after = lines(5000, (i) => (i === 2500 ? "line-2501-changed" : `line-${i + 1}`)).join("\n");

    const diff = computeDiff(before, after);
    expect(diff.filter((l) => l.type === "unchanged")).toHaveLength(4999);
    expect(diff.filter((l) => l.type === "removed")).toHaveLength(1);
    expect(diff.filter((l) => l.type === "added")).toHaveLength(1);
    // 改动点的行号必须仍然对得上（1-based，第 2501 行）
    const removed = diff.find((l) => l.type === "removed")!;
    const added = diff.find((l) => l.type === "added")!;
    expect(removed.oldLineNum).toBe(2501);
    expect(removed.content).toBe("line-2501");
    expect(added.newLineNum).toBe(2501);
    expect(added.content).toBe("line-2501-changed");
    // 首尾 unchanged 的行号也要对
    expect(diff[0]).toMatchObject({ type: "unchanged", oldLineNum: 1, newLineNum: 1 });
    expect(diff[diff.length - 1]).toMatchObject({ type: "unchanged", oldLineNum: 5000, newLineNum: 5000 });
  });

  it("DV-BIG-2: 上面的计算必须有界（前后缀裁剪后才可能这么快）", () => {
    const before = lines(5000, (i) => `line-${i + 1}`).join("\n");
    const after = lines(5000, (i) => (i === 2500 ? "changed" : `line-${i + 1}`)).join("\n");
    const t0 = performance.now();
    computeDiff(before, after);
    const ms = performance.now() - t0;
    // 未裁剪时是 2500 万格 DP（实测 1–3 s）；裁剪后是几十行 ⇒ 留 20 倍余量
    expect(ms, `大文件 diff 耗时 ${ms.toFixed(0)}ms（应远小于 500ms）`).toBeLessThan(500);
  });

  it("DV-BIG-3（反向对照）: 小样例的 diff 逐行等价", () => {
    const diff = computeDiff("a\nb\nc", "a\nB\nc\nd");
    expect(diff.map((l) => `${l.type}:${l.content}`)).toEqual([
      "unchanged:a",
      "removed:b",
      "added:B",
      "unchanged:c",
      "added:d",
    ]);
    expect(diff.map((l) => l.oldLineNum)).toEqual([1, 2, null, 3, null]);
    expect(diff.map((l) => l.newLineNum)).toEqual([1, null, 2, 3, 4]);
  });
});

describe("DiffViewer：渲染量有界", () => {
  it("DV-CAP-1: unified 视图超过上限时只渲染前 N 行，并明确告知被截断", () => {
    const before = lines(1200, (i) => `old-${i}`).join("\n");
    const after = lines(1200, (i) => `new-${i}`).join("\n");
    render(<DiffViewer filePath="big.ts" before={before} after={after} />);

    // 切到 unified（默认是 preview）
    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    const rows = document.querySelectorAll(".diff-unified tr.diff-line");
    expect(rows.length, "渲染行数必须有上限（否则 2400 行进 DOM）").toBeLessThanOrEqual(DIFF_RENDER_ROW_CAP);
    expect(rows.length, "上限不能小到看不见内容").toBeGreaterThan(0);
    expect(
      document.body.textContent ?? "",
      "被截断必须说出来（不许静默少显示）",
    ).toMatch(/仅显示|truncated/i);
  });
});

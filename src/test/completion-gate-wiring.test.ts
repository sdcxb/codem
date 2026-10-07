/**
 * **完成门链路的完整性**（第 46 波 ✓）。
 *
 * 为什么要这组判据 ✓：本会话已经栽过一次同类跟头 —— 工具管线的"七条出口"里
 * 只堵了三条 ✗（见 `tool-pipeline-finalize-all-exits.test.ts` 的来历 ✓）。
 * 所以"完成门"必须同样**逐出口**核一遍 ✓：
 *
 *   ① 循环里所有 `type: "stop"` 出口中，**只能有一处** `reason: "completed"` ✓
 *      （否则别处收尾就绕过门 ✗）；
 *   ② 那一处**必须带上** `regressionRedTests` ✓（否则门永远拿到空数组 ⇒ 形同虚设 ✗）；
 *   ③ 两个包装函数（`attachExitReason` / `withCompletionNudgesDetail`）必须**保留**该字段 ✓
 *      —— 它们用 `{ ...result }` 展开 ✓，但这是**实现细节** ✓，一旦有人改成逐字段重建 ✗
 *      就会**静默丢字段** ✗ ⇒ 必须钉住 ✓。
 *
 * 本判据是**源码级**的 ✓（行为已在 `turn-outcome-regression-gate.test.ts` 与
 * `test-regression-detection.test.ts` 里验过 ✓）；它守的是"接线不再被改断" ✓。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LOOP = join(process.cwd(), "src", "core", "llm", "agentic-loop.ts");
const src = readFileSync(LOOP, "utf8");
const lines = src.split("\n");

/**
 * 每个 `type: "stop"` 出口的（行号, 其后若干行拼成的上下文）。
 *
 * ⚠️ 窗口取 **10 行** ✓（不是 6 ✗）：实测 completed 出口里 `regressionRedTests` 在
 * `type: "stop"` 之后第 **7** 行 ✓（中间隔着 `reason` / `usage` 和一段注释 ✓）。
 * 第一版窗口取 6 ⇒ CG-2 假红 ✗ —— 这正是"**判据自己的量程要够**"那条教训 ✓。
 */
function stopExits(): Array<{ line: number; ctx: string }> {
  const WINDOW = 10;
  const out: Array<{ line: number; ctx: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/type: "stop"/.test(lines[i])) continue;
    out.push({ line: i + 1, ctx: lines.slice(i, i + WINDOW).join(" ") });
  }
  return out;
}

const reasonOf = (ctx: string) => /reason:\s*"([^"]+)"/.exec(ctx)?.[1] ?? "";

describe("完成门链路完整性（逐出口核 ✓，与 tool-pipeline 七出口同一套路 ✓）", () => {
  it("CG-1: `reason: \"completed\"` 的出口**恰好一处** ✓（多一处就绕过门 ✗）", () => {
    const completed = stopExits().filter((e) => reasonOf(e.ctx) === "completed");
    expect(completed.length, "completed 出口必须唯一").toBe(1);
  });

  it("CG-2: 那个唯一的 completed 出口**带上了** `regressionRedTests` ✓", () => {
    const completed = stopExits().filter((e) => reasonOf(e.ctx) === "completed");
    expect(completed.length).toBe(1);
    expect(completed[0].ctx, "completed 出口必须携带回归字段（否则门形同虚设）").toContain(
      "regressionRedTests",
    );
  });

  it("CG-3: 两个包装函数都用展开保留字段 ✓（不许改成逐字段重建 ✗）", () => {
    expect(src, "attachExitReason 必须展开原结果").toMatch(
      /private attachExitReason\(result: LoopResult\)[\s\S]{0,400}?return \{ \.\.\.result, detail \}/,
    );
    expect(src, "withCompletionNudgesDetail 必须展开原结果").toMatch(
      /export function withCompletionNudgesDetail\([\s\S]{0,900}?return \{\s*\.\.\.result,/,
    );
  });

  it("CG-4: 所有非 completed 的 stop 出口**不带**该字段 ✓（免得别处误触发门 ✗）", () => {
    for (const e of stopExits()) {
      if (reasonOf(e.ctx) === "completed") continue;
      expect(e.ctx, `行 ${e.line} 不是 completed 出口，不该带回归字段`).not.toContain("regressionRedTests");
    }
  });
});

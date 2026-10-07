/**
 * **收尾红测试提醒**的文本判据（第 46 波末重建 ✓）。
 *
 * 为什么只有两条 ✓：原先那几条（`SD-1..5` / `RT-1`）钉的是**提示词措辞**
 * （「与题面同一个病的不算无关 ⇒ 必须修」✗）—— 第 46 波末按用户指令**撤下** ✗：
 * **提示词不是治本手段** ✓（随模型升级/切换而变 ✓）。
 *
 * 正确性现在由**结构**保证 ✓：
 *   · `src/core/llm/test-regression.ts` ✓（回归判定 = 纯函数 ✓）
 *   · `src/core/llm/turn-outcome.ts` ✓（**完成门**：有回归 ⇒ 绝不显示完成 ✓）
 *   · `src/core/llm/agentic-loop.ts` ✓（回归不接受"点名豁免"✓，结果里带 `regressionRedTests` ✓）
 *   ⇒ 它们的判据在 `test-regression-detection.test.ts` 与 `turn-outcome-regression-gate.test.ts` ✓。
 *
 * 本文件只保留**这两条仍然成立**的判据 ✓：
 *   · 提醒里的**插值**不许丢（条数 / 文件清单 / 最近命令 ✓）
 *   · **结构**：那段文案只由纯函数造 ✓（不许在循环里再手写一份 ✗ ⇒ 两份必然漂移 ✗）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("收尾红测试提醒：只钉插值与结构（措辞类判据已按指令撤下 ✗）", () => {
  it("RT-2: 插值不许丢（条数 / 文件清单 / 最近命令都要在提醒里 ✓）", async () => {
    const { buildRedTestNudgeText } = await import("../core/llm/completion-guards");
    const text = buildRedTestNudgeText({
      failedCount: 4,
      fileList: "（a.test.ts, b.test.ts）",
      command: "npx vitest run x",
    });
    expect(text, "条数").toContain("4 条失败");
    expect(text, "文件清单").toContain("（a.test.ts, b.test.ts）");
    expect(text, "最近命令").toContain("最近一次命令：npx vitest run x");
    const noCmd = buildRedTestNudgeText({ failedCount: 1, fileList: "" });
    expect(noCmd, "没有命令时不许出现空括号").not.toContain("最近一次命令");
  });

  it("RT-3: 结构 —— 循环里那段文案只由纯函数造（不许再手写一份 ✗）", () => {
    const loop = readFileSync(join(process.cwd(), "src", "core", "llm", "agentic-loop.ts"), "utf8");
    expect(loop, "循环必须调用这个构造器").toContain("buildRedTestNudgeText(");
    expect(loop, "旧的内联文案不许再留在循环里（两份必然漂移 ✗）").not.toContain(
      "不允许把这次收尾写成「已完成」而不提这些红",
    );
  });

  it("RT-4: 提醒里**不再**出现「同病必须修」那类措辞 ✓（第 46 波末撤下 ✗）", async () => {
    const { buildRedTestNudgeText } = await import("../core/llm/completion-guards");
    const text = buildRedTestNudgeText({ failedCount: 2, fileList: "（x.test.ts）" });
    expect(text, "被撤下的措辞不许回归").not.toContain("与题面同一个病");
    expect(text, "既有两种收场仍要在（那是既有判据 ✓）").toContain("如果它们确实不该由你修");
  });
});

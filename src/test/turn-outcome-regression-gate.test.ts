/**
 * **确定性完成门**（第 46 波 ✓，治本 ✓ 不靠提示词 ✗）。
 *
 * 现象 ✓：模型在收尾时刻把同族的红判据"点名"为无关 ✗，然后正常收尾 ⇒ 界面显示"任务完成" ✗。
 * 真机取证 ✓：`repo-02` 与 `repo-06` 两格都是这个形态 ✓（交接第十九节 ✓）。
 *
 * 本判据只钉一件事 ✓：**result 里声明的"基线绿 → 现在红"非空时，绝不返回 completed** ✓。
 * 反向对照同样重要 ✓：**没有回归时必须照旧完成** ✓（否则会误伤 `repo-03/04` 那类
 * "题面无关的既有红" ✗ —— 那两格的红是基线红 ✓ 不算回归 ✓）。
 */
import { describe, expect, it } from "vitest";
import { describeTurnOutcome } from "../core/llm/turn-outcome";

const completed = (extra: Record<string, unknown> = {}) => ({
  type: "stop",
  reason: "completed",
  usage: {},
  ...extra,
});

describe("确定性完成门：有回归 ⇒ 绝不显示完成", () => {
  it("REG-1 有回归时：不是 completed，且不显示完成卡、不报喜", () => {
    const o = describeTurnOutcome(completed({ regressionRedTests: ["src/test/dsh-d9-multi-edit-partial-failure.test.ts"] }), { lang: "zh" });
    expect(o.kind, "有回归时 kind 不能是 completed").not.toBe("completed");
    expect(o.completionCard, "有回归时不许显示完成卡").toBe(false);
    expect(o.suppressTaskBubble, "有回归时不许报喜气泡").toBe(true);
    expect(o.messageStatus, "有回归时消息要标 error").toBe("error");
    expect(o.turnStatus?.code, "必须留下可机检的 code").toBe("REGRESSION_TESTS_RED");
    expect(o.notice ?? "", "正文要点名那个红判据").toContain("dsh-d9-multi-edit-partial-failure");
    expect(o.notice ?? "", "正文必须说清这不是完成").toMatch(/这不是完成|NOT a completion/);
  });

  it("REG-2 无回归时（反向对照）：照旧 completion ✓ —— 不许误伤", () => {
    const o = describeTurnOutcome(completed({ regressionRedTests: [] }), { lang: "zh" });
    expect(o.kind).toBe("completed");
    expect(o.completionCard).toBe(true);
    expect(o.suppressTaskBubble).toBe(false);
  });

  it("REG-3 字段缺失（旧形状）：照旧完成 ✓ —— 向后兼容", () => {
    const o = describeTurnOutcome(completed(), { lang: "zh" });
    expect(o.kind).toBe("completed");
  });

  it("REG-4 字段里混进垃圾（空串/数字/null）：只认真实文件名 ✓", () => {
    const o = describeTurnOutcome(
      completed({ regressionRedTests: ["", null, 42, "src/test/real.test.ts"] }),
      { lang: "zh" },
    );
    expect(o.kind, "有一个真文件名 ⇒ 仍要拦住").not.toBe("completed");
    expect(o.turnStatus?.message ?? "", "只列真文件名").toContain("real.test.ts");
    expect(o.turnStatus?.message ?? "", "不许把垃圾塞进正文").not.toContain("42");
  });

  it("REG-5 超过 5 个时：正文说「等 N 个」✓（不刷屏）", () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/test/many-${i}.test.ts`);
    const o = describeTurnOutcome(completed({ regressionRedTests: files }), { lang: "zh" });
    expect(o.kind).not.toBe("completed");
    expect(o.notice ?? "").toContain("等 8 个");
    expect(o.turnStatus?.message ?? "").toContain("8 regression test(s)");
  });

  it("REG-6 英文也一样拦住 ✓（与语言无关 ✓）", () => {
    const o = describeTurnOutcome(completed({ regressionRedTests: ["src/test/x.test.ts"] }), { lang: "en" });
    expect(o.kind).not.toBe("completed");
    expect(o.completionCard).toBe(false);
    expect(o.turnStatus?.code).toBe("REGRESSION_TESTS_RED");
  });

  it("REG-7 非完成类结果不受影响 ✓（error/aborted 既有行为不变）", () => {
    expect(describeTurnOutcome({ type: "error", error: "x" }, { lang: "zh" }).kind).toBe("error");
    expect(describeTurnOutcome({ type: "aborted" }, { lang: "zh" }).kind).toBe("aborted");
  });
});

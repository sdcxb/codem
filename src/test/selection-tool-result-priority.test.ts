/**
 * 选择器（`selectMessagesByPriority`）与工具结果的判据。
 *
 * ## 被守的缺陷（真机查实）
 * 优先级那一行判的是 **`msg.tool_calls`（蛇形）**，而**存储形状是 `toolCalls`（驼峰）** ——
 * 同一个函数上面算 token 时就写着「存储形状里工具结果在 `toolCalls[].result`」。
 * 于是**带工具结果的助手消息一律被打成最低优先级（1）**，预算一紧就**最先被丢掉**：
 * 真机形态 = 补写的两条 25 万字符工具结果（共 50 万字符）在 115,200 预算下**一条都没入选**，
 * 水位只报 756 token（"占用 1%"）⇒ 自动压缩/折叠的触发依据全部失真。
 *
 * 判据必须能红：SEL-1/SEL-3 在修之前**必红**（修前 toolCalls 形状拿不到 2 档优先级、
 * 巨型工具结果进不了 usedTokens）。
 */
import { describe, expect, it } from "vitest";
import { selectMessagesByPriority, summarizeModelContext } from "../core/llm/compaction-budget";

const WINDOW = 128000;
const BUDGET = summarizeModelContext([], WINDOW).budgetTokens; // 窗口 × 0.9

/** 存储形状：工具结果在 assistant 消息的 `toolCalls[].result`（驼峰） */
function storageShape(id: string, ts: number, toolChars: number, content = "（读了点东西）") {
  return {
    id,
    role: "assistant",
    content,
    timestamp: ts,
    toolCalls: [{ id: `${id}-tc`, tool: "read", args: { path: "big.txt" }, result: "字".repeat(toolChars), status: "done" }],
  };
}

describe("SEL 工具结果在选择器里的优先级（真机缺陷）", () => {
  it("SEL-1：存储形状（toolCalls）的工具结果必须抬到 MEDIUM —— 不许预算一紧就先丢它", () => {
    /* 预算塞不下的场景：一条巨大工具结果 + 一堆正文稍大的助手消息 */
    const msgs: any[] = [storageShape("big", 1, 120_000)];
    for (let i = 0; i < 6; i++) {
      msgs.push({ id: `t${i}`, role: "assistant", content: "正文".repeat(8_000), timestamp: 10 + i });
    }
    const sel = selectMessagesByPriority(msgs as never[], BUDGET);
    const ids = sel.map((m: any) => m.id);
    expect(
      ids.includes("big"),
      `带工具结果的助手消息必须优先于纯正文消息被保留（实际入选：${ids.join(",")}）`,
    ).toBe(true);
  });

  it("SEL-2：原始行形状（tool_calls）也不能回归 —— 两种形状都要认", () => {
    const msgs: any[] = [
      { id: "raw", role: "assistant", content: "（读了点东西）", timestamp: 1, tool_calls: [{ id: "x", tool: "read", result: "字".repeat(120_000) }] },
    ];
    for (let i = 0; i < 6; i++) {
      msgs.push({ id: `t${i}`, role: "assistant", content: "正文".repeat(8_000), timestamp: 10 + i });
    }
    const ids = selectMessagesByPriority(msgs as never[], BUDGET).map((m: any) => m.id);
    expect(ids.includes("raw"), "原始行形状（tool_calls）同样要按「带工具结果」对待").toBe(true);
  });

  it("SEL-3a：近期的巨型工具结果必须原样进 usedTokens（模型当前在用的东西，不许动）", () => {
    const now = 1_000_000;
    const msgs: any[] = [];
    for (let i = 0; i < 21; i++) {
      msgs.push({ id: `s${i}`, role: i % 2 === 0 ? "user" : "assistant", content: "短消息", timestamp: now + i });
    }
    msgs.push(storageShape("probe-recent", now + 100, 250_000));
    const { usedTokens } = summarizeModelContext(msgs as never[], WINDOW);
    expect(
      usedTokens,
      "近期的大工具结果必须原样体现在用量里（修前同样的输入只有几十 token）",
    ).toBeGreaterThan(100_000);
  });

  it("SEL-3b：远处的巨型工具结果不许被丢掉，而是截短并留说明", () => {
    const now = 1_000_000;
    const msgs: any[] = [];
    for (let i = 0; i < 21; i++) {
      msgs.push({ id: `s${i}`, role: i % 2 === 0 ? "user" : "assistant", content: "短消息", timestamp: now + i });
    }
    /* 远处（时间最老 ⇒ 排序后在前面）⇒ 超预算时该"截短保留"，而不是"整条丢弃" */
    msgs.push(storageShape("probe-old", now - 100_000, 250_000));
    const sorted = [...msgs].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const { selected, usedTokens } = summarizeModelContext(sorted as never[], WINDOW);
    const ids = selected.map((m: any) => m.id);
    expect(ids.includes("probe-old"), "远处的大工具结果必须留在选择里（丢它等于丢证据）").toBe(true);
    const kept: any = selected.find((m: any) => m.id === "probe-old");
    const result = String(kept?.toolCalls?.[0]?.result ?? "");
    /**
     * ⚠️ 这里**不**要求它缩到 5k 那种小头 —— 把远处的大结果压成 head+tail 是**折叠阶梯**的职责
     * （FD-1/FD-4：阈值 0.5 触发、与距离挂钩）。选择器只保证三件事：
     * ① 不丢；② 超预算时截短而不是整条消失；③ 截完仍不超预算。
     */
    expect(result.length, "要截短（原来是 250000）").toBeLessThan(250_000);
    expect(/truncated for context budget/.test(result), "要留可见的说明").toBe(true);
    expect(usedTokens, "截短后必须落回预算内").toBeLessThanOrEqual(BUDGET);
  });
});

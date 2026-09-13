/**
 * 「回复被输出上限截断」的续写契约（第 68 波）。
 *
 * 用户报告：说"继续之前没完成的任务"之后，一轮就结束了 —— 控制台里只有
 * `[AgenticLoop] Single-response dedup: 0 tool calls in this response: []`，
 * 紧接着直接进入记忆抽取（`[extractMemories] Extracted 15 memories`），
 * 也就是**这一轮没有任何工具调用就直接收尾了**。
 *
 * 根因：`finish_reason === "length"`（达到单次输出上限、回复被截断）此前**只用于
 * 内容型工具的提示**，从不参与"要不要停"的判断 —— 于是"被截断的回复"（尤其是纯文本、
 * 没有工具调用的那种）被当成「写完了」，用户看到的就是「任务又中断了」。
 *
 * 现在的契约：
 *   · 截断 ⇒ 注入「从断点继续」的提示并**继续循环**（预算 3 次）；
 *   · 预算用完 ⇒ 明确停下 + 告诉用户该怎么办（分块写入 / 调大上限），而不是静默结束；
 *   · 结束原因必须能从循环状态里读到（provider 的 end 事件不向上游 yield）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const loop = () => read("src/core/llm/agentic-loop.ts");

describe("输出截断 ⇒ 自动续写（第 68 波）", () => {
  it("TRUNC-1: 结束原因进入循环状态（不再只是 executeIteration 的局部变量）", () => {
    const src = loop();
    // 状态字段 + 初始化 + 写入点
    expect(src).toMatch(/lastFinishReason: string;/);
    expect(src).toMatch(/lastFinishReason: "stop",/);
    expect(src).toMatch(/this\.state\.lastFinishReason = finishReason;/);
    // 主循环要读它（而不是本地变量）
    expect(src).toMatch(/if \(this\.state\.lastFinishReason === "length"\) \{/);
  });

  it("TRUNC-2: 截断时先**自动续写**（注入从断点继续的提示 + continue），而不是收尾", () => {
    const src = loop();
    const idx = src.indexOf('if (this.state.lastFinishReason === "length") {');
    expect(idx).toBeGreaterThan(-1);
    // 按标记取块（不要用固定长度：这个分支本身会随修复长大，固定窗口会把断言截断）
    const giveUpIdx = src.indexOf('phase: "give-up"', idx);
    expect(giveUpIdx, "应能找到 give-up 分支作为块尾").toBeGreaterThan(idx);
    const block = src.slice(idx, giveUpIdx);
    expect(block, "要有续写预算").toMatch(/MAX_TRUNCATED_CONTINUATIONS/);
    expect(block, "注入提示").toMatch(/从断点继续/);
    expect(block, "教它分块写入").toMatch(/append: true/);
    expect(block, "不要重复已写内容").toMatch(/不要重复/);
    expect(block, "要继续循环而不是返回").toMatch(/\bcontinue;/);
    // 必须排在正常 completed 停止之前
    const completedAt = src.indexOf('reason: "completed"');
    expect(idx, "截断分支必须在 completed 分支之前").toBeLessThan(completedAt);
  });

  it("TRUNC-3: 续写预算用完 → 明确停下并给出下一步（不静默结束）", () => {
    const src = loop();
    const idx = src.indexOf('phase: "give-up"');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 900);
    expect(block, "告诉用户已停止").toMatch(/已连续/);
    expect(block, "给出两条出路").toMatch(/分块写入/);
    expect(block).toMatch(/maxTokens/);
    expect(block, "结构化停止原因").toMatch(/reason: "output_truncated"/);
  });

  it("TRUNC-4: 续写预算按轮次重置（否则第二次任务一开始就没额度了）", () => {
    const src = loop();
    const runStart = src.indexOf("async *run(");
    const head = src.slice(runStart, runStart + 1600);
    expect(head).toContain("this.truncatedContinuations = 0");
  });

  it("TRUNC-5: 内容型工具在截断回复里跑过 → 仍要提示核对完整性（第 67 波契约不回归）", () => {
    const src = loop();
    expect(src).toMatch(/finishReason === "length" && isContentBearingTool\(name\)/);
    expect(src).toMatch(/核对它是否完整|核实它是否完整/);
  });
});

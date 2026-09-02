/**
 * 上下文折叠测试 — 截断丢弃时生成紧凑摘要（防模型失忆重复劳动 → 省 token）
 *
 * 覆盖：
 * TOK-F1 foldStats 统计被丢弃消息的工具操作构成（assistant tool_calls → 工具名计数）
 * TOK-F2 纯文本回复也计入丢弃
 * TOK-F3 renderFoldSummary 中文/英文文案含工具计数与"重新调用工具"引导
 * TOK-F4 isFoldMessage 判定折叠行（防每轮重复插入累积）
 * TOK-F5 集成：buildMessages 超预算截断后首条消息为折叠摘要、原文案不丢失
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  foldStats, renderFoldSummary, isFoldMessage, FOLD_PREFIX,
  pruneLargeToolResult, pruneStaleToolResults,
  TOOL_RESULT_PRUNE_THRESHOLD, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS,
} from "../core/llm/context-fold";

describe("上下文折叠（token 效率）", () => {
  it("TOK-F1: foldStats 统计工具操作构成", () => {
    const dropped = [
      { role: "user", content: "原始意图：修复 bug", id: "u1" },
      { role: "assistant", content: "", tool_calls: [
        { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "grep", arguments: "{}" } },
      ], id: "a1" },
      { role: "tool", toolCallId: "c1", content: "file content…" },
      { role: "tool", toolCallId: "c2", content: "matches…" },
      { role: "assistant", content: "", tool_calls: [
        { id: "c3", type: "function", function: { name: "bash", arguments: "{}" } },
      ], id: "a2" },
      { role: "tool", toolCallId: "c3", content: "ok" },
    ];
    const stats = foldStats(dropped);
    expect(stats.droppedMessages).toBe(6);
    expect(stats.toolCounts).toEqual({ read: 1, grep: 1, bash: 1 });
    expect(stats.droppedTextReplies).toBe(0);
  });

  it("TOK-F2: 纯文本 assistant 回复计入 droppedTextReplies", () => {
    const stats = foldStats([
      { role: "assistant", content: "我先看看代码", id: "a1" },
      { role: "assistant", content: "", tool_calls: [], id: "a2" },
    ]);
    expect(stats.droppedTextReplies).toBe(1);
  });

  it("TOK-F3: 摘要文案含工具计数与重新读取引导", () => {
    const zh = renderFoldSummary({ droppedMessages: 6, toolCounts: { read: 2, bash: 1 }, droppedTextReplies: 0 }, "zh");
    expect(zh.startsWith(FOLD_PREFIX)).toBe(true);
    expect(zh).toContain("read×2");
    expect(zh).toContain("bash×1");
    expect(zh).toContain("重新调用相应工具");
    const en = renderFoldSummary({ droppedMessages: 3, toolCounts: {}, droppedTextReplies: 2 }, "en");
    expect(en).toContain("folded");
    expect(en).toContain("never guess");
  });

  it("TOK-F4: isFoldMessage 识别折叠行", () => {
    expect(isFoldMessage({ role: "user", content: `${FOLD_PREFIX} 较早的消息被精简` })).toBe(true);
    expect(isFoldMessage({ role: "user", content: "正常消息" })).toBe(false);
    expect(isFoldMessage(null)).toBe(false);
  });

  it("TOK-F6: 超长工具结果裁剪为 head+marker+tail（对齐 dsh 8192/4096/1024）", () => {
    const big = "A".repeat(20_000) + "ERROR_TAIL_SENTINEL";
    const pruned = pruneLargeToolResult(big);
    expect(pruned.length).toBeLessThan(TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS + 120);
    expect(pruned.startsWith("A".repeat(TOOL_RESULT_HEAD_CHARS))).toBe(true);
    expect(pruned.endsWith("ERROR_TAIL_SENTINEL")).toBe(true); // 尾部（错误信息）保留
    expect(pruned).toContain("中段已裁剪");
    // 未超阈值原样返回
    const small = "short result";
    expect(pruneLargeToolResult(small)).toBe(small);
    expect(pruneLargeToolResult("")).toBe("");
  });

  it("TOK-F7: pruneStaleToolResults 保留最近 N 条完整、裁剪更早超大结果", () => {
    const big = "X".repeat(TOOL_RESULT_PRUNE_THRESHOLD + 5000);
    const recent = "Y".repeat(TOOL_RESULT_PRUNE_THRESHOLD + 5000); // 最近也大但保留
    const messages = [
      { role: "user", content: "意图", id: "u" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }], id: "a1" },
      { role: "tool", toolCallId: "c1", content: big, id: "t1" },      // 陈旧大 → 裁剪
      { role: "assistant", content: "", tool_calls: [{ id: "c2" }], id: "a2" },
      { role: "tool", toolCallId: "c2", content: "small", id: "t2" },
      { role: "assistant", content: "", tool_calls: [{ id: "c3" }], id: "a3" },
      { role: "tool", toolCallId: "c3", content: recent, id: "t3" },   // 最近(第2条) → 保留完整
    ];
    const out = pruneStaleToolResults(messages, 2);
    expect(out).not.toBe(messages); // 有变更 → 新数组
    const t1 = out.find((m: any) => m.id === "t1");
    expect(t1.content.length).toBeLessThan(TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS + 120);
    expect(t1.content).toContain("中段已裁剪");
    const t3 = out.find((m: any) => m.id === "t3");
    expect(t3.content).toBe(recent); // 最近保留完整
    // 全部小 → 原数组引用不变
    const smalls = [{ role: "tool", content: "a" }, { role: "tool", content: "b" }];
    expect(pruneStaleToolResults(smalls, 2)).toBe(smalls);
  });
});

/**
 * 高水位微压缩判据（SEG-3 的阶梯 3）：
 * 压力 ≥ 0.9 时，最近 10 条里**历史**工具结果也应被折叠（保留最近 2 条不动），
 * 否则单个巨大工具结果会让保留集永远超预算（overBudget 的常见来源）。
 *
 * 关键不变量：只替换 `role:"tool"` 的 content，**不动 role / tool_call_id**，
 * 所以不会出现「调了工具但没有结果」的孤儿配对。
 */
import { describe, expect, it } from "vitest";

import { microCompact } from "../core/llm/micro-compact";

function conversation(turns: number): any[] {
  const msgs: any[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < turns; i++) {
    msgs.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read", arguments: "{}" } }],
    });
    msgs.push({ role: "tool", toolCallId: `call_${i}`, content: `tool output ${i} ${"x".repeat(12000)}` });
  }
  return msgs;
}

describe("MICRO-9 默认保留最近 10 条", () => {
  it("不传 keepRecent 时最近 10 条原样保留", () => {
    const msgs = conversation(10); // 21 条
    const r = microCompact(msgs);
    expect(r.compactedCount, `count=${r.compactedCount}`).toBeGreaterThan(0);
    // 最后 10 条里只有 tool 结果会被折；检查最后一条仍是原内容
    expect(r.messages[r.messages.length - 1].content).toContain("tool output 9");
  });
});

describe("MICRO-9b 高水位缩到最近 2 条", () => {
  it("keepRecent=2 时折得更多，但最后 2 条不动", () => {
    const msgs = conversation(10);
    const normal = microCompact(msgs);
    const aggressive = microCompact(msgs, { keepRecent: 2 });
    expect(aggressive.compactedCount, `normal=${normal.compactedCount} aggressive=${aggressive.compactedCount}`).toBeGreaterThan(normal.compactedCount);
    const tail = aggressive.messages.slice(-2);
    // 最后两条是「assistant(tool_call) + tool 结果」这一对，原样保留
    expect(tail[0].role).toBe("assistant");
    expect(tail[1].role).toBe("tool");
    expect(tail[1].content).toContain("tool output 9");
    // 配对不变量：每条 tool 的 tool_call_id 还在，且前面仍有对应 assistant
    const ids = new Set(
      aggressive.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => (m.tool_calls ?? []).map((t: any) => t.id)),
    );
    for (const m of aggressive.messages.filter((x) => x.role === "tool")) {
      expect(ids.has(m.toolCallId), `孤儿 tool：${m.toolCallId}`).toBe(true);
    }
  });

  it("对话不够长时不做任何事", () => {
    const r = microCompact(conversation(1), { keepRecent: 2 });
    expect(r.compactedCount).toBe(0);
  });
});

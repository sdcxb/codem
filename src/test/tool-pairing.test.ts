/**
 * P0：工具调用/结果**配对**的判据（这是"折叠是否把对拆散"的正式答案）。
 *
 * 两层：
 * 1. **折叠/裁剪层** —— 只改文本，不删消息、不删调用（`foldToolOutputsUnderTarget` /
 *    `pruneStaleToolResults`）；
 * 2. **请求层** —— `enforceToolPairing` 清掉孤儿结果、剥掉没有结果/部分结果的 `tool_calls`。
 *
 * 判据按"会被 API 拒绝的形状"写：孤儿 tool、悬空 tool_calls、部分结果。
 */
import { describe, it, expect, vi } from "vitest";

import { enforceToolPairing } from "../core/llm/tool-pairing";
import { foldToolOutputsUnderTarget } from "../core/llm/tool-output-fold";
import { pruneStaleToolResults } from "../core/llm/context-fold";

const assistantWithCalls = (id: string, calls: Array<{ id: string; result?: string }>) => ({
  id,
  role: "assistant",
  content: "我来读文件",
  tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: "read", arguments: "{}" } })),
});

const toolResult = (callId: string, content: string) => ({
  id: `tool-${callId}`,
  role: "tool",
  toolCallId: callId,
  content,
});

describe("工具配对：请求侧清理（enforceToolPairing）", () => {
  it("PAIR-1: 干净的一对一保持原样（不剥、不丢）", () => {
    const input = [
      { id: "u1", role: "user", content: "读一下" },
      assistantWithCalls("a1", [{ id: "tc1" }]),
      toolResult("tc1", "内容"),
    ];
    const r = enforceToolPairing(input);
    expect(r.messages).toHaveLength(3);
    expect(r.strippedToolCallMessages).toBe(0);
    expect(r.droppedOrphanToolResults).toBe(0);
    expect(r.messages[1].tool_calls).toHaveLength(1);
  });

  it("PAIR-2: 孤儿 tool 结果被丢掉（没有 assistant 声明它）", () => {
    const r = enforceToolPairing([
      { id: "u1", role: "user", content: "继续" },
      toolResult("tc-ghost", "没有归属的结果"),
    ]);
    expect(r.droppedOrphanToolResults).toBe(1);
    expect(r.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("PAIR-3: 一条结果都没有 → 整块剥掉 tool_calls，只留正文", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = enforceToolPairing([
      { id: "u1", role: "user", content: "读一下" },
      assistantWithCalls("a1", [{ id: "tc1" }, { id: "tc2" }]),
    ]);
    expect(r.strippedToolCallMessages).toBe(1);
    expect(r.strippedToolCalls).toBe(2);
    expect(r.messages[1].tool_calls, "悬空调用必须被剥掉，否则模型会重试").toBeUndefined();
    expect(r.messages[1].content).toBe("我来读文件");
    vi.restoreAllMocks();
  });

  it("PAIR-4: 部分结果 → 只保留有结果的那个调用（否则 API 400）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = enforceToolPairing([
      assistantWithCalls("a1", [{ id: "tc1" }, { id: "tc2" }]),
      toolResult("tc1", "只有这一条活下来"),
    ]);
    expect(r.messages[0].tool_calls.map((tc: any) => tc.id)).toEqual(["tc1"]);
    expect(r.strippedToolCalls).toBe(1);
    expect(r.strippedToolCallMessages).toBe(1);
    vi.restoreAllMocks();
  });
});

describe("折叠/裁剪不拆配对", () => {
  /** 5 条带工具结果的消息（足够让"最近 2 条结果"之外还有可折的） */
  const makeMessages = () => {
    const out: any[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      out.push({ id: `u${turn}`, role: "user", content: `第 ${turn} 轮` });
      out.push({
        id: `a${turn}`,
        role: "assistant",
        content: "",
        toolCalls: [
          { tool: "read", args: { path: `f${turn}.ts` }, result: String(turn).repeat(6000) },
          { tool: "read", args: { path: `g${turn}.ts` }, result: String(turn).repeat(6000) },
        ],
      });
    }
    return out;
  };

  it("PAIR-5: 折叠只改文本 —— 消息数、调用数、每个调用的 result 都还在", () => {
    const before = makeMessages();
    const beforeJson = JSON.stringify(before);
    const folded = foldToolOutputsUnderTarget(before, {
      targetTokens: 1, // 逼它把所有候选都折一遍
      estimate: (msgs) => JSON.stringify(msgs).length,
    });

    expect(folded.candidates.length, "应当有可折的候选").toBeGreaterThan(0);
    expect(folded.messages).toHaveLength(before.length);
    expect(folded.messages.map((m: any) => m.id)).toEqual(before.map((m) => m.id));

    for (let i = 0; i < before.length; i += 1) {
      const a = before[i] as any;
      const b = folded.messages[i] as any;
      if (!Array.isArray(a.toolCalls)) continue;
      expect(b.toolCalls, `第 ${i} 条消息的调用数组不该消失`).toHaveLength(a.toolCalls.length);
      for (let j = 0; j < a.toolCalls.length; j += 1) {
        expect(typeof b.toolCalls[j].result, `第 ${i} 条第 ${j} 个调用必须仍有 result`).toBe("string");
        expect(b.toolCalls[j].result.length).toBeGreaterThan(0);
      }
    }
    expect(JSON.stringify(folded.messages).length).toBeLessThan(beforeJson.length);
  });

  it("PAIR-5b: 最近 2 条工具结果不折（唯一被保护的那一档）", () => {
    const before = makeMessages();
    const folded = foldToolOutputsUnderTarget(before, {
      targetTokens: 1,
      estimate: (msgs) => JSON.stringify(msgs).length,
    });

    expect(folded.candidates.length).toBeGreaterThan(0);
    const resultMessages = before.filter((m: any) => Array.isArray(m.toolCalls));
    const protectedIds = new Set(resultMessages.slice(-2).map((m: any) => m.id));
    for (const cand of folded.candidates) {
      expect(
        protectedIds.has(cand.messageId),
        `候选落在最近 2 条工具结果里（${cand.messageId}）—— 当前正在干的事不许折`,
      ).toBe(false);
    }
  });

  it("PAIR-6: pruneStaleToolResults 不删消息（只裁 content）", () => {
    const messages = [
      { id: "t0", role: "tool", content: "x".repeat(20_000) },
      { id: "t1", role: "tool", content: "y".repeat(20_000) },
      { id: "t2", role: "tool", content: "z".repeat(20_000) },
    ];
    const pruned = pruneStaleToolResults(messages, 1);
    expect(pruned).toHaveLength(messages.length);
    expect(pruned.map((m: any) => m.id)).toEqual(messages.map((m) => m.id));
    // 最近 1 条保持完整，更早的裁成 head+tail
    expect(String(pruned[2].content).length).toBe(20_000);
    expect(String(pruned[0].content).length).toBeLessThan(20_000);
  });
});

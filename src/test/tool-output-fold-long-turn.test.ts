/**
 * FOLD-LONGTURN：**一个长回合**里的陈旧工具输出必须能被折叠。
 *
 * ## 被守的缺陷（2026-10-19，用户实报）
 *
 * 用户：长对话里工具调用很多，3–5 个对话就触发「上下文即将满」。机制要求"先静默折叠远处工具输出，
 * 还高才提示"，但在**一个很长的 agent 回合**里，"最近 3 轮不折"会把这**一整轮**都保护起来
 * （轮 = 一条 user 到下一轮之前）⇒ 折叠一条都折不动，水位继续冲过 70%，提示照旧出现。
 *
 * 修复：再加一道**按消息数**的尾部保护（最后 6 条不动，含最近 2 条工具结果），
 * 更早的"轮内陈旧工具输出"允许折叠。判据 `FOLD-LONGTURN-1..3`；变异 `fold-long-turn`。
 */
import { describe, it, expect } from "vitest";
import {
  foldToolOutputsUnderTarget,
  protectedFromIndexForTurns,
  planToolOutputFold,
  FOLD_KEEP_TAIL_MESSAGES,
} from "../core/llm/tool-output-fold";

const WINDOW = 128_000;
const AVAILABLE = Math.round(WINDOW * 0.9);
/** 与 `summarizeModelContext` 同量级的口径：4 字符 ≈ 1 token */
const estimate = (ms: any[]) => {
  let chars = 0;
  for (const m of ms) {
    if (typeof m?.content === "string") chars += m.content.length;
    for (const tc of m?.toolCalls ?? []) chars += typeof tc?.result === "string" ? tc.result.length : 0;
  }
  return Math.ceil(chars / 4);
};

/** 一条带单个工具结果的 assistant 消息 */
function toolMsg(id: string, chars: number, tool = "read") {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [{ tool, result: "x".repeat(chars), status: "done" }],
  };
}
function userMsg(id: string, text = "继续") {
  return { id, role: "user", content: text };
}

/** 4 轮历史 + 最后一轮 30 次工具调用（每次 12K 字符） */
function longTurnConversation() {
  const messages: any[] = [];
  for (let t = 0; t < 3; t++) {
    messages.push(userMsg(`u${t}`, `第 ${t} 轮`));
    for (let k = 0; k < 3; k++) messages.push(toolMsg(`t${t}-${k}`, 12_000));
    messages.push({ id: `a${t}`, role: "assistant", content: "这一轮完成。" });
  }
  messages.push(userMsg("u3", "把这件事做完"));
  for (let k = 0; k < 30; k++) messages.push(toolMsg(`c${k}`, 12_000));
  messages.push({ id: "final", role: "assistant", content: "完成。" });
  return messages;
}

describe("FOLD-LONGTURN 长回合折叠", () => {
  it("FOLD-LONGTURN-1: 长回合水位 >70% 时，能把陈旧工具输出折到 70% 以下，且末尾与最近 2 条结果不动", () => {
    const msgs = longTurnConversation();
    const before = estimate(msgs) / AVAILABLE;
    expect(before, "构造的长回合必须真的超过 70%").toBeGreaterThan(0.7);

    const tail = msgs.slice(-3);
    const lastTwoResults = msgs
      .filter((m) => m.toolCalls?.length)
      .slice(-2)
      .map((m) => m.toolCalls[0].result);

    const result = foldToolOutputsUnderTarget(msgs, {
      protectedFromIndex: protectedFromIndexForTurns(msgs),
      targetTokens: Math.floor(AVAILABLE * 0.45),
      estimate,
    });

    expect(result.candidates.length, "必须真的折到东西").toBeGreaterThan(0);
    const after = estimate(result.messages) / AVAILABLE;
    expect(after, `折叠后应跌破 70%（实际 ${(after * 100).toFixed(1)}%）`).toBeLessThan(0.7);

    // 最后 3 条逐字不动（含最后一条回复）
    expect(result.messages.slice(-3)).toEqual(tail);
    // 最近 2 条工具结果逐字不动
    const newLastTwo = result.messages
      .filter((m: any) => m.toolCalls?.length)
      .slice(-2)
      .map((m: any) => m.toolCalls[0].result);
    expect(newLastTwo).toEqual(lastTwoResults);
    // 消息数与所有 user 文本不变（只截工具结果中段）
    expect(result.messages).toHaveLength(msgs.length);
    expect(result.messages.filter((m: any) => m.role === "user").map((m: any) => m.content)).toEqual(
      msgs.filter((m: any) => m.role === "user").map((m: any) => m.content),
    );
  });

  it("FOLD-LONGTURN-2: 小结果不折；最近 2 条结果永远不动", () => {
    const short = [userMsg("u0"), toolMsg("t0", 1_500), { id: "a0", role: "assistant", content: "好" }];
    expect(planToolOutputFold(short, { protectedFromIndex: 0 }), "小于阈值的工具结果不折").toHaveLength(0);
  });

  it("FOLD-LONGTURN-4: 最近 2 条工具结果即使落在末尾保护之外，也不许折", () => {
    const msgs: any[] = [userMsg("u0")];
    for (let k = 0; k < 6; k++) msgs.push(toolMsg(`t${k}`, 12_000));
    // 末尾 10 条都是纯文本消息 ⇒ 最后 2 条工具结果在"末尾 8 条"之外，
    // 只能靠 FOLD_KEEP_RECENT_RESULTS 保护它们。
    for (let k = 0; k < 10; k++) msgs.push({ id: `x${k}`, role: "assistant", content: "说明。" });
    const candidates = planToolOutputFold(msgs, { protectedFromIndex: 0 });
    const ids = new Set(candidates.map((c) => c.messageId));
    expect(ids.has("t5"), "最近 1 条工具结果不许折").toBe(false);
    expect(ids.has("t4"), "最近 2 条工具结果不许折").toBe(false);
    expect(ids.has("t0"), "更早的可以折").toBe(true);
  });

  it("FOLD-LONGTURN-5: 第一档不够时换短存根，可重放的结果被折到 240 字符，不可重放的保留更多", () => {
    const msgs: any[] = [userMsg("u0")];
    for (let k = 0; k < 20; k++) msgs.push(toolMsg(`big${k}`, 60_000, k === 0 ? "web_fetch" : "read"));
    msgs.push({ id: "final", role: "assistant", content: "完成。" });
    const before = estimate(msgs) / AVAILABLE;
    expect(before, "构造场景必须真的很高").toBeGreaterThan(1);

    const result = foldToolOutputsUnderTarget(msgs, {
      protectedFromIndex: protectedFromIndexForTurns(msgs),
      targetTokens: Math.floor(AVAILABLE * 0.45),
      estimate,
    });
    const after = estimate(result.messages) / AVAILABLE;
    expect(after, `第二档应把水位拉下来（实际 ${(after * 100).toFixed(1)}%）`).toBeLessThan(0.7);

    const stubbed = result.messages.find((m: any) => m.id === "big1")?.toolCalls[0].result as string;
    expect(stubbed, "可重放结果应换成短存根").toContain("工具结果中段已折叠：原始 60000 字符");
    expect(stubbed.length).toBeLessThanOrEqual(240);

    const irrepro = result.messages.find((m: any) => m.id === "big0")?.toolCalls[0].result as string;
    expect(irrepro.length, "不可重放的工具（web_fetch）不许换成 240 字存根").toBeGreaterThan(8_000);
  });

  it("FOLD-LONGTURN-3: 普通多轮（每轮都小）不受影响 —— 仍然只折较早的那几条", () => {
    const msgs: any[] = [];
    for (let t = 0; t < 6; t++) {
      msgs.push(userMsg(`u${t}`));
      msgs.push(toolMsg(`t${t}`, 9_000));
      msgs.push({ id: `a${t}`, role: "assistant", content: "好。" });
    }
    const candidates = planToolOutputFold(msgs, { protectedFromIndex: protectedFromIndexForTurns(msgs) });
    // 18 条消息、尾部保护 3 条 + 最近 2 条结果（t4/t5）⇒ 可折 t0..t3
    expect(candidates.map((c) => c.messageId).sort()).toEqual(["t0", "t1", "t2", "t3"]);
  });
});

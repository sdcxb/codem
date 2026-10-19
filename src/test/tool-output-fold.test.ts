/**
 * 折叠阶梯的判据（纯函数，不依赖端口夹具 —— 夹具那条路本轮已经证明不可靠，别再走）。
 *
 * FD-1：水位过 0.5 时，折叠远处的大工具结果能把估算压到目标以下（这就是"先不提示"的依据）。
 * FD-2：最近 2 条工具结果**绝不**被折。
 * FD-3：折叠是**读时视图** —— 原文一个字都不少（不销毁信息，"取回"等于重跑工具或直接看历史）。
 * FD-4：不可重放类留更大片段并写明原因（网页/API 那种取不回来的）。
 * FD-5：按「距离 × 体积」选 —— 只折最老的那条不够时，会继续折"更近但更大"的那条。
 * FD-6：确定性 —— 同一输入两次折叠结果一致（否则水位会抖，横幅会闪）。
 */
import { describe, expect, it } from "vitest";
import {
  FOLD_KEEP_RECENT_RESULTS,
  FOLD_TARGET_RATIO,
  FOLD_TRIGGER_RATIO,
  foldToolOutputsUnderTarget,
  isReproducibleTool,
  planToolOutputFold,
  protectedFromIndexForTurns,
} from "../core/llm/tool-output-fold";
import { summarizeModelContext } from "../core/llm/compaction-budget";

const WINDOW = 128000;
const AVAILABLE = Math.round(WINDOW * 0.9); // 115,200（与水位同一口径）
const estimate = (msgs: any[]) => summarizeModelContext(msgs as never[], WINDOW).usedTokens;

/** 造一条 assistant 消息，挂 n 个工具结果（每个 chars 字符） */
function asst(id: string, chars: number[], ts: number, tools?: string[]) {
  return {
    id,
    role: "assistant",
    content: "做了点事",
    timestamp: ts,
    toolCalls: chars.map((c, i) => ({
      id: `${id}-tc${i}`,
      tool: tools?.[i] ?? "read",
      args: { path: `f${i}.txt` },
      result: "字".repeat(c),
    })),
  };
}
function usr(id: string, ts: number, chars = 50) {
  return { id, role: "user", content: "字".repeat(chars), timestamp: ts };
}

/** 一段 60 万字符历史（≈150k token，远超窗口）+ 最近 3 轮对话 */
function longHistory() {
  const msgs: any[] = [];
  let ts = 1;
  for (let round = 0; round < 12; round++) {
    msgs.push(usr(`u${round}`, ts++));
    msgs.push(asst(`a${round}`, [200_000, 120_000], ts++, ["read", "grep"]));
  }
  /* 最近 3 轮（必须被保护） */
  for (let i = 0; i < 3; i++) {
    msgs.push(usr(`ru${i}`, ts++));
    /* 近处故意小：这样"选择后"的大头落在**远处的大工具结果**上 —— 正是折叠要处理的形态 */
    msgs.push(asst(`ra${i}`, [300], ts++, ["read"]));
  }
  return msgs;
}

describe("FD 折叠阶梯：工具输出（用户提的机制）", () => {
  it("FD-1：水位超过折叠触发档时，折叠能把估算压到目标以下（先静默折叠、不打扰用户）", () => {
    const msgs = longHistory();
    /* 用线性估算器（字符总量）钉住折叠逻辑本身：选择器的优先序是另一个变量，不该混进这条判据 */
    const chars = (ms: any[]) => ms.reduce((n, m) => n + (typeof m?.content === "string" ? m.content.length : 0) + (Array.isArray(m?.toolCalls) ? m.toolCalls.reduce((k: number, tc: any) => k + (typeof tc?.result === "string" ? tc.result.length : 0), 0) : 0), 0);
    const before = chars(msgs);
    const target = Math.floor(before * 0.25); /* 目标：压到原来的 1/4 以下（阶梯的目标档就是"显著降下来"） */
    expect(
      before,
      "前提：折叠前确实超过目标档（否则这条判据没意义）",
    ).toBeGreaterThan(target);

    const protectedFrom = protectedFromIndexForTurns(msgs);
    const folded = foldToolOutputsUnderTarget(msgs, {
      protectedFromIndex: protectedFrom,
      targetTokens: target,
      estimate: chars,
    });

    expect(folded.candidates.length, "必须真的折了东西").toBeGreaterThan(0);
    expect(
      chars(folded.messages),
      "折完必须低于目标（这就是「还高才提示用户」的前提）",
    ).toBeLessThanOrEqual(target);
  });

  it("FD-2：最近 2 条工具结果绝不被折", () => {
    const msgs = longHistory();
    const protectedFrom = protectedFromIndexForTurns(msgs);
    const candidates = planToolOutputFold(msgs, { protectedFromIndex: protectedFrom });
    /* 最近 N 条工具结果（无论在第几轮）不许折 */
    const withResults = msgs.filter((m) => m.toolCalls?.length).map((m) => String(m.id));
    const recentResults = new Set(withResults.slice(-FOLD_KEEP_RECENT_RESULTS));
    for (const c of candidates) {
      expect(recentResults.has(c.messageId), `不许折最近 ${FOLD_KEEP_RECENT_RESULTS} 条工具结果`).toBe(false);
    }
    /* "长回合内陈旧输出可折"由 `tool-output-fold-long-turn.test.ts` 单独钉（这里近处故意很小） */
  });

  it("FD-3：折叠是读时视图 —— 原文一个字都不少（不销毁信息）", () => {
    const msgs = longHistory();
    const original = JSON.stringify(msgs);
    const protectedFrom = protectedFromIndexForTurns(msgs);
    const folded = foldToolOutputsUnderTarget(msgs, {
      protectedFromIndex: protectedFrom,
      targetTokens: 1000,
      estimate,
    });
    expect(folded.candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(msgs), "入参数组一字不动（折叠只产生新数组）").toBe(original);
    /* 折叠后的视图里仍能看到"中段已裁剪/已折叠"的说明，便于模型重取 */
    const text = JSON.stringify(folded.messages);
    expect(/工具结果中段已裁剪|中段已折叠/.test(text), "折叠处必须留下可重取的说明").toBe(true);
  });

  it("FD-4：不可重放的工具留更大片段并写明原因（网页/API 取不回来）", () => {
    expect(isReproducibleTool("read")).toBe(true);
    expect(isReproducibleTool("web_fetch")).toBe(false);
    const msgs = [
      usr("u1", 1),
      asst("a1", [40_000], 2, ["web_fetch"]),
      usr("u2", 3),
      asst("a2", [1000], 4, ["read"]),
    ];
    const plan = planToolOutputFold(msgs, { protectedFromIndex: 4, keepRecentResults: 0 });
    const web = plan.find((c) => c.tool === "web_fetch");
    const read = plan.find((c) => c.tool === "read");
    expect(web, "网页抓取必须被当成候选（但不能折狠）").toBeTruthy();
    /* 40,000 字符：可重放会折到 4096+note+1024 ≈ 5.2k；不可重放留 8192+note+2048 ⇒ 明显更大 */
    expect(web!.afterChars, "不可重放要留更大片段").toBeGreaterThan(10_000);
    /*
     * 1,000 字符的可重放结果：第一档折不动（head 4096 比它还大），但**允许作为第二档候选**
     * （换成 240 字存根）。这里钉的是"第一档不许动它"。
     */
    expect(read, "小于第一档阈值的结果仍然可以进第二档候选").toBeTruthy();
    expect(read!.afterChars, "第一档不许把它改小").toBe(read!.beforeChars);
    expect(read!.stubChars, "第二档存根最多 240 字").toBeLessThanOrEqual(240);
  });

  it("FD-5：按「距离 × 体积」选 —— 更近但更大的那条也会被折（只看最老的不够）", () => {
    const msgs = [
      usr("u1", 1),
      asst("old-small", [6000], 2, ["read"]),
      asst("new-big", [200_000], 3, ["read"]),
      usr("ru1", 4),
      asst("ra1", [500], 5, ["read"]),
    ];
    const plan = planToolOutputFold(msgs, { protectedFromIndex: 3, keepRecentResults: 0 });
    expect(plan[0].messageId, "省得最多的那条必须排第一（距离×体积）").toBe("new-big");
  });

  it("FD-6：确定性 —— 同一输入两次折叠结果完全一致（否则水位会抖、横幅会闪）", () => {
    const msgs = longHistory();
    const protectedFrom = protectedFromIndexForTurns(msgs);
    const opts = { protectedFromIndex: protectedFrom, targetTokens: 5000, estimate };
    const a = foldToolOutputsUnderTarget(msgs, opts);
    const b = foldToolOutputsUnderTarget(msgs, opts);
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    expect(a.candidates.map((c) => c.messageId)).toEqual(b.candidates.map((c) => c.messageId));
  });
});

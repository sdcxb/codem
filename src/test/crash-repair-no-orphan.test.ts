/**
 * 第 164 波：**崩溃修复绝不允许产出"孤儿 `tool_result`"** ✓。
 *
 * ## 用户看到的那条（存量 ✓）
 *
 * ```
 * 1791003170776-s2dseeyhe: tool_result at seq 13835
 *   references unknown toolCallId: call_00_pLcrhU2XQ4TS09fnSMAV4802
 * ```
 *
 * 只读摊开 seq 13833..13836 之后确认：**同一次调用配了两条 `tool_result`** ✗，
 * 第二条用的是 **provider 的 id**（`call_00_…` ✓），而事件库里没有对应的 `tool_call` ✗。
 *
 * 之后逐处查证写入点 ✓：
 * - 正常路径**只有一处**（`tool-pipeline.ts:1135/1143` ✓），
 *   而且**两条用的是同一个** `toolCallId` ✓（`result.id || ctx.toolCallId` ✓，
 *   注释里记着"第 71 轮"那次 id 对齐修复 ✓）⇒ **当前代码不可能产出它** ✓；
 * - 修复路径（`repairCrashedSession` ✓）**只遍历事件库里的 `tool_call`** ✓
 *   ⇒ 它写出的每条结果都必然有对应调用 ✓。
 *
 * ⇒ 结论 ✓：那处孤儿是**id 对齐修复之前的历史遗留** ✗（所以"存量、不会自己消失"✓），
 * 而**当前代码是干净的** ✓。但"干净"必须有判据守着 ✓ —— 这条就是 ✓。
 *
 * ## 判据
 *
 * - **ORPH-1**：日志里有一个"有调用没结果"的调用 + 一个"调用结果齐全"的调用 ⇒
 *   修复**只能**给前者补一条结果 ✓，并且**修完之后不许有任何孤儿** ✓
 *   （每个 `tool_result` 都能回指到一条 `tool_call` ✓）。
 *
 * 变异：让修复为一条**日志里不存在**的调用写结果 ⇒ ORPH-1 红 ✓。
 */
import { describe, expect, it, vi } from "vitest";

/** 极小的记忆事件日志 ✓（只需要 append / readAll ✓） */
function makeLog(seed: Array<{ type: string; payload: Record<string, unknown> }>) {
  const events: Array<{ seq: number; type: string; payload: Record<string, unknown> }> = [];
  let seq = 1;
  for (const e of seed) events.push({ seq: seq++, type: e.type, payload: e.payload });
  return {
    readAll: () => events.map((e) => ({ ...e })),
    append: (_sid: string, type: string, payload: Record<string, unknown>) => {
      events.push({ seq: seq++, type, payload: { ...payload } });
      return { seq: seq - 1 };
    },
    __events: () => events,
  };
}

let log = makeLog([]);
vi.mock("../core/storage/event-log", () => ({
  getEventLog: () => log,
}));

const { repairCrashedSession } = await import("../core/llm/compaction-control");

/**
 * 判定：每个 tool_result 都必须能回指到一条 tool_call ✓。
 *
 * ⚠️ **必须与检查器同口径**（第 170 波 ✓）：`event-projection.ts::validateReplay` 现在的口径是
 * "**整个日志里有没有这个 id**"✓（顺序不敏感 ✓）—— 因为修复补出来的调用只能**追加**在结果之后 ✗，
 * 顺序敏感的口径下"补了也照样报"✓（判据 ORPH-2 当场抓到过这件事 ✗）。
 */
function orphans(events: Array<{ type: string; payload: Record<string, unknown> }>): string[] {
  const allCalls = new Set(
    events.filter((e) => e.type === "tool_call").map((e) => String(e.payload?.toolCallId ?? "")),
  );
  const bad: string[] = [];
  for (const e of events) {
    const id = String(e.payload?.toolCallId ?? "");
    if (e.type === "tool_result" && id && !allCalls.has(id)) bad.push(id);
  }
  return bad;
}

describe("第 164 波：崩溃修复不许产出孤儿 tool_result", () => {
  it("ORPH-1: 只给'有调用没结果'的那个补结果，且修完之后一个孤儿都没有", () => {
    log = makeLog([
      /** ① 完整的一对 ✓ */
      { type: "tool_call", payload: { toolCallId: "call-A", messageId: "m1", tool: "read", status: "completed" } },
      { type: "tool_result", payload: { toolCallId: "call-A", messageId: "m1", status: "completed" } },
      /** ② 只有调用、没有结果 ✗（崩溃留下的） */
      { type: "tool_call", payload: { toolCallId: "call-B", messageId: "m1", tool: "bash", status: "running" } },
    ]);

    const result = repairCrashedSession("s1");
    const events = log.__events();

    expect(result.repairs.length, "应当只修那一个不完整的调用").toBe(1);
    expect(result.repairs[0].toolCallId).toBe("call-B");
    expect(
      orphans(events),
      "修完之后**不许**出现任何孤儿 —— 每个 tool_result 都要能回指到一条 tool_call ✗",
    ).toEqual([]);
    /** 反向对照：完整那一对不许被重复补一遍 ✓ */
    expect(
      events.filter((e) => e.type === "tool_result" && String(e.payload?.toolCallId) === "call-A").length,
      "已经有结果的调用不许被再补一条（否则就是重复结果 ✗）",
    ).toBe(1);
  });

  it("ORPH-2: 反方向的缺口（有结果没调用）也要被修好，而且**幂等**（第 170 波 ✓）", () => {
    /**
     * 用户每次维护都被报一次的那处存量 ✗：
     * `tool_result at seq 13835 references unknown toolCallId: call_00_…` ✓
     * —— 它是"id 对齐修复之前"的历史遗留 ✓（所以"存量、不会自己消失"✓）。
     *
     * 这里钉住修复的两条性质 ✓：
     * ① 补一条**被标记**的 `tool_call`（`recovered: true` ✓，不冒充原始记录 ✓）；
     * ② **幂等** —— 它每次 `run()` 都会跑 ✓，跑第二遍不许再补一遍 ✓。
     */
    log = makeLog([
      { type: "tool_result", payload: { toolCallId: "call-ORPHAN", messageId: "m9", status: "completed", result: "旧结果" } },
    ]);

    const first = repairCrashedSession("s2");
    expect(first.repairedCount, "应当补一条调用").toBe(1);
    expect(first.repairs[0].action).toBe("synthesized_call");
    let events = log.__events();
    expect(orphans(events), "补完之后不许再有孤儿").toEqual([]);
    const recovered = events.filter((e) => e.type === "tool_call" && e.payload?.recovered === true);
    expect(recovered.length, "补出来的调用必须**明确标记** recovered ✓（不冒充原始记录 ✗）").toBe(1);

    /** ② 幂等：再跑一遍不许再补 ✓ */
    const second = repairCrashedSession("s2");
    events = log.__events();
    expect(second.repairedCount, "第二遍不该再补（已有配对 ✓）").toBe(0);
    expect(
      events.filter((e) => e.type === "tool_call" && e.payload?.recovered === true).length,
      "补出来的调用总数必须仍是 1 ✓",
    ).toBe(1);
  });
});

/**
 * 「这一轮丢了什么上下文」的可见通道 —— 第 122 轮 B 项。
 *
 * ## 病（用户报的原话）
 *
 * > 一个对话轮次多了之后，它就会经常任务停止，或者压缩思考和回答……**其他平台都是会提示**，
 * > 我们平台水位不够了、效果马上变坏了、新开对话的提示，**dsh 就没有**。
 *
 * 侦察结论：我们**有**水位阈值与告警文案，但
 * ① 它们只渲染在默认关闭的 `ContextMonitor` 里；
 * ② 真正"丢上下文"的三处（`agentic-loop.ts:3138`/`3142`/`3161`）**只写 `console.warn`**，
 *    而那条给模型看的 `[上下文精简]`（`context-fold.ts::FOLD_PREFIX`）**不落库、不上界面**。
 *
 * 也就是说：模型少了半截上下文，用户这边**一个像素都没有变化**。
 * 用户唯一能观察到的现象是"回答变差了"，归因必然是「这模型不行」。
 *
 * ## 这个文件守什么
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | CD-1 | 记录了就能读到，读不到时不报假警 |
 * | CD-2 | 订阅者会收到通知（界面才有机会刷新） |
 * | CD-3 | **只保留最近一次**，不累加 —— 界面上写"已累计丢弃 47 条"是误导 |
 * | CD-4 | 通知通道**绝不抛出**（提示是尽力而为，模型这一轮的上下文是必须的） |
 * | CD-5 | `agentic-loop.ts` 的三处剥离/折叠**真的接了**这个通道（静态接线判据） |
 * | CD-6 | 那条 `[上下文精简]` 是**给模型的**，不许被当成用户消息写进对话（判据见下） |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  recordContextDrop,
  readContextDrop,
  subscribeContextDrop,
  contextDropVersion,
  __resetContextDrops,
  type ContextDropRecord,
} from "../core/llm/context-visibility";

const SESSION = "s-vis";

function sample(over: Partial<Omit<ContextDropRecord, "at">> = {}) {
  return {
    droppedMessages: 3,
    toolCounts: { bash: 2, read: 1 },
    strippedToolCallMessages: 1,
    strippedToolCalls: 2,
    foldSummaryInserted: true,
    ...over,
  };
}

beforeEach(() => {
  __resetContextDrops();
});

afterEach(() => {
  __resetContextDrops();
});

describe("第 122 轮 · 上下文丢弃的可见通道", () => {
  it("CD-1: 记录了就能读到；没记录过读到的必须是 null（不报假警）", () => {
    expect(readContextDrop(SESSION)).toBeNull();
    expect(readContextDrop("")).toBeNull();
    recordContextDrop(SESSION, sample());
    const got = readContextDrop(SESSION);
    expect(got).not.toBeNull();
    expect(got!.droppedMessages).toBe(3);
    expect(got!.toolCounts).toEqual({ bash: 2, read: 1 });
    expect(got!.strippedToolCalls).toBe(2);
    expect(got!.at).toBeGreaterThan(0);
    // 别的会话不受影响
    expect(readContextDrop("s-other")).toBeNull();
  });

  it("CD-2: 订阅者会收到通知，退订之后不再收到", () => {
    const seen: number[] = [];
    const off = subscribeContextDrop(() => seen.push(contextDropVersion()));
    const v0 = contextDropVersion();
    recordContextDrop(SESSION, sample());
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThan(v0);

    off();
    recordContextDrop(SESSION, sample({ droppedMessages: 9 }));
    expect(seen.length).toBe(1);
  });

  it("CD-3: **只保留最近一次**，不累加（「已累计丢弃 N 条」是误导）", () => {
    recordContextDrop(SESSION, sample({ droppedMessages: 3 }));
    recordContextDrop(SESSION, sample({ droppedMessages: 1 }));
    const got = readContextDrop(SESSION);
    expect(got!.droppedMessages).toBe(1);
  });

  it("CD-4: 单个订阅者抛错不影响其它订阅者，也不向外抛（提示是尽力而为）", () => {
    const good = vi.fn();
    const offBad = subscribeContextDrop(() => {
      throw new Error("订阅者内部错误");
    });
    const offGood = subscribeContextDrop(good);
    expect(() => recordContextDrop(SESSION, sample())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    // 数据照样写进去了
    expect(readContextDrop(SESSION)!.droppedMessages).toBe(3);
    offBad();
    offGood();
  });

  it("CD-5: 空会话 id 不记录（不能把丢弃记到「当前没有会话」上）", () => {
    recordContextDrop("", sample());
    expect(readContextDrop("")).toBeNull();
  });

  it("CD-6: `agentic-loop.ts` 的三处剥离/折叠**真的接了**这个通道（静态接线判据）", () => {
    /**
     * 这一条守的是"模块写好了但没人喂它"—— 本仓栽过多次的形态
     * （`output-contract` 框架齐备、零个工具注册过 outputSchema，于是整套校验恒真）。
     * 所以这里对着**真实调用点**断言，而不是只断言模块自己能跑。
     *
     * ⚠️ 第一版只断言"文本里出现过 `recordContextDrop(this.currentSessionId`"，
     * **变异自证当场打脸**：把守卫改成 `if (false) {`（通知彻底拆掉）
     * 那版判据**照样全绿** —— 因为它只查"字符串在不在"，不查"这段代码跑不跑"。
     * 现在改成三段语义判据：
     *   ① 那个调用**属于**一个可执行的语句，而不是被常量假条件封死；
     *   ② 守卫条件里必须真的引用那两个计数变量；
     *   ③ 两个计数变量必须真的被自增过。
     */
    const src = readFileSync("src/core/llm/agentic-loop.ts", "utf8");
    expect(src).toContain('import { recordContextDrop } from "./context-visibility"');
    expect(src).toContain("recordContextDrop(this.currentSessionId");

    // ① 取出包着调用的那个 `if (...)` 条件，判断它是不是常量假
    const callIdx = src.indexOf("recordContextDrop(this.currentSessionId");
    const guardStart = src.lastIndexOf("\n    if (", callIdx);
    expect(guardStart, "recordContextDrop 必须在一个 if 守卫里（无条件调用会在无丢弃时也发通知）").toBeGreaterThan(0);
    /**
     * ⚠️ 行尾处理：本仓**同一文件里 CRLF 与 LF 是混的**（无 `.gitattributes`、
     * `core.autocrlf=true`）。第一版用 `indexOf("\n", guardStart)` 切行，
     * 在 CRLF 行上会把 `\r` 留下，于是正则 `…\{$` 匹配不上、判据报"形态不认识"
     * —— 一个由行尾引起、看起来像"代码写错了"的假红。这里按 `\r?\n` 切。
     */
    const rest = src.slice(guardStart + 1);
    const guardLine = (rest.split(/\r?\n/, 1)[0] ?? "").replace(/\s+$/, "");
    const condMatch = guardLine.match(/^ {4}if \((.*)\) \{$/);
    expect(condMatch, `守卫形态不认识，无法判定可达性：${guardLine}`).not.toBeNull();
    const cond = condMatch![1];
    // 常量假检测：把一个明显为假的东西当条件 ⇒ 通知永远不会发出
    expect(/^\s*false\s*$/.test(cond), `守卫条件是常量假（${cond}）—— 通知被拆掉了`).toBe(false);
    // ② 守卫必须引用两个计数变量本身（挡住了 `if (0)` / `if (null)` / `if (false)` 之类改写）
    expect(cond).toContain("droppedCount");
    expect(cond).toContain("strippedToolCallMessages");

    // ③ 计数变量必须真的被自增（否则守卫恒假，"接了"是假的）
    expect(src).toMatch(/strippedToolCallMessages\+\+/);
    expect(src).toMatch(/strippedToolCalls \+=/);
    expect(src).toMatch(/droppedCount = dropped\.length/);
    // 折叠摘要是否插入也要如实记录（它只进模型的消息数组，不落库）
    expect(src).toMatch(/foldSummaryInserted:\s*foldInserted/);
    /**
     * 而且**必须**在 `valid.unshift(foldMsg)` 之后才可能记到 `foldInserted = true`
     * —— 顺序反了会把"没插折叠摘要"记成"插了"。
     */
    const unshiftIdx = src.indexOf("valid.unshift({ role: \"user\", content: foldMsg");
    const flagIdx = src.indexOf("foldInserted = true");
    expect(unshiftIdx).toBeGreaterThan(0);
    expect(flagIdx).toBeGreaterThan(unshiftIdx);
  });

  it("CD-7: 折叠摘要行是**给模型的**，不是用户消息 —— 它不能出现在对话消息表里", () => {
    /**
     * `agentic-loop.ts:3161` 把 `{role:"user", content: foldMsg}` unshift 进**本地**的
     * `valid`（给模型的消息数组），**没有**任何落库调用。这条判据把它钉住：
     * 一旦有人"顺手"把它写进消息表，用户会在对话里看到一条自己从没发过的
     * `[上下文精简] …` —— 那是把内部机制泄漏成用户发言。
     *
     * 同时这也解释了为什么必须**另开**一个可见通道：那条提示模型看得到、用户看不到。
     */
    const src = readFileSync("src/core/llm/agentic-loop.ts", "utf8");
    const idx = src.indexOf('valid.unshift({ role: "user", content: foldMsg');
    expect(idx).toBeGreaterThan(0);
    // 取该语句所在行，确认它只碰本地数组
    const lineStart = src.lastIndexOf("\n", idx) + 1;
    const lineEnd = src.indexOf("\n", idx);
    const line = src.slice(lineStart, lineEnd);
    expect(line).toContain("valid.unshift");
    expect(line).not.toMatch(/createMessage|saveMessage|MessageStorage|domainWrite/);
  });
});

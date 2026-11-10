/**
 * C03「最小工作集（Working Set）」的判据。
 *
 * ## 这一组守什么
 *
 * 工作集是**请求侧最后一道收口**：预算内全放得下时它必须**什么都不做**
 * （`selected` 就是入参那个数组 —— 不是"内容一样"，是**同一个引用**），
 * 超预算时只移出**最旧的那一段**、必选项（system / 最近几轮 / 最后一条 user）一条不许少，
 * 移出的内容变成 Pager 索引（原文仍可检索）。
 *
 * | id | 钉什么 | 变红方式 |
 * |---|---|---|
 * | WS-1 | 预算内全放得下 ⇒ `selected===messages`（引用相等）、`indexLines=[]`、顺序不变 | 永远复制一份 / 永远生成索引 |
 * | WS-2 | 超预算 ⇒ 只移出最旧的；最近 keepRecent + 最后 user 必在；`tokens<=budget`；索引恰好覆盖 evicted | 改「永远全选」（不再移出） |
 * | WS-3 | system 永不被移出，索引行不含 system | 把 system 也算进候选 |
 * | WS-4 | 纯函数：同输入两次逐字节一致；**不调用** `Date.now` / `Math.random` | 在实现里加时间戳/随机 id |
 * | WS-5 | 真循环：长历史 + 小窗口 ⇒ 请求里出现索引头、估算不超预算；短历史 ⇒ 请求与改前逐字节一致 | 永远全选 / 索引插到第一条 |
 * | WS-6 | manifest 记录工作集四个数字；没走工作集 ⇒ **不记**（**不在本文件**：工整的数字进清单由 `context-manifest.test.ts` 的 WS-6a / WS-6b 钉住） | 恒写 0 |
 * | WS-8 | 超预算的真循环：压缩 marker 的 **id 仍在请求里**、正文完整，**不是**只剩一行索引摘要 | 让 `planWorkingSet` 忽略 `protectedIds` |
 *
 * 纯函数部分（WS-1~WS-4、WS-8a）不碰存储、不碰时钟；WS-5 / WS-7 / WS-8 走真 `AgenticLoop`
 * + 假存储端口，断言的是**provider 实际收到的请求**（只看源码会假绿）。
 * 默认配置（`segmentEpochs` 未显式关闭）下的短历史零变化由 `working-set-default-on.test.ts` 的 WS-9 钉住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  DEFAULT_INDEX_LINE_MAX,
  DEFAULT_KEEP_RECENT,
  WORKING_SET_INDEX_HEADER,
  collectProtectedContextIds,
  isProtectedContextMessage,
  planWorkingSet,
  renderWorkingSetIndexMessage,
} from "../core/context/working-set";

// ========== 纯函数部分（WS-1 ~ WS-4） ==========

/** 判据里的估算尺子：1 token / 字符（确定性，不受 BPE 启发式影响） */
function chars(message: { content?: unknown }): number {
  return typeof message.content === "string" ? message.content.length : 0;
}

function msg(id: string, role: string, content: string) {
  return { id, role, content };
}

/** 造一条"内容恰好 n 字符"的消息（便于把预算算成整数） */
function sized(id: string, role: string, n: number, fill = "x") {
  return { id, role, content: fill.repeat(n) };
}

describe("C03 工作集：纯函数计划（WS-1 ~ WS-4）", () => {
  it("WS-1：预算内全放得下 ⇒ selected 就是入参那个数组（引用相等）、indexLines 为空、顺序不变", () => {
    const messages = [
      msg("s1", "system", "sys"),
      msg("u1", "user", "hello"),
      msg("a1", "assistant", "hi"),
    ];
    const plan = planWorkingSet({ messages, budgetTokens: 1000, estimate: chars });

    /* ★ 变异点：改成「永远复制一份」或「永远生成索引」⇒ 本行红 */
    expect(plan.selected, "全放得下时必须是**同一个数组引用**（零行为变化）").toBe(messages);
    expect(plan.indexLines).toEqual([]);
    expect(plan.evicted).toEqual([]);
    expect(plan.tokens).toBe("sys".length + "hello".length + "hi".length);
    expect(plan.reasons.budget).toBe(1000);
    /* 全放得下这条路径没有动用任何保底规则 ⇒ keepRecent 计 0（"没用到"不是"用了 0 条"） */
    expect(plan.reasons.keepRecent).toBe(0);
    expect(plan.reasons.evicted).toBe(0);
  });

  it("WS-2：超预算 ⇒ 只移出最旧的；最近 keepRecent + 最后 user 必在；tokens<=budget；索引恰好覆盖 evicted", () => {
    /* 8 条：0=system，1..7 按 user/assistant 交替；最后一条 7 是 user */
    const messages = [
      sized("s1", "system", 3, "s"),
      sized("u1", "user", 100),
      sized("a1", "assistant", 100),
      sized("u2", "user", 100),
      sized("a2", "assistant", 100),
      sized("u3", "user", 100),
      sized("a3", "assistant", 100),
      sized("u4", "user", 100),
    ];
    /* 必选 = system(3) + 最近 4 条(4..7，各 100) + 最后 user(7，已在最近里) = 403 */
    const budget = 403 + 150;
    const plan = planWorkingSet({ messages, budgetTokens: budget, estimate: chars, keepRecent: 4 });

    /* ★ 变异点：改成「永远全选」⇒ 下面两条立即红 */
    expect(plan.evicted.map((m) => m.id), "只移出最旧的那一段（连续前缀），不许中间掏空").toEqual([
      "u1",
      "a1",
    ]);
    expect(plan.evicted.length, "确实移出了东西").toBeGreaterThan(0);

    /* 必选项一条不许少 */
    expect(plan.selected.map((m) => m.id)).toEqual(["s1", "u2", "a2", "u3", "a3", "u4"]);
    expect(plan.selected.some((m) => m.id === "u4"), "最后一条 user 必在").toBe(true);
    for (const id of ["a2", "u3", "a3", "u4"]) {
      expect(plan.selected.some((m) => m.id === id), `最近 keepRecent 内的 ${id} 必在`).toBe(true);
    }

    /* 顺序 = 原时间顺序（不是按新→旧重排） */
    const order = messages.map((m) => m.id);
    const selectedOrder = plan.selected.map((m) => m.id);
    expect(selectedOrder).toEqual(order.filter((id) => selectedOrder.includes(id)));

    /* 预算与估算 */
    expect(plan.tokens).toBeLessThanOrEqual(budget);
    expect(plan.tokens).toBe(3 + 100 * 5);
    expect(plan.reasons.keepRecent).toBe(4);
    expect(plan.reasons.evicted).toBe(2);

    /* 索引恰好覆盖 evicted（≤40 行时一条不少），且有内容的行是 `- [role] id: 摘要` */
    expect(plan.indexLines).toHaveLength(2);
    expect(plan.indexLines[0]).toMatch(/^- \[user\] u1: /);
    expect(plan.indexLines[1]).toMatch(/^- \[assistant\] a1: /);
    for (const id of ["u1", "a1"]) {
      expect(plan.indexLines.join("\n"), `索引必须点到 ${id}（原文才可检索）`).toContain(id);
    }
    expect(plan.indexLines.join("\n"), "摘要要带上，否则索引只剩 id").toContain("xxxx");
  });

  it("WS-3：system 永不被移出，索引行也不含 system（必选自己就超预算时如实报 tokens>budget）", () => {
    const messages = [
      sized("sys1", "system", 1000, "s"),
      sized("sys2", "system", 1000, "s"),
      sized("u1", "user", 100),
      sized("a1", "assistant", 100),
      sized("u2", "user", 10),
    ];
    /* 必选 = 两个 system(2000) + 最后 user(10) = 2010；预算只给 2010（一条可选都塞不下） */
    const budget = 2010;
    const plan = planWorkingSet({ messages, budgetTokens: budget, estimate: chars, keepRecent: 1 });

    expect(plan.selected.map((m) => m.id)).toEqual(["sys1", "sys2", "u2"]);
    expect(plan.evicted.map((m) => m.id)).toEqual(["u1", "a1"]);
    /* 索引行里**不许**出现 system 的 id（system 从来没被移出，谈不上索引） */
    const index = plan.indexLines.join("\n");
    expect(index).not.toContain("sys1");
    expect(index).not.toContain("sys2");
    /**
     * 必选集合自身超过预算时**不裁剪**（系统提示与"用户当下要什么"不能被预算挤掉），
     * 但要如实报出 `tokens > budget` —— 不假装"已压进预算"。
     */
    expect(plan.tokens).toBe(2010);
    expect(plan.tokens).toBeGreaterThan(0);
  });

  it("WS-4：纯函数 —— 同输入两次逐字节一致，且不调用 Date.now / Math.random", () => {
    const messages = [
      sized("s1", "system", 3, "s"),
      ...Array.from({ length: 12 }, (_, i) => sized(`m${i}`, i % 2 === 0 ? "user" : "assistant", 80)),
    ];
    const input = { messages, budgetTokens: 300, estimate: chars, keepRecent: 3 };

    const nowSpy = vi.spyOn(Date, "now");
    const randomSpy = vi.spyOn(Math, "random");
    const first = planWorkingSet(input);
    const second = planWorkingSet({ ...input, messages: [...messages] });
    const calls = { now: nowSpy.mock.calls.length, random: randomSpy.mock.calls.length };
    nowSpy.mockRestore();
    randomSpy.mockRestore();

    expect(calls.now, "工作集里不许读时钟（否则同一轮的多次 buildMessages 会抖）").toBe(0);
    expect(calls.random, "工作集里不许用随机数（判据要能逐字节复现）").toBe(0);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    /* 入参不许被改（纯函数还意味着"不顺手重排调用方的数组"） */
    expect(messages.map((m) => m.id)).toEqual(input.messages.map((m) => m.id));
    expect(first.selected.length + first.evicted.length).toBe(messages.length);
  });

  it("WS-4b：索引溢出 —— 总行数不超过 indexLineMax，末行是「还有 N 条更早消息」注记", () => {
    /* 1 条 system + 60 条 user；keepRecent=0 ⇒ 只有最后一条 user 是必选，其余 59 条全进索引 */
    const messages = [sized("s1", "system", 3, "s"), ...Array.from({ length: 60 }, (_, i) => sized(`m${i}`, "user", 20))];
    const plan = planWorkingSet({ messages, budgetTokens: 3, estimate: chars, keepRecent: 0 });

    expect(plan.evicted).toHaveLength(59);
    expect(plan.indexLines.length, "总行数（含注记）不许超过 indexLineMax").toBeLessThanOrEqual(
      DEFAULT_INDEX_LINE_MAX,
    );
    const note = plan.indexLines[plan.indexLines.length - 1];
    /* 40 行里让出一行给注记 ⇒ 39 条明细 + 注记（省略 59-39=20 条更早的） */
    expect(note).toBe(`（还有 ${59 - (DEFAULT_INDEX_LINE_MAX - 1)} 条更早消息，用 thread_history_search 检索）`);
    expect(plan.indexLines.filter((line) => line.startsWith("- ["))).toHaveLength(DEFAULT_INDEX_LINE_MAX - 1);

    /* 自定义上限同样成立（≤ 5 行，含注记） */
    const tight = planWorkingSet({ messages, budgetTokens: 3, estimate: chars, keepRecent: 0, indexLineMax: 5 });
    expect(tight.indexLines).toHaveLength(5);
    expect(tight.indexLines[4]).toContain("还有 55 条更早消息");
  });

  it("WS-4c：默认值 / 坏输入收敛（keepRecent=6、预算 NaN/负数归 0、不抛）", () => {
    expect(DEFAULT_KEEP_RECENT).toBe(6);
    const messages = [
      sized("s1", "system", 3, "s"),
      ...Array.from({ length: 10 }, (_, i) => sized(`m${i}`, "user", 50)),
    ];
    /* 预算给 0：一条可选都放不下，但必选（system + 最近 6 条 + 最后 user）都在 */
    const plan = planWorkingSet({ messages, budgetTokens: Number.NaN, estimate: chars });
    expect(plan.reasons.budget, "NaN 预算收敛为 0（不许把 NaN 传下去）").toBe(0);
    expect(plan.selected.map((m) => m.id)).toEqual(["s1", "m4", "m5", "m6", "m7", "m8", "m9"]);
    expect(plan.evicted.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(plan.reasons.keepRecent, "默认 keepRecent=6").toBe(6);

    const negative = planWorkingSet({ messages, budgetTokens: -500, estimate: chars });
    expect(negative.reasons.budget).toBe(0);
    expect(() => planWorkingSet({ messages, budgetTokens: 10, estimate: null as never })).not.toThrow();
    expect(() => planWorkingSet({ messages: null as never, budgetTokens: 10, estimate: chars })).not.toThrow();
  });

  it("WS-4d：默认摘要 —— 只有工具调用的 assistant 消息写工具名（不退化成一串「（无文本）」）", () => {
    const messages = [
      sized("s1", "system", 3, "s"),
      { id: "tool-call", role: "assistant", content: "", toolCalls: [{ tool: "read" }, { tool: "grep" }] },
      sized("u1", "user", 10),
    ];
    const plan = planWorkingSet({ messages, budgetTokens: 12, estimate: chars, keepRecent: 1 });
    expect(plan.evicted.map((m) => m.id)).toEqual(["tool-call"]);
    expect(plan.indexLines[0]).toContain("工具调用：read、grep");
  });

  it("WS-4e：索引正文渲染契约（标题行来自同一个常量）", () => {
    expect(renderWorkingSetIndexMessage([])).toBe("");
    const text = renderWorkingSetIndexMessage(["- [user] u1: 你好"]);
    expect(text.split("\n")[0]).toBe(WORKING_SET_INDEX_HEADER);
    expect(text).toContain("- [user] u1: 你好");
    expect(WORKING_SET_INDEX_HEADER.startsWith("# 更早消息索引")).toBe(true);
  });

  /**
   * WS-8a：`protectedIds` 的纯函数语义 + **反向对照**。
   *
   * 反向对照是这条判据的另一半：同一条最旧的 marker，**不传** protectedIds 时必须被移出
   * 并只留一行索引 —— 否则 WS-8 的绿可能只是「它本来就没被移出」（判据没有区分力）。
   */
  it("WS-8a：protectedIds 命中的消息必选且计入预算；不传 ⇒ 同一条会被移出（反向对照）", () => {
    const marker = sized("compact-1700000000000-1", "user", 300);
    const messages = [
      sized("s1", "system", 3, "s"),
      marker,
      ...Array.from({ length: 12 }, (_, i) => sized(`t-${i}`, i % 2 === 0 ? "user" : "assistant", 100)),
    ];
    /* 必选（system + 最近 2 条 + 最后 user）约 203 + 300(marker 只在受保护时必选) */
    const budget = 500;

    const withProtection = planWorkingSet({
      messages,
      budgetTokens: budget,
      estimate: chars,
      keepRecent: 2,
      protectedIds: new Set(["compact-1700000000000-1"]),
    });
    /* ★ 变异点：planWorkingSet 忽略 protectedIds ⇒ 下面这条红 */
    expect(
      withProtection.selected.some((m) => m.id === "compact-1700000000000-1"),
      "受保护的 marker 必须留在 selected 里",
    ).toBe(true);
    /* 计入预算：selected 的估算合计 == 如实报出的 tokens（marker 的费用没有被漏掉） */
    const protectedCost = withProtection.selected.reduce((sum, m) => sum + chars(m), 0);
    expect(withProtection.tokens).toBe(protectedCost);
    expect(withProtection.reasons.evicted).toBeGreaterThan(0);

    const withoutProtection = planWorkingSet({
      messages,
      budgetTokens: budget,
      estimate: chars,
      keepRecent: 2,
    });
    expect(
      withoutProtection.selected.some((m) => m.id === "compact-1700000000000-1"),
      "反向对照：不传 protectedIds 时，这条最旧的 marker 会被移出视图",
    ).toBe(false);
    expect(withoutProtection.indexLines.join("\n")).toContain("compact-1700000000000-1");
  });

  it("WS-8b：受保护 id 的收集口径 —— `metadata.contextEpoch` 或 `compact-` 前缀，坏输入不抛", () => {
    const withEpoch = {
      id: "some-user-id",
      metadata: { contextEpoch: { epochId: "e1", cutoffMessageId: "x" } },
    };
    const byIdPrefix = { id: "compact-manual-1-2", metadata: null };
    const plain = { id: "u1", metadata: { midTurnGuidance: true } };
    expect(isProtectedContextMessage(withEpoch)).toBe(true);
    expect(isProtectedContextMessage(byIdPrefix), "读不到 metadata 时按 id 前缀兜底").toBe(true);
    expect(isProtectedContextMessage(plain)).toBe(false);
    expect(isProtectedContextMessage(null)).toBe(false);
    expect(isProtectedContextMessage("nope")).toBe(false);

    const ids = collectProtectedContextIds([withEpoch, byIdPrefix, plain, null as never, { metadata: {} } as never]);
    expect([...ids].sort()).toEqual(["compact-manual-1-2", "some-user-id"]);
    expect(collectProtectedContextIds(null).size).toBe(0);
    expect(collectProtectedContextIds([{ metadata: { contextEpoch: "坏形状" } }]).size, "非对象 epoch 不算").toBe(0);
  });
});

// ========== 真循环部分（WS-5 / WS-7 / WS-8） ==========

const SESSION = "ws-loop";
const SYSTEM_PROMPT = "你是工作集判据用的助手。";

class RecordingProvider {
  id = "ws-provider";
  name = "WS Mock";
  requests: any[] = [];
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "收到" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

/**
 * WS-10 用：同一轮里回两次 —— 第一次一个工具调用（循环会追加一条工具结果再发第二次）。
 * 工具用 `update_plan`：不碰文件系统，执行成败不影响"工具结果已追加"这个事实。
 */
class ToolCallThenStopProvider {
  id = "ws10-provider";
  name = "WS10 Mock";
  requests: any[] = [];
  calls = 0;
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "tool_use_start", id: "call-ws10-1", name: "update_plan" };
      yield { type: "tool_use_end", id: "call-ws10-1", input: { action: "append", titles: ["继续"] } };
      yield { type: "end", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "完成" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "" };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

/** 造一条"内容约 n 字符"的会话消息（用 ASCII，估算稳定） */
function historyRow(id: string, role: string, n: number, timestamp: number) {
  return {
    id,
    session_id: SESSION,
    role,
    content: `[${id}] ` + "abcdefghij".repeat(Math.ceil(n / 10)).slice(0, Math.max(0, n - id.length - 3)),
    timestamp,
    status: "done",
    hidden: 0,
  };
}

describe("C03 工作集：真循环接线（WS-5 / WS-7 / WS-8）", () => {
  let port: any;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const { setStoragePort } = await import("../core/storage/port");
    const { getTokenTracker } = await import("../core/llm/token-tracker");
    const { forgetManifests } = await import("../core/context/manifest");
    const { getContextManager } = await import("../core/context/context");

    forgetManifests(SESSION);
    getTokenTracker().setContextWindow(200_000);
    /* 固定配置口径（面板默认值），让「预算 = 窗口 - 输出预留 - 系统提示词」可复算 */
    getContextManager().updateConfig({ segmentEpochs: false, outputReserve: 4096, systemPromptTokens: 2000 });
    port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: SESSION, project_id: "p1", title: "t", created_at: 1, last_message_at: 2, message_count: 0 },
        ],
      },
    });
    setStoragePort(port as never);
  });

  afterEach(async () => {
    const { setStoragePort } = await import("../core/storage/port");
    const { forgetManifests } = await import("../core/context/manifest");
    const { getContextManager } = await import("../core/context/context");
    forgetManifests(SESSION);
    getContextManager().updateConfig({ segmentEpochs: false });
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  function seed(rows: any[]): void {
    port.data.execute("crud.upsert", { table: "messages", rows, mode: "replace" });
  }

  /** 跑一轮并把 loop 一起返回（压力口径的判据要读 loop 的内部状态） */
  async function runTurnWithLoop(
    prompt: string,
    contextWindow: number,
  ): Promise<{ request: any; loop: any }> {
    const { AgenticLoop } = await import("../core/llm/agentic-loop");
    const { createDefaultToolRegistry } = await import("../core/llm/tools");
    const { getTokenTracker } = await import("../core/llm/token-tracker");
    getTokenTracker().setContextWindow(contextWindow);
    const provider = new RecordingProvider();
    const loop = new AgenticLoop(provider as never, createDefaultToolRegistry(), {
      maxIterations: 1,
      model: "m",
      securityMode: "full",
      contextWindow,
      enableCompaction: false,
    });
    for await (const _event of loop.run(SESSION, prompt, "C:\\repo", SYSTEM_PROMPT)) void _event;
    return { request: provider.requests[0], loop };
  }

  async function runTurn(prompt: string, contextWindow: number): Promise<any> {
    return (await runTurnWithLoop(prompt, contextWindow)).request;
  }

  it("WS-5a：短历史 ⇒ 请求里没有索引（与改前逐字节一致），manifest 也不记 workingSet", async () => {
    seed([
      { id: "sh-1", session_id: SESSION, role: "user", content: "你好", timestamp: 1, status: "done", hidden: 0 },
      { id: "sh-2", session_id: SESSION, role: "assistant", content: "在", timestamp: 2, status: "done", hidden: 0 },
      { id: "sh-3", session_id: SESSION, role: "user", content: "第二轮", timestamp: 3, status: "done", hidden: 0 },
    ]);
    const request = await runTurn("第三轮", 200_000);
    const texts = request.messages.map((m: any) => String(m.content ?? ""));

    /* 短历史 ⇒ 完全不动：没有索引消息 */
    expect(texts.some((t: string) => t.includes(WORKING_SET_INDEX_HEADER)), "短历史不许产生索引").toBe(false);
    /**
     * 「改前逐字节一致」的等价断言：这一轮的对话消息**就是库里那三条**（同内容、同顺序），
     * 没有增删改 —— 改前 `buildMessages` 对短历史返回的正是这一份。
     */
    expect(request.messages[0].role).toBe("system");
    expect(request.messages.slice(1, 4).map((m: any) => `${m.role}:${m.id ?? ""}`)).toEqual([
      "user:sh-1",
      "assistant:sh-2",
      "user:sh-3",
    ]);
    expect(request.messages.slice(1, 4).map((m: any) => String(m.content))).toEqual(["你好", "在", "第二轮"]);

    const { listManifests } = await import("../core/context/manifest");
    const latest = listManifests(SESSION).at(-1)!;
    expect(latest.workingSet, "没走工作集时不许写这个字段（「没走」≠「走了但 0 条」）").toBeUndefined();
    expect(latest.messageIds.length, "短历史清单条数 = 三条对话消息").toBe(3);
  });

  it("WS-5b：长历史 + 小窗口 ⇒ 请求里出现「# 更早消息索引」、插在最后一条 user 之前、估算不超预算", async () => {
    /* 60 条历史，每条 2000 字符（约 500 token）；窗口压到 24k ⇒ 预算约 24k-4096-系统提示 ≈ 19.8k */
    const rows: any[] = [];
    for (let i = 0; i < 60; i += 1) {
      rows.push(historyRow(`h-${i}`, i % 2 === 0 ? "user" : "assistant", 2000, i + 1));
    }
    seed(rows);

    const contextWindow = 24_000;
    const request = await runTurn("继续", contextWindow);
    const indexPos = request.messages.findIndex((m: any) =>
      String(m.content ?? "").includes(WORKING_SET_INDEX_HEADER),
    );

    /* ★ 变异点 1：改「永远全选」（不再移出）⇒ 这里找不到索引 ⇒ 红 */
    expect(indexPos, "长历史必须产生索引消息（否则模型又不知道旧内容存在）").toBeGreaterThan(1);
    const indexMessage = request.messages[indexPos];
    expect(indexMessage.role, "索引消息是 user 角色").toBe("user");
    expect(String(indexMessage.content)).toContain("thread_history_search/read");
    expect(String(indexMessage.content)).toMatch(/- \[(user|assistant|tool)\] h-\d+: /);

    /* ★ 变异点 2：把索引插到第一条（第 1 位，紧跟 system）⇒ 下面两条都会红 */
    expect(
      request.messages[1].id,
      "第 1 位必须仍是原来的那条消息（稳定前缀不许动：插到第一条会整段打爆前缀缓存）",
    ).not.toBe("ctx-workingset-index");
    expect(
      request.messages.filter((m: any) => String(m.content ?? "").includes(WORKING_SET_INDEX_HEADER)),
      "索引只能有一条（插在最后一条 user 之前）",
    ).toHaveLength(1);
    /* 紧跟着的必须是一条 user 消息（= 本轮最后一条 user，索引被插在它之前） */
    expect(request.messages[indexPos + 1]?.role, "索引后面紧跟最后一条 user 消息").toBe("user");

    /* manifest 记了工作集数字，且「选中条数 + 索引消息 = 清单条数」 */
    const { listManifests } = await import("../core/context/manifest");
    const latest = listManifests(SESSION).at(-1)!;
    const ws = latest.workingSet;
    expect(ws, "长历史必须记录工作集").toBeTruthy();
    expect(ws!.evicted, "确实移出了消息").toBeGreaterThan(0);
    expect(ws!.indexLines, "有索引行").toBeGreaterThan(0);
    expect(ws!.selected + 1, "选中条数 + 1 条索引消息 = 清单里的条数").toBe(latest.messageIds.length);

    /**
     * 预算：`窗口 - 输出预留 - 系统提示词`（记忆块在本仓位于系统提示词内部，见
     * `workingSetBudget` 的注释）。判据里按同一个公式复算，**不用循环内部数字**。
     */
    const { getContextManager } = await import("../core/context/context");
    const { estimateTokens } = await import("../core/llm/token-tracker");
    const { estimateRawContextTokens } = await import("../core/llm/compaction-budget");
    const cfg = getContextManager().getConfig();
    const budget = contextWindow - cfg.outputReserve - Math.ceil(estimateTokens(SYSTEM_PROMPT));
    expect(ws!.budgetTokens, "manifest 里的预算与公式一致").toBe(budget);

    /* 请求里属于工作集的那几条消息的估算，必须 ≤ 预算（这就是「不超预算」的判据） */
    const ids = new Set(latest.messageIds);
    const workingPart = request.messages.filter((m: any) => typeof m.id === "string" && ids.has(m.id));
    expect(workingPart.length, "清单里的消息必须真的出现在请求里").toBe(latest.messageIds.length);
    const estimateOfRequest = estimateRawContextTokens(workingPart);
    expect(estimateOfRequest, "工作集部分（含索引消息）的估算不许超预算").toBeLessThanOrEqual(budget);
  });

  /**
   * WS-10：**同一轮内两次请求的稳定前缀必须逐字节一致**。
   *
   * 场景：第一次请求 → 模型回一个工具调用 → 循环追加工具结果 → 第二次请求。
   * 工作集在第二次会重新计算（多了一条工具结果 / 最近窗口变化），但**第一条索引消息
   * 之前的前缀**是 provider 前缀缓存的命中区间，必须一个字节都不变 —— 否则每多一次
   * 工具调用就把整段缓存打爆。
   *
   * `k` = 第一条索引消息之前的消息条数（索引消息在尾部且可变，不参与比较）。
   *
   * 变红方式：
   * ① 把索引插到第一条（`attachWorkingSetIndex` 的 `insertAt=1`）⇒ `indexPos > 10` 红；
   * ② 第二次请求重排出不同的稳定前缀 ⇒ 逐字节比较红；
   * ③ 两次请求索引位置漂移 ⇒ `pos1 === pos2` 红。
   */
  it("WS-10：同一轮两次请求（第二次只追加一条工具结果）的稳定前缀逐字节一致", async () => {
    const rows: any[] = [];
    for (let i = 0; i < 60; i += 1) {
      rows.push(historyRow(`w-${i}`, i % 2 === 0 ? "user" : "assistant", 2000, i + 1));
    }
    seed(rows);

    const contextWindow = 24_000;
    const { AgenticLoop } = await import("../core/llm/agentic-loop");
    const { createDefaultToolRegistry } = await import("../core/llm/tools");
    const { getTokenTracker } = await import("../core/llm/token-tracker");
    getTokenTracker().setContextWindow(contextWindow);
    const provider = new ToolCallThenStopProvider();
    const loop = new AgenticLoop(provider as never, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "m",
      securityMode: "full",
      contextWindow,
      enableCompaction: false,
    });
    for await (const _event of loop.run(SESSION, "继续", "C:\\repo", SYSTEM_PROMPT)) void _event;

    expect(provider.requests.length, "必须真的发生两次请求（第一次工具调用 → 第二次收尾）").toBeGreaterThanOrEqual(2);
    const first = provider.requests[0].messages as any[];
    const second = provider.requests[1].messages as any[];
    const indexPos = (messages: any[]) =>
      messages.findIndex((m: any) => String(m.content ?? "").includes(WORKING_SET_INDEX_HEADER));
    const pos1 = indexPos(first);
    const pos2 = indexPos(second);

    // 索引必须在尾部（插到第一条会让 k 退化成 1，前缀缓存整段失效）
    expect(pos1, "索引消息必须在尾部，前面要有真正的稳定前缀").toBeGreaterThan(10);
    expect(pos2, "第二次请求的索引位置也不能漂到开头").toBeGreaterThan(10);
    expect(pos1, "两次请求的索引位置必须一致（否则尾部之前的内容被重排）").toBe(pos2);

    const k = pos1; // 第一条索引消息之前的长度
    const serialize = (list: any[]) => JSON.stringify(list);
    expect(
      serialize(first.slice(0, k)),
      "稳定前缀（第一条索引消息之前）必须逐字节一致",
    ).toBe(serialize(second.slice(0, k)));
    // 反向对照：尾部确实变了（不是拿同一个数组在自证）
    expect(serialize(first.slice(k))).not.toBe(serialize(second.slice(k)));
  });

  /**
   * WS-7：**工作集不许改变压力口径**。
   *
   * 这条守的是一个真实回归（并行工作流实测 5 条红）：压力原来按 `buildMessages` 的**返回**
   * 估算，而工作集把返回截小了 ⇒ hard 线（0.9）在构造上不可达 ⇒ `AUTOCOMPACT-SWITCH*`
   * （中途换段）全部失效、`switchedThisTurn` 永远是 false。
   *
   * 现在的口径：压力按**工作集之前**的那一份算（`lastPressureBasis`），与改前逐字节一致 ——
   * 工作集只截"这次发给 provider 的字节"，不缩小"这段对话有多满"。
   *
   * 变红方式：把 `run()` 里的压力改回 `estimateContextPressure(apiMessages)`
   * （或让 `lastPressureBasis` 在工作集之后取值）⇒ 下面第一条等式立刻红。
   */
  it("WS-7：启用工作集后 state.contextPressure 仍按工作集之前的全量视图算（与改前一致）", async () => {
    const rows: any[] = [];
    for (let i = 0; i < 60; i += 1) {
      rows.push(historyRow(`p-${i}`, i % 2 === 0 ? "user" : "assistant", 2000, i + 1));
    }
    seed(rows);

    const contextWindow = 24_000;
    const { request, loop } = await runTurnWithLoop("继续", contextWindow);

    const { listManifests } = await import("../core/context/manifest");
    const latest = listManifests(SESSION).at(-1)!;
    const ws = latest.workingSet;
    /* 前提：工作集真的生效（不然这条判据测的是"什么都没发生"） */
    expect(ws?.evicted, "前提：工作集必须真的移出了消息").toBeGreaterThan(0);

    /* 工作集之前的那一份 = 全量视图（比请求里那几条多） */
    const basis = (loop as any).lastPressureBasis;
    expect(Array.isArray(basis), "必须留下压力口径的输入（工作集之前的那一份）").toBe(true);
    expect(basis.length, "口径输入是**截断前**的全量视图").toBeGreaterThan(ws!.selected);

    /* 请求里属于工作集的那几条（= 截断后） */
    const ids = new Set(latest.messageIds);
    const requestPart = request.messages.filter((m: any) => typeof m.id === "string" && ids.has(m.id));
    expect(requestPart.length).toBe(latest.messageIds.length);

    const pressureFromBasis = (loop as any).estimateContextPressure(basis);
    const pressureFromRequest = (loop as any).estimateContextPressure(requestPart);
    /**
     * ★ 变异点：压力若改回按**请求**算，`state.contextPressure` 会等于 `pressureFromRequest`
     * ⇒ 下面第一条等式红；这也正是"hard 线不可达、换段失效"的根因。
     */
    expect(
      (loop as any).getState().contextPressure,
      "state.contextPressure 必须来自工作集之前的全量视图",
    ).toBe(pressureFromBasis);
    expect(
      pressureFromBasis,
      "截断后的请求确实更小（否则这条判据没有区分力）",
    ).toBeGreaterThan(pressureFromRequest);
  });
});

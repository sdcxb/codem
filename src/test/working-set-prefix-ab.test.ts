/**
 * WS-11：最小工作集（Working Set）的**前缀缓存 A/B** 判据。
 *
 * ## 为什么单开一个文件（而不是塞进 working-set.test.ts）
 *
 * `working-set.test.ts` 的真循环用例在 `beforeEach` 里固定「`segmentEpochs:false` +
 * 小窗口」当旧路径对照臂；WS-11 需要的形态恰好相反：
 * - **工作集启用**（`segmentEpochs:true`，即 2026-11-06 起的默认值）；
 * - 同一会话**跑两轮**（第二轮前追加消息），而不是同一轮两次请求（那是 WS-10）；
 * - 还要在同一份历史下切到「不启用 + 预算充足」做 A/B 对照。
 *
 * 单开文件可以按用例改配置，又不会污染既有 WS-5 / WS-10 的固定口径。
 *
 * ## 判据
 *
 * | id | 钉什么 | 变红方式 |
 * |---|---|---|
 * | WS-11a | 两轮都发生移出；**第一轮索引之前的稳定前缀**（system + 保留的早期消息）在第二轮逐字节不变；索引与尾部可变；稳定前缀占请求字节的多数 | 把索引插到第一条（`insertAt=1`）⇒ 稳定前缀退化成只有 system，字节占比断言红 |
 * | WS-11b | 同一历史：工作集**不启用**（显式 `segmentEpochs:false` + 预算充足）⇒ 请求与「启用但未移出」逐字节一致、两边都不记 `workingSet` | 工作集在未移出时顺手复制/重排消息 ⇒ 逐字节比较红 |
 *
 * ## 这里证明的是什么、不证明什么（如实标注）
 *
 * 判据只证明「**稳定前缀逐字节不变**」这个**缓存前提**；本仓的 provider 请求里
 * **没有**缓存命中字段（DeepSeek / OpenAI 协议都不回传 hit/miss token 明细），
 * 所以**不证明**真实缓存命中，也不证明省了多少钱。WS-11 的结论边界仅此：
 * 工作集把索引放在尾部时，索引之前那段字节与上一轮相同 ⇒ 服务端前缀缓存**可以**命中。
 *
 * ## 冻结时钟
 *
 * 尾部会注入时间上下文（`Time sampled …`，秒级）与计划段；它们**不参与**稳定前缀，
 * 但会进入 `totalBytes`。为了证据里的数字可复现，本文件把系统时钟冻结在固定时刻
 * （`vi.setSystemTime`；不启用假定时器，只 mock `Date`，不影响循环里的真实 Promise）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { WORKING_SET_INDEX_HEADER } from "../core/context/working-set";

const SESSION = "ws-11-prefix";
const AB_ON_SESSION = "ws-11-ab-on";
const AB_OFF_SESSION = "ws-11-ab-off";
const SYSTEM_PROMPT = "你是 WS-11 前缀缓存判据用的助手。";
const FROZEN_NOW = new Date("2026-11-06T04:00:00.000Z");

class RecordingProvider {
  id = "ws-11-provider";
  name = "WS11 Mock";
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

/** 一条「内容约 n 字符」的历史消息（ASCII 正文，token 估算稳定、不受 BPE 启发式影响） */
function historyRow(sessionId: string, id: string, role: string, n: number, timestamp: number) {
  return {
    id,
    session_id: sessionId,
    role,
    content: `[${id}] ` + "abcdefghij".repeat(Math.ceil(n / 10)).slice(0, Math.max(0, n - id.length - 3)),
    timestamp,
    status: "done",
    hidden: 0,
  };
}

/** 一条消息序列的可逐字节比较文本（JSON 序列化；键序由对象字面量固定） */
function serialize(messages: any[]): string {
  return JSON.stringify(messages);
}

/** UTF-8 字节数（证据里的 `stablePrefixBytes` / `totalBytes` 用同一把尺） */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function indexPosition(messages: any[]): number {
  return messages.findIndex((m: any) => String(m.content ?? "").includes(WORKING_SET_INDEX_HEADER));
}

describe("C03 工作集：前缀缓存 A/B（WS-11）", () => {
  let port: any;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.setSystemTime(FROZEN_NOW);
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const { setStoragePort } = await import("../core/storage/port");
    const { getTokenTracker } = await import("../core/llm/token-tracker");
    const { getContextManager } = await import("../core/context/context");
    const { forgetManifests } = await import("../core/context/manifest");
    for (const sessionId of [SESSION, AB_ON_SESSION, AB_OFF_SESSION]) forgetManifests(sessionId);
    getTokenTracker().setContextWindow(24_000);
    /**
     * 工作集启用 + 固定预算口径（与 working-set.test.ts 的 WS-5b 同一公式）。
     *
     * `maxMessagesAfterCompaction` 调到远大于时间线：WS-11 只测工作集，
     * 不让「回合完成态换段」在第二轮中途插入 `compact-…` marker
     * （那是 C11 的机制，另有判据；混进来会把两轮的消息序列换成 `[marker, ...]` 形态）。
     */
    getContextManager().updateConfig({
      segmentEpochs: true,
      outputReserve: 4096,
      systemPromptTokens: 2000,
      maxMessagesAfterCompaction: 10_000,
    });
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
    const { getContextManager } = await import("../core/context/context");
    const { forgetManifests } = await import("../core/context/manifest");
    for (const sessionId of [SESSION, AB_ON_SESSION, AB_OFF_SESSION]) forgetManifests(sessionId);
    getContextManager().updateConfig({
      segmentEpochs: false,
      maxMessagesAfterCompaction: 20,
    });
    setStoragePort(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function seed(rows: any[]): void {
    port.data.execute("crud.upsert", { table: "messages", rows, mode: "replace" });
  }

  async function createLoop(
    provider: RecordingProvider,
    contextWindow: number,
    maxIterations = 1,
  ): Promise<any> {
    const { AgenticLoop } = await import("../core/llm/agentic-loop");
    const { createDefaultToolRegistry } = await import("../core/llm/tools");
    return new AgenticLoop(provider as never, createDefaultToolRegistry(), {
      maxIterations,
      model: "m",
      securityMode: "full",
      contextWindow,
      enableCompaction: false,
    });
  }

  async function runToEnd(loop: any, sessionId: string, prompt: string): Promise<void> {
    for await (const _event of loop.run(sessionId, prompt, "C:\\repo", SYSTEM_PROMPT)) void _event;
  }

  /**
   * WS-11a：同一会话两轮，第二轮前追加 4 条（assistant + 2 条短消息 + 新 user 提示）。
   *
   * 两轮都满足「工作集启用且发生移出」；第二轮多出来的消息落在索引**之后**的尾部，
   * 所以第一轮索引之前那段（system + 保留的早期消息）必须逐字节不变。
   */
  it("WS-11a：两轮都移出时，索引之前的稳定前缀逐字节一致；索引与尾部可变", async () => {
    const rows: any[] = [];
    for (let i = 0; i < 60; i += 1) {
      rows.push(historyRow(SESSION, `h-${i}`, i % 2 === 0 ? "user" : "assistant", 2000, i + 1));
    }
    /* 真实 App 在调用 run() 之前已把本轮 user 消息落库；判据按同一形态预置 */
    rows.push(historyRow(SESSION, "u-turn1", "user", 30, 100));
    seed(rows);

    const { listManifests } = await import("../core/context/manifest");
    const provider = new RecordingProvider();
    const contextWindow = 24_000;
    const loop = await createLoop(provider, contextWindow);

    /* ===== 第一轮 ===== */
    await runToEnd(loop, SESSION, "第一轮");
    expect(provider.requests.length, "第一轮必须真的发出请求").toBe(1);
    const request1 = provider.requests[0];
    const manifest1 = listManifests(SESSION).at(-1)!;
    const index1 = indexPosition(request1.messages);

    expect(manifest1.workingSet?.evicted, "前提：第一轮工作集必须真的移出了消息").toBeGreaterThan(0);
    expect(index1, "第一轮必须有索引消息").toBeGreaterThan(-1);
    expect(
      index1,
      "索引必须在尾部：它前面要有 system + 保留的早期消息（插到第一条会让稳定前缀退化成 1 条）",
    ).toBeGreaterThan(10);

    /* ===== 第二轮：追加 4 条消息，再跑同一会话 ===== */
    rows.push(historyRow(SESSION, "a-turn1", "assistant", 20, 101));
    rows.push(historyRow(SESSION, "e-1", "user", 10, 102));
    rows.push(historyRow(SESSION, "e-2", "assistant", 10, 103));
    rows.push(historyRow(SESSION, "u-turn2", "user", 30, 104));
    seed(rows);

    await runToEnd(loop, SESSION, "第二轮");
    expect(provider.requests.length, "第二轮必须真的发出请求").toBe(2);
    const request2 = provider.requests[1];
    const manifest2 = listManifests(SESSION).at(-1)!;
    const index2 = indexPosition(request2.messages);

    expect(manifest2.workingSet?.evicted, "前提：第二轮工作集仍然启用并移出了消息").toBeGreaterThan(0);
    expect(index2, "第二轮必须有索引消息").toBeGreaterThan(-1);
    expect(
      index2,
      "第二轮索引只能后移（新消息追加在索引之前/尾部），不许漂回开头",
    ).toBeGreaterThan(index1);

    /* ===== 稳定前缀：第一轮索引之前的那一段，在第二轮逐字节一致 ===== */
    expect(request2.messages[0].role, "两轮的第一条都必须是 system").toBe("system");
    expect(request2.messages[0].content, "system 消息逐字节一致（前缀缓存的起点）").toBe(
      request1.messages[0].content,
    );
    const stablePrefix1 = serialize(request1.messages.slice(0, index1));
    const stablePrefix2 = serialize(request2.messages.slice(0, index1));
    expect(
      stablePrefix2,
      "索引之前的稳定前缀（system + 保留的早期消息）必须逐字节一致",
    ).toBe(stablePrefix1);
    expect(
      request1.messages.slice(1, index1).length,
      "稳定前缀里必须有真正的早期消息（不只是 system）",
    ).toBeGreaterThan(10);

    /* ===== 索引与尾部可变：不要求两轮相同，但这里必须**确实**变了（反向对照） ===== */
    expect(
      serialize(request2.messages.slice(index2)),
      "尾部（本轮 user 提示及其后的易变注入）必须不同——否则是在拿同一份数组自证",
    ).not.toBe(serialize(request1.messages.slice(index1)));

    /* ===== 实测字节数（证据文件引用的就是这次打印的数字） ===== */
    const stablePrefixBytes = utf8Bytes(stablePrefix1);
    const totalBytes1 = utf8Bytes(serialize(request1.messages));
    const totalBytes2 = utf8Bytes(serialize(request2.messages));
    const ratio1 = stablePrefixBytes / totalBytes1;
    const ratio2 = stablePrefixBytes / totalBytes2;
    console.log(
      `[WS-11] round1 stablePrefixMsgs=${index1} stablePrefixBytes=${stablePrefixBytes} ` +
        `totalBytes=${totalBytes1} ratio=${(ratio1 * 100).toFixed(2)}%`,
    );
    console.log(
      `[WS-11] round2 stablePrefixMsgs=${index1} stablePrefixBytes=${stablePrefixBytes} ` +
        `totalBytes=${totalBytes2} ratio=${(ratio2 * 100).toFixed(2)}% ` +
        `indexPos=${index2} evicted1=${manifest1.workingSet?.evicted} evicted2=${manifest2.workingSet?.evicted}`,
    );

    /* ★ 变异点：把索引插到第一条（attachWorkingSetIndex 的 insertAt=1）⇒ 稳定前缀只剩
       system，字节占比掉到个位数 ⇒ 下面这条红（索引位置/前缀消息数的断言也会先红）。 */
    expect(ratio1, "稳定前缀必须占请求字节的多数（索引在尾部才谈得上前缀缓存）").toBeGreaterThan(0.5);
    expect(ratio2, "第二轮同理").toBeGreaterThan(0.5);
  });

  /**
   * WS-11b：A/B 零行为变化。
   *
   * 同一份短历史（远小于预算）在两个会话上各跑一轮：
   * - A 臂：`segmentEpochs:true`（工作集启用），但全部放得下 ⇒ `planWorkingSet`
   *   返回同一个数组引用、`applied:false`；
   * - B 臂：显式 `segmentEpochs:false` + 预算充足 ⇒ 连 `planWorkingSet` 都不跑。
   *
   * 两臂的实际请求必须逐字节一致，两边的清单都**不许**记 `workingSet`。
   *
   * 时钟已冻结（时间上下文进尾部，两臂看到同一采样时刻），所以这里比较的是**整条**
   * 消息序列，而不是只比较前缀 —— 比任务要求的「请求前缀一致」更强。
   */
  it("WS-11b：工作集不启用（预算充足）与启用但未移出 —— 请求逐字节一致", async () => {
    const { getContextManager } = await import("../core/context/context");
    const { getTokenTracker } = await import("../core/llm/token-tracker");
    const { forgetManifests, listManifests } = await import("../core/context/manifest");

    /**
     * 两臂各用空会话（消息 id 相同、session_id 不同）：避免同一会话第二轮
     * 受上一轮事件/时间节流状态影响。历史正文与时间戳两臂完全一致。
     */
    const rowsFor = (sessionId: string) => [
      historyRow(sessionId, "ab-1", "user", 3, 1),
      historyRow(sessionId, "ab-2", "assistant", 3, 2),
      historyRow(sessionId, "ab-3", "user", 3, 3),
    ];

    const runArm = async (sessionId: string, segmentEpochs: boolean): Promise<any> => {
      getContextManager().updateConfig({ segmentEpochs, outputReserve: 4096, systemPromptTokens: 2000 });
      getTokenTracker().setContextWindow(200_000);
      forgetManifests(sessionId);
      port.data.execute("crud.upsert", { table: "messages", rows: rowsFor(sessionId), mode: "replace" });
      const provider = new RecordingProvider();
      const loop = await createLoop(provider, 200_000);
      await runToEnd(loop, sessionId, "第三轮");
      expect(provider.requests.length, "每一臂都必须真的发出请求").toBe(1);
      return provider.requests[0];
    };

    const enabled = await runArm(AB_ON_SESSION, true);
    const disabled = await runArm(AB_OFF_SESSION, false);

    /* 前提：两臂都没有触发工作集效果（没有任何索引消息、清单也没有 workingSet 字段） */
    for (const [label, request, sessionId] of [
      ["启用但未移出", enabled, AB_ON_SESSION],
      ["不启用", disabled, AB_OFF_SESSION],
    ] as const) {
      const texts = request.messages.map((m: any) => String(m.content ?? ""));
      expect(
        texts.some((t: string) => t.includes(WORKING_SET_INDEX_HEADER)),
        `${label}：预算充足时不许出现索引头`,
      ).toBe(false);
      const manifest = listManifests(sessionId).at(-1)!;
      expect(manifest.workingSet, `${label}：没移出时不许记 workingSet`).toBeUndefined();
    }

    /* ★ 变异点：工作集在「全部放得下」时复制/重排消息 ⇒ 下面这条逐字节比较红 */
    expect(
      serialize(enabled.messages),
      "工作集不启用 vs 启用但未移出：整条请求必须逐字节一致（零行为变化）",
    ).toBe(serialize(disabled.messages));
  });
});

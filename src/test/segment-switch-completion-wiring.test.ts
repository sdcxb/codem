/**
 * P0（完成态换段）**真实收尾路径的接线判据**（SEG-WIRE-*）。
 *
 * ## 为什么需要它
 *
 * 1.18.13 装机版 + `segmentEpochs:true` + `compactionThreshold:0.8` + 24 条历史，
 * 一轮「真实模型完成」之后，库里**没有任何 `kind="switch"` 的 epoch**，也没有
 * `context_steward_decision` 事件。两层根因：
 *
 * ① 那几次「真实模型完成」其实是 `Failed to fetch`（渲染进程直连 `api.anthropic.com`，
 *    被 CORS 挡掉）⇒ 出口是 `llm_error`，**根本没走到完成分支**
 *    （见 `agentic-loop.ts` 的 `noteExit("llm_error")`）；
 * ② 当时 `decideEpochAction` 把「压力 < 压缩阈值 ⇒ none」放在 `turnCompleted` 之前 ——
 *    完成态换段的代码**永远不可达**。
 *
 * ## 2026-11 修正（独立复核的高优先级缺陷）
 *
 * ② 的修法当时是「完成即边界」（完成态无视水位），**过度修正**了：历史超过 keepCount
 * 之后每个用户回合都切一段（真实 200 轮不可能只有 3 段）。现在完成态与中途共用同一把
 * 水尺：`pressure >= compactionThreshold` 才切；低压力完成 ⇒ **继续当前段**。
 *
 * 所以本文件钉**两条相反的接线**（都不许删弱）：
 * - SEG-WIRE-1：低压力的完成回合 ⇒ 完成出口**不写** switch（修正后的真机行为）；
 * - SEG-WIRE-3：压力达到考虑线的完成回合 ⇒ 完成出口**必须写** switch（接线上限）。
 * SEG-WIRE-2 是显式关闭的反向对照（旧路径零变化）。
 *
 * ## 为什么 SEG-WIRE-3 关掉中途压缩
 *
 * `pressure >= compactionThreshold` 在 `run()` 的 **prep** 里先被「中途压缩」看见：
 * 未完成 ⇒ compact（25 §6 的护栏）⇒ 清缓存后重建视图、**再跑一次迭代**
 * （`compactedThisIteration` 让循环不在此收尾，见 `agentic-loop.ts` 的 continue 分支）⇒
 * 完成时压力已经是压缩后的低值。也就是说**开着压缩时，阈值穿越先被压缩吃掉**，
 * 完成出口只负责「没有被压缩救下的高水位」。要钉完成出口本身，就必须关掉那条干扰路径
 * （与 `context-os-scale-acceptance` 的 ICM-3 同一做法；中途压缩由 ICM-2 / AUTOCOMPACT-* 守）。
 *
 * ## 判据为什么不能只断言「有 epoch」
 *
 * 断言「跑了 `loop.run()` 后有 epoch」抓不住「App 那条链没接上」（例如有人把
 * `this.trySwitchOnCompletion(...)` 删了、或把它挪到别的出口）。所以每条都：
 * 1. **从 `engine.process()` 进**（App 的同一入口，不是直接 new AgenticLoop）；
 * 2. 断言最后一个 `end` 事件的 `result.reason`（证明走的是完成出口）；
 * 3. 断言 `state.contextPressure` 与阈值的关系（证明触发条件成立/不成立）；
 * 4. 从**时间线**读回 `kind="switch"` 的 epoch + `segmentSeq`，从**事件日志**
 *    读回 `context_steward_decision`（两条都是真机复验时查库的那两张表）。
 *
 * 变异自证：
 * - 删掉 `agentic-loop.ts` 完成出口的 `this.trySwitchOnCompletion(...)` ⇒ SEG-WIRE-3 红；
 * - 去掉完成态的水位判断（退回「完成即边界」）⇒ SEG-WIRE-1 红；
 * - 让水位判断恒 true（例如把阈值换成 0）⇒ SEG-WIRE-1 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecuteCommand, memFs } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  memFs: new Map<string, string>(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\seg-wire",
  exists: async (p: string) => memFs.has(p),
  readFile: async (p: string) => {
    if (!memFs.has(p)) throw new Error("ENOENT: " + p);
    return memFs.get(p)!;
  },
  readTextWindow: async (p: string, offset = 0, maxBytes?: number) => {
    const c = memFs.get(p) ?? "";
    const end = maxBytes ? Math.min(c.length, offset + maxBytes) : c.length;
    let text = c.slice(offset, end);
    const eof = end >= c.length;
    if (!eof) {
      const cut = text.lastIndexOf("\n");
      if (cut >= 0) text = text.slice(0, cut + 1);
    }
    return { text, nextOffset: offset + text.length, eof: end >= c.length, size: c.length };
  },
  appendFile: async (p: string, c: string) => {
    memFs.set(p, (memFs.get(p) ?? "") + c);
  },
  writeFile: async (p: string, c: string) => {
    memFs.set(p, c);
  },
  deleteFile: async (p: string) => {
    memFs.delete(p);
  },
  deletePath: async (p: string) => {
    memFs.delete(p);
  },
  renameFile: async (a: string, b: string) => {
    const c = memFs.get(a);
    memFs.delete(a);
    if (c !== undefined) memFs.set(b, c);
  },
  listDirectory: async () => [],
  globSearch: async () => [],
  grepSearch: async () => [],
  readFileLines: async (p: string) => ({ text: memFs.get(p) ?? "", hasMore: false, totalLines: 1 }),
  isPathWithinWorkspace: () => true,
}));

import { LLMEngine } from "../core/llm";
import { getContextManager } from "../core/context/context";
import { getTokenTracker } from "../core/llm/token-tracker";
import { clearSessionLogCache, createMessage, listTimelineMessages } from "../core/storage/message";
import { getEventLog } from "../core/storage/event-log";
import { __resetJsonlCache } from "../core/storage/session-jsonl";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import { setSetting } from "../core/storage/settings";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";

const SESSION_ID = "seg-wire-1";
const CWD = "C:\\seg-wire";
const PROJECT_ID = "proj-seg-wire";
/** 真机同款窗口（`codem-context-config.maxContextWindow` 默认 128000） */
const WINDOW = 128_000;
/** 真机同款保留条数 */
const KEEP = 20;
/** 真机同款阈值（默认 0.8）—— 24 条短历史 + 系统提示/工具表 ≈ 0.21，远低于它 */
const THRESHOLD = 0.8;
/**
 * 「水位达标」用的阈值：`readContextCompactionThreshold` 的合法区间是 (0.1, 0.95]。
 * 同上现场 ≈ 0.21 ⇒ 0.15 让「达标」成立、又离 hard(0.9) 很远。
 */
const LOW_THRESHOLD = 0.15;

/** 只回一句话的 provider：不调工具 ⇒ 走「完成」出口 */
class TextProvider {
  id = "seg-wire-provider";
  name = "Segment Wire Mock";
  config: any = { apiKey: "sk-test", models: [{ id: "seg-wire-model", contextWindow: WINDOW }] };
  dynamicModels: any[] | null = null;
  isConfigured() {
    return true;
  }
  async *stream(_request: any): AsyncGenerator<any> {
    yield { type: "text_delta", text: "OK" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [
      {
        id: "seg-wire-model",
        name: "SegWire",
        contextWindow: WINDOW,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ];
  }
  async fetchModelsFromServer() {
    return this.listModels();
  }
}

function installFsStub() {
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = { core: { invoke: async () => undefined } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

let engine: LLMEngine;
let provider: TextProvider;

beforeEach(() => {
  vi.clearAllMocks();
  memFs.clear();
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSessionMessageBus();
  resetDelegationOrchestrator();
  mockExecuteCommand.mockResolvedValue({ stdout: "输出", stderr: "", exitCode: 0 });

  createProject({ id: PROJECT_ID, name: "SegWire", path: CWD, createdAt: Date.now(), lastAccessedAt: Date.now() } as any);
  createSession({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: "SegWire",
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    messageCount: 0,
  } as any);
  setSetting("codem-security-mode", "full");

  /**
   * TokenTracker 是**进程级单例**：不重置的话，同一文件里前一个用例的
   * `recordActualUsage`（这个假 provider 不上报 usage，循环会记一条 promptTokens=0）
   * 会让压力估算切到 `actual` 分支 —— 那条分支**不加**系统提示词/工具表，
   * 于是同一个现场的压力会在用例之间漂移。判据要的是「同一把尺」，
   * 所以每个用例从干净的历史 + 真机同款窗口开始。
   */
  getTokenTracker().reset();
  getTokenTracker().setContextWindow(WINDOW);

  engine = new LLMEngine();
  provider = new TextProvider();
  engine.providers.register(provider as any);
  (engine as any).config.defaultProvider = "seg-wire-provider";
  (engine as any).config.defaultModel = "seg-wire-model";
});

afterEach(() => {
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

/** 预置 24 条**短**历史：条数 > keep、但压力远低于默认阈值（真机形态） */
function seedShortHistory(count = 24) {
  for (let i = 0; i < count; i += 1) {
    createMessage(
      {
        id: `wire-msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `短历史第 ${i} 条`,
        timestamp: 1_000 + i,
        status: "done",
      },
      SESSION_ID,
    );
  }
}

function withConfig<T>(
  config: { segmentEpochs: boolean; compactionThreshold: number; maxMessagesAfterCompaction: number },
  fn: () => Promise<T>,
): Promise<T> {
  const cm = getContextManager();
  cm.updateConfig(config);
  return fn().finally(() => {
    /* 单例：还原到**默认口径**（2026-11 起默认开启）—— 不把显式关闭漏给同进程的其它用例 */
    cm.updateConfig({ segmentEpochs: true, compactionThreshold: 0.7, maxMessagesAfterCompaction: 20 });
  });
}

const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
const switchesOf = () => listTimelineMessages(SESSION_ID).filter((m) => epochOf(m)?.kind === "switch");
const switchDecisions = () =>
  getEventLog()
    .readAll(SESSION_ID)
    .filter((e) => e.type === "context_steward_decision" && (e.payload as any)?.action === "switch")
    .map((e) => (e.payload ?? {}) as Record<string, unknown>);

describe("SEG-WIRE：完成出口 → trySwitchOnCompletion（App 同一入口）", () => {
  it("SEG-WIRE-1: 完成但压力低于考虑线 ⇒ 不切段（继续当前段，这是修正后的真机行为）", async () => {
    seedShortHistory(24);

    const events: any[] = [];
    await withConfig(
      { segmentEpochs: true, compactionThreshold: THRESHOLD, maxMessagesAfterCompaction: KEEP },
      async () => {
        for await (const event of engine.process(SESSION_ID, "只回复 OK", CWD)) events.push(event);
      },
    );

    /* ① 这一轮确实走的是**完成**出口（不是 llm_error / aborted / overflow） */
    const end = [...events].reverse().find((e) => e.type === "end");
    expect(end, `没有 end 事件；事件=${events.map((e) => e.type).join(",")}`).toBeTruthy();
    expect(end.result?.reason, "必须先走到 completed 出口，才谈得上完成态换段").toBe("completed");

    /* ② 前提：压力确实**低于**阈值 —— 这正是「不该切」的触发条件 */
    const loop = (engine as any).loopPool.get(SESSION_ID);
    expect(loop, "engine.process 应当为该会话建了 AgenticLoop").toBeTruthy();
    const state = loop.getState();
    expect(
      state.contextPressure,
      `前提：真机形态下完成时压力应远低于阈值（实际 ${Number(state.contextPressure).toFixed(3)}）`,
    ).toBeLessThan(THRESHOLD);

    /* ③ 完成出口不写 switch epoch —— 旧实现（完成即边界）在这里会写一条 */
    expect(switchesOf(), "低压力完成不许换段（否则每回合都切一段）").toHaveLength(0);
    expect(switchDecisions(), "没换段就不许写 switch 决策事件").toHaveLength(0);

    /* ④ 旧消息一条不少（继续当前段，视图不变） */
    expect(listTimelineMessages(SESSION_ID).filter((m) => m.id.startsWith("wire-msg-")).length).toBe(24);
  }, 60_000);

  it("SEG-WIRE-4: 首拍不先压缩，完成态直接写 switch（不再被压缩吃掉）", async () => {
    seedShortHistory(24);

    const events: any[] = [];
    await withConfig(
      { segmentEpochs: true, compactionThreshold: LOW_THRESHOLD, maxMessagesAfterCompaction: KEEP },
      async () => {
        for await (const event of engine.process(SESSION_ID, "只回复 OK", CWD)) events.push(event);
      },
    );

    const end = [...events].reverse().find((e) => e.type === "end");
    expect(end?.result?.reason, "这一段必须走完成出口").toBe("completed");
    expect(
      events.some((e) => e.type === "compaction_start"),
      "首拍显式开启段式上下文时不应先压缩",
    ).toBe(false);

    const switches = switchesOf();
    expect(switches.length, "首拍完成必须产生 switch").toBe(1);
    expect(
      listTimelineMessages(SESSION_ID).filter((m) => epochOf(m)?.kind === "compact"),
      "不许同时留 compact marker",
    ).toHaveLength(0);
    expect(epochOf(switches[0])?.segmentSeq, "第一次换段是第 2 段").toBeGreaterThanOrEqual(2);
    expect(
      listTimelineMessages(SESSION_ID).filter((m) => m.id.startsWith("wire-msg-")).length,
      "旧消息一条不少",
    ).toBe(24);
  }, 60_000);

  it("SEG-WIRE-2: 显式关闭 ⇒ 完成出口一行 switch 都不写（旧路径零变化）", async () => {
    seedShortHistory(24);
    const events: any[] = [];
    await withConfig(
      { segmentEpochs: false, compactionThreshold: THRESHOLD, maxMessagesAfterCompaction: KEEP },
      async () => {
        for await (const event of engine.process(SESSION_ID, "只回复 OK", CWD)) events.push(event);
      },
    );

    const end = [...events].reverse().find((e) => e.type === "end");
    expect(end?.result?.reason).toBe("completed");

    expect(switchesOf()).toHaveLength(0);
    expect(
      getEventLog().readAll(SESSION_ID).filter((e) => e.type === "context_steward_decision"),
      "开关关着时不许写决策事件",
    ).toHaveLength(0);
  }, 60_000);

  it("SEG-WIRE-3: 完成且压力达到考虑线 ⇒ 完成出口写 switch epoch（接线上限）", async () => {
    seedShortHistory(24);

    /**
     * 关掉**中途压缩**（见文件头）：否则阈值穿越会先被 compact 吃掉，
     * 完成时压力已被压缩降低 —— 那样测的就不是完成出口了。
     * `engine.getAgenticLoop` 返回的就是 `process()` 复用的那个池化实例。
     */
    const pooled = (engine as any).getAgenticLoop(undefined, SESSION_ID);
    expect(pooled, "engine 必须能为该会话建/取池化 loop").toBeTruthy();
    pooled.updateConfig({ enableCompaction: false });

    const events: any[] = [];
    await withConfig(
      { segmentEpochs: true, compactionThreshold: LOW_THRESHOLD, maxMessagesAfterCompaction: KEEP },
      async () => {
        for await (const event of engine.process(SESSION_ID, "只回复 OK", CWD)) events.push(event);
      },
    );

    const end = [...events].reverse().find((e) => e.type === "end");
    expect(end?.result?.reason, "这一段必须走完成出口").toBe("completed");

    /* 前提：压力在 [阈值, hard) —— 达标但没到「再压也救不回来」的救援线 */
    const loop = (engine as any).loopPool.get(SESSION_ID);
    const state = loop.getState();
    expect(
      state.contextPressure,
      `前提：压力必须达到考虑线（实际 ${Number(state.contextPressure).toFixed(3)}，阈值 ${LOW_THRESHOLD}）`,
    ).toBeGreaterThanOrEqual(LOW_THRESHOLD);
    expect(state.contextPressure, "前提：低于 hard 线 ⇒ 这一刀不是 hard 救援").toBeLessThan(0.9);
    expect(events.some((e) => e.type === "compaction_start"), "前提：这条路径上不该有中途压缩").toBe(false);

    const switches = switchesOf();
    expect(
      switches.length,
      `压力达标 + 完成 ⇒ 必须写 switch epoch（时间线 ${listTimelineMessages(SESSION_ID).length} 条；事件=${events.map((e) => e.type).join(",")}）`,
    ).toBe(1);
    expect(epochOf(switches[0])?.segmentSeq, "第一段默认 1 ⇒ 第一次换段必须是 2").toBeGreaterThanOrEqual(2);

    /* 旧消息一条不少（D3） */
    expect(listTimelineMessages(SESSION_ID).filter((m) => m.id.startsWith("wire-msg-")).length).toBe(24);

    /* 决策事件（真机复验时查的就是 session_events 表） */

    const decisions = switchDecisions();
    expect(decisions.length, "换段必须留下 context_steward_decision 事件").toBeGreaterThanOrEqual(1);
    expect(Number(decisions[0].segmentSeq)).toBeGreaterThanOrEqual(2);

    /* C01 当前构建证据：压力真的达到阈值、完成出口真的写 switch（不是旧 0.000 证据） */
    console.log(
      "[C01-EVIDENCE] " +
        JSON.stringify({
          collectedAt: new Date().toISOString(),
          command: "npx vitest run src/test/segment-switch-completion-wiring.test.ts -t SEG-WIRE-3",
          sessionId: SESSION_ID,
          resultReason: end?.result?.reason,
          pressure: Number(state.contextPressure),
          threshold: LOW_THRESHOLD,
          switches: switches.length,
          segmentSeq: epochOf(switches[0])?.segmentSeq,
          oldMessages: listTimelineMessages(SESSION_ID).filter((m) => m.id.startsWith("wire-msg-")).length,
          decisions: decisions.length,
        }),
    );
  }, 60_000);
});

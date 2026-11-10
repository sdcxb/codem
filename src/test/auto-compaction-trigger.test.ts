/**
 * 自动压缩的**触发路径**端到端判据（AUTOCOMPACT-*）。
 *
 * ## 为什么需要它
 *
 * 压缩的**机制**早就有一堆判据（`doCompactMessages` 被直接调用、HEADROOM 断言阈值与保留预算），
 * 但「水位真的涨过 70% → 循环自己触发压缩 → 事件发出来 → 历史真的变短」这条链
 * **没有任何用例走过**：`compaction_start/end` 此前只被「类型可构造」断言过。
 *
 * 这组用例从 `run()` 真的跑一遍：预置一段超过窗口的历史 → 收集事件 → 断言
 * ① 压缩真的被触发；② 事件里报告移除了消息；③ 历史里出现压缩标记（软删 + 标记替换，
 * 原文不销毁）；④ 压缩后的请求确实比压缩前小。
 *
 * 它**不是**真机验证：这里没有打包应用、没有真实 provider、没有 UI 横幅/重载。
 * 真机那一步仍然要做（见 `docs/project-guide/16-MCODE-STACK-AUDIT.md` §6.1）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { setStoragePort, type StoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getTokenTracker } from "../core/llm/token-tracker";
import { getContextManager } from "../core/context/context";
import { createMessage, listMessages, listTimelineMessages } from "../core/storage/message";
import { getSession, listSessions } from "../core/storage/session";
import { epochActionForLoop } from "../core/context/segment-switch";

const SESSION = "auto-compact-trigger";
const CWD = "C:\\auto-compact";
const SYSTEM_PROMPT = "你是测试用助手。";
const WINDOW = 24_000;

let port: FakeStoragePort;
let logSpy: any;

function seedRow(table: string, row: Record<string, unknown>) {
  void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
}

function seedSession(id: string) {
  seedRow("sessions", {
    id,
    project_id: "p1",
    title: id,
    model: null,
    created_at: 1,
    last_message_at: 2,
    message_count: 0,
    pinned: 0,
  });
}

/** 一段足够长的中文正文（估算器按 CJK 计，1200 字 ≈ 上千 token） */
function body(tag: string, n = 1200): string {
  return `${tag}：` + "上下文压缩触发判据的填充正文。".repeat(Math.ceil(n / 16));
}

class AbortedProvider {
  id = "ac-aborted";
  name = "Aborted Mock";
  requests: any[] = [];
  isConfigured() { return true; }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "开始" };
    /* 用户点 ■ 时 provider 会这样收尾（见 agentic-loop 的 aborted 分支） */
    yield { type: "end", finishReason: "aborted" };
  }
  async complete() { return { content: "" }; }
  async listModels() { return []; }
  async fetchModelsFromServer() { return []; }
}

/**
 * 第一次回一个工具调用（把循环推进到第二轮），之后回文本收尾。
 * 工具用 `update_plan`：它不需要文件系统，执行失败也不影响"已经发生过工具调用"这个事实。
 */
class ToolCallThenStopProvider {
  id = "ac-tool-then-stop";
  name = "Tool Then Stop Mock";
  toolCalls = 0;
  isConfigured() {
    return true;
  }
  async *stream(_request: any): AsyncGenerator<any> {
    this.toolCalls += 1;
    if (this.toolCalls === 1) {
      yield { type: "tool_use_start", id: "call-ceiling-1", name: "update_plan" };
      yield { type: "tool_use_end", id: "call-ceiling-1", input: { action: "append", titles: ["继续"] } };
      yield { type: "end", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "完成" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return {
      content: "结构化摘要：已完成 A，待办 B。",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

class RecordingProvider {
  id = "ac-provider";
  name = "AutoCompact Mock";
  requests: any[] = [];
  completes: any[] = [];
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "收到" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete(request: any) {
    this.completes.push(request);
    return {
      content: "结构化摘要：已完成 A，待办 B。",
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

/**
 * 只抛 provider overflow 的假 provider：让循环真的走到
 * 「连压到上限」/「反应式压缩关闭」两条错误出口，而不是只读源码。
 */
class OverflowProvider {
  constructor(private readonly beforeStream?: () => void) {}
  id = "ac-overflow";
  name = "Overflow Mock";
  isConfigured() {
    return true;
  }
  async *stream(): AsyncGenerator<any> {
    this.beforeStream?.();
    throw new Error(
      "API error 400: maximum context length is 128000 tokens. However, you requested 130000 tokens.",
    );
  }
  async complete() {
    return { content: "摘要", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}
beforeEach(() => {
  port = createFakeStoragePort();
  setStoragePort(port as unknown as StoragePort);
  getTokenTracker().setContextWindow(WINDOW);
  /**
   * 2026-11-06：`segmentEpochs` 默认改为 true（用户授权）。
   *
   * 本文件的历史用例守的是**压缩**路径（开关关闭时的旧路径）；需要换段的用例
   * 自己在用例内显式 `updateConfig({ segmentEpochs: true })`。这里统一先放回旧路径，
   * 让每个用例的开关状态都由用例自己声明，不依赖默认值变化。
   */
  getContextManager().updateConfig({ segmentEpochs: false });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("AUTOCOMPACT：自动压缩的触发路径", () => {
  it("水位超过阈值时，run() 自己触发压缩、发出事件、历史变短", async () => {
    seedSession(SESSION);

    // 60 条历史（30 轮），每条 800 字 —— 既超过 24k 窗口的 70%，也让待压集跨过中间档
    // （跨档才会真的调用 LLM 摘要；只压中间档时是确定性要点，不调模型）
    for (let i = 0; i < 60; i += 1) {
      seedRow("messages", {
        id: `ac-msg-${i}`,
        session_id: SESSION,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`第 ${i} 条`, 800),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const provider = new RecordingProvider();
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 2,
      model: "ac-model",
      securityMode: "full",
      contextWindow: WINDOW,
      enableCompaction: true,
      compactionThreshold: 0.7,
    });

    const events: any[] = [];
    for await (const event of loop.run(SESSION, "你好", CWD, SYSTEM_PROMPT)) {
      events.push(event);
    }

    const start = events.find((e) => e.type === "compaction_start");
    const end = events.find((e) => e.type === "compaction_end");
    expect(start, `没有触发压缩；事件序列=${events.map((e) => e.type).join(",")}`).toBeTruthy();
    expect(end, "压缩开始后必须发结束事件（否则 UI 横幅永远挂着）").toBeTruthy();
    expect(end.messagesRemoved, "压缩必须真的移除消息（0 = 没压）").toBeGreaterThan(0);
    expect(provider.completes.length, "压缩摘要走 complete()，至少调用一次").toBeGreaterThan(0);
    const compactLog = logSpy.mock.calls
      .map((c: any[]) => String(c[0]))
      .find((line: string) => line.startsWith("[compact] usage"));
    expect(compactLog, "压缩调用必须留一行 usage 读数（否则压缩成本不可观测）").toBeTruthy();
    expect(compactLog).toContain("prompt=100");
    expect(compactLog, "provider 没报缓存字段时不许编 0（读/写两个桶都要显示 ?）").toContain("cacheRead=?");
    expect(compactLog, "写缓存桶同样不许编 0").toContain("cacheWrite=?");
    // 压缩用量单独累计，且**不并进**主循环的 totalUsage（否则评测口径会被污染）
    const state = (loop as any).getState();
    expect(state.compactionUsage.promptTokens).toBe(100);
    expect(state.compactionUsage.completionTokens).toBe(20);
    expect(state.compactionUsage.totalTokens).toBe(120);
    expect(state.totalUsage.totalTokens, "压缩用量不并进主循环 totalUsage").toBe(0);

    // 历史里出现压缩标记（原文软删 + 标记是唯一副本，不是物理删除）
    const after = listMessages(SESSION);
    const marker = after.find(
      (m) => m.role === "user" && /\[上下文已(自动|手动)压缩\]/.test(String(m.content ?? "")),
    );
    expect(marker, "压缩后必须留下摘要标记（否则模型与用户都看不到发生过什么）").toBeTruthy();
    expect(after.length, "压缩后历史条数应变少").toBeLessThan(61);

    // 压缩后的请求确实比压缩前小（否则只是"发了个事件"）
    const sizes = provider.requests.map((r) => JSON.stringify(r.messages).length);
    const firstSize = sizes[0];
    const lastSize = sizes[sizes.length - 1];
    expect(lastSize, `压缩后的请求应当更小：first=${firstSize} last=${lastSize}`).toBeLessThan(firstSize);
  });

  /**
   * AUTOCOMPACT-SWITCH（P0-3）：开关打开 + 压力越过 hard 线时，`run()` 必须走**换段**，
   * 而不是压缩摘要。
   *
   * ## 为什么这条必须存在
   *
   * `decideEpochAction`（规则）与 `performSegmentSwitch`（写入）各有单测，但**接缝**
   * ——「loop 真的走进 `switchOutcome.switched` 分支并复用它那套收尾」—— 此前没有任何用例
   * 经过。能变红的变异：把 `trySwitchSegment()` 首行改成 `return { switched: false }`，
   * 或把 `const compacted = switchOutcome.switched ? … : await this.compactMessages(…)`
   * 改成恒 `await this.compactMessages(…)`：规则/写入的单测全绿，只有这条会红。
   *
   * 同时钉住三件事：① 时间线出现 `kind="switch"` 的 epoch；② `compaction_end` 报告移出条数；
   * ③ **不调摘要**（`provider.complete` 一次都不该有），但记忆提取钩子照跑。
   */
  it("AUTOCOMPACT-SWITCH：开关开 + 接近 hard ⇒ run() 换段（不调摘要、记忆钩子照跑）", async () => {
    seedSession(SESSION);
    /* 90 条 × 1400 字：稳稳越过 hard 线（0.9），且保留 20 条后仍然很满 */
    for (let i = 0; i < 90; i += 1) {
      seedRow("messages", {
        id: `sw-msg-${i}`,
        session_id: SESSION,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`换段第 ${i} 条`, 1400),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const contextManager = getContextManager();
    contextManager.updateConfig({ segmentEpochs: true });
    try {
      const provider = new RecordingProvider();
      const onCompactionComplete = vi.fn();
      const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
        maxIterations: 2,
        model: "ac-model",
        securityMode: "full",
        contextWindow: WINDOW,
        enableCompaction: true,
        compactionThreshold: 0.7,
        memoryEnabled: true,
        onCompactionComplete,
      });

      const events: any[] = [];
      for await (const event of loop.run(SESSION, "你好", CWD, SYSTEM_PROMPT)) {
        events.push(event);
      }

      const timeline = listTimelineMessages(SESSION);
      const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
      const switchMarkers = timeline.filter((m) => epochOf(m)?.kind === "switch");
      expect(
        switchMarkers.length,
        `开关开着、压力已过 hard 线，必须写出 switch epoch；事件序列=${events.map((e) => e.type).join(",")}`,
      ).toBeGreaterThanOrEqual(1);
      /*
       * **同一轮只切一次**：中途 hard 线已经切过 ⇒ 完成出口不许在刚建好的新段里再切一刀
       * （否则时间线出现两个 marker，视图头不再是用例拿到的第一个 —— 实测就是这么红的）。
       */
      expect(switchMarkers.length, "同一轮不许切两次（中途 hard 切过 ⇒ 完成出口跳过）").toBe(1);

      /**
       * ⚠️ 关键：**换段路径上不许再压一次**。
       *
       * 只断言"有 switch epoch"抓不到"switch 写了但结果被丢掉、后面照旧压缩"
       * （实测：那种变异下 switch epoch 照样存在、compaction_end 也报告移出条数，
       * 前三条断言全绿）。判据必须落在**最终视图**上：
       * ① 时间线里除了 switch 不许出现 compact epoch；② 模型视图的第一条就是 switch marker。
       */
      expect(
        timeline.filter((m) => epochOf(m)?.kind === "compact"),
        "换段路径上不该再生成 compact epoch（否则等于既换段又压缩）",
      ).toHaveLength(0);
      const view = listMessages(SESSION);
      expect(view[0]?.id, "模型视图的头必须是 switch marker").toBe(switchMarkers[0].id);

      const end = events.find((e) => e.type === "compaction_end");
      expect(end, "换段也要发 compaction_end（UI 横幅不能永远挂着）").toBeTruthy();
      expect(end.messagesRemoved, "移出模型视图的条数必须如实上报").toBeGreaterThan(0);

      expect(
        provider.completes.length,
        "换段**不许**调用摘要模型（那会把 handoff 变成第二套压缩）",
      ).toBe(0);
      expect(onCompactionComplete, "换段后记忆提取钩子必须照跑").toHaveBeenCalled();
    } finally {
      /* 全局单例：不还原会把开关漏给同文件的其它用例 */
      contextManager.updateConfig({ segmentEpochs: false });
    }
  });

  /**
   * P0（完成态换段）：回合**真的完成**、**且水位达到考虑线**时才按任务边界切段。
   *
   * 用 `enableCompaction:false` 把「中途压缩」这条干扰路径关掉 —— 于是这一次 switch
   * 只可能来自**完成出口**（`trySwitchOnCompletion`），判据钉的就是那条线。
   *
   * ⚠️ 2026-11 修正：完成态不再「完成即边界」，而是与中途共用 `compactionThreshold`
   * 水尺。本夹具的压力 ≈0.87（40 条 × 900 字 / 24k 窗口）⇒ 达标；低压力完成不切
   * 由 `DEF-1b` / `SEG-WIRE-1` / `ICM-1` 守。
   */
  it("AUTOCOMPACT-DONE-SWITCH：完成 + 水位达标 ⇒ 切段（同一 Session、旧消息仍在、后续输入不丢）", async () => {
    seedSession(SESSION);
    for (let i = 0; i < 40; i += 1) {
      seedRow("messages", {
        id: `done-msg-${i}`,
        session_id: SESSION,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`完成态第 ${i} 条`, 900),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const contextManager = getContextManager();
    contextManager.updateConfig({ segmentEpochs: true });
    try {
      const provider = new RecordingProvider();
      const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
        maxIterations: 2,
        model: "ac-model",
        securityMode: "full",
        contextWindow: WINDOW,
        enableCompaction: false,
        compactionThreshold: 0.7,
      });
      const events: any[] = [];
      for await (const event of loop.run(SESSION, "你好", CWD, SYSTEM_PROMPT)) events.push(event);

      const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
      const timeline = listTimelineMessages(SESSION);
      const switches = timeline.filter((m) => epochOf(m)?.kind === "switch");
      expect(switches.length, `完成态必须切一段；事件=${events.map((e) => e.type).join(",")}`).toBe(1);

      /* ⓪ 前提：完成时的压力确实达到考虑线（这一刀不是「完成即边界」的旧行为） */
      const pressure = Number((loop as any).getState().contextPressure);
      expect(
        pressure,
        `前提：完成时必须达到考虑线（实际 ${Number.isFinite(pressure) ? pressure.toFixed(3) : pressure}）`,
      ).toBeGreaterThanOrEqual(0.7);
      expect(pressure, "前提：低于 hard 线 ⇒ 不是 hard 救援").toBeLessThan(0.9);

      /* ① 仍是同一 Session：没有新建会话、loop 仍跑在原 id 上 */
      expect(getSession(SESSION), "切段不许换 Session").toBeTruthy();
      expect(listSessions("p1").length, "切段不许新建会话").toBe(1);

      /* ② 旧消息仍可见（时间线里一条不少） */
      const oldIds = timeline.filter((m) => m.id.startsWith("done-msg-")).map((m) => m.id);
      expect(oldIds.length, "切段不删消息").toBe(40);

      /* ③ 切换之后的输入不丢：新消息落在 marker 之后，模型与时间线都看得到 */
      createMessage({ id: "after-switch", role: "user", content: "切换后继续输入", timestamp: 9_999, status: "done" }, SESSION);
      const view = listMessages(SESSION);
      expect(view.map((m) => m.id), "模型视图 = [switch marker, ...最近 N 条]").toContain("after-switch");
      expect(view[0].id).toBe(switches[0].id);
      expect(listTimelineMessages(SESSION).map((m) => m.id)).toContain("after-switch");
    } finally {
      contextManager.updateConfig({ segmentEpochs: false });
    }
  });

  /**
   * AUTOCOMPACT-SWITCH-ONCE（P0，2026-11）：**同一轮只许写一个 switch marker**。
   *
   * ## 被守的形态（独立复核）
   *
   * `trySwitchSegment` 有两个中途入口 —— 主动压力（`agentic-loop.ts:2869`）与
   * 反应式溢出（`:4775`）—— 而守卫只存在于**完成出口**（`trySwitchOnCompletion`）。
   * 一次 hard 线切换之后，下一迭代的压力是**重算**的（保留集仍可能 ≥ hard 线），
   * 同一次超长事件的 catch 分支也可能再进来 ⇒ 两条入口各写一条 epoch：
   * 时间线两个 marker、handoff 两份、段号一次跳两级。
   *
   * ## 判据怎么造（不靠猜测）
   *
   * 先跑一轮真实 `run()`（= 上面的 AUTOCOMPACT-SWITCH 形态）拿到那一次 hard 切换；
   * 再按"下一迭代仍然 ≥ hard"的现场调**同一个入口**（两处入口调的就是它）。
   * 前半段先断言「如果没有守卫，这一下确实该切」（`epochActionForLoop` = switch），
   * 否则"没切"可能只是因为压力不够 —— 那样的判据删掉守卫也不会红。
   *
   * 变红方式：删掉 `trySwitchSegment` 入口的
   * `if (this.switchedThisTurn) return { switched:false, reason:"already switched this turn" }`
   * ⇒ 第二次调用真的换段、时间线多出第二条 marker、本条红。
   */
  it("AUTOCOMPACT-SWITCH-ONCE：同一轮已换过段 ⇒ 再触发只返回 already switched，不写第二条 marker", async () => {
    seedSession(SESSION);
    /* 与 AUTOCOMPACT-SWITCH 同一份现场：稳稳越过 hard 线（0.9） */
    for (let i = 0; i < 90; i += 1) {
      seedRow("messages", {
        id: `once-msg-${i}`,
        session_id: SESSION,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`只切一次第 ${i} 条`, 1400),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const contextManager = getContextManager();
    contextManager.updateConfig({ segmentEpochs: true });
    try {
      const provider = new RecordingProvider();
      const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
        maxIterations: 2,
        model: "ac-model",
        securityMode: "full",
        contextWindow: WINDOW,
        enableCompaction: true,
        compactionThreshold: 0.7,
      });

      const events: any[] = [];
      for await (const event of loop.run(SESSION, "你好", CWD, SYSTEM_PROMPT)) events.push(event);

      const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
      const switchCount = () =>
        listTimelineMessages(SESSION).filter((m) => epochOf(m)?.kind === "switch").length;

      expect(switchCount(), `前提：主动 hard 线必须已经切过一次；事件=${events.map((e) => e.type).join(",")}`).toBe(1);
      expect((loop as any).switchedThisTurn, "前提：本轮已标记换过段").toBe(true);

      /**
       * 把现场改成"下一迭代仍然 ≥ hard"：压力是重算的，保留集在大文件/大粘贴下
       * 完全可能仍越线。先证明这一刻**该切**（否则本条判据证明不了守卫有用）。
       */
      const state = (loop as any).state;
      state.contextPressure = 0.95;
      state.consecutiveCompactions = 0;
      expect(
        epochActionForLoop(
          { segmentEpochs: true, compactionThreshold: 0.7 },
          { contextPressure: state.contextPressure, consecutiveCompactions: state.consecutiveCompactions },
        ),
        "前提：除守卫外的所有前置都成立（会切）",
      ).toBe("switch");

      /**
       * ★ 前置断言（独立复核补强）：**证明"若无守卫确实切得动"**。
       *
       * `performSegmentSwitch` 还有一道"没有可切内容"（`timeline.length <= keepCount`）——
       * 只断言规则说 switch，仍可能因为时间线太短而"第二次没切"与守卫无关，
       * 那样删掉守卫本条也不会红（判据失效）。所以先把真正的切段前置也钉住：
       * 第二次调用前，时间线条数必须**大于**保留条数。
       */
      const keepCount = getContextManager().getConfig().maxMessagesAfterCompaction;
      expect(
        listTimelineMessages(SESSION).length,
        `前提：若无守卫，这一刻确实切得动（时间线必须 > keepCount=${keepCount}）`,
      ).toBeGreaterThan(keepCount);

      const second = (loop as any).trySwitchSegment(SESSION);
      expect(second.switched, "同一轮第二次触发不许再换段").toBe(false);
      expect(second.reason, "必须如实报告原因").toBe("already switched this turn");
      expect(switchCount(), "时间线只许有第一条 switch marker").toBe(1);
    } finally {
      contextManager.updateConfig({ segmentEpochs: false });
    }
  });

  /**
   * ★ C01（诚实性 P0，2026-11）：**窗口满时开关开启 ⇒ 换段/压缩救回；开关关闭 ⇒ 中性错误、Session 保留**。
   *
   * ## 被修的形态
   *
   * `agentic-loop.ts` 的「连压 3 次」分支原来直接结束本轮并写
   * 「上下文窗口已满，即使压缩后仍无法继续。请开启新对话。」
   * —— 与 C01 对外的承诺「不因上下文窗口满而被迫重开」直接冲突。
   * 现在 `segmentEpochs` 开启时先 `trySwitchSegment`，失败再 `compactMessages`，
   * 两者都救不回来 ⇒ 中性错误（不出现「请开启新对话」）；关闭时同样不劝退。
   *
   * ## 怎么造出"连压 3 次"的现场（不靠猜）
   *
   * 真实跑到第 3 次压缩太慢且依赖摘要内容。这里在**第一轮压缩收尾之后**
   * （`compaction_end` 之后的第一个 `text_delta` —— 此刻 `nextConsecutiveCompactions`
   * 已经算完，不会被覆盖）把 `state.consecutiveCompactions` 置成 3，
   * 于是**下一轮 prep** 就是"窗口满"那一刻，判据落在真实分支上。
   *
   * 变红方式：删掉开关开启的那段救援（或让它等价于默认路径）⇒ 第一条红（出现原提示）。
   * 第二条是反向对照：默认路径被改宽/改窄都会红。
   */
  async function runCeilingScenario(options: { segmentOn: boolean }): Promise<{ events: any[] }> {
    seedSession(SESSION);
    /* 90 条 × 2000 字：稳稳越过 hard 线；压缩后保留的 20 条仍远高于阈值 */
    for (let i = 0; i < 90; i += 1) {
      seedRow("messages", {
        id: `ceiling-msg-${i}`,
        session_id: SESSION,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`窗口满第 ${i} 条`, 2000),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const contextManager = getContextManager();
    contextManager.updateConfig({ segmentEpochs: false });
    const provider = new RecordingProvider();
    const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 2,
      model: "ac-model",
      securityMode: "full",
      contextWindow: WINDOW,
      enableCompaction: true,
      compactionThreshold: 0.7,
    });
    const events: any[] = [];
    let sawCompactionEnd = false;
    let injected = false;
    try {
      for await (const event of loop.run(SESSION, "你好", CWD, SYSTEM_PROMPT)) {
        events.push(event);
        if (event.type === "compaction_end") sawCompactionEnd = true;
        /**
         * 注入点必须在这一刻：compaction_end **之后**的 text_delta。
         * 若在 compaction_end 上改，随后的 `nextConsecutiveCompactions` 会把值覆盖掉。
         */
        if (sawCompactionEnd && !injected && event.type === "text_delta") {
          injected = true;
          (loop as any).state.consecutiveCompactions = 3;
          if (options.segmentOn) contextManager.updateConfig({ segmentEpochs: true });
        }
      }
    } finally {
      contextManager.updateConfig({ segmentEpochs: false });
    }
    return { events };
  }

  it("AUTOCOMPACT-CEILING-SEGMENT：开关开 + 窗口满 ⇒ 换段救回（同一 Session、不要求重开）", async () => {
    const { events } = await runCeilingScenario({ segmentOn: true });
    const serialized = JSON.stringify(events);
    expect(
      serialized,
      `开关开启时不许再把用户推去开新对话；事件序列=${events.map((e) => e.type).join(",")}`,
    ).not.toContain("请开启新对话");

    const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
    const switchMarkers = listTimelineMessages(SESSION).filter((m) => epochOf(m)?.kind === "switch");
    expect(
      switchMarkers.length,
      `窗口满时应换段而不是劝退；事件序列=${events.map((e) => e.type).join(",")}`,
    ).toBe(1);
    expect(listSessions("p1").length, "换段不新建会话（同一 Session 继续）").toBe(1);
    expect(getSession(SESSION), "Session 必须还在").toBeTruthy();
    expect(
      events.some((e) => e.type === "end" && e.result?.type === "overflow"),
      "不许以「窗口满」终态结束本轮",
    ).toBe(false);
  });

  it("AUTOCOMPACT-CEILING-EXPLICIT-OFF：显式关闭 + 同一形态 ⇒ 中性错误、不劝开新对话、Session 保留", async () => {
    const { events } = await runCeilingScenario({ segmentOn: false });
    const end = events.find((e) => e.type === "end");
    expect(end, `显式关闭路径必须以中性错误结束；事件=${events.map((e) => e.type).join(",")}`).toBeTruthy();
    expect(end.result?.type, "不是 overflow 终态").toBe("error");
    expect(JSON.stringify(end), "不许出现「请开启新对话」").not.toContain("请开启新对话");
    expect(getSession(SESSION), "Session 必须保留，用户可重试").toBeTruthy();
    const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
    expect(
      listTimelineMessages(SESSION).filter((m) => epochOf(m)?.kind === "switch"),
      "显式关闭时不许产生 switch epoch",
    ).toHaveLength(0);
  });

  /**
   * AUTOCOMPACT-SWITCH-NEXT-TURN（C 项判据补强）：**第二轮仍可再切**。
   *
   * `switchedThisTurn` 是"同一轮只切一次"的守卫，`run()` 开头按轮重置。
   * 若把重置删掉（或挪出按轮重置区），第二轮会沿用上一轮的 `true`：
   * 中途 hard 线切不了、完成出口也会跳过 ⇒ 时间线只有第一条 marker。
   * 本用例跑**同一个 loop 实例**两轮，第二轮前再堆一截历史把压力顶回 hard 线，
   * 断言出现**第二条** switch marker 且段号递增。
   */
  it("AUTOCOMPACT-SWITCH-NEXT-TURN：同一 loop 第二轮重置守卫并能再切（segmentSeq 递增）", async () => {
    seedSession(SESSION);
    for (let i = 0; i < 90; i += 1) {
      seedRow("messages", {
        id: `nextturn-msg-${i}`,
        session_id: SESSION,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`第二轮第 ${i} 条`, 1400),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const contextManager = getContextManager();
    contextManager.updateConfig({ segmentEpochs: true });
    try {
      const provider = new RecordingProvider();
      const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
        maxIterations: 2,
        model: "ac-model",
        securityMode: "full",
        contextWindow: WINDOW,
        enableCompaction: true,
        compactionThreshold: 0.7,
      });
      const runOnce = async () => {
        const events: any[] = [];
        for await (const event of loop.run(SESSION, "你好", CWD, SYSTEM_PROMPT)) events.push(event);
        return events;
      };
      const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
      const switches = () =>
        listTimelineMessages(SESSION).filter((m) => epochOf(m)?.kind === "switch");

      await runOnce();
      expect(switches().length, "前提：第一轮必须切出一段").toBe(1);
      expect((loop as any).switchedThisTurn, "前提：第一轮已标记切过段").toBe(true);

      /* 第二轮现场：再堆 40 条大消息，保证 prep 时压力重新越过 hard 线（中途切段路径） */
      for (let i = 0; i < 40; i += 1) {
        createMessage(
          {
            id: `nextturn-second-${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            content: body(`第二轮加料第 ${i} 条`, 2000),
            timestamp: 20_000 + i,
            status: "done",
          },
          SESSION,
        );
      }

      await runOnce();
      const markers = switches();
      expect(markers.length, "第二轮必须能再切一段（段号递增）").toBe(2);
      const seqs = markers.map((m) => Number(epochOf(m)?.segmentSeq));
      expect(seqs[1], `第二轮段号必须递增（第一段 ${seqs[0]}，第二段 ${seqs[1]}）`).toBeGreaterThan(seqs[0]);
      expect(listSessions("p1").length, "跨轮换段仍不许新建会话").toBe(1);
    } finally {
      contextManager.updateConfig({ segmentEpochs: false });
    }
  });

  /**
   * AUTOCOMPACT-SWITCH-GUARD-FALLBACK（C 项判据补强）：
   * `trySwitchSegment` 返回 `already switched this turn` 时，**调用方仍走压缩**。
   *
   * 现场：第一轮 hard 线切段（`switchedThisTurn=true`）；切段后继续堆消息把压力顶回 hard，
   * 第二轮 prep 再问换段 ⇒ 被守卫拒 ⇒ 必须回退 `compactMessages`（且**不写第二条 marker**）。
   * 用 spy 断言"压缩恰好被调用一次"（摘要内容不在本判据范围内）。
   */
  it("AUTOCOMPACT-SWITCH-GUARD-FALLBACK：守卫拒换段后调用方仍压缩一次（不写第二条 marker）", async () => {
    seedSession(SESSION);
    for (let i = 0; i < 90; i += 1) {
      seedRow("messages", {
        id: `fallback-msg-${i}`,
        session_id: SESSION,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`守卫回退第 ${i} 条`, 1400),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const contextManager = getContextManager();
    contextManager.updateConfig({ segmentEpochs: true });
    try {
      const provider = new ToolCallThenStopProvider();
      const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
        maxIterations: 2,
        model: "ac-model",
        securityMode: "full",
        contextWindow: WINDOW,
        enableCompaction: true,
        compactionThreshold: 0.7,
      });
      const compactSpy = vi.spyOn(loop as any, "compactMessages");

      const events: any[] = [];
      let injected = false;
      for await (const event of loop.run(SESSION, "你好", CWD, SYSTEM_PROMPT)) {
        events.push(event);
        /**
         * 第一次 `compaction_end` 就是 hard 线换段的收尾。此刻再堆 40 条大消息，
         * 让**下一轮**的压力重新越过 hard 线 ⇒ 第二次 `trySwitchSegment` 必然被守卫拒绝。
         */
        if (!injected && event.type === "compaction_end") {
          injected = true;
          for (let i = 0; i < 40; i += 1) {
            createMessage(
              {
                id: `fallback-extra-${i}`,
                role: i % 2 === 0 ? "user" : "assistant",
                content: body(`守卫回退加料第 ${i} 条`, 2000),
                timestamp: 30_000 + i,
                status: "done",
              },
              SESSION,
            );
          }
          (loop as any).msgCache = null;
        }
      }

      expect(provider.toolCalls, "前提：第一轮真的产生了工具调用（否则不会进第二轮）").toBeGreaterThanOrEqual(1);
      const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
      const markers = listTimelineMessages(SESSION).filter((m) => epochOf(m)?.kind === "switch");
      expect(markers.length, "守卫生效：只许有第一条 switch marker").toBe(1);
      expect(
        compactSpy,
        "守卫只拒换段、不拒压缩：调用方必须回退 compactMessages（恰好一次）",
      ).toHaveBeenCalledTimes(1);
      expect(
        events.filter((e) => e.type === "compaction_end").length,
        "换段一次 + 回退压缩一次 ⇒ 两条收尾事件",
      ).toBeGreaterThanOrEqual(2);
    } finally {
      contextManager.updateConfig({ segmentEpochs: false });
    }
  });

  /**
   * P0（未完成不切）：回合**被中止**（不是完成）⇒ 完成态换段不许发生。
   *
   * 用 45 条中等正文把压力顶到 0.7–0.9 之间（不触发 hard 线的中途切段），
   * 收到第一段文本就 `loop.abort()` —— 出口是 aborted 而不是 completed。
   * 若把 `trySwitchOnCompletion` 挪到 abort 路径、或去掉 `completed` 判断，这条会红。
   */
  it("AUTOCOMPACT-DONE-GUARD：未完成（被中止）的回合不切段", async () => {
    seedSession(SESSION);
    for (let i = 0; i < 53; i += 1) {
      seedRow("messages", {
        id: `mid-msg-${i}`,
        session_id: SESSION,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`中途第 ${i} 条`, 600),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }
    const contextManager = getContextManager();
    contextManager.updateConfig({ segmentEpochs: true });
    try {
      const provider = new AbortedProvider();
      const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
        maxIterations: 2,
        model: "ac-model",
        securityMode: "full",
        contextWindow: WINDOW,
        enableCompaction: false,
        compactionThreshold: 0.7,
      });
      const events: any[] = [];
      for await (const event of loop.run(SESSION, "你好", CWD, SYSTEM_PROMPT)) events.push(event);

      const pressure = (loop as any).getState().contextPressure as number;
      const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
      const switches = listTimelineMessages(SESSION).filter((m) => epochOf(m)?.kind === "switch");
      expect(pressure, `前提：压力应落在 0.7–0.9（实际 ${pressure.toFixed(3)}）`).toBeGreaterThanOrEqual(0.7);
      expect(pressure).toBeLessThan(0.9);
      expect(switches, "未完成的回合不许切段").toHaveLength(0);
    } finally {
      contextManager.updateConfig({ segmentEpochs: false });
    }
  });
});

describe("上下文溢出的两条真实错误出口（2026-11-09）", () => {
  function makeLoop(enableReactiveCompaction: boolean, beforeStream?: () => void) {
    return new AgenticLoop(new OverflowProvider(beforeStream) as any, createDefaultToolRegistry(), {
      maxIterations: 3,
      model: "ac-model",
      securityMode: "full",
      contextWindow: WINDOW,
      enableCompaction: true,
      enableReactiveCompaction,
      compactionThreshold: 0.7,
    });
  }

  async function run(loop: AgenticLoop): Promise<any[]> {
    seedSession(SESSION);
    seedRow("messages", {
      id: "overflow-msg-1",
      session_id: SESSION,
      role: "user",
      content: body("溢出前历史", 200),
      reasoning: null,
      timestamp: 1,
      model: null,
      status: "done",
      hidden: 0,
    });
    const events: any[] = [];
    for await (const event of loop.run(SESSION, "继续", CWD, SYSTEM_PROMPT)) events.push(event);
    return events;
  }

  it("OFLOW-REAL-1：连续压缩到上限后 provider overflow ⇒ 中性说明，不劝开新对话", async () => {
    let loop: any;
    loop = makeLoop(true, () => {
      loop.state.consecutiveCompactions = 3;
    });
    const events = await run(loop);
    const text = events.filter((e) => e.type === "text_delta").map((e) => String(e.text)).join("\n");
    const end = events.find((e) => e.type === "end");
    expect(text).toContain("上下文超出模型上限");
    expect(text, "不得出现新对话建议").not.toMatch(/开一个新对话|新建对话|开新对话|新会话/);
    expect(end?.result?.reason).toBe("context_overflow");
    expect(getSession(SESSION), "Session 必须保留").toBeTruthy();
  });

  it("OFLOW-REAL-2：反应式压缩关闭时 provider overflow ⇒ 说明未压缩，不劝开新对话", async () => {
    const loop = makeLoop(false);
    const events = await run(loop);
    const text = events.filter((e) => e.type === "text_delta").map((e) => String(e.text)).join("\n");
    const end = events.find((e) => e.type === "end");
    expect(text).toContain("没有自动压缩");
    expect(text).not.toMatch(/开一个新对话|新建对话|开新对话|新会话/);
    expect(end?.result?.reason).toBe("context_overflow");
    expect(getSession(SESSION), "Session 必须保留").toBeTruthy();
  });
});
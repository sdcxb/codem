/**
 * 25 号文 P2：自适应 steward 在**真实 loop** 里的接线判据（SP-W1..SP-W4）。
 *
 * ## 守什么
 *
 * 纯函数判据（`steward-policy.test.ts`）只能证明「公式对」；这一组证明
 * **loop 真的把窗口 / 单轮观测算进去了**，而且调整会留下 `steward_policy` 审计事件：
 *
 * - SP-W1：24k 窗口 ⇒ consider 被拉低（0.619），0.67 的完成态换段；
 *   事件里有 `steward_policy`（reason 含「窗口」），且每回合最多一条；
 * - SP-W2：128k 默认窗口 ⇒ 不调整、**一条审计都不写**（默认路径事件库与改前一致）；
 * - SP-W3：单轮观测 = 本回合平均 prompt tokens − 上一回合同口径均值（不是上下文总量）；
 *   首个回合没有基线 ⇒ 0；
 * - SP-W4：`steward_policy` 的 payload 能回答「用哪套刻度」（consider/hard/reason/窗口/观测）。
 *
 * ## 变异自证
 *
 * - 把 `modelContextWindow` 传成配置里的 `maxContextWindow`（而不是 loop 真实窗口）⇒
 *   24k 用例不再调整 ⇒ SP-W1 红；
 * - 观测改成「本回合 prompt 总量」（不减基线）⇒ SP-W3 的首回合/第二回合读数红；
 * - 每回合都写审计（去掉 `auditedThisTurn` 守卫）⇒ SP-W1 的条数红；
 * - 无条件写审计（不看 adjusted）⇒ SP-W2 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort, type StoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getTokenTracker } from "../core/llm/token-tracker";
import { getContextManager } from "../core/context/context";
import { listTimelineMessages } from "../core/storage/message";
import { getEventLog } from "../core/storage/event-log";

const CWD = "C:\\steward-wire";
const SYSTEM_PROMPT = "你是测试用助手。";

let port: FakeStoragePort;

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

/** 与 `auto-compaction-trigger.test.ts` 同款正文：每条 ≈600 字（48 条在 24k 窗口下压力 ≈0.67）。 */
function body(tag: string, n = 600): string {
  return `${tag}：` + "上下文压缩触发判据的填充正文。".repeat(Math.ceil(n / 16));
}

/** 48 条 × 600 字在 24k 窗口下压力 ≈ 0.67（实测；见判据里的前提断言）。 */
function seedHistory(sessionId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    seedRow("messages", {
      id: `${sessionId}-m${i}`,
      session_id: sessionId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: body(`第 ${i} 条`, 600),
      reasoning: null,
      timestamp: 1_000 + i,
      model: null,
      status: "done",
      hidden: 0,
    });
  }
}

class TextProvider {
  id = "steward-wire-provider";
  name = "Steward Wire Mock";
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
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

/** 两回合分别报 1000 / 21000 次 prompt tokens：用来钉「观测 = 增量」而不是「上下文总量」。 */
class UsageProvider extends TextProvider {
  turn = 0;
  async *stream(_request: any): AsyncGenerator<any> {
    this.turn += 1;
    const promptTokens = this.turn === 1 ? 1_000 : 21_000;
    yield { type: "text_delta", text: "OK" };
    yield { type: "usage", usage: { promptTokens, completionTokens: 10, totalTokens: promptTokens + 10 } };
    yield { type: "end", finishReason: "stop" };
  }
}

function makeLoop(provider: any, window: number, overrides: Record<string, unknown> = {}): AgenticLoop {
  return new AgenticLoop(provider, createDefaultToolRegistry(), {
    maxIterations: 1,
    model: "steward-wire-model",
    securityMode: "full",
    contextWindow: window,
    enableCompaction: false,
    compactionThreshold: 0.7,
    ...overrides,
  } as never);
}

function policyEvents(sessionId: string): any[] {
  return getEventLog()
    .readAll(sessionId)
    .filter((e) => e.type === "steward_policy");
}

beforeEach(async () => {
  port = createFakeStoragePort();
  setStoragePort(port as unknown as StoragePort);
  getTokenTracker().reset();
  getTokenTracker().setContextWindow(24_000);
  getContextManager().updateConfig({
    segmentEpochs: true,
    compactionThreshold: 0.7,
    maxMessagesAfterCompaction: 20,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  /**
   * **预热一次压力估算**（判据环境限定）。
   *
   * 进程内第一次估算走 `estimate` 路径，会把 46 个工具定义算进去（实测把 24k 窗口
   * 直接顶到 1.0）；第二次起走 `actual` 基准。这不是被测行为，而是"首轮工具表就绪"
   * 的既有口径。用一个独立会话预热，被测会话的读数才是稳定的压力读数（0.67）。
   */
  const warmSession = "steward-wire-warmup";
  seedSession(warmSession);
  const warmLoop = makeLoop(new TextProvider() as any, 24_000);
  for await (const _event of warmLoop.run(warmSession, "预热", CWD, SYSTEM_PROMPT)) {
    /* drain */
  }
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("SP-W1：24k 窗口 ⇒ consider 提前 + 审计一条", () => {
  it("0.67 的完成态被换段；steward_policy 只写一条且 reason 说得清", async () => {
    const sessionId = "steward-wire-small";
    seedSession(sessionId);
    seedHistory(sessionId, 48);
    const loop = makeLoop(new TextProvider() as any, 24_000);
    for await (const _event of loop.run(sessionId, "你好", CWD, SYSTEM_PROMPT)) {
      /* drain */
    }

    const policy = Number(loop.getState().contextPressure);
    const basis = (loop as any).getPressureBasis?.();
    expect(
      policy,
      `前提：压力须落在 [0.619, 0.7)（实际 ${policy.toFixed(3)}；basis=${JSON.stringify(basis)}）`,
    ).toBeGreaterThanOrEqual(0.619);
    expect(policy, "前提：低于默认 0.7（否则旧实现也会切，判据抓不到提前）").toBeLessThan(0.7);

    const switched = listTimelineMessages(sessionId).filter(
      (m) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch?.kind === "switch",
    );
    expect(switched.length, "窗口提前后的 consider 应让这一刀真的切出去").toBe(1);
    expect(switched[0].content, "handoff 必须来自真实换段").toContain("[段切换 handoff]");

    const events = policyEvents(sessionId);
    expect(events.length, "真的调整了阈值 ⇒ 必须写一条 steward_policy 审计").toBe(1);
    const payload = events[0].payload as Record<string, any>;
    expect(payload.reason).toContain("窗口");
    expect(payload.modelContextWindow).toBe(24_000);
    expect(payload.consider).toBeLessThan(0.7);
    expect(payload.consider).toBeGreaterThanOrEqual(0.55);
    expect(payload.hard).toBe(0.9);
    expect(Number(payload.consecutiveCompactions)).toBe(0);
  });
});

describe("SP-W2：默认 128k 窗口 ⇒ 不调整也不写审计", () => {
  it("低压力完成：不换段，steward_policy 0 条（默认路径事件库与改前一致）", async () => {
    const sessionId = "steward-wire-default";
    seedSession(sessionId);
    seedHistory(sessionId, 24);
    getTokenTracker().setContextWindow(128_000);
    const loop = makeLoop(new TextProvider() as any, 128_000);
    for await (const _event of loop.run(sessionId, "你好", CWD, SYSTEM_PROMPT)) {
      /* drain */
    }
    expect(Number(loop.getState().contextPressure), "前提：默认窗口下是低压力").toBeLessThan(0.62);
    const switched = listTimelineMessages(sessionId).filter(
      (m) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch?.kind === "switch",
    );
    expect(switched, "低压力完成不许换段").toHaveLength(0);
    expect(policyEvents(sessionId), "默认输入下一条审计都不该有").toHaveLength(0);
  });
});

describe("SP-W3：单轮观测是「本回合均值 − 上一回合均值」", () => {
  it("首回合无基线 ⇒ 0；第二回合 1000 → 21000 ⇒ 20000", async () => {
    const sessionId = "steward-wire-observe";
    seedSession(sessionId);
    const provider = new UsageProvider();
    const loop = makeLoop(provider, 24_000);

    for await (const _event of loop.run(sessionId, "第一回合", CWD, SYSTEM_PROMPT)) {
      /* drain */
    }
    expect((loop as any).observedTurnTokens, "首个回合没有基线 ⇒ 不做单轮调整").toBe(0);
    expect((loop as any).previousTurnPromptAvg).toBe(1_000);

    for await (const _event of loop.run(sessionId, "第二回合", CWD, SYSTEM_PROMPT)) {
      /* drain */
    }
    expect((loop as any).observedTurnTokens, "观测必须是增量（21000 − 1000），不是总量").toBe(20_000);
    expect((loop as any).previousTurnPromptAvg).toBe(21_000);
  });

  it("provider 不报 usage ⇒ 观测保持 0（不在噪声上抖动）", async () => {
    const sessionId = "steward-wire-nousage";
    seedSession(sessionId);
    const loop = makeLoop(new TextProvider() as any, 24_000);
    for await (const _event of loop.run(sessionId, "没有用量", CWD, SYSTEM_PROMPT)) {
      /* drain */
    }
    expect((loop as any).observedTurnTokens).toBe(0);
    expect((loop as any).previousTurnPromptAvg).toBeNull();
  });
});

describe("SP-W4：审计 payload 能回答「用哪套刻度」", () => {
  it("调整后的 payload 同时带 consider/hard/keepRecent/reason/窗口/观测/压力", async () => {
    const sessionId = "steward-wire-payload";
    seedSession(sessionId);
    seedHistory(sessionId, 48);
    const loop = makeLoop(new TextProvider() as any, 24_000);
    for await (const _event of loop.run(sessionId, "你好", CWD, SYSTEM_PROMPT)) {
      /* drain */
    }
    const events = policyEvents(sessionId);
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, any>;
    for (const key of [
      "consider",
      "hard",
      "keepRecent",
      "reason",
      "modelContextWindow",
      "observedAvgTurnTokens",
      "consecutiveCompactions",
      "pressure",
    ]) {
      expect(payload, `steward_policy 必须带 ${key}`).toHaveProperty(key);
    }
    expect(payload.keepRecent).toBe(20);
    expect(String(payload.reason)).toContain("consider");
    expect(String(payload.reason)).toContain("hard");
  });
});

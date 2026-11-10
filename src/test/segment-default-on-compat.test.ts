/**
 * 段式上下文**默认关闭**（2026-11-08 决定）后的 D11 兼容矩阵；显式 true 才产生 switch。
 *
 * ## 背景
 *
 * D11 原文（26 §2）：remote `session.get` 与 `fork` 的 switch-epoch 兼容判据全绿之前，
 * 2026-11-08 决定锁定：`segmentEpochs` **默认 false**；DEF-1 的语义是「默认不产生 switch，显式 true 才产生」。
 *
 * ## 四条判据（一条一条对应 D11 的两个读路径 + 导出 + 默认生效）
 *
 * | 编号 | 钉什么 | 为什么这一条能证明兼容 |
 * |---|---|---|
 * | DEF-1 | **默认配置不产生 switch**：不写 settings、压力达到考虑线的完成回合 ⇒ 时间线没有 `kind="switch"`；<br>**DEF-1c 正向**：显式 `{segmentEpochs:true}` + 同样压力 ⇒ 产生 switch；<br>**DEF-1b 反向**：默认配置 + 低压力完成 ⇒ 不产生 switch | 默认 false 必须真的拦住写侧（写死 false 但代码不看 = 假绿）；显式 true 必须真的生效 |
 * | DEF-2 | **post-switch fork**：已有 switch epoch 的会话，子会话消息数 = 父时间线（含旧段），子会话无 `contextEpoch`、能正常打开 | fork 若读投影视图会静默丢掉换段前的全部消息（D11 点名的形态） |
 * | DEF-3 | **remote**：`readRemoteMessages`（`desktop-engine.ts`，= 手机 `session.get` 的数据入口）返回全部时间线（含旧段） | 手机若读投影视图，换段后少一段且无任何报错 |
 * | DEF-4 | **export / JSONL**：权威 JSONL 日志里旧段一条不少，且 switch marker 的 `metadata.contextEpoch` 原样落盘 | 导出/重建都从权威日志来；日志丢段 = 换段后「导出少一段」 |
 *
 * ## 变异自证（都会让本文件红）
 *
 * - 把 `context.ts` 的 `DEFAULT_CONFIG.segmentEpochs` 改成 `true` ⇒ DEF-1 红；
 * - 去掉完成态的水位判断（退回「完成即边界」）⇒ DEF-1b 红；
 * - 让水位判断恒 true（阈值换成 0）⇒ DEF-1b 红；
 * - 让 fork 改读 `listMessages`（投影）⇒ DEF-2 红；
 * - 让 `readRemoteMessages` 改读 `listMessages` ⇒ DEF-3 红；
 * - 从 JSONL 序列化里删掉 `metadata` ⇒ DEF-4 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { memFs } = vi.hoisted(() => ({
  memFs: new Map<string, string>(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\compat",
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
    /* 与 Rust 侧 `append_file` 一致：它负责补行分隔（写侧只交一行 JSON） */
    memFs.set(p, (memFs.get(p) ?? "") + c + "\n");
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
import { performSegmentSwitch } from "../core/storage/context-switch";
import {
  clearSessionLogCache,
  createMessage,
  listDisplayMessages,
  listMessages,
  listTimelineMessages,
} from "../core/storage/message";
import { readRemoteMessages } from "../core/remote/desktop-engine";
import { __awaitPendingWrites, domainEnsureLoaded } from "../core/storage/domain-store";
import { __resetJsonlCache, flushSessionLogWrites, readSessionMessages } from "../core/storage/session-jsonl";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import * as SessionStorage from "../core/storage/session";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";
import { useProjectStore } from "../core/store";
import { getSettingJSON } from "../core/storage/settings";

const SESSION = "sess-default-on-compat";
const PROJECT = "proj-default-on-compat";
const CWD = "C:\\compat";
const WINDOW = 128_000;
/** 与 `codem-context-config.maxMessagesAfterCompaction` 默认值一致 ⇒ 历史 > 它才有可切内容 */
const KEEP = 20;
const HISTORY = 24;

let port: ReturnType<typeof createFakeStoragePort>;

/** 只回一句话的 provider：不调工具 ⇒ 一定走「完成」出口 */
class TextProvider {
  id = "def-on-provider";
  name = "Default On Mock";
  config: any = { apiKey: "sk-test", models: [{ id: "def-on-model", contextWindow: WINDOW }] };
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
        id: "def-on-model",
        name: "DefOn",
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

/**
 * 种一个可分叉的源会话（与 `display-view-switch.test.ts` 的 `seedForkableSession` 同一做法：
 * 表行 + 域镜像 + store 三处都要，少一处就是「源会话不存在」的假失败）。
 */
async function seedSession(messageCount: number) {
  const proj = { id: PROJECT, name: "Compat", path: CWD, createdAt: 1, lastAccessedAt: 1 };
  await port.data.execute("crud.upsert", {
    table: "sessions",
    mode: "replace",
    rows: [
      {
        id: SESSION,
        project_id: PROJECT,
        title: "兼容矩阵",
        model: null,
        created_at: 1,
        last_message_at: messageCount,
        message_count: messageCount,
        pinned: 0,
      },
    ],
  });
  await new Promise<void>((resolve) => {
    domainEnsureLoaded("sessions", () => resolve());
  });
  expect(SessionStorage.getSession(SESSION), "源会话必须真的在域镜像里").toBeTruthy();
  useProjectStore.setState({
    projects: [proj] as never,
    currentProject: proj as never,
    sessions: [
      {
        id: SESSION,
        projectId: PROJECT,
        title: "兼容矩阵",
        createdAt: 1,
        lastMessageAt: messageCount,
        messageCount,
        pinned: false,
      },
    ] as never,
  });
}

/** 预置 N 条短历史（> keep，但压力远低于任何阈值） */
function seedShortHistory(count = HISTORY) {
  for (let i = 0; i < count; i += 1) {
    createMessage(
      {
        id: `compat-msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `兼容历史第 ${i} 条`,
        timestamp: 1_000 + i,
        status: "done",
      },
      SESSION,
    );
  }
}

/**
 * 预置一段**把水位顶到考虑线之上、但没到 hard 线**的大历史（DEF-1 的触发条件）。
 *
 * 口径（实测，128k 窗口）：24 条短历史 + 41 条 3000 字 ⇒ 压力 ≈ 0.73（> 默认 0.7、< hard 0.9）。
 * 这里造的是**模型真会看到的那份历史**；压力由真实估算器算，不写死数字。
 */
function seedPressuredHistory(count = 60, chars = 3_000) {
  const filler = "上下文规模化验收填充正文。".repeat(Math.ceil(chars / 14));
  for (let i = 0; i < count; i += 1) {
    createMessage(
      {
        id: `compat-big-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${filler}第 ${i} 段`,
        timestamp: 2_000 + i,
        status: "done",
      },
      SESSION,
    );
  }
}

/**
 * 默认配置（**不写 settings**）跑完一轮。
 *
 * `options.isolateCompletionSwitch`：关掉**中途压缩**，只留完成出口那一条判定
 * （见 SEG-WIRE 文件头的同一说明：阈值穿越会先被 prep 的 compact 吃掉）。
 * 它改的是 loop 的运行参数，不是 settings —— 「不写 settings」 的前提不变。
 */
async function runDefaultTurn(options: { isolateCompletionSwitch?: boolean } = {}): Promise<{ events: any[]; engine: LLMEngine }> {
  const engine = new LLMEngine();
  engine.providers.register(new TextProvider() as any);
  (engine as any).config.defaultProvider = "def-on-provider";
  (engine as any).config.defaultModel = "def-on-model";
  if (options.isolateCompletionSwitch) {
    const pooled = (engine as any).getAgenticLoop(undefined, SESSION);
    pooled.updateConfig({ enableCompaction: false });
  }
  const events: any[] = [];
  for await (const event of engine.process(SESSION, "只回复 OK", CWD)) events.push(event);
  return { events, engine };
}

const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memFs.clear();
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = { core: { invoke: async () => undefined } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
  resetSessionMessageBus();
  resetDelegationOrchestrator();

  port = createFakeStoragePort({});
  setStoragePort(port);
  /**
   * TokenTracker 是进程级单例：清掉历史，免得上一用例的 `recordActualUsage`
   * 把压力估算切到 `actual` 分支（那条分支不加系统提示词/工具表，读数会漂）。
   */
  getTokenTracker().reset();
  getTokenTracker().setContextWindow(WINDOW);
  await seedSession(HISTORY);
});

afterEach(() => {
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  useProjectStore.setState({ projects: [], currentProject: null, sessions: [], currentSession: null } as never);
  setStoragePort(null);
  vi.restoreAllMocks();
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("D11 兼容矩阵：默认关闭，显式 true 才产生 switch（DEF-*）", () => {
  it("DEF-1: 不写 settings 的默认配置 + 压力达到考虑线完成一轮 ⇒ 不产生 switch（默认关闭）", async () => {
    expect(getSettingJSON("codem-context-config", null), "判据前提：不写 settings").toBeNull();
    expect(getContextManager().getConfig().segmentEpochs, "前提：默认配置是关闭").toBe(false);
    expect(getContextManager().getConfig().compactionThreshold, "前提：默认考虑线").toBe(0.7);

    seedShortHistory(HISTORY);
    seedPressuredHistory(41, 3_000);
    const { events, engine } = await runDefaultTurn({ isolateCompletionSwitch: true });

    const end = [...events].reverse().find((e) => e.type === "end");
    expect(end?.result?.reason, "必须走到完成出口").toBe("completed");
    const pressure = Number((engine as any).loopPool.get(SESSION)?.getState().contextPressure);
    expect(pressure, `前提：压力达到考虑线（实际 ${pressure.toFixed(3)}）`).toBeGreaterThanOrEqual(0.7);
    expect(pressure, "前提：低于 hard 线").toBeLessThan(0.9);

    const timeline = listTimelineMessages(SESSION);
    expect(timeline.filter((m) => epochOf(m)?.kind === "switch"), "默认关闭时不许换段").toHaveLength(0);
    expect(timeline.filter((m) => m.id.startsWith("compat-msg-")).length).toBe(HISTORY);
    expect(timeline.filter((m) => m.id.startsWith("compat-big-")).length).toBe(41);
  }, 60_000);

  it("DEF-1c: 显式 {segmentEpochs:true} + 同样压力完成 ⇒ 产生 switch（显式 true 真生效）", async () => {
    getContextManager().updateConfig({ segmentEpochs: true });
    expect(getContextManager().getConfig().segmentEpochs).toBe(true);

    seedShortHistory(HISTORY);
    seedPressuredHistory(41, 3_000);
    const { events, engine } = await runDefaultTurn({ isolateCompletionSwitch: true });

    const end = [...events].reverse().find((e) => e.type === "end");
    expect(end?.result?.reason, "必须走到完成出口").toBe("completed");
    const pressure = Number((engine as any).loopPool.get(SESSION)?.getState().contextPressure);
    expect(pressure, `前提：压力达到考虑线（实际 ${pressure.toFixed(3)}）`).toBeGreaterThanOrEqual(0.7);
    expect(pressure, "前提：低于 hard 线").toBeLessThan(0.9);

    const timeline = listTimelineMessages(SESSION);
    const switches = timeline.filter((m) => epochOf(m)?.kind === "switch");
    expect(switches.length, "显式 true 必须产生 switch").toBe(1);
    expect(timeline.filter((m) => m.id.startsWith("compat-msg-")).length).toBe(HISTORY);

    /* C01 当前构建证据：默认阈值 0.7、压力真的达标、完成出口真的写 switch。
     * 仅在 C01_EVIDENCE=1 时落盘，避免普通全量测试改仓库文件。 */
    if (process.env.C01_EVIDENCE === "1") {
      writeFileSync(
        join(process.cwd(), "docs", "marketing", "evidence", "c01-segment-switch-current.json"),
        JSON.stringify({
          schema: "codem.c01.segment-switch-evidence.v1",
          collectedAt: new Date().toISOString(),
          command: "C01_EVIDENCE=1 npx vitest run src/test/segment-default-on-compat.test.ts -t DEF-1c",
          sessionId: SESSION,
          resultReason: end?.result?.reason,
          pressure,
          threshold: 0.7,
          switches: switches.length,
          segmentSeq: epochOf(switches[0])?.segmentSeq,
          oldMessages: timeline.filter((m) => m.id.startsWith("compat-msg-")).length,
        }, null, 2) + "\n",
      );
    }
  }, 60_000);
  /**
   * DEF-1b（2026-11 修正的回归判据）：默认配置 + **低压力**完成 ⇒ 不许换段。
   *
   * 旧实现「完成即边界」在这里会切一段；历史超过 keepCount 之后每个用户回合都切，
   * 真实 200 轮不可能只有 3 段（`ICM-1` 的规模化判据因此造假）。
   */
  it("DEF-1b: 关闭配置 + 低压力完成 ⇒ 不产生 switch（完成不再等于段边界）", async () => {
    getContextManager().updateConfig({ segmentEpochs: false });
    expect(getContextManager().getConfig().segmentEpochs, "前提：显式关闭").toBe(false);

    seedShortHistory(HISTORY);
    const { events, engine } = await runDefaultTurn();

    const end = [...events].reverse().find((e) => e.type === "end");
    expect(end?.result?.reason, "这一段必须走完成出口").toBe("completed");
    const pressure = Number((engine as any).loopPool.get(SESSION)?.getState().contextPressure);
    expect(pressure, `前提：低压力（实际 ${pressure.toFixed(3)} < 0.7）`).toBeLessThan(0.7);

    const timeline = listTimelineMessages(SESSION);
    expect(timeline.filter((m) => epochOf(m)?.kind === "switch"), "低压力完成不许换段").toHaveLength(0);
    expect(timeline.filter((m) => m.id.startsWith("compat-msg-")).length, "不换段也不许动旧消息").toBe(HISTORY);
  }, 60_000);

  it("DEF-2: post-switch fork ⇒ 子会话消息数=父时间线（含旧段）、无 contextEpoch、可正常打开", async () => {
    seedShortHistory(HISTORY);
    const switched = performSegmentSwitch(SESSION, { keepCount: KEEP, now: 10_000 });
    expect(switched.switched, "前提：会话里真的有一条 switch epoch").toBe(true);

    const parentTimeline = listTimelineMessages(SESSION);
    expect(parentTimeline.length, "前提：父时间线 = 历史 + switch marker").toBe(HISTORY + 1);

    const child = useProjectStore.getState().forkSession(SESSION, parentTimeline.length - 1, "Fork: 默认开启");
    expect(child, "分叉必须落地").toBeTruthy();
    await __awaitPendingWrites();

    const childTimeline = listTimelineMessages(child!.id);
    expect(childTimeline.length, "子会话消息数必须等于父时间线（含旧段）").toBe(parentTimeline.length);
    expect(
      childTimeline.filter((m) => m.id.startsWith("compat-msg-")).length,
      "换段之前的旧消息必须在子会话里（不是只剩最后一段）",
    ).toBe(HISTORY);
    expect(
      childTimeline.some((m) => Boolean(m.metadata as Record<string, unknown> | undefined)?.contextEpoch),
      "子会话不许带悬空的 epoch（cutoff id 指向源会话，会让每次读 fail-open）",
    ).toBe(false);

    /* 可正常打开：DisplayView 与模型视图都不被 cutoff 裁剪，且能按 id 读出内容 */
    expect(listDisplayMessages(child!.id).length).toBe(parentTimeline.length);
    expect(listMessages(child!.id).length).toBe(parentTimeline.length);
    expect(childTimeline.map((m) => String(m.content))).toContain("兼容历史第 0 条");
  });

  it("DEF-3: remote（手机 session.get 的数据入口）对 switch 会话返回全部时间线（含旧段）", () => {
    seedShortHistory(HISTORY);
    const switched = performSegmentSwitch(SESSION, { keepCount: KEEP, now: 10_000 });
    expect(switched.switched).toBe(true);

    /* 模型视图只看最新段：这是「手机若读错视图就会少一段」的对照 */
    const modelContent = listMessages(SESSION).map((m) => String(m.content));
    expect(modelContent, "模型视图不含换段前旧段（前提）").not.toContain("兼容历史第 0 条");

    const rows = readRemoteMessages(SESSION, 200);
    const contents = rows.map((r) => r.content);
    expect(contents, "手机必须看到换段之前的旧段").toContain("兼容历史第 0 条");
    expect(contents, "也必须看到换段之后的当前段").toContain(`兼容历史第 ${HISTORY - 1} 条`);
    expect(rows.length, "手机看到的就是完整时间线（不裁掉旧段）").toBe(HISTORY + 1);

    /* 分页仍然按「最后 N 条」语义（不破坏既有 limit 契约） */
    expect(readRemoteMessages(SESSION, 2).length).toBe(2);
  });

  it("DEF-4: export / 权威 JSONL 不丢旧段，switch marker 的 epoch 元数据原样落盘", async () => {
    seedShortHistory(HISTORY);
    const switched = performSegmentSwitch(SESSION, { keepCount: KEEP, now: 10_000 });
    expect(switched.switched).toBe(true);
    expect(switched.epochId).toBeTruthy();

    await flushSessionLogWrites();
    const log = await readSessionMessages(SESSION);
    expect(log.skippedLines, "权威日志不该有坏行").toBe(0);

    const ids = new Set(log.messages.map((r) => r.id));
    for (let i = 0; i < HISTORY; i += 1) {
      expect(ids.has(`compat-msg-${i}`), `旧段第 ${i} 条必须写进权威 JSONL（导出/重建都读它）`).toBe(true);
    }

    /* switch marker 本身 + 它的 contextEpoch 必须进日志（重建后 epoch 事实不能丢） */
    const marker = log.messages.find((r) => r.id === switched.epochId);
    expect(marker, "switch marker 必须在权威日志里").toBeTruthy();
    const epoch = (marker as any)?.metadata?.contextEpoch;
    expect(epoch?.kind).toBe("switch");
    expect(epoch?.segmentSeq).toBeGreaterThanOrEqual(2);
    expect(epoch?.cutoffMessageId, "cutoff 也必须落盘（否则重建后投影视图失效）").toBeTruthy();
  });
});



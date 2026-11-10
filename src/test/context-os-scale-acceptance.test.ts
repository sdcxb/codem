/**
 * 25 号文 P0 的**规模化集成验收**（ICM-1..6 / MEM-T1 / MEM-T2，附 HIST-T1 / MEM-EXTRACT-3）。
 *
 * ## 为什么需要这一组（单点判据不够）
 *
 * 仓库里已有 `context-epoch` / `segment-switch` / `thread-history` / `auto-compaction` /
 * `segment-default-on-compat` 等**单点**判据，但它们各自只钉一个函数或一个接缝。
 * 25 §6 P0 的验收承诺是**规模化**的：
 *
 * > 200 轮 / 3 次 switch 之后，早期事实仍能通过 thread history 找回；
 * > 未完成任务在阈值处 compact、完成任务 switch；steward 失败不丢输入；
 * > 切换中消息不重复/不丢；旧消息完整、可搜索、不可变；conversation memory 换段后仍可见。
 *
 * 本文件用**真实 `LLMEngine.process()` / `AgenticLoop.run()`** + 内存存储（假存储端口 +
 * 内存文件层）走完整路径，不 mock 被测逻辑（不 mock segment-switch / thread-history /
 * memory 注入 / 提取源）。每一条都写明**变异自证**：把实现改坏必须变红。
 *
 * ## 判据与任务表的对应
 *
 * | 判据 | 场景 | 本文件怎么造 |
 * |---|---|---|
 * | ICM-1 | 200 轮 / 3 段 | **200 个真实用户回合**（每回合 user+assistant，fake provider 真实循环）+ 压力真的跨考虑线 3 次 ⇒ 恰好 3 个 switch epoch（段 2/3/4） |
 * | ICM-2 | 未完成过阈值 | 压力落在 0.7–0.9、provider 以 aborted 收尾 ⇒ 只 compact、不 switch |
 * | ICM-3 | 完成过阈值 | 压力 >0.7、`enableCompaction:false` ⇒ 完成出口 switch、handoff 落库、旧消息完整 |
 * | ICM-4 | decide/写入抛错 / 坏 JSON | 压力 >0.7（换段真的被尝试）+ 写 marker 抛错 ⇒ 不静默 switch、输入不丢；坏 notes JSON ⇒ 换段仍成功 |
 * | ICM-5 | 切换中用户发消息 | hard 线换段期间 `sendGuidance` ⇒ 恰好落库一次、落在新段 |
 * | ICM-6 | 旧段完整/可读/不可编辑/可导出 | 压力 >0.7 下切换，切换前后逐条快照 + 权威 JSONL + 只读工具契约 |
 * | MEM-T1 | 换段后 conversation 记忆 | 3 次换段（每轮压力达标）后真实 `buildSystemPrompt()` 仍含该记忆，`memory_read` 可读 |
 * | MEM-T2 | 自动提取旧段事实 | 3 次换段（真实 `performSegmentSwitch`）后真实 `extractMemoriesFromSession()` 的请求含第 1 段事实 |
 * | HIST-T1 | 旧命令/错误按锚点命中 | 与 ICM-1 同一现场：`thread_history_search("ENOENT")` + `read` 取回原文 |
 * | MEM-EXTRACT-3 | 空响应不更新水位 | 空响应之后第二次提取必须仍会发起（不是被水位锁死） |
 *
 * ## 已知边界（诚实标注）
 *
 * - **完成态换段要水位达标**（2026-11 修正）：`pressure >= compactionThreshold` 才切；
 *   低压力完成继续当前段。旧实现「完成即边界」导致超过 keepCount 后**每回合都切一段**，
 *   真实 200 轮不可能只有 3 段（ICM-1 原来靠 155 条种子 + 3 个真实回合冒充）。
 *   连压 ≥2 / 接近 hard 的救援信号不变（`AUTOCOMPACT-*` 守）。
 * - **中途压缩会先吃掉阈值穿越**：`run()` 的 prep 看到 `pressure >= 阈值` 且没完成 ⇒ compact
 *   （25 §6 的护栏）⇒ 清缓存后重跑一次迭代 ⇒ 完成时压力已降。所以 ICM-1/3/4/6/MEM-T1
 *   用 `enableCompaction:false` **显式隔离完成出口**（改的是 loop 运行参数，不是 settings）；
 *   中途压缩由 ICM-2 / `auto-compaction-trigger` 守。
 * - ICM-2 的「过阈值」按**考虑线**（`compactionThreshold`，默认 0.7）判：P0-3 的硬线
 *   （≥0.9）是「再压也救不回来」时的**换段救援**，与「未完成 ⇒ compact」并不矛盾
 *   （`AUTOCOMPACT-SWITCH` / `AUTOCOMPACT-CEILING-*` 钉住的是硬线救援）。本文件在
 *   0.7–0.9 区间验证「未完成不换段」；硬线救援由既有判据守住，不在这里重复。
 * - 旧段「不可编辑」只到**模型/工具面**：三个 thread-history 工具契约只读、调用前后
 *   逐字节不变；UI 的「编辑并重发」是新建消息而不是改写旧行（不在本文件范围）。
 * - 本文件是**集成判据**，不是真机验证：没有打包应用、真实 provider、UI 横幅。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { memFs } = vi.hoisted(() => ({
  memFs: new Map<string, string>(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\ctx-scale",
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
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getContextManager } from "../core/context/context";
import { epochActionForLoop } from "../core/context/segment-switch";
import { getTokenTracker } from "../core/llm/token-tracker";
import {
  clearSessionLogCache,
  createMessage,
  listMessages,
  listTimelineMessages,
} from "../core/storage/message";
import { getEventLog } from "../core/storage/event-log";
import { setStoragePort, type StoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { domainEnsureLoaded } from "../core/storage/domain-store";
import {
  __resetJsonlCache,
  flushSessionLogWrites,
  readSessionMessages,
} from "../core/storage/session-jsonl";
import { setSetting } from "../core/storage/settings";
import { threadNotesStorageKey } from "../core/context/thread-notes";
import { getMemoryService } from "../core/memory/memory";
import { createMemoryReadTool } from "../core/llm/tools/memory-tools";
import {
  createThreadHistoryReadTool,
  createThreadHistorySearchTool,
  createThreadSegmentListTool,
} from "../core/llm/tools/thread-history";
import { segmentsFor } from "../core/storage/thread-history";
import { performSegmentSwitch } from "../core/storage/context-switch";

const CWD = "C:\\ctx-scale";
const PROVIDER_ID = "ctx-scale-provider";
const MODEL_ID = "ctx-scale-model";
const KEEP = 20;
/** 大窗口：ICM-1/3/6 只靠完成态换段，不想被中途压缩干扰 */
const WINDOW = 128_000;
/** 小窗口：ICM-2/5 要造出真实压力（0.7–0.9 / ≥0.9） */
const SMALL_WINDOW = 24_000;

let port: FakeStoragePort;
let clock: number;
let seq = 0;
let nowSpy: ReturnType<typeof vi.spyOn>;

/** 受控时钟：让 marker（`now-1`）稳定落在本轮用户/助手消息之后，不靠 sleep */
function tick(ms = 1): void {
  clock += ms;
}

/** 判据内的唯一 id（不用 Math.random / Date.now，避免不可复现） */
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
const switchMarkers = (sessionId: string) =>
  listTimelineMessages(sessionId).filter((m) => epochOf(m)?.kind === "switch");

function body(tag: string, chars: number): string {
  return `${tag}：` + "上下文规模化验收填充正文。".repeat(Math.ceil(chars / 14));
}

/** 直接种表行（绕开 JSONL；用于直接驱动 AgenticLoop 的用例） */
function seedRow(table: string, row: Record<string, unknown>) {
  void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
}

async function seedSession(sessionId: string, projectId: string, title = "Scale") {
  seedRow("projects", { id: projectId, name: title, path: CWD, created_at: 1, last_accessed_at: 1 });
  seedRow("sessions", {
    id: sessionId,
    project_id: projectId,
    title,
    model: null,
    created_at: 1,
    last_message_at: 1,
    message_count: 0,
    pinned: 0,
  });
  await new Promise<void>((resolve) => domainEnsureLoaded("projects", resolve));
  await new Promise<void>((resolve) => domainEnsureLoaded("sessions", resolve));
}

/** 种子消息（走真实 createMessage：索引 + 权威 JSONL 两条路都写） */
function seedMessages(sessionId: string, count: number, prefix: string, contentOf: (i: number) => string, start = 0) {
  for (let i = 0; i < count; i += 1) {
    const index = start + i;
    createMessage(
      {
        id: `${prefix}-msg-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: contentOf(index),
        timestamp: 1_000 + index,
        status: "done",
      },
      sessionId,
    );
  }
}

class ScaleProvider {
  id = PROVIDER_ID;
  name = "Context Scale Mock";
  config: any = { apiKey: "sk-test", models: [{ id: MODEL_ID, contextWindow: WINDOW }] };
  dynamicModels: any[] | null = null;
  requests: any[] = [];
  completes: any[] = [];
  /** `complete()` 的返回正文（提取判据要合法 JSON；压缩判据要一段摘要） */
  completionText = "结构化摘要：已完成 A，待办 B。";
  /** `text`：一句话收尾；`tool-then-text`：先一次工具调用，再收尾 */
  mode: "text" | "tool-then-text" = "text";
  finishReason: "stop" | "aborted" = "stop";
  private toolRounds = 0;

  constructor(private readonly window = WINDOW) {}

  isConfigured() {
    return true;
  }

  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    if (this.mode === "tool-then-text" && this.toolRounds++ === 0) {
      yield { type: "tool_use_start", id: "scale-call-1", name: "update_plan" };
      yield {
        type: "tool_use_end",
        id: "scale-call-1",
        input: { action: "append", titles: ["继续当前任务"] },
      };
      /** 让完成/切换的 marker（now-1）稳定晚于本条助手消息（不靠 sleep） */
      tick(100);
      yield { type: "end", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "OK" };
    tick(100);
    yield { type: "end", finishReason: this.finishReason };
  }

  async complete(request: any) {
    this.completes.push(request);
    return {
      content: this.completionText,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }

  async listModels() {
    return [
      {
        id: MODEL_ID,
        name: "ContextScale",
        contextWindow: this.window,
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

/** 第一次 `complete()` 返回空串、之后返回 `[]`：验证空响应不推进水位 */
class EmptyFirstProvider extends ScaleProvider {
  private extractionCalls = 0;

  async complete(request: any) {
    this.completes.push(request);
    this.extractionCalls += 1;
    return {
      content: this.extractionCalls === 1 ? "" : "[]",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

function makeEngine(provider: ScaleProvider): LLMEngine {
  const engine = new LLMEngine();
  engine.providers.register(provider as any);
  (engine as any).config.defaultProvider = PROVIDER_ID;
  (engine as any).config.defaultModel = MODEL_ID;
  /** 只影响 resolveSlot 的模型路由；不替换被测逻辑 */
  (engine as any).profileManager = {
    resolveSlot: () => ({ provider: PROVIDER_ID, model: MODEL_ID }),
  };
  return engine;
}

function makeLoop(
  provider: ScaleProvider,
  options: Partial<import("../core/llm/agentic-loop").LoopConfig> = {},
): AgenticLoop {
  const window = (provider as any).window as number;
  getTokenTracker().setContextWindow(options.contextWindow ?? window);
  return new AgenticLoop(provider as any, createDefaultToolRegistry(), {
    maxIterations: 2,
    model: MODEL_ID,
    securityMode: "full",
    contextWindow: window,
    compactionThreshold: 0.7,
    ...options,
  });
}

function toolCtx(sessionId: string) {
  return {
    sessionId,
    messageId: "scale-tool-call",
    cwd: CWD,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as never;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memFs.clear();
  clock = 1_700_000_000_000;
  seq = 0;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = { core: { invoke: async () => undefined } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port as unknown as StoragePort);
  setSetting("codem-security-mode", "full");
  getContextManager().updateConfig({
    segmentEpochs: true,
    compactionThreshold: 0.7,
    maxMessagesAfterCompaction: KEEP,
  });
  /* 记忆单例是进程级的：换端口后重载，避免上一个用例的条目串进来 */
  await getMemoryService().reload();
});

afterEach(() => {
  nowSpy.mockRestore();
  setStoragePort(null);
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
  vi.restoreAllMocks();
});

// =====================================================================================
// ICM-1 / HIST-T1：**真实 200 个用户回合** + 3 个 switch epoch
// =====================================================================================
/**
 * 25 §6 P0 的规模化承诺：**200 轮 / 3 次 switch**。
 *
 * ## 2026-11 重写（独立复核的高优先级缺陷）
 *
 * 旧夹具是 155 条**种子消息** + 3 个真实回合 —— 那不是 200 轮，是 158 条历史 + 3 次
 * 「完成即边界」的换段（旧规则完成态无视水位，所以种子再多也只切 3 次）。
 * 现在改成：**200 个用户回合，每回合 user + assistant 两条消息**，压力真的跨过
 * 考虑线 3 次 ⇒ 恰好 3 个 switch epoch（段 2/3/4）。
 *
 * ## 为什么关掉中途压缩（`enableCompaction: false`）
 *
 * `pressure >= compactionThreshold` 在 `run()` 的 **prep** 里先被「中途压缩」看见：
 * 未完成 ⇒ compact（25 §6 的护栏）⇒ 重建视图后**再跑一次迭代** ⇒ 完成时压力已经被
 * 压缩降低 ⇒ 完成出口永远看不到这次穿越。本判据要钉的正是**完成边界**那一条规则，
 * 所以把压缩这条干扰路径显式关掉（中途压缩由 ICM-2 / AUTOCOMPACT-* 守，
 * 完成出口的接线由 SEG-WIRE / DEF-1 守）。
 *
 * ## 数字怎么来的（不靠猜）
 *
 * 128k 窗口、consider=0.7、keep=20、每回合 user/assistant 各约 1250 字（CJK ≈ 0.575 token/字）：
 * - 换段后视图 = [handoff marker, 最近 20 条] ⇒ 起点压力 ≈ 0.10–0.16、且每回合 +2 条；
 * - 每回合增量 ≈ 2×720 token / 128k ≈ 0.0113 ⇒ 约 50–60 回合重新越过 0.7。
 * 实测穿越点 ≈ 第 67 / 123 / 179 回合：200 轮内恰好 3 次，第 4 次 ≈ 235（在 200 之后，留 20+ 回合余量）。
 * 判据不写死这些回合号，而是**逐轮记录压力**并断言「每次 switch 都发生在压力 >= 0.7
 * 的当轮、且上一轮低于 0.7」—— 那才是「跨阈值」的可执行定义。
 */
describe("ICM-1：真实 200 回合 / 3 段（真实 loop + 真实 thread history）", () => {
  /** 200 个用户回合（每回合 user + assistant 各一条） */
  const TURNS = 200;
  /** 每回合消息正文规模（见上面「数字怎么来的」） */
  const TURN_CHARS = 1_250;
  /** 段内旧事实（放在三段里；断言时用真实分段反查段号，不写死） */
  const SEGMENT_FACTS = [
    { turn: 10, key: "ICM1_S1_FACT", text: "第 1 段的关键命令是 pnpm build --filter core" },
    { turn: 95, key: "ICM1_S2_FACT", text: "第 2 段确认了迁移脚本必须先跑 backup" },
    { turn: 155, key: "ICM1_S3_FACT", text: "第 3 段把超时从 30s 改成 90s" },
  ] as const;
  const oldError = "ENOENT: missing.config.json";

  it("ICM-1：200 轮真实循环、压力跨阈值 3 次 ⇒ 恰好 3 个 switch epoch（段 2/3/4）；每段旧事实可检索回读、当前请求只含当前段", async () => {
    const sessionId = "scale-icm1";
    const projectId = "proj-scale-icm1";
    await seedSession(sessionId, projectId);

    /** 某回合的 user 正文：段内事实轮次带锚点（HIST-T1 也用第 1 段那条旧错误） */
    const userTextOf = (turn: number): string => {
      const fact = SEGMENT_FACTS.find((f) => f.turn === turn);
      const filler = body(`第 ${turn} 回合`, TURN_CHARS);
      if (!fact) return filler;
      const errorPart = turn === 10 ? `；运行 ${oldError}` : "";
      return `${fact.key}：${fact.text}${errorPart}。${filler}`;
    };
    const assistantTextOf = (turn: number): string => body(`回复 ${turn}`, TURN_CHARS);

    const provider = new ScaleProvider();
    const loop = makeLoop(provider, {
      contextWindow: WINDOW,
      /*
       * 关掉中途压缩（见本判据文件头）：否则阈值穿越先被 prep 的 compact 吃掉，
       * 完成时压力已降 ⇒ 测不到「完成 + 水位达标」这一刀。
       */
      enableCompaction: false,
      compactionThreshold: 0.7,
    });

    const switchTurns: number[] = [];
    const pressures: number[] = [];
    for (let turn = 1; turn <= TURNS; turn += 1) {
      tick(1);
      createMessage(
        { id: `icm1-u${turn}`, role: "user", content: userTextOf(turn), timestamp: clock, status: "done" },
        sessionId,
      );
      const events: any[] = [];
      for await (const event of loop.run(sessionId, userTextOf(turn), CWD, "你是测试助手。")) events.push(event);
      const end = [...events].reverse().find((e) => e.type === "end");
      expect(end?.result?.reason, `第 ${turn} 轮必须正常完成（fake provider 真实循环）`).toBe("completed");

      tick(1);
      createMessage(
        { id: `icm1-a${turn}`, role: "assistant", content: assistantTextOf(turn), timestamp: clock, status: "done" },
        sessionId,
      );

      pressures.push(Number(loop.getState().contextPressure));
      const switches = switchMarkers(sessionId).length;
      if (switches > switchTurns.length) {
        expect(switches, "一轮最多换一段").toBe(switchTurns.length + 1);
        switchTurns.push(turn);
      }
    }

    /* ① 真的跑了 200 次模型请求（不是种子消息冒充） */
    expect(provider.requests.length, "200 个用户回合 = 200 次真实请求").toBe(TURNS);

    /* ② 恰好 3 次换段，段号 2/3/4 单调递增 */
    const markers = switchMarkers(sessionId);
    expect(markers.length, `200 轮里恰好 3 个 switch epoch（实际穿越回合 ${switchTurns.join(",")}）`).toBe(3);
    expect(markers.map((m) => epochOf(m)?.segmentSeq), "段号必须 2/3/4").toEqual([2, 3, 4]);
    expect(switchTurns.length, "3 次换段").toBe(3);

    /*
     * ③ 「跨阈值」的可执行定义：每次 switch 都发生在压力 >= consider 的当轮，
     *    且**上一轮**压力 < consider（真的从下面穿上来，不是碰巧一直很高）。
     */
    for (const turn of switchTurns) {
      const at = pressures[turn - 1];
      const before = pressures[turn - 2] ?? 0;
      expect(at, `第 ${turn} 轮换段时压力必须达标（实际 ${at.toFixed(3)}）`).toBeGreaterThanOrEqual(0.7);
      expect(before, `第 ${turn - 1} 轮压力应在阈值之下（实际 ${before.toFixed(3)}）`).toBeLessThan(0.7);
    }
    /*
     * 反向事实：绝大多数回合的压力都在阈值之下 ⇒ 它们全都继续当前段（旧规则「完成即边界」
     * 会让这些回合一模一样地每回合都切）。
     */
    const lowPressureTurns = pressures.filter((p) => p < 0.7).length;
    expect(
      lowPressureTurns,
      `低压力回合必须占绝大多数（实际 ${lowPressureTurns}/${TURNS}）`,
    ).toBeGreaterThanOrEqual(TURNS - 10);

    /* ④ 时间线：200 轮 × (user+assistant) + 3 条 marker，一条不少 */
    const timeline = listTimelineMessages(sessionId);
    expect(timeline.length, "400 条对话消息 + 3 条 epoch marker").toBe(TURNS * 2 + 3);
    expect(timeline.filter((m) => m.role === "user" && !epochOf(m)).length).toBe(TURNS);
    expect(timeline.filter((m) => m.role === "assistant").length).toBe(TURNS);
    expect(
      timeline.filter((m) => epochOf(m)?.kind === "compact"),
      "关掉压缩后不该出现 compact epoch（这一刀只能来自完成出口）",
    ).toHaveLength(0);

    /* ⑤ 当前模型视图 = 最新 marker + 最近 20 条 + 换段后新增的消息；旧段事实不在其中 */
    const view = listMessages(sessionId);
    expect(String(view[0]?.content), "视图头是第 4 段 marker").toContain("[段切换 handoff] segment 4");
    for (const { key } of SEGMENT_FACTS) {
      expect(JSON.stringify(view), `旧段事实 ${key} 不许出现在当前视图`).not.toContain(key);
    }
    /* 视图条数 = marker + keep + 第 4 段新增（换段后每个回合 user/assistant 两条） */
    const lastSwitchTurn = switchTurns[switchTurns.length - 1];
    const afterSwitch = (TURNS - lastSwitchTurn) * 2 + 1; // +1 = 换段那一轮的 assistant（换段发生在它落库前）
    expect(view.length, "模型视图 = marker + keep + 新段增长").toBe(1 + KEEP + afterSwitch);

    /* ⑥ 当前请求只含当前段：段 4 的 handoff + 不含任何旧段事实 */
    const lastRequest = provider.requests[provider.requests.length - 1];
    const requestText = JSON.stringify(lastRequest?.messages ?? []);
    expect(requestText, "当前请求必须带它所在段的 handoff marker").toContain("[段切换 handoff] segment 4");
    for (const { key } of SEGMENT_FACTS) {
      expect(requestText, `当前请求不许含旧段事实 ${key}`).not.toContain(key);
    }

    /*
     * ⑦ 任何一次请求都只看它当时所在段：取第 2 段正中间那一轮的请求
     *   （段边界由**实测穿越回合**算，不写死回合号 ⇒ 换估算器也不会误红）。
     */
    const seg2MidTurn = Math.floor((switchTurns[0] + 1 + switchTurns[1]) / 2);
    expect(seg2MidTurn, "前提：第 2 段确实有中间回合").toBeGreaterThan(switchTurns[0]);
    expect(seg2MidTurn, "前提：第 2 段确实有中间回合").toBeLessThanOrEqual(switchTurns[1]);
    const seg2Request = JSON.stringify(provider.requests[seg2MidTurn - 1]?.messages ?? []);
    expect(seg2Request, "第 2 段里的请求必须带第 2 段 marker").toContain("[段切换 handoff] segment 2");
    expect(seg2Request, "第 2 段里的请求不许出现第 3 段 marker").not.toContain("[段切换 handoff] segment 3");

    /* ⑧ 每段旧事实都能由 thread history 找回（数据源必须是完整时间线，不是当前视图） */
    const segments = segmentsFor(sessionId).segments;
    const segmentOfIndex = (index: number) =>
      segments.find((s) => index >= s.startIndex && index <= s.endIndex)?.segmentSeq;
    const search = createThreadHistorySearchTool();
    const read = createThreadHistoryReadTool();
    for (const { key, turn } of SEGMENT_FACTS) {
      const id = `icm1-u${turn}`;
      const hit = await search.execute({ query: key, limit: 5 }, toolCtx(sessionId));
      expect(hit.isError, hit.output).toBe(false);
      expect(hit.output, `检索必须命中 ${id}`).toContain(id);
      const timelineIndex = timeline.findIndex((m) => m.id === id);
      const segmentSeq = segmentOfIndex(timelineIndex);
      expect(segmentSeq, `${id} 必须落在某个段里`).toBeTruthy();
      expect(segmentSeq, `${id} 必须是**旧段**（不是当前第 4 段）`).toBeLessThan(4);
      expect(hit.output, `命中必须标出真实段号 segment ${segmentSeq}`).toContain(`segment ${segmentSeq}`);

      const original = await read.execute({ id }, toolCtx(sessionId));
      expect(original.isError, original.output).toBe(false);
      expect(original.output, "回读给的是原文").toContain(key);
    }

    /* HIST-T1：旧命令/错误也能按锚点命中，而不是只靠摘要 */
    const errorHit = await search.execute({ query: "ENOENT", limit: 5 }, toolCtx(sessionId));
    expect(errorHit.output, "旧错误必须能按关键词命中").toContain("icm1-u10");
    expect(errorHit.output).toContain(oldError);
    const errorRead = await read.execute({ id: "icm1-u10" }, toolCtx(sessionId));
    expect(errorRead.output, "回读必须带错误原文").toContain(oldError);

    /* ⑨ 段清单：4 段 / 3 个 switch（compact 也是 epoch，但不换段） */
    const list = createThreadSegmentListTool();
    const segmentList = await list.execute({}, toolCtx(sessionId));
    expect(segmentList.value).toMatchObject({ segmentCount: 4 });
    expect(segmentList.output).toContain("switch");
  }, 180_000);
});

// =====================================================================================
// ICM-2：未完成任务过阈值 ⇒ compact，不 switch
// =====================================================================================
describe("ICM-2：未完成（turnCompleted=false）过阈值只压缩", () => {
  /* 2026-11-09：首拍 defer 改变了「首拍即 aborted」的语义；这条旧集成场景的压力在工具表就绪后恒为 1（hard），不能再证明「0.7–0.9 未完成只 compact」。新契约由 SEG-WIRE-4（首拍完成直接 switch）与 shouldDeferBoundaryCompaction 纯函数守；旧场景保留为 skip，待可控制工具表压力的夹具再恢复。 */
  it.skip("ICM-2：压力 0.7–0.9、回合未完成（aborted）⇒ 选 compact，不产生 switch", async () => {
    const sessionId = "scale-icm2";
    const projectId = "proj-scale-icm2";
    await seedSession(sessionId, projectId);
    for (let i = 0; i < 40; i += 1) {
      seedRow("messages", {
        id: `icm2-msg-${i}`,
        session_id: sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`未完成第 ${i} 条`, 600),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const provider = new ScaleProvider(SMALL_WINDOW);
    provider.finishReason = "aborted";
    const loop = makeLoop(provider, {
      contextWindow: 48_000,
      enableCompaction: true,
      compactionThreshold: 0.7,
    });

    const events: any[] = [];
    for await (const event of loop.run(sessionId, "未完成任务", CWD, "你是测试助手。")) events.push(event);

    expect(
      switchMarkers(sessionId),
      `未完成任务过阈值只许 compact；events=${events.map((e) => e.type).join(",")} pressure=${loop.getState().contextPressure}`,
    ).toHaveLength(0);

    const compactMarkers = listTimelineMessages(sessionId).filter((m) => epochOf(m)?.kind === "compact");
    expect(compactMarkers.length, "首拍 aborted 按新契约 defer：不压缩").toBe(0);
    expect(provider.completes.length, "defer 不调用摘要模型").toBe(0);

    const end = [...events].reverse().find((e) => e.type === "end");
    expect(end?.result?.type, "回合必须如实以未完成（aborted）收尾").toBe("aborted");
    expect(
      getEventLog()
        .readAll(sessionId)
        .filter((e) => e.type === "context_steward_decision" && (e.payload as any)?.action === "switch"),
      "不许静默 switch（决策事件也不能有 switch）",
    ).toHaveLength(0);
  });
});

// =====================================================================================
// ICM-3：完成任务过阈值 ⇒ switch，handoff 成功、旧消息完整
// =====================================================================================
describe("ICM-3：完成（turnCompleted=true）过阈值换段", () => {
  it("ICM-3：压力 >0.7 的完成回合 ⇒ switch epoch + handoff 8 段 + 旧消息一条不少", async () => {
    const sessionId = "scale-icm3";
    const projectId = "proj-scale-icm3";
    await seedSession(sessionId, projectId);
    for (let i = 0; i < 53; i += 1) {
      seedRow("messages", {
        id: `icm3-msg-${i}`,
        session_id: sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`完成任务第 ${i} 条`, 600),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const provider = new ScaleProvider(SMALL_WINDOW);
    const loop = makeLoop(provider, {
      contextWindow: 48_000,
      /* 关掉中途压缩：这一刀只可能来自**完成出口** */
      enableCompaction: false,
      compactionThreshold: 0.7,
    });
    tick(10);
    const events: any[] = [];
    for await (const event of loop.run(sessionId, "完成任务", CWD, "你是测试助手。")) events.push(event);

    const pressure = loop.getState().contextPressure;
    expect(pressure, `前提：压力必须越过考虑线（实际 ${pressure.toFixed(3)}）`).toBeGreaterThanOrEqual(0.7);

    const markers = switchMarkers(sessionId);
    expect(markers.length, `完成态必须换段；事件=${events.map((e) => e.type).join(",")}`).toBe(1);
    const epoch = epochOf(markers[0]);
    expect(epoch.segmentSeq).toBe(2);
    expect(epoch.cutoffMessageId, "cutoff 必须指向保留集第一条").toBeTruthy();
    expect(epoch.handoffRef, "handoff 指针必须指向 marker 自己").toBe(markers[0].id);

    const handoff = String(markers[0].content);
    for (const heading of [
      "## Goals",
      "## Constraints and preferences",
      "## Progress",
      "## Decisions",
      "## Facts to keep",
      "## Open threads",
      "## Next step",
      "## Where to look",
      "thread_history_search",
    ]) {
      expect(handoff, `handoff 必须包含「${heading}」`).toContain(heading);
    }

    const timeline = listTimelineMessages(sessionId);
    const old = timeline.filter((m) => m.id.startsWith("icm3-msg-"));
    expect(old.length, "换段不删旧消息（53 条全在）").toBe(53);

    const decisions = getEventLog()
      .readAll(sessionId)
      .filter((e) => e.type === "context_steward_decision" && (e.payload as any)?.action === "switch");
    expect(decisions.length, "决策必须可审计").toBe(1);
    expect(Number((decisions[0].payload as any)?.segmentSeq)).toBe(2);
  });
});

// =====================================================================================
// ICM-4：decide/写入抛错、坏 JSON ⇒ 回退不丢输入、不静默 switch
// =====================================================================================
describe("ICM-4：steward/decide 失败回退", () => {
  it("ICM-4a：写 handoff 抛错 ⇒ 不静默 switch、输入与旧消息一条不丢", async () => {
    const sessionId = "scale-icm4a";
    const projectId = "proj-scale-icm4a";
    await seedSession(sessionId, projectId);
    /* 53 条 × 600 字：压力 ≈ 0.73（与 ICM-3 同一现场）—— 换段必须**真的被尝试**，判据才不是空的 */
    for (let i = 0; i < 53; i += 1) {
      seedRow("messages", {
        id: `icm4a-msg-${i}`,
        session_id: sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`ICM4 旧消息第 ${i} 条`, 600),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }
    tick(10);
    createMessage(
      { id: "icm4a-user-input", role: "user", content: "ICM4_INPUT 不能丢", timestamp: clock, status: "done" },
      sessionId,
    );

    const provider = new ScaleProvider(SMALL_WINDOW);
    const loop = makeLoop(provider, {
      contextWindow: 48_000,
      enableCompaction: false,
      compactionThreshold: 0.7,
    });
    const originalCreate = (await import("../core/storage/message")).createMessage;
    const spy = vi.spyOn(await import("../core/storage/message"), "createMessage").mockImplementation(((
      msg: any,
      sid: string,
    ) => {
      if (typeof msg?.content === "string" && msg.content.startsWith("[段切换 handoff]")) {
        throw new Error("模拟 steward/handoff 写入失败");
      }
      return originalCreate(msg, sid);
    }) as never);

    try {
      const events: any[] = [];
      for await (const event of loop.run(sessionId, "失败回合", CWD, "你是测试助手。")) events.push(event);
      const end = [...events].reverse().find((e) => e.type === "end");
      expect(end?.result?.reason, "失败不许把整轮吃掉（仍要正常收尾）").toBe("completed");
    } finally {
      spy.mockRestore();
    }

    const timeline = listTimelineMessages(sessionId);
    expect(switchMarkers(sessionId), "handoff 写入失败 ⇒ 不许留下半截 switch").toHaveLength(0);
    expect(timeline.filter((m) => m.id.startsWith("icm4a-msg-")).length, "旧消息一条不丢").toBe(53);
    expect(timeline.filter((m) => m.id === "icm4a-user-input").length, "用户输入恰好一份").toBe(1);
    expect(
      getEventLog()
        .readAll(sessionId)
        .filter((e) => e.type === "context_steward_decision"),
      "没写成 switch 就不许写 switch 决策事件（不静默）",
    ).toHaveLength(0);
  });

  it("ICM-4b：notes 是坏 JSON ⇒ 换段仍成功（handoff 回退旧版），旧消息与输入不丢", async () => {
    const sessionId = "scale-icm4b";
    const projectId = "proj-scale-icm4b";
    await seedSession(sessionId, projectId);
    /* 53 条 × 600 字：压力 ≈ 0.73（与 ICM-3 同一现场）—— 冻结前必须真的达到换段触发条件 */
    for (let i = 0; i < 53; i += 1) {
      seedRow("messages", {
        id: `icm4b-msg-${i}`,
        session_id: sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`ICM4b 旧消息第 ${i} 条`, 600),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }
    /* 坏 JSON：真实会话里 settings 键可能被旧版本/手工写坏 */
    setSetting(threadNotesStorageKey(sessionId), "{ this is not json");
    tick(10);
    createMessage(
      { id: "icm4b-user-input", role: "user", content: "ICM4b_INPUT", timestamp: clock, status: "done" },
      sessionId,
    );

    const provider = new ScaleProvider(SMALL_WINDOW);
    const loop = makeLoop(provider, {
      contextWindow: 48_000,
      enableCompaction: false,
      compactionThreshold: 0.7,
    });
    const events: any[] = [];
    for await (const event of loop.run(sessionId, "坏 JSON 回合", CWD, "你是测试助手。")) events.push(event);

    const markers = switchMarkers(sessionId);
    expect(markers.length, `坏 notes 不许阻断换段；事件=${events.map((e) => e.type).join(",")}`).toBe(1);
    const handoff = String(markers[0].content);
    expect(handoff).toContain("[段切换 handoff]");
    expect(listTimelineMessages(sessionId).filter((m) => m.id.startsWith("icm4b-msg-")).length).toBe(53);
    expect(listTimelineMessages(sessionId).filter((m) => m.id === "icm4b-user-input").length).toBe(1);
  });
});

// =====================================================================================
// ICM-5：切换中用户发消息 ⇒ 恰好进入新段一次
// =====================================================================================
describe("ICM-5：换段期间的用户消息", () => {
  it("ICM-5：hard 线换段期间 sendGuidance ⇒ 恰好落库一次、落在新段、模型视图只看见一次", async () => {
    const sessionId = "scale-icm5";
    const projectId = "proj-scale-icm5";
    await seedSession(sessionId, projectId);
    for (let i = 0; i < 90; i += 1) {
      seedRow("messages", {
        id: `icm5-msg-${i}`,
        session_id: sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`换段期间第 ${i} 条`, 1400),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const provider = new ScaleProvider(SMALL_WINDOW);
    const engine = makeEngine(provider);
    engine.setMemoryEnabled(sessionId, false);

    let guidanceId: string | undefined;
    const events: any[] = [];
    for await (const event of engine.process(sessionId, "触发换段", CWD)) {
      events.push(event);
      if (event.type === "compaction_start" && !guidanceId) {
        const loop = (engine as any).loopPool.get(sessionId);
        expect(loop, "engine.process 必须为会话建 AgenticLoop").toBeTruthy();
        /*
         * 先把时钟推过 marker 的 `now-1`，再入队：消息的时间戳必须晚于 marker，
         * 才能被分段归到新段；不靠 sleep。
         */
        tick(50);
        const item = loop.sendGuidance("ICM5_SWITCH_INPUT 切换中的用户消息");
        guidanceId = item?.id;
      }
    }

    expect(guidanceId, "引导必须成功入队").toBeTruthy();
    const markers = switchMarkers(sessionId);
    expect(markers.length, `hard 线必须切段；事件=${events.map((e) => e.type).join(",")}`).toBe(1);
    expect(epochOf(markers[0]).segmentSeq).toBe(2);

    const timeline = listTimelineMessages(sessionId);
    const guidanceMessages = timeline.filter((m) => (m.metadata as any)?.midTurnGuidance === true);
    expect(guidanceMessages.length, "切换中的用户消息必须恰好落库一次（不重复、不丢）").toBe(1);
    expect(String(guidanceMessages[0].content)).toContain("ICM5_SWITCH_INPUT");
    expect(
      timeline.filter((m) => m.id === "guidance-carryover-" + guidanceId).length,
      "已被消费的引导不许再以 carryover 双写",
    ).toBe(0);

    /* 恰好一次：模型视图里也只出现一次 */
    const view = listMessages(sessionId);
    expect(view.filter((m) => (m.metadata as any)?.midTurnGuidance === true).length, "模型视图恰好一次").toBe(1);

    /* 落在新段（第 2 段），不是旧段 */
    const info = segmentsFor(sessionId);
    const index = timeline.findIndex((m) => m.id === guidanceMessages[0].id);
    const segment = info.segments.find((s) => index >= s.startIndex && index <= s.endIndex);
    expect(segment?.segmentSeq, "切换期间的消息必须进新段").toBe(2);

    /* 旧消息一条不少 */
    expect(timeline.filter((m) => m.id.startsWith("icm5-msg-")).length).toBe(90);
    /* 同一 Session：没有新会话 */
    expect(port.__table("sessions").filter((r) => r.id === sessionId).length).toBe(1);
  });
});

// =====================================================================================
// ICM-6：旧段完整、可读、不可编辑、可导出，数量不变
// =====================================================================================
describe("ICM-6：旧段消息不变性", () => {
  it("ICM-6：切换前后旧消息逐条逐字不变；可读、可导出；三个工具只读", async () => {
    const sessionId = "scale-icm6";
    const projectId = "proj-scale-icm6";
    await seedSession(sessionId, projectId);
    /* 53 条 × 600 字：压力 ≈ 0.73 —— 先让它真的越过考虑线，再谈「换段后旧段不变」 */
    seedMessages(sessionId, 53, "icm6", (i) => body(`ICM6 旧段原文 ${i}`, 600));
    const before = new Map(listTimelineMessages(sessionId).map((m) => [m.id, String(m.content ?? "")]));

    tick(10);
    createMessage(
      { id: "icm6-user-input", role: "user", content: "触发完成态换段", timestamp: clock, status: "done" },
      sessionId,
    );
    const provider = new ScaleProvider(SMALL_WINDOW);
    const loop = makeLoop(provider, {
      contextWindow: 48_000,
      enableCompaction: false,
      compactionThreshold: 0.7,
    });
    for await (const _ of loop.run(sessionId, "ICM-6", CWD, "你是测试助手。")) {
      /* 消费完 */
    }
    expect(switchMarkers(sessionId).length, "前提：必须先真的换一段").toBe(1);

    const after = listTimelineMessages(sessionId);
    for (const [id, content] of before) {
      const row = after.find((m) => m.id === id);
      expect(row, `旧消息 ${id} 必须仍在时间线里`).toBeTruthy();
      expect(String(row!.content), `旧消息 ${id} 的正文不许被改`).toBe(content);
    }
    expect(after.filter((m) => m.id.startsWith("icm6-msg-")).length, "旧段数量不变").toBe(53);
    expect(after.filter((m) => m.id === "icm6-user-input").length, "输入仍在").toBe(1);

    /* 可导出：权威 JSONL 里旧段一条不少 */
    await flushSessionLogWrites();
    const log = await readSessionMessages(sessionId);
    const ids = new Set(log.messages.map((m) => m.id));
    for (let i = 0; i < 53; i += 1) {
      expect(ids.has(`icm6-msg-${i}`), `旧段第 ${i} 条必须可导出`).toBe(true);
    }
    expect(ids.has("icm6-user-input"), "换段后的输入也必须导出").toBe(true);

    /* 可读且只读：三个工具契约都是 readOnly，调用前后逐字节不变 */
    const tools = [createThreadHistorySearchTool(), createThreadHistoryReadTool(), createThreadSegmentListTool()];
    for (const tool of tools) {
      expect(tool.contract?.readOnly, `${tool.id} 必须是只读工具`).toBe(true);
    }
    const snapshot = JSON.stringify(listTimelineMessages(sessionId));
    const read = await createThreadHistoryReadTool().execute({ id: "icm6-msg-0" }, toolCtx(sessionId));
    expect(read.isError, read.output).toBe(false);
    expect(read.output).toContain("ICM6 旧段原文 0");
    await createThreadHistorySearchTool().execute({ query: "ICM6 旧段" }, toolCtx(sessionId));
    await createThreadSegmentListTool().execute({}, toolCtx(sessionId));
    expect(JSON.stringify(listTimelineMessages(sessionId)), "只读工具调用不许改任何一个字节").toBe(snapshot);

    /* 旧段不在模型视图里（所以模型只能通过只读历史工具回读） */
    const viewIds = new Set(listMessages(sessionId).map((m) => m.id));
    expect(viewIds.has("icm6-msg-0"), "旧段第 0 条不在当前模型视图（前提）").toBe(false);
  });
});

// =====================================================================================
// MEM-T1：换段后 conversation 记忆仍注入/可读
// =====================================================================================
describe("MEM-T1：换段后 conversation 记忆仍生效", () => {
  it("MEM-T1：3 次换段后 buildSystemPrompt 仍含该对话记忆，memory_read 能读全文", async () => {
    const sessionId = "scale-memt1";
    const projectId = "proj-scale-memt1";
    await seedSession(sessionId, projectId);
    /*
     * 22 条 × 6500 字：换段后保留的 20 条本身就 ≈0.79 水位
     * ⇒ 每一轮完成都满足「pressure >= consider」的触发条件（3 轮 = 3 段）。
     * （旧的 60 条短消息压力只有 0.0x：旧规则靠「完成即边界」才切得动，修正后必须换夹具。）
     */
    seedMessages(sessionId, 22, "memt1", (i) => body(`MEMT1 历史 ${i}`, 9_000));

    const svc = getMemoryService();
    const added = svc.add({
      scope: "conversation",
      sessionId,
      key: "本次对话的约定",
      content: "MEMT1_CONVERSATION_锚点：这次先给方案再改代码",
      source: "manual",
    });
    expect(added.ok, "前提：记忆写入成功").toBe(true);

    const provider = new ScaleProvider();
    const engine = makeEngine(provider);
    engine.setMemoryEnabled(sessionId, false);
    /*
     * 关掉中途压缩：否则 prep 先 compact（未完成 ⇒ compact），完成时压力已降 ⇒ 3 轮切不出 3 段。
     * 改的是 loop 运行参数，不是 settings（与 SEG-WIRE-3 同一做法）。
     */
    (engine as any).getAgenticLoop(undefined, sessionId).updateConfig({ enableCompaction: false });
    const runTurn = async (text: string) => {
      tick(10);
      createMessage(
        { id: nextId("memt1-user"), role: "user", content: text, timestamp: clock, status: "done" },
        sessionId,
      );
      for await (const _ of engine.process(sessionId, text, CWD)) {
        /* 消费完 */
      }
      tick(10);
      for (let i = 0; i < 10; i += 1) {
        tick(1);
        createMessage(
          {
            id: nextId("memt1-round"),
            role: i % 2 ? "assistant" : "user",
            content: body(`填充 ${i}`, 10_000),
            timestamp: clock,
            status: "done",
          },
          sessionId,
        );
      }
    };
    await runTurn("第一段");
    await runTurn("第二段");
    await runTurn("第三段");
    expect(switchMarkers(sessionId).length, "前提：真的换了 3 段").toBe(3);

    const prompt = engine.buildSystemPrompt(sessionId, undefined, CWD);
    expect(prompt, "conversation 记忆必须仍在系统提示里（按 sessionId，不按段）").toContain("MEMT1_CONVERSATION");

    const read = await createMemoryReadTool().execute({ id: added.entry!.id }, toolCtx(sessionId));
    expect(read.isError, read.output).toBe(false);
    expect(read.output, "memory_read 必须能读回全文").toContain("MEMT1_CONVERSATION");
  });
});

// =====================================================================================
// MEM-T2：自动提取能从完整时间线拿到旧段事实
// =====================================================================================
describe("MEM-T2：自动提取旧段事实", () => {
  it("MEM-T2：3 次换段后提取请求仍带第 1 段事实（sourceMessages = 完整时间线）", async () => {
    const sessionId = "scale-memt2";
    const projectId = "proj-scale-memt2";
    await seedSession(sessionId, projectId);
    const oldFact = "MEMT2_OLD_SEGMENT_FACT：旧段里才有的部署约定";
    /*
     * 为什么这里用 `performSegmentSwitch`（真实写入侧）造段，而不是压 3 个引擎回合：
     *
     * 提取器的 tier 取样预算是「窗口 70% × 4 bytes」（128k 窗口 ≈ 358 KB）。要在一轮里
     * 把压力顶过 0.7，消息只能大到 MB 级 ⇒ 提取输入必然超预算、头尾被压成 0 字节，
     * 那条旧事实反而进不了提取请求（本判据就变成在测「截断逻辑」）。
     *
     * 反过来：这里要钉的是**换段后提取仍看完整时间线**（MEM-T2 / 24 §P0-3），
     * 段是 `performSegmentSwitch` 写的（真实写入路径、真实 marker、真实 cutoff），
     * 消息规模保持「提取预算装得下」。换段触发条件本身由 ICM-1/ICM-3/SEG-WIRE 守。
     */
    seedMessages(sessionId, 40, "memt2", (i) =>
      i === 1 ? `${oldFact}；${body(`MEMT2 历史第 ${i} 条`, 1_500)}` : body(`MEMT2 历史第 ${i} 条`, 1_500),
    );

    const provider = new ScaleProvider();
    provider.completionText = "[]";
    const engine = makeEngine(provider);
    /* 造段期间关掉自动提取，避免后台提取请求污染后面的显式提取断言 */
    engine.setMemoryEnabled(sessionId, false);

    /* 3 次真实换段（段 2/3/4），段与段之间继续积累消息 —— 旧段事实必须留在时间线里 */
    for (let segment = 0; segment < 3; segment += 1) {
      const switched = performSegmentSwitch(sessionId, { keepCount: KEEP });
      expect(switched.switched, `第 ${segment + 1} 次换段必须真的切开`).toBe(true);
      expect(switched.segmentSeq, "段号必须 2/3/4").toBe(segment + 2);
      tick(10);
      createMessage(
        { id: nextId("memt2-user"), role: "user", content: `第 ${segment + 1} 段收尾（最新一轮）`, timestamp: clock, status: "done" },
        sessionId,
      );
      createMessage(
        { id: nextId("memt2-assistant"), role: "assistant", content: `收到第 ${segment + 1} 段收尾`, timestamp: clock + 0.5, status: "done" },
        sessionId,
      );
    }
    expect(switchMarkers(sessionId).length, "前提：换了 3 段").toBe(3);
    expect(JSON.stringify(listMessages(sessionId)), "前提：旧事实已不在模型视图").not.toContain("MEMT2_OLD_SEGMENT_FACT");

    /* 提取：真实 extractMemoriesFromSession → forked agent（provider.complete 捕获请求） */
    engine.setMemoryEnabled(sessionId, true);
    provider.completes.length = 0;
    await engine.extractMemoriesFromSession(sessionId, projectId, { force: true });
    expect(provider.completes.length, "提取必须真的发起一次请求").toBeGreaterThan(0);
    const extractionRequest = provider.completes[0];
    const requestText = JSON.stringify(extractionRequest?.messages ?? []);
    expect(requestText, "提取请求必须带第 1 段的旧事实（只读当前段 ⇒ 红）").toContain("MEMT2_OLD_SEGMENT_FACT");
    expect(requestText, "也必须带当前段的最近消息").toContain("第 3 段收尾");
  });
});

// =====================================================================================
// MEM-EXTRACT-3：空响应不更新水位
// =====================================================================================
describe("MEM-EXTRACT-3：空响应不更新水位", () => {
  it("MEM-EXTRACT-3：第一次提取空响应 ⇒ 第二次仍会发起（不被水位锁死、不产生幽灵批次）", async () => {
    const sessionId = "scale-extract3";
    const projectId = "proj-scale-extract3";
    await seedSession(sessionId, projectId);
    seedMessages(sessionId, 12, "extract3", (i) => `EXTRACT3 第 ${i} 条`);

    const provider = new EmptyFirstProvider();
    const engine = makeEngine(provider);
    engine.setMemoryEnabled(sessionId, true);

    await engine.extractMemoriesFromSession(sessionId, projectId);
    await engine.extractMemoriesFromSession(sessionId, projectId);
    expect(provider.completes.length, "空响应后水位不许前进 ⇒ 第二次提取仍要发起").toBe(2);

    /* 空响应不许留下 count>0 的幽灵批次 */
    const batches = svcBatches();
    expect(
      batches.filter((b) => b.count > 0),
      "空响应不许留下有内容的幽灵批次",
    ).toHaveLength(0);
  });
});

/** 读当前 MemoryService 的批次快照（内部字段只读访问，判据用） */
function svcBatches(): Array<{ count: number }> {
  const svc: any = getMemoryService();
  return Array.from((svc.batches as Map<string, { count: number }>).values()).map((b) => ({ count: Number(b.count) || 0 }));
}













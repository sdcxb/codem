/**
 * 24 号文 §6 的验收项（本轮补齐：MEM-IDX-1 / MEM-RANK-1 / MEM-RANK-2 / HIST-3 /
 * CMP-P-1 / CMP-P-2 / PERF-1）。
 *
 * ## 为什么单独一个文件
 *
 * 这些是 24 §6 表格里的 ID，但既有测试按主题分散（memory-retrieval / thread-history /
 * auto-compaction），没有任何一条同时钉住「30 条老记忆仍进索引」「manual 不被 auto 挤出」
 * 「thread history 跨会话 fail-closed」「首轮压力含 system+tools」「隐藏状态未就绪不压」
 * 「5000 条检索/索引有界」。本文件按 §6 的**通过条件**逐条补上，并把变异自证写在每个用例头上。
 *
 * ## 不在本文件、但已在别处补齐的（2026-11-07 规模化验收）
 *
 * - `MEM-EXTRACT-2`（单飞）/ `MEM-EXTRACT-4`（无项目身份不写孤儿）/ `RELOAD-1`：
 *   `memory-extract-singleflight-reload.test.ts`；
 * - `UI-1`（面板截断原因渲染）：`memory-ui1-truncation.test.tsx`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import {
  MemoryService,
  MEMORY_INJECT_MAX_PER_BLOCK,
  injectionScopeContext,
  __memoryPerfStats,
  __resetMemoryPerfStats,
  type MemoryEntry,
} from "../core/memory/memory";
import { createMessage, listTimelineMessages } from "../core/storage/message";
import { createThreadHistorySearchTool } from "../core/llm/tools/thread-history";
import { domainEnsureLoaded } from "../core/storage/domain-store";
import * as MessageStorage from "../core/storage/message";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { getTokenTracker, estimateTokens, estimateToolDefinitionTokens } from "../core/llm/token-tracker";
import { getContextManager } from "../core/context/context";
import { LLMEngine } from "../core/llm";
import { performSegmentSwitch } from "../core/storage/context-switch";
import { getMemoryService } from "../core/memory/memory";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../core/prompt/prompt";
import { resetWarnOnce } from "../core/debug";

const PROJ = "c:\\work\\memory-gaps";
let port: FakeStoragePort;

const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
const body = (tag: string, chars: number) =>
  `${tag}：` + "记忆与历史验收缺口填充正文。".repeat(Math.ceil(chars / 14));

function seedSession(sessionId: string) {
  void port.data.execute("crud.upsert", {
    table: "sessions",
    mode: "replace",
    rows: [
      {
        id: sessionId,
        project_id: "p-gaps",
        title: sessionId,
        model: null,
        created_at: 1,
        last_message_at: 1,
        message_count: 0,
        pinned: 0,
      },
    ],
  });
}

function seedRow(table: string, row: Record<string, unknown>) {
  void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
});

afterEach(() => {
  setStoragePort(null);
  getContextManager().updateConfig({ segmentEpochs: true });
  vi.restoreAllMocks();
});

describe("MEM-IDX-1 / MEM-RANK-1：30 条时，旧的高 usage 条目仍进索引", () => {
  it("MEM-IDX-1：30 条（15 条旧高 usage + 15 条新）⇒ 索引保留全部旧高 usage，新条目只占剩余名额", async () => {
    const svc = new MemoryService();
    for (let i = 0; i < 15; i += 1) {
      const r = svc.add({
        scope: "project",
        projectId: PROJ,
        key: `旧高使用记忆 ${i}`,
        content: `OLD_HIGH_USAGE_${i}`,
        source: "manual",
        usageCount: 20,
        timestamp: 1_000 + i,
      });
      expect(r.ok, r.ok ? "" : (r as any).message).toBe(true);
    }
    for (let i = 0; i < 15; i += 1) {
      const r = svc.add({
        scope: "project",
        projectId: PROJ,
        key: `新低使用记忆 ${i}`,
        content: `NEW_LOW_USAGE_${i}`,
        source: "manual",
        usageCount: 0,
        timestamp: 2_000 + i,
      });
      expect(r.ok, r.ok ? "" : (r as any).message).toBe(true);
    }

    const prompt = svc.buildMemoryPrompt("project", PROJ);
    const lines = prompt.split("\n").filter((line) => line.startsWith("- ["));
    expect(lines.length, `注入必须按条数上限截断到 ${MEMORY_INJECT_MAX_PER_BLOCK}`).toBe(
      MEMORY_INJECT_MAX_PER_BLOCK,
    );
    for (let i = 0; i < 15; i += 1) {
      expect(prompt, `旧的高 usage 条目 ${i} 不许被新条目挤出索引`).toContain(`OLD_HIGH_USAGE_${i}`);
    }
    /* 30 条里 15 条旧 + 15 条新，20 个名额 ⇒ 最新 5 条新条目进；第 6~15 新的被挤出 */
    expect(prompt, "最新 5 条低 usage 仍按创建序占剩余名额").toContain("NEW_LOW_USAGE_14");
    expect(prompt, "第 6 新的低 usage 条目必须被旧高 usage 挤出").not.toContain("NEW_LOW_USAGE_8");
    await svc.flushPendingPersist();
  });

  it("MEM-RANK-2：20 条 manual + 5 条 auto ⇒ manual 一条不被 auto 挤出（来源桶各自封顶）", async () => {
    const svc = new MemoryService();
    for (let i = 0; i < MEMORY_INJECT_MAX_PER_BLOCK; i += 1) {
      const r = svc.add({
        scope: "project",
        projectId: PROJ,
        key: `手动约定 ${i}`,
        content: `MANUAL_KEEP_${i}`,
        source: "manual",
        timestamp: 1_000 + i,
      });
      expect(r.ok).toBe(true);
    }
    for (let i = 0; i < 5; i += 1) {
      const r = svc.add({
        scope: "project",
        projectId: PROJ,
        key: `自动线索 ${i}`,
        content: `AUTO_EXTRA_${i}`,
        source: "auto",
        timestamp: 2_000 + i,
      });
      expect(r.ok).toBe(true);
    }

    const prompt = svc.buildMemoryPrompt("project", PROJ);
    for (let i = 0; i < MEMORY_INJECT_MAX_PER_BLOCK; i += 1) {
      expect(prompt, `第 ${i} 条 manual 必须仍被注入（auto 只占自己的桶）`).toContain(`MANUAL_KEEP_${i}`);
    }
    for (let i = 0; i < 5; i += 1) {
      expect(prompt, `auto ${i} 也必须注入（它不是挤掉 manual 换来的）`).toContain(`AUTO_EXTRA_${i}`);
    }
    await svc.flushPendingPersist();
  });
});

describe("HIST-3：thread history 默认只在当前会话（fail-closed）", () => {
  it("HIST-3：A 会话检索不到 B 会话的事实；B 会话自己可以检索到", async () => {
    const A = "gaps-hist-a";
    const B = "gaps-hist-b";
    seedSession(A);
    seedSession(B);
    await new Promise<void>((resolve) => domainEnsureLoaded("sessions", resolve));
    createMessage({ id: "hist-a-1", role: "user", content: "A 的普通内容", timestamp: 1, status: "done" }, A);
    createMessage(
      { id: "hist-b-secret", role: "user", content: "HIST3_B_ONLY 只属于 B 会话的事实", timestamp: 2, status: "done" },
      B,
    );

    const tool = createThreadHistorySearchTool();
    const ctx = (sessionId: string) =>
      ({
        sessionId,
        messageId: "call",
        cwd: "C:\\work",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
      }) as never;

    const inA = await tool.execute({ query: "HIST3_B_ONLY" }, ctx(A));
    expect(inA.isError).toBe(false);
    expect(inA.output, "A 会话不许看到 B 会话的消息").not.toContain("hist-b-secret");
    expect(inA.output, "A 会话里确实没有这条事实（No match）").toContain("No match");

    const inB = await tool.execute({ query: "HIST3_B_ONLY" }, ctx(B));
    expect(inB.output, "B 会话自己能检索到").toContain("hist-b-secret");
    expect(inB.output).toContain("HIST3_B_ONLY");
  });
});

describe("CACHE-1：换段不破坏系统提示的稳定前缀", () => {
  it("CACHE-1：一次真实换段前后，缓存边界哨兵之前的字节逐字不变", async () => {
    const sessionId = "gaps-cache1";
    seedSession(sessionId);
    await new Promise<void>((resolve) => domainEnsureLoaded("sessions", resolve));
    for (let i = 0; i < 40; i += 1) {
      createMessage(
        { id: `cache1-msg-${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `CACHE1 历史 ${i}`, timestamp: 1_000 + i, status: "done" },
        sessionId,
      );
    }
    const svc = getMemoryService();
    await svc.reload();
    const added = svc.add({
      scope: "platform",
      key: "平台约定",
      content: "CACHE1_STABLE_PLATFORM",
      source: "manual",
    });
    expect(added.ok).toBe(true);

    const engine = new LLMEngine();
    const stablePrefix = (text: string) => {
      const at = text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
      expect(at, "前提：系统提示里必须有缓存边界哨兵").toBeGreaterThan(0);
      return text.slice(0, at);
    };
    const before = stablePrefix(engine.buildSystemPrompt(sessionId, undefined, "C:\\work"));
    expect(before).toContain("CACHE1_STABLE_PLATFORM");

    const switched = performSegmentSwitch(sessionId, { keepCount: 20, now: 9_999 });
    expect(switched.switched, "前提：真的发生了一次换段").toBe(true);

    const after = stablePrefix(engine.buildSystemPrompt(sessionId, undefined, "C:\\work"));
    expect(after, "换段（epoch 变化）不许改动稳定前缀任何一个字节").toBe(before);
    await svc.flushPendingPersist();
  });
});

describe("CMP-P-2：隐藏状态未就绪时不跑反应式/压力压缩", () => {  it("CMP-P-2：压力过阈值但 isHiddenStateAuthoritative=false ⇒ 不压缩；反向对照 true ⇒ 会压缩", async () => {
    const sessionId = "gaps-cmp2";
    seedSession(sessionId);
    await new Promise<void>((resolve) => domainEnsureLoaded("sessions", resolve));
    for (let i = 0; i < 90; i += 1) {
      seedRow("messages", {
        id: `cmp2-msg-${i}`,
        session_id: sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: body(`隐藏状态第 ${i} 条`, 1400),
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }
    getContextManager().updateConfig({ segmentEpochs: false });
    getTokenTracker().setContextWindow(24_000);

    const compactRuns = async (authoritative: boolean) => {
      const hiddenSpy = vi
        .spyOn(MessageStorage, "isHiddenStateAuthoritative")
        .mockReturnValue(authoritative);
      const provider = {
        id: "gaps-cmp2-provider",
        isConfigured: () => true,
        async *stream() {
          yield { type: "text_delta", text: "OK" };
          yield { type: "end", finishReason: "stop" };
        },
        async complete() {
          return { content: "摘要", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        },
        async listModels() {
          return [];
        },
        async fetchModelsFromServer() {
          return [];
        },
      };
      const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
        maxIterations: 1,
        model: "gaps-cmp2-model",
        securityMode: "full",
        contextWindow: 24_000,
        enableCompaction: true,
        compactionThreshold: 0.7,
      });
      const events: any[] = [];
      for await (const event of loop.run(sessionId, "你好", "C:\\work", "你是测试助手。")) events.push(event);
      hiddenSpy.mockRestore();
      return { events, pressure: loop.getState().contextPressure };
    };

    const notReady = await compactRuns(false);
    expect(notReady.pressure, "前提：压力必须已经过阈值").toBeGreaterThanOrEqual(0.7);
    expect(
      notReady.events.some((e) => e.type === "compaction_start"),
      "隐藏状态未就绪 ⇒ 不许启动压缩（可见集可能含已隐藏历史）",
    ).toBe(false);
    expect(
      listTimelineMessages(sessionId).filter((m) => epochOf(m)?.kind === "compact"),
      "未就绪时也不许写 compact marker",
    ).toHaveLength(0);

    /* 反向对照：同一现场，权威门打开 ⇒ 必须真的压缩（证明上一条不是恒真） */
    const ready = await compactRuns(true);
    expect(
      ready.events.some((e) => e.type === "compaction_start"),
      "反向对照：隐藏状态就绪时必须走压缩",
    ).toBe(true);
    expect(
      listTimelineMessages(sessionId).filter((m) => epochOf(m)?.kind === "compact").length,
      "反向对照：必须留下 compact marker",
    ).toBeGreaterThanOrEqual(1);
  });
});

/**
 * CMP-P-1（24 §P0-5 / §6）：**首轮压力必须含 system + tools**；拿不到工具表时必须显式标
 * 「未计入工具定义」而不是静默按 0 算。
 *
 * 变异自证：
 * - 把工具定义从 `estimateContextPressure` 的入参里删掉（恢复旧 `currentToolDefs` 无赋值）⇒
 *   `withTools > withoutTools * 1.5` 与 `basis.toolCount === 1` 双双变红；
 * - 把系统提示词从纯估算里删掉 ⇒ `systemIncluded` / 期望 token 下限断言红；
 * - 不给工具表时若仍标 `toolsIncluded=true` ⇒ 「未计入」那条红。
 */
describe("CMP-P-1：首轮压力含 system + tools（拿不到工具表要如实标）", () => {
  const WINDOW = 100_000;

  /** 只用于压力估算的 loop（不跑 run；算的是被修的那个函数本身） */
  function pressureLoop(): AgenticLoop {
    const provider = {
      id: "gaps-cmp-p1-provider",
      isConfigured: () => true,
      async *stream() {
        yield { type: "text_delta", text: "OK" };
        yield { type: "end", finishReason: "stop" };
      },
      async complete() {
        return { content: "OK", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
      async listModels() {
        return [];
      },
      async fetchModelsFromServer() {
        return [];
      },
    };
    return new AgenticLoop(provider as never, createDefaultToolRegistry(), {
      model: "gaps-cmp-p1-model",
      maxIterations: 1,
      securityMode: "full",
      contextWindow: WINDOW,
      enableCompaction: false,
    } as never);
  }

  it("CMP-P-1：固定夹具下首轮压力含 system + tools；去掉工具定义 ⇒ 明显偏低", () => {
    const tracker = getTokenTracker();
    tracker.reset();
    tracker.setContextWindow(WINDOW);
    const loop = pressureLoop() as unknown as {
      turnSystemPrompt: string;
      pressureSystemPrompt: string;
      currentToolDefs: unknown[] | null;
      estimateContextPressure(messages: unknown[]): number;
      getPressureBasis(): {
        toolsIncluded: boolean;
        toolCount: number;
        systemIncluded: boolean;
        mode: "actual" | "estimate";
      } | null;
    };

    loop.turnSystemPrompt = "S".repeat(4000);
    loop.pressureSystemPrompt = "S".repeat(4000);
    const messages = [{ id: "cmp-p1-u1", role: "user", content: "M".repeat(4000) }];
    const tools = [{ name: "cmp_p1_probe_tool", description: "T".repeat(4000), parameters: { type: "object" } }];
    loop.currentToolDefs = tools;

    const withTools = loop.estimateContextPressure(messages);
    const basis = loop.getPressureBasis()!;
    expect(basis.mode, "首轮没有真实 usage ⇒ 纯估算路径").toBe("estimate");
    expect(basis.toolsIncluded, "工具定义必须被计入").toBe(true);
    expect(basis.toolCount, "计入的是**本轮真实发送集合**（这里 1 条）").toBe(1);
    expect(basis.systemIncluded, "系统提示词必须被计入").toBe(true);

    const actualTokens = Math.round(withTools * WINDOW);
    const expectedFloor =
      estimateTokens("S".repeat(4000)) + estimateToolDefinitionTokens(tools);
    expect(actualTokens, "压力读数必须 ≥ system + tools 的估算（漏算任何一半都会低）").toBeGreaterThanOrEqual(
      Math.floor(expectedFloor),
    );

    /* 反向对照：同一条消息、同一份 system，只把工具表清空 ⇒ 压力必须明显偏低 */
    loop.currentToolDefs = [];
    const withoutTools = loop.estimateContextPressure(messages);
    expect(withoutTools).toBeLessThan(withTools);
    expect(
      withTools,
      `去掉工具定义后压力必须明显偏低（with=${withTools.toFixed(4)} without=${withoutTools.toFixed(4)}）`,
    ).toBeGreaterThan(withoutTools * 1.5);
    expect(loop.getPressureBasis()!.toolCount, "清空后读数如实为 0").toBe(0);
  });

  it("CMP-P-1（真实 run 接线）：首轮压力用的是**本轮实际发送集合**（category 计数由 prepare 写入）", async () => {
    const sessionId = "gaps-cmp-p1-wire";
    seedSession(sessionId);
    await new Promise<void>((resolve) => domainEnsureLoaded("sessions", resolve));
    for (let i = 0; i < 4; i += 1) {
      seedRow("messages", {
        id: `cmp-p1-wire-${i}`,
        session_id: sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `CMP-P-1 接线第 ${i} 条`,
        reasoning: null,
        timestamp: 1_000 + i,
        model: null,
        status: "done",
        hidden: 0,
      });
    }

    const provider = {
      id: "gaps-cmp-p1-wire-provider",
      isConfigured: () => true,
      async *stream() {
        yield { type: "text_delta", text: "完成" };
        yield { type: "end", finishReason: "stop" };
      },
      async complete() {
        return { content: "完成", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
      async listModels() {
        return [];
      },
      async fetchModelsFromServer() {
        return [];
      },
    };
    getTokenTracker().setContextWindow(WINDOW);
    const loop = new AgenticLoop(provider as never, createDefaultToolRegistry(), {
      model: "gaps-cmp-p1-wire-model",
      maxIterations: 1,
      securityMode: "full",
      contextWindow: WINDOW,
      enableCompaction: false,
    } as never);
    for await (const _event of loop.run(sessionId, "你好", "C:\\work", "你是测试助手。")) {
      /* 事件不需要断言；我们要的是这一轮**真实 prep** 记下的压力构成 */
    }

    const basis = loop.getPressureBasis();
    expect(basis, "真实跑完一轮后必须有压力构成读数").toBeTruthy();
    expect(basis!.toolsIncluded, "真实 run 的首轮压力必须计入工具定义（旧实现这里是 false）").toBe(true);
    expect(basis!.toolCount, "toolCount 必须是本轮实际发送的那张表（不是 0）").toBeGreaterThan(0);
  });

  it("CMP-P-1（缺工具表）：拿不到工具时显式标 toolsIncluded=false 并打一次性日志（不许静默）", () => {    const tracker = getTokenTracker();
    tracker.reset();
    tracker.setContextWindow(WINDOW);
    const loop = pressureLoop() as unknown as {
      currentToolDefs: unknown[] | null;
      pressureSystemPrompt: string;
      estimateContextPressure(messages: unknown[]): number;
      getPressureBasis(): { toolsIncluded: boolean; mode: "actual" | "estimate" } | null;
    };
    loop.pressureSystemPrompt = "S".repeat(4000);
    loop.currentToolDefs = null;

    resetWarnOnce();
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    try {
      loop.estimateContextPressure([{ id: "cmp-p1-u2", role: "user", content: "M".repeat(100) }]);
      const basis = loop.getPressureBasis()!;
      expect(basis.toolsIncluded, "拿不到工具表 ⇒ 必须标 false（不许静默当成完整读数）").toBe(false);
      expect(warns.join("\n"), "必须有一条可查的日志说明「未计入工具定义」").toContain("未计入工具定义");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * PERF-1（24 §6）：5000 条记忆的检索/索引**有界**。
 *
 * 判据口径（刻意不靠脆弱墙钟）：
 * - **操作计数**：`search()` 逐条扫描 ≤ n；索引生成（`buildMemoryPrompt` 三个作用域）≤ 3n；
 *   冲突图的内容归一化次数 ≤ n（每条只归一化一次）；
 * - 同 key 形态：旧实现是两两比较（`n(n-1)/2` 对 × 每对两次归一化 + `includes`），
 *   5000 条实测 **111.9 秒**；现在 800 条只允许 ≤ n 次归一化（旧实现 639,200 次）⇒ 去掉修复必红；
 * - **宽松墙钟**（<2s）只作为第二道保险（本机 Node 环境；正常实现是几十毫秒量级，
 *   余量 >50×，不会因为 CI 抖动假红）。
 */
describe("PERF-1：5000 条记忆的检索/索引有界", () => {
  const SESSION_PERF = "gaps-perf-session";

  function seedPerfEntries(svc: MemoryService, n: number, sameKey: boolean): void {
    const entries = (svc as unknown as { entries: Map<string, MemoryEntry> }).entries;
    for (let i = 0; i < n; i += 1) {
      const id = `perf-${i}`;
      entries.set(id, {
        id,
        scope: "project",
        projectId: PROJ,
        key: sameKey ? "构建命令" : `构建命令 ${i}`,
        content: `构建命令 ${i}：npm run build-${i} ` + "x".repeat(60),
        source: "manual",
        status: "active",
        timestamp: 1_000 + i,
        order: i,
      });
    }
  }

  it("PERF-1a：5000 条（各不同 key）⇒ search 扫 ≤n、索引生成 ≤3n，宽松墙钟 <2s", () => {
    const svc = new MemoryService();
    seedPerfEntries(svc, 5_000, false);
    const ctx = injectionScopeContext(PROJ, SESSION_PERF);

    __resetMemoryPerfStats();
    const t0 = performance.now();
    const hits = svc.search("构建", undefined, 10, ctx);
    const searchMs = performance.now() - t0;
    const searchStats = __memoryPerfStats();
    expect(hits, "检索仍然要返回结果（不是把功能删掉换性能）").toHaveLength(10);
    expect(searchStats.searchEntries, "一次检索只该逐条扫一遍（O(n)）").toBeLessThanOrEqual(5_000);
    expect(
      searchStats.conflictComparisons,
      "冲突图每条只归一化一次（旧实现退化成 O(n²) 的每对两次）",
    ).toBeLessThanOrEqual(5_000);
    expect(searchMs, "宽松墙钟（本机 Node；正常几十毫秒，2s 只为抓数量级回归）").toBeLessThan(2_000);

    __resetMemoryPerfStats();
    const t1 = performance.now();
    const prompt = svc.buildMemoryPrompt(undefined, PROJ, SESSION_PERF);
    const promptMs = performance.now() - t1;
    const promptStats = __memoryPerfStats();
    expect(prompt.length, "索引生成必须真的产出内容").toBeGreaterThan(0);
    expect(
      promptStats.injectionEntries,
      "索引生成 = 每个作用域扫一遍（3n），不许按块/按条反复全扫",
    ).toBeLessThanOrEqual(3 * 5_000);
    expect(promptMs, "宽松墙钟（同上）").toBeLessThan(2_000);
  });

  it("PERF-1b：800 条同 key（旧实现 O(n²)=11 万+ 对）⇒ 冲突比较 ≤n，且仍能报出冲突", () => {
    const svc = new MemoryService();
    seedPerfEntries(svc, 800, true);
    const ctx = injectionScopeContext(PROJ, SESSION_PERF);

    __resetMemoryPerfStats();
    const t0 = performance.now();
    const hits = svc.search("构建", undefined, 10, ctx);
    const ms = performance.now() - t0;
    const stats = __memoryPerfStats();

    expect(hits, "同 key 形态也必须返回结果").toHaveLength(10);
    expect(
      stats.conflictComparisons,
      "每条只归一化一次；旧实现是 800×799 次比较（2×对 + includes）",
    ).toBeLessThanOrEqual(800);
    expect(
      hits.some((h) => h.conflictWith.length > 0),
      "冲突判定不许为了性能被删掉（结果里仍要能看到冲突对象）",
    ).toBe(true);
    expect(ms, "宽松墙钟（本机 Node；旧实现在这个规模约 1~3 秒，现已毫秒级）").toBeLessThan(2_000);
  });
});

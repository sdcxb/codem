/**
 * 24 号文 §P0-3 剩余细项的判据：**水位游标 + 空闲批次**。
 *
 * ## 判据与变异自证
 *
 * | ID | 通过条件 | 把实现改坏 |
 * |---|---|---|
 * | MEM-EXTRACT-CURSOR-1 | 重启（新引擎）后只提取**新增**（游标 id 之后） | 水位改回"某进程内条数" ⇒ 新引擎读到 0 条已提取 ⇒ 全量重提 ⇒ 红 |
 * | MEM-EXTRACT-CURSOR-2 | 旧**数字**游标兼容（`"8"` ⇒ 只取第 9 条之后） | 只认对象形状（数字判成坏游标）⇒ 回退全量 ⇒ 红 |
 * | MEM-EXTRACT-CURSOR-3 | 坏游标 ⇒ 回退全量 + warn（不抛、不锁死） | 把坏游标当"没有游标"静默处理 ⇒ warn 断言红；整份跳过 ⇒ 提取次数红 |
 * | MEM-EXTRACT-CURSOR-4 | 游标 id 不在当前列表（被裁剪）⇒ 回退全量 + warn | 找不到 id 就返回空增量 ⇒ 提取永远不再发生 ⇒ 红 |
 * | MEM-EXTRACT-CURSOR-5 | 游标带 epoch/segmentSeq（换段后仍可判断） | 只写 messageId ⇒ epoch 断言红 |
 * | MEM-EXTRACT-BATCH-1 | fake clock 前进 30s 才跑；不到点不跑 | 把延迟改回 0 / 立即提取 ⇒ "29.999s 不跑"红 |
 * | MEM-EXTRACT-BATCH-2 | 到点仍无新消息 ⇒ 不空跑 | 去掉 `hasNewMessages` 检查 ⇒ 空跑一次 ⇒ 红 |
 * | MEM-EXTRACT-BATCH-3 | 关闭会话取消排期（advance 后不跑） | 只清在途、不清计时器 ⇒ 红 |
 * | MEM-EXTRACT-BATCH-4 | 两回合只 1 个批次（单飞仍生效） | 每次触发都重置/新建计时器 ⇒ provider 调用 2 次 ⇒ 红 |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { memFs } = vi.hoisted(() => ({ memFs: new Map<string, string>() }));
vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\cursor-batch",
  exists: async (p: string) => memFs.has(p),
  readFile: async (p: string) => {
    if (!memFs.has(p)) throw new Error("ENOENT: " + p);
    return memFs.get(p)!;
  },
  readTextWindow: async (p: string, offset = 0, maxBytes?: number) => {
    const c = memFs.get(p) ?? "";
    const end = maxBytes ? Math.min(c.length, offset + maxBytes) : c.length;
    return { text: c.slice(offset, end), nextOffset: end, eof: end >= c.length, size: c.length };
  },
  appendFile: async (p: string, c: string) => {
    memFs.set(p, (memFs.get(p) ?? "") + c + "\n");
  },
  writeFile: async (p: string, c: string) => {
    memFs.set(p, c);
  },
  deleteFile: async () => {},
  deletePath: async () => {},
  renameFile: async () => {},
  listDirectory: async () => [],
  globSearch: async () => [],
  grepSearch: async () => [],
  readFileLines: async (p: string) => ({ text: memFs.get(p) ?? "", hasMore: false, totalLines: 1 }),
  isPathWithinWorkspace: () => true,
}));

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { getSetting, saveMemory, setSetting, setSettingJSON } from "../core/storage/settings";
import { MemoryService } from "../core/memory/memory";
import { LLMEngine } from "../core/llm";
import * as MessageStorage from "../core/storage/message";
import {
  memoryExtractionWatermarkKey,
  readMemoryExtractionCursor,
} from "../core/memory/extraction-cursor";
import { MemoryExtractionBatcher } from "../core/memory/extraction-batcher";
import { EXTRACTION_IDLE_DELAY_MIN_MS } from "../core/memory/extraction-delay";

const SESSION = "s-cursor-batch";
const PROJ = "c:\\work\\cursor-batch";
const CWD = "C:\\cursor-batch";

type Msg = { id: string; role: string; content: string; timestamp?: number; metadata?: Record<string, unknown> };

/** n 条消息：内容带 id，便于断言"哪几条进了请求" */
function messages(n: number, prefix = "m"): Msg[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${prefix}${i} 的对话内容`,
    timestamp: 1_000 + i,
  }));
}

let port: FakeStoragePort;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memFs.clear();
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
  saveMemory("");
  setSettingJSON(`memory-enabled-${SESSION}`, true);
});

afterEach(() => {
  setStoragePort(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Harness {
  engine: LLMEngine;
  /** 每次 `spawnForked` 收到的 sourceMessages（按调用顺序） */
  calls: Array<Array<Record<string, unknown>>>;
}

/**
 * 造一个"真实提取链路"的引擎：`spawnForked` 压成桩（本文件钉的是水位/调度，不是 LLM），
 * 但提取的**读取、过滤、游标、取样**全部是真的。
 */
function makeEngine(list: Msg[], opts: { delayMs?: number } = {}): Harness {
  const svc = new MemoryService();
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = svc;
  const provider = {
    id: "cursor-batch-provider",
    isConfigured: () => true,
    complete: async () => ({ content: "[]" }),
    listModels: async () => [],
    fetchModelsFromServer: async () => [],
    async *stream() {
      yield { type: "text_delta", text: "OK" };
      yield { type: "end", finishReason: "stop" };
    },
  };
  (engine as unknown as { providers: unknown }).providers = {
    get: () => provider,
    getAll: () => [provider],
    register: () => {},
  };
  (engine as unknown as { profileManager: unknown }).profileManager = {
    resolveSlot: () => ({ provider: "cursor-batch-provider", model: "cursor-batch-model" }),
  };
  if (opts.delayMs !== undefined) engine.setMemoryExtractionIdleDelay(opts.delayMs);
  vi.spyOn(MessageStorage, "listMessages").mockReturnValue(list as never);
  const calls: Array<Array<Record<string, unknown>>> = [];
  vi.spyOn(engine, "spawnForked").mockImplementation((async (
    _sid: string,
    _sys: string,
    _prompt: string,
    options?: { sourceMessages?: ReadonlyArray<Record<string, unknown>> },
  ) => {
    calls.push((options?.sourceMessages ?? []).map((m) => ({ ...m })));
    return "[]";
  }) as never);
  return { engine, calls };
}

function idsIn(call: Array<Record<string, unknown>> | undefined): string[] {
  return (call ?? []).map((m) => String(m.id));
}

function cursorSetting(): Record<string, any> | null {
  const raw = getSetting(memoryExtractionWatermarkKey(SESSION));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return null;
  }
}

describe("MEM-EXTRACT-CURSOR：最后已提取的消息 id + epoch/segmentSeq（持久化，兼容旧数字）", () => {
  it("MEM-EXTRACT-CURSOR-1：新引擎（模拟重启）只提取游标之后的新增", async () => {
    const first = makeEngine(messages(12));
    await first.engine.extractMemoriesFromSession(SESSION, PROJ);
    expect(first.calls, "第一次必须真的提取").toHaveLength(1);
    expect(idsIn(first.calls[0]), "第一次没有游标 ⇒ 全量（12 条）").toEqual(messages(12).map((m) => m.id));
    const saved = cursorSetting();
    expect(saved?.messageId, "游标必须是**消息 id**，不是条数").toBe("m11");
    expect(saved?.messageCount, "条数只作诊断/旧口径兼容").toBe(12);

    /* 重启：新引擎（新 MemoryService），消息多了 4 条 */
    const second = makeEngine(messages(16));
    await second.engine.extractMemoriesFromSession(SESSION, PROJ);
    expect(second.calls, "重启后仍要提取（不做「重开应用就永远提不出来」的死锁）").toHaveLength(1);
    expect(idsIn(second.calls[0]), "只许提取游标 id 之后的新增").toEqual(["m12", "m13", "m14", "m15"]);
    expect(
      idsIn(second.calls[0]).some((id) => Number(id.replace("m", "")) <= 11),
      "已提取过的旧消息不许重进请求",
    ).toBe(false);
  });

  it("MEM-EXTRACT-CURSOR-2：旧数字游标兼容（\"8\" ⇒ 只取第 9 条之后），成功后被升级", async () => {
    setSetting(memoryExtractionWatermarkKey(SESSION), "8");
    expect(readMemoryExtractionCursor(SESSION).kind, "旧数字必须被识别为 legacy").toBe("legacy");
    const { engine, calls } = makeEngine(messages(12));
    await engine.extractMemoriesFromSession(SESSION, PROJ);
    expect(calls, "旧数字游标下仍要提取").toHaveLength(1);
    expect(idsIn(calls[0]), "旧口径：跳过前 8 条").toEqual(["m8", "m9", "m10", "m11"]);
    expect(cursorSetting()?.messageId, "成功一次后升级成 id 游标").toBe("m11");
  });

  it("MEM-EXTRACT-CURSOR-3：坏游标 ⇒ 回退全量 + warn（不抛、不锁死）", async () => {
    setSetting(memoryExtractionWatermarkKey(SESSION), "{ this is not json");
    const warns: string[] = [];
    vi.mocked(console.warn).mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    const { engine, calls } = makeEngine(messages(12));
    await engine.extractMemoriesFromSession(SESSION, PROJ);
    expect(calls, "坏游标不许把提取锁死（回退全量）").toHaveLength(1);
    expect(idsIn(calls[0])[0], "回退全量 ⇒ 从第 1 条开始").toBe("m0");
    expect(
      warns.some((line) => line.includes("游标") && line.includes("回退全量")),
      `必须有可查的 warn（实际：${warns.join(" | ")}）`,
    ).toBe(true);
    expect(cursorSetting()?.messageId, "回退全量成功后也要把游标修正").toBe("m11");
  });

  it("MEM-EXTRACT-CURSOR-4：游标 id 已被裁剪 ⇒ 回退全量 + warn（不返回空增量）", async () => {
    setSetting(
      memoryExtractionWatermarkKey(SESSION),
      JSON.stringify({ messageId: "已被裁剪的消息", messageCount: 3 }),
    );
    const warns: string[] = [];
    vi.mocked(console.warn).mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    const { engine, calls } = makeEngine(messages(12));
    await engine.extractMemoriesFromSession(SESSION, PROJ);
    expect(calls, "游标 id 找不到时必须回退全量，而不是「没有新消息」").toHaveLength(1);
    expect(idsIn(calls[0])).toContain("m0");
    expect(
      warns.some((line) => line.includes("不在当前消息列表")),
      "必须 warn（可诊断）",
    ).toBe(true);
  });

  it("MEM-EXTRACT-CURSOR-5：游标带上 epoch / segmentSeq（换段后仍可判断）", async () => {
    const list = messages(12);
    /* 末尾放一个换段 marker（会被提取源排除，但 epoch 要从完整列表里读出来） */
    list.push({
      id: "compact-test-1",
      role: "user",
      content: "段摘要",
      timestamp: 2_000,
      metadata: { contextEpoch: { epochId: "epoch-7", segmentSeq: 7, cutoffMessageId: "m0", kind: "compact" } },
    });
    const { engine } = makeEngine(list);
    await engine.extractMemoriesFromSession(SESSION, PROJ);
    const saved = cursorSetting();
    expect(saved?.messageId, "游标指向最后一条真实消息（marker 被排除）").toBe("m11");
    expect(saved?.epochId, "必须持久化 epochId").toBe("epoch-7");
    expect(saved?.segmentSeq, "必须持久化 segmentSeq").toBe(7);
  });
});

describe("MEM-EXTRACT-BATCH：空闲批次（30s 才跑、无新消息不跑、关闭取消、两回合 1 次）", () => {
  it("MEM-EXTRACT-BATCH-1：fake clock 前进 30s 才跑（29.999s 不跑）", async () => {
    const { engine, calls } = makeEngine(messages(12));
    const schedule = (engine as unknown as { memoryExtractionBatcher: { schedule: (s: string, p?: string) => boolean } })
      .memoryExtractionBatcher;
    vi.useFakeTimers();
    expect(schedule.schedule(SESSION, PROJ), "第一次排期必须新建").toBe(true);
    expect(engine.isMemoryExtractionScheduled(SESSION)).toBe(true);

    await vi.advanceTimersByTimeAsync(EXTRACTION_IDLE_DELAY_MIN_MS - 1);
    expect(calls, "不到点不许跑").toHaveLength(0);
    expect(engine.isMemoryExtractionScheduled(SESSION), "没到点时仍在排期里").toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(calls, "到点必须跑一次").toHaveLength(1));
    expect(engine.isMemoryExtractionScheduled(SESSION), "跑完必须清掉排期").toBe(false);
  });

  it("MEM-EXTRACT-BATCH-2：到点但会话没有新消息 ⇒ 不空跑", async () => {
    const { engine, calls } = makeEngine(messages(12));
    await engine.extractMemoriesFromSession(SESSION, PROJ); // 第一轮：游标推到 m11
    expect(calls).toHaveLength(1);

    const schedule = (engine as unknown as { memoryExtractionBatcher: { schedule: (s: string, p?: string) => boolean } })
      .memoryExtractionBatcher;
    vi.useFakeTimers();
    schedule.schedule(SESSION, PROJ); // 模拟"回合结束"，但消息没变
    await vi.advanceTimersByTimeAsync(EXTRACTION_IDLE_DELAY_MIN_MS);
    expect(calls, "没有新消息 ⇒ 30s 后也不许再发一次模型调用").toHaveLength(1);
  });

  it("MEM-EXTRACT-BATCH-3：关闭会话取消排期（advance 后不跑）", async () => {
    const { engine, calls } = makeEngine(messages(12));
    const schedule = (engine as unknown as { memoryExtractionBatcher: { schedule: (s: string, p?: string) => boolean } })
      .memoryExtractionBatcher;
    vi.useFakeTimers();
    schedule.schedule(SESSION, PROJ);
    expect(engine.cancelMemoryExtraction(SESSION), "取消一个排期必须返回 true").toBe(true);
    expect(engine.isMemoryExtractionScheduled(SESSION), "取消后不许留在排期表里").toBe(false);
    await vi.advanceTimersByTimeAsync(EXTRACTION_IDLE_DELAY_MIN_MS);
    expect(calls, "关闭/取消会话后批次不许再跑").toHaveLength(0);
  });

  it("MEM-EXTRACT-BATCH-4：两个回合只跑 1 个批次（首次排期优先，单飞仍生效）", async () => {
    const { engine, calls } = makeEngine(messages(12));
    const schedule = (engine as unknown as { memoryExtractionBatcher: { schedule: (s: string, p?: string) => boolean } })
      .memoryExtractionBatcher;
    vi.useFakeTimers();
    expect(schedule.schedule(SESSION, PROJ), "第 1 回合新建排期").toBe(true);
    /* 第 2 回合（10 秒后再触发）——只合并，不重置计时器 */
    await vi.advanceTimersByTimeAsync(10_000);
    expect(schedule.schedule(SESSION, PROJ), "第 2 回合不许新建第二个批次").toBe(false);
    expect(engine.isMemoryExtractionScheduled(SESSION)).toBe(true);

    /* 距首次排期 30s 到点：只跑一次 */
    await vi.advanceTimersByTimeAsync(EXTRACTION_IDLE_DELAY_MIN_MS - 10_000);
    await vi.waitFor(() => expect(calls, "两个回合合起来只跑 1 次").toHaveLength(1));
  });

  it("MEM-EXTRACT-BATCH-5（单元）：注入时钟/计时器 —— 到点回调只调用一次，取消后回调空转", () => {
    let now = 1_000_000;
    let pending: (() => void) | null = null;
    const run = vi.fn();
    const hasNew = vi.fn(() => true);
    const batcher = new MemoryExtractionBatcher({
      delayMs: EXTRACTION_IDLE_DELAY_MIN_MS,
      hasNewMessages: hasNew,
      run,
      now: () => now,
      setTimer: (fn: () => void) => {
        pending = fn;
        return 1;
      },
      clearTimer: () => {
        pending = null;
      },
      warn: () => {},
    });
    expect(batcher.schedule("s1")).toBe(true);
    expect(batcher.dueAt("s1")).toBe(now + EXTRACTION_IDLE_DELAY_MIN_MS);
    expect(batcher.pendingCount()).toBe(1);
    expect(batcher.schedule("s1")).toBe(false);
    now += EXTRACTION_IDLE_DELAY_MIN_MS;
    pending!();
    expect(run).toHaveBeenCalledTimes(1);
    expect(hasNew).toHaveBeenCalledTimes(1);

    /* 取消后即使回调被平台错误地再执行一次，也不能跑 */
    expect(batcher.schedule("s2")).toBe(true);
    const cancelledCallback = pending;
    expect(cancelledCallback).not.toBeNull();
    expect(batcher.cancel("s2")).toBe(true);
    cancelledCallback!();
    expect(run, "取消后的回调必须空转").toHaveBeenCalledTimes(1);
  });
});

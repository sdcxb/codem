/**
 * 24 号文 §P0-3 剩余细项的判据：**tier 取样 + 8MB/70% 预算**。
 *
 * ## 判据与变异自证
 *
 * | ID | 通过条件 | 把实现改坏 |
 * |---|---|---|
 * | MEM-EXTRACT-TIER-1 | 预算紧张时 Human/Final 保留、Tool 先丢 | 中间段改成"按时间先取"（不按 tier 排序）⇒ Human/Final 被工具摘要挤掉 ⇒ 红 |
 * | MEM-EXTRACT-TIER-2 | 工具结果只取摘要（原文长尾不进提示词） | 去掉 `summarizeToolResult` ⇒ 原文长尾出现 ⇒ 红 |
 * | MEM-EXTRACT-BUDGET-1 | `min(8MB, 窗口 70%)`（取小）；窗口未知退回 8MB | 改回固定 8MB 或按窗口不取小 ⇒ 红 |
 * | MEM-EXTRACT-BUDGET-2 | 头 10 + 尾 40 保留；超限有界且标注截断 | 去掉头尾保留（只取尾部）⇒ 第 1 条事实丢失 ⇒ 红；去掉截断标记 ⇒ 红 |
 * | MEM-EXTRACT-BUDGET-3（接线） | 真实提取请求里也有摘要与截断标记 | 把 `sourceMessages: sample.messages` 改回 `extractionSource` ⇒ 摘要不生效 ⇒ 红 |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTRACTION_HEAD_KEEP,
  EXTRACTION_MAX_INPUT_BYTES,
  EXTRACTION_TAIL_KEEP,
  EXTRACTION_TOOL_SUMMARY_CHARS,
  EXTRACTION_TOOL_SUMMARY_MARK,
  EXTRACTION_TRUNCATION_MARK,
  extractionBudgetBytes,
  extractionTierOf,
  sampleExtractionMessages,
  summarizeToolResult,
  type ExtractionSampleResult,
} from "../core/memory/extraction-sampling";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting, setSettingJSON } from "../core/storage/settings";
import { MemoryService } from "../core/memory/memory";
import { LLMEngine } from "../core/llm/index";
import * as MessageStorage from "../core/storage/message";

const SESSION = "s-tier-budget";
const PROJ = "c:\\work\\tier-budget";

type Msg = Record<string, any>;

/** 造一条工具调用（status done，result 为长正文） */
function toolCall(id: string, result: string): Record<string, unknown> {
  return { id, tool: "read_file", args: { path: "x" }, status: "done", result };
}

function filler(id: string, role: string, content: string, extra: Partial<Msg> = {}): Msg {
  return { id, role, content, timestamp: Number(id.replace(/\D/g, "")) || 0, ...extra };
}

/**
 * 60 条消息的固定夹具：头 10 / 中间 10 / 尾 40。
 *
 * 中间那 10 条刻意是"老的巨大工具结果 + 小的用户/最终结论"：
 * 预算只够放一部分时，tier 优先级必须选 Human/Final、丢 Tool。
 */
function fixture(): { messages: Msg[]; budget: number } {
  const messages: Msg[] = [];
  for (let i = 0; i < 10; i += 1) messages.push(filler(`h${i}`, i % 2 ? "assistant" : "user", `head-${i}-小消息`));
  /* 中间：5 条巨大的工具结果（每条 6000 字符 + 唯一尾部锚点） */
  for (let i = 10; i < 15; i += 1) {
    messages.push(
      filler(`m${i}`, "assistant", `第 ${i} 步：读文件`, {
        toolCalls: [toolCall(`tc-${i}`, `TOOL_RAW_${i}:` + "工具读出来的文件正文。".repeat(500) + `TOOL_TAIL_${i}_END`)],
      }),
    );
  }
  /* 中间：人类要求 + 最终结论（都很小） */
  messages.push(filler("m15", "user", "HUMAN_CRITICAL：以后构建一律先跑 pnpm build --filter core"));
  messages.push(filler("m16", "assistant", "中间叙述：我先把构建脚本看一遍。"));
  messages.push(filler("m17", "assistant", "中间叙述：再确认一下缓存目录。"));
  messages.push(filler("m18", "user", "HUMAN_SECOND：测试只跑定向文件。"));
  messages.push(filler("m19", "assistant", "FINAL_CRITICAL：结论是这个仓库用 pnpm，且不要动 styles.css。"));
  /* 尾 40 */
  for (let i = 20; i < 60; i += 1) messages.push(filler(`t${i}`, i % 2 ? "assistant" : "user", `tail-${i}-小消息`));

  /* 头 10 + 尾 40 的字节数（中间另算）—— 用同一套取样规则量，不手算 */
  const headTail = sampleExtractionMessages([...messages.slice(0, 10), ...messages.slice(-40)], {
    budgetBytes: 8 * 1024 * 1024,
    headKeep: 10,
    tailKeep: 40,
  }).stats.selectedBytes;
  /* 预算 = 头尾 + 只够放 Human/Final + 两条工具摘要 —— 保证 Tool 一定会被丢 */
  const budget = headTail + 2600;
  return { messages, budget };
}

function idsOf(sample: ExtractionSampleResult): string[] {
  return sample.messages.map((m) => String(m.id));
}

describe("MEM-EXTRACT-TIER：预算紧张时按 Human > Final > Agent > Commentary > Context > Tool 取样", () => {
  it("MEM-EXTRACT-TIER-1：Human/Final 保留、Tool 先丢，且总字节有界", () => {
    const { messages, budget } = fixture();
    const sample = sampleExtractionMessages(messages, { budgetBytes: budget });
    const ids = idsOf(sample);
    const text = JSON.stringify(sample.messages);

    expect(sample.stats.selectedBytes, "取样后必须 ≤ 预算（有界）").toBeLessThanOrEqual(budget);
    expect(text, "人类的要求（最高 tier）必须留下").toContain("HUMAN_CRITICAL");
    expect(text, "最终结论（Final tier）必须留下").toContain("FINAL_CRITICAL");
    expect(
      sample.stats.droppedByTier.tool,
      `工具结果必须是最先被丢的（实际丢弃=${JSON.stringify(sample.stats.droppedByTier)}）`,
    ).toBeGreaterThan(0);
    expect(
      sample.stats.budgetExhausted,
      "预算必须真的不够放全部（否则这条判据测不到取舍）",
    ).toBe(true);
    /* 时间顺序不许被打乱：HUMAN 在 FINAL 之前 */
    expect(ids.indexOf("m15"), "取样结果必须保持原始时间顺序").toBeLessThan(ids.indexOf("m19"));
    /* 变异自证点：按时间先取 ⇒ 前几条巨大的工具摘要会先吃掉预算，HUMAN/FINAL 进不来 */
    expect(
      sample.stats.selectedByTier.human,
      "Human 至少选中一条（按时间先取时可能为 0）",
    ).toBeGreaterThan(0);
  });

  it("MEM-EXTRACT-TIER-2：工具结果只取摘要，原文长尾不进提示词", () => {
    const { messages } = fixture();
    const sample = sampleExtractionMessages(messages, { budgetBytes: EXTRACTION_MAX_INPUT_BYTES });
    const text = JSON.stringify(sample.messages);

    expect(sample.stats.toolResultsSummarized, "必须有工具结果被摘要").toBeGreaterThan(0);
    expect(text, "摘要必须带明确标注").toContain(EXTRACTION_TOOL_SUMMARY_MARK);
    /* 摘要保留开头（TOOL_RAW_i）但**绝不**包含原文尾部（TOOL_TAIL_i_END） */
    expect(text, "摘要必须保留开头").toContain("TOOL_RAW_10");
    expect(
      text.includes("TOOL_TAIL_10_END"),
      "原文尾部不许进提示词（摘要上限 400 字符；出现尾部说明没有摘要）",
    ).toBe(false);
    /* 每条工具结果进提示词后都必须 ≤ 摘要上限 + 标记（不靠"重复次数"这种脆断言） */
    for (const m of sample.messages) {
      for (const tc of (m.toolCalls as Array<{ result?: unknown }> | undefined) ?? []) {
        if (typeof tc.result === "string" && tc.result.length > 0) {
          expect(
            tc.result.length,
            `工具结果 ${tc.result.slice(0, 20)}… 必须被摘要（≤ ${EXTRACTION_TOOL_SUMMARY_CHARS + 80} 字符）`,
          ).toBeLessThanOrEqual(EXTRACTION_TOOL_SUMMARY_CHARS + 80);
        }
      }
    }

    /* 反向对照：短结果不摘要（不是"所有工具结果都砍掉"） */
    const short = summarizeToolResult("短结果");
    expect(short.summarized).toBe(false);
    expect(short.text).toBe("短结果");
    const long = summarizeToolResult("x".repeat(1000), 100);
    expect(long.summarized).toBe(true);
    expect(long.text.length).toBeLessThan(200);
  });

  it("MEM-EXTRACT-TIER-3：tier 分类本身（Human/Final/Agent/Commentary/Context/Tool）", () => {
    expect(extractionTierOf({ role: "user" })).toBe("human");
    expect(extractionTierOf({ role: "assistant" }, true)).toBe("final");
    expect(
      extractionTierOf({ role: "assistant", toolCalls: [toolCall("t", "ok")] }),
      "带已完成工具调用的助手步 ⇒ Agent",
    ).toBe("agent");
    expect(extractionTierOf({ role: "assistant" }), "非最终、无工具调用 ⇒ Commentary").toBe("commentary");
    expect(extractionTierOf({ role: "weird" }), "角色不认识 ⇒ Context").toBe("context");
    expect(extractionTierOf({ role: "tool" })).toBe("tool");
    expect(
      extractionTierOf({ role: "assistant", toolCalls: [toolCall("t", "ok")] }, true),
      "一轮最后一条助手消息即便是工具步也算 Final（优先级更高）",
    ).toBe("final");
  });
});

describe("MEM-EXTRACT-BUDGET：min(8MB, 窗口 70%) + 头尾保留 + 有界截断", () => {
  it("MEM-EXTRACT-BUDGET-1：预算取小（窗口 70% vs 8MB），窗口未知退回 8MB", () => {
    /* 128k token 窗口：0.7×128000×4 = 358400 字节 < 8MB ⇒ 取窗口值 */
    expect(extractionBudgetBytes(128_000), "小窗口时窗口 70% 才是约束").toBe(Math.floor(128_000 * 0.7 * 4));
    /* 超大窗口：8MB 才是约束 */
    expect(extractionBudgetBytes(10_000_000), "大窗口时 8MB 是硬上限").toBe(EXTRACTION_MAX_INPUT_BYTES);
    /* 拿不到窗口：退回 8MB（不静默按 0 关掉提取） */
    expect(extractionBudgetBytes(undefined)).toBe(EXTRACTION_MAX_INPUT_BYTES);
    expect(extractionBudgetBytes(0)).toBe(EXTRACTION_MAX_INPUT_BYTES);
    expect(extractionBudgetBytes(Number.NaN)).toBe(EXTRACTION_MAX_INPUT_BYTES);
  });

  it("MEM-EXTRACT-BUDGET-2a：头 10 + 尾 40 保留（中间按 tier 选）", () => {
    const messages: Msg[] = [];
    for (let i = 0; i < 100; i += 1) {
      messages.push(filler(`x${i}`, i % 2 ? "assistant" : "user", `EARLY_${i}_` + "填充。".repeat(50)));
    }
    const sample = sampleExtractionMessages(messages, {
      budgetBytes: 100_000,
      headKeep: EXTRACTION_HEAD_KEEP,
      tailKeep: EXTRACTION_TAIL_KEEP,
    });
    const ids = new Set(idsOf(sample));
    for (let i = 0; i < EXTRACTION_HEAD_KEEP; i += 1) {
      expect(ids.has(`x${i}`), `头第 ${i} 条必须保留（早期事实只在这里）`).toBe(true);
    }
    for (let i = 100 - EXTRACTION_TAIL_KEEP; i < 100; i += 1) {
      expect(ids.has(`x${i}`), `尾第 ${i} 条必须保留（最近进展）`).toBe(true);
    }
    expect(sample.stats.headKept).toBe(EXTRACTION_HEAD_KEEP);
    expect(sample.stats.tailKept).toBe(EXTRACTION_TAIL_KEEP);
  });

  it("MEM-EXTRACT-BUDGET-2b：头尾自身超预算 ⇒ 等分截断、仍保留头尾、标注截断且总字节有界", () => {
    const messages: Msg[] = [];
    for (let i = 0; i < 50; i += 1) {
      messages.push(filler(`big${i}`, i % 2 ? "assistant" : "user", `BIG_${i}:` + "超长正文。".repeat(2000)));
    }
    const budget = 20_000; // 50 条 × ~6KB 正文 ≫ 预算
    const sample = sampleExtractionMessages(messages, { budgetBytes: budget });
    const text = JSON.stringify(sample.messages);

    expect(sample.stats.selectedBytes, "必须 ≤ 预算（有界）").toBeLessThanOrEqual(budget);
    expect(idsOf(sample), "头尾一条都不许丢（超预算时等分截断）").toHaveLength(50);
    expect(sample.stats.truncatedMessages, "必须有消息被截断").toBeGreaterThan(0);
    expect(text, "截断必须标注（模型/日志都能看见）").toContain(EXTRACTION_TRUNCATION_MARK);
    expect(sample.stats.truncated).toBe(true);
    expect(sample.stats.budgetExhausted).toBe(true);
    /* 每一条都还能认出自己（截断只切正文，不切 id/角色） */
    for (const i of [0, 25, 49]) expect(idsOf(sample)).toContain(`big${i}`);
  });

  it("MEM-EXTRACT-BUDGET-2c：预算为 0 时返回空集并如实计数（不假装没消息）", () => {
    const { messages } = fixture();
    const sample = sampleExtractionMessages(messages, { budgetBytes: 0 });
    expect(sample.messages).toHaveLength(0);
    expect(sample.stats.inputCount).toBe(messages.length);
    expect(sample.stats.budgetExhausted).toBe(true);
    expect(sample.stats.selectedBytes).toBe(0);
  });

  it("MEM-EXTRACT-BUDGET-2d：纯函数不改调用方的消息对象（工具结果原文仍在入参里）", () => {
    const { messages } = fixture();
    const before = JSON.stringify(messages);
    sampleExtractionMessages(messages, { budgetBytes: 50_000 });
    expect(JSON.stringify(messages), "取样必须返回副本，不许改调用方持有的对象").toBe(before);
  });
});

/**
 * 接线判据：**真实 `extractMemoriesFromSession`** 的请求里也要有摘要 / 截断标记。
 *
 * 变异自证：把 `sourceMessages: sample.messages` 改成 `extractionSource` ⇒
 * 工具原文长尾与超长正文原样进请求 ⇒ `TOOL_RAW` 长尾与截断标记断言一起红。
 */
describe("MEM-EXTRACT-BUDGET-3（接线）：真实提取请求用取样结果（摘要 + 截断标注）", () => {
  let port: ReturnType<typeof createFakeStoragePort>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
    setStoragePort(port);
    saveMemory("");
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("MEM-EXTRACT-BUDGET-3：请求里工具结果已摘要、超长正文有截断标记", async () => {
    setSettingJSON(`memory-enabled-${SESSION}`, true);
    setSetting("memory-write-approval", JSON.stringify({ platform: true, project: true, conversation: false }));
    const svc = new MemoryService();

    const longUserText = "USER_LONG:" + "用户粘贴的巨长正文。".repeat(60_000); // ~1.4MB > 358KB 预算
    const messages: Msg[] = [];
    /* 头 10 条里放工具步（head 保留 ⇒ 摘要必然出现在请求里） */
    for (let i = 0; i < 5; i += 1) messages.push(filler(`f${i}`, i % 2 ? "assistant" : "user", `小消息 ${i}`));
    messages.push(
      filler("toolstep", "assistant", "读文件", {
        toolCalls: [toolCall("tc-1", "工具读出来的文件正文。".repeat(10_000) + "TOOL_TAIL_MARKER")],
      }),
    );
    for (let i = 5; i < 10; i += 1) messages.push(filler(`f${i}`, i % 2 ? "assistant" : "user", `小消息 ${i}`));
    for (let i = 0; i < 6; i += 1) messages.push(filler(`g${i}`, i % 2 ? "assistant" : "user", `填充 ${i}`));
    messages.push(filler("big-user", "user", longUserText));
    messages.push(filler("last", "assistant", "最后一条"));

    vi.spyOn(MessageStorage, "listMessages").mockReturnValue(messages as never);
    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    const provider = {
      id: "tier-budget-provider",
      isConfigured: () => true,
      complete: async () => ({ content: "[]" }),
      listModels: async () => [],
      fetchModelsFromServer: async () => [],
      async *stream() {
        yield { type: "text_delta", text: "x" };
        yield { type: "end", finishReason: "stop" };
      },
    };
    (engine as unknown as { providers: unknown }).providers = { get: () => provider };
    (engine as unknown as { profileManager: unknown }).profileManager = {
      resolveSlot: () => ({ provider: "tier-budget-provider", model: "tier-budget-model" }),
    };

    let captured: Array<Record<string, any>> = [];
    vi.spyOn(engine, "spawnForked").mockImplementation((async (
      _sid: string,
      _sys: string,
      _prompt: string,
      opts: { sourceMessages?: ReadonlyArray<Record<string, any>> },
    ) => {
      captured = (opts?.sourceMessages ?? []).map((m) => ({ ...m }));
      return "[]";
    }) as never);

    /* 窗口压小：让 70% 预算真的成为约束（否则 8MB 下 1.4MB 也放得下） */
    const { getTokenTracker } = await import("../core/llm/token-tracker");
    getTokenTracker().setContextWindow(24_000); // 0.7×24000×4 = 67200 字节

    await engine.extractMemoriesFromSession(SESSION, PROJ, { force: true });

    expect(captured.length, "必须真的把样本递给 forked agent").toBeGreaterThan(0);
    const text = JSON.stringify(captured);
    expect(text, "工具结果必须已被摘要").toContain(EXTRACTION_TOOL_SUMMARY_MARK);
    expect(
      text.includes("TOOL_TAIL_MARKER"),
      "工具原文的**尾部**不许进请求（摘要只保留开头 400 字符）",
    ).toBe(false);
    expect(text, "超长正文必须被预算截断并标注").toContain(EXTRACTION_TRUNCATION_MARK);
    /* 头尾保留：头 10 条与最后一条都还在 */
    expect(text, "头 10 条保留").toContain("小消息 0");
    expect(text, "最后一条保留").toContain("最后一条");
    getTokenTracker().setContextWindow(128_000);
  });
});

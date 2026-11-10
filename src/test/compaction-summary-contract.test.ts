/**
 * 24 号文 P1-2：**摘要质量与阈值**的判据（COMPACT-1 / COMPACT-2 / 连压上限）。
 *
 * ## 守什么
 *
 * 1. `COMPACT-2`：压缩 marker **不许**宣称「已移除」旧消息（检查点模式下一条都没删），
 *    且必须给出取回入口（`thread_history_search` / `thread_history_read`）；
 * 2. `COMPACT-1`：摘要正文 ≤ `COMPACTION_SUMMARY_MAX_CHARS`（4–6K 取 6K 上沿），
 *    且裁剪**保住每个结构化段落的标题**（不是一刀切掉尾部段落）；历史消息仍完整；
 * 3. **连续压缩上限 = 2**（24 §P1-2）：一个常量、两条触发路径 + 硬结论共用它；
 *    不许再出现写死的 `3`。
 *
 * ## 变异自证（把实现改坏，判据必须红）
 *
 * - 把 `composeCompactionMarkerText` 的收尾文案改回「已移除 N 条旧消息」⇒ COMPACT-2 红；
 * - 去掉 `clampCompactionSummary` 调用（或把上限改成 8000+）⇒ COMPACT-1 红；
 * - 把 `MAX_CONSECUTIVE_COMPACTIONS` 改回 3、或使用点改回写死的 3 ⇒ 上限判据红。
 *
 * ⚠️ 键名/字段名一律加引号（本仓踩过：带中文/括号的裸键会让 esbuild 直接报错）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import {
  clampCompactionSummary,
  composeCompactionMarkerText,
  COMPACTION_MARKER_READ_HINT,
  COMPACTION_SUMMARY_MAX_CHARS,
  MAX_CONSECUTIVE_COMPACTIONS,
} from "../core/llm/compaction-budget";

const listMessagesMock = vi.fn();
const createMessageMock = vi.fn();

vi.mock("../core/storage/message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/storage/message")>();
  return {
    isHiddenStateAuthoritative: () => true,
    ...actual,
    listMessages: (...a: unknown[]) => listMessagesMock(...a),
    listVisibleMessages: (...a: unknown[]) => listMessagesMock(...a),
    createMessage: (...a: unknown[]) => createMessageMock(...a),
    deleteMessagesByIds: vi.fn(),
    getLastDeleteReport: vi.fn(() => ({ requested: 0, unresolved: 0, sessions: [], softDeleteResponded: true })),
    getLastPersistError: () => null,
    flushPendingPersist: async () => true,
  };
});

vi.mock("../core/storage/session-jsonl", () => ({
  appendSessionMessage: async () => {},
  appendMessageTombstone: async () => {},
  readSessionMessages: () => [],
  hiddenFlagOf: () => 0,
  trimmedFlagOf: () => 0,
  isCompressedHidden: () => false,
  durableMessageIds: async () => [],
  flushSessionLogWrites: async () => {},
}));

/** 8 段结构化摘要的段名（`buildCompactionInstruction` 要求 EXACTLY 这些段落） */
const SUMMARY_SECTIONS = [
  "主要请求和意图",
  "关键技术和概念",
  "文件和代码",
  "错误和修复",
  "待办任务",
  "当前工作",
  "下一步",
  "关键上下文",
] as const;

/** 造一份"模型超长输出"：每段 1200 字符 ⇒ 总长约 9.6K（超过 6K 上限） */
function hugeStructuredSummary(): string {
  return SUMMARY_SECTIONS.map((name, index) => `## ${name}\n${`第${index}段`.repeat(400)}`).join("\n\n");
}

function makeMessages(turns: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let t = 0; t < turns; t++) {
    out.push({ id: `u${t}`, role: "user", content: `第 ${t} 轮：${"问".repeat(4000)}`, timestamp: t * 10 });
    out.push({
      id: `a${t}`,
      role: "assistant",
      content: `第 ${t} 轮回答：${"答".repeat(4000)}`,
      timestamp: t * 10 + 1,
      toolCalls: [{ id: `tc${t}`, tool: "read", args: { path: `f${t}` }, result: "结果".repeat(200) }],
    });
  }
  return out;
}

function makeLoop() {
  const provider = {
    id: "test-provider",
    name: "Test",
    async *stream() {
      yield { type: "text_end", text: "" };
    },
    async complete() {
      return {
        content: hugeStructuredSummary(),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      };
    },
    async listModels() {
      return [];
    },
    isConfigured() {
      return true;
    },
  };
  return new AgenticLoop(provider as never, createDefaultToolRegistry(), {
    model: "test-model",
    maxIterations: 1,
  } as never);
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  listMessagesMock.mockReset();
  createMessageMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("COMPACT-2：压缩 marker 不许宣称「已移除」旧消息", () => {
  it("纯函数：文案如实说「已折叠（不是删除）」并给出取回入口，同时保留两个计数", () => {
    const text = composeCompactionMarkerText({
      summary: "## 检查点摘要\n- 结论：方案是 X",
      removedCount: 30,
      keptCount: 8,
      summarizedCount: 20,
      middleCount: 10,
      overflowCount: 0,
    });

    expect(text, "检查点模式下旧消息一条都没被删除 —— 「已移除」是与事实相反的陈述").not.toContain("已移除");
    expect(text, "必须说清是「折叠进摘要」而不是删除").toContain("已折叠进本段摘要（不是删除）");
    expect(text, "必须给出模型可用的回读工具名").toContain("thread_history_search");
    expect(text).toContain("thread_history_read");
    expect(text, "必须说清原文仍在时间线").toContain("原文仍在时间线");
    expect(text, "removedCount 事实仍要写出来").toContain("较早的 30 条消息");
    expect(text, "keptCount 事实仍要写出来").toContain("保留最近 8 条");
    expect(text.endsWith(COMPACTION_MARKER_READ_HINT), "尾部回读提示保持不变（稳定前缀/解析不受影响）").toBe(true);
  });

  it("行为：真实压缩产出的 marker 也不含「已移除」", async () => {
    const messages = makeMessages(20);
    listMessagesMock.mockReturnValue(messages);
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    await loop.compactMessages("s-compact2");

    const marker = String(createMessageMock.mock.calls[0]?.[0]?.content ?? "");
    expect(marker, "前提：确实写了一条 marker").toContain("[上下文已自动压缩]");
    expect(marker).not.toContain("已移除");
    expect(marker).toContain("thread_history_search");
  });
});

describe("COMPACT-1：摘要 ≤6K，且结构化段落保留、旧消息完整", () => {
  it("纯函数：超长摘要被裁到上限以内，8 个段落标题一个不少", () => {
    const huge = hugeStructuredSummary();
    expect(huge.length, "前提：夹具确实超过上限").toBeGreaterThan(COMPACTION_SUMMARY_MAX_CHARS);

    const clamped = clampCompactionSummary(huge, COMPACTION_SUMMARY_MAX_CHARS);
    expect(clamped.length).toBeLessThanOrEqual(COMPACTION_SUMMARY_MAX_CHARS);
    for (const name of SUMMARY_SECTIONS) {
      expect(clamped, `段落标题「${name}」必须保留（头截会整段丢掉「下一步/当前工作」）`).toContain(`## ${name}`);
    }
    expect(clamped, "裁剪必须可见（不静默）").toContain("已按字符预算裁剪");
  });

  it("纯函数：短摘要原样返回（不多写一个字符）", () => {
    const short = "## 主要请求和意图\n- 修好 P1-2";
    expect(clampCompactionSummary(short)).toBe(short);
  });

  it("行为：LLM 写出 6K+ 摘要时，marker 里的检查点段 ≤6K、标题齐全、旧消息一条没删", async () => {
    /* 轮数要够多：待压集分成「中间档（确定性）」与「更早（LLM 摘要）」两段，
       轮数太少时更早档为空 ⇒ 一次 LLM 都不调（那是既有设计，不是本判据的被守面）。 */
    const messages = makeMessages(60);
    listMessagesMock.mockReturnValue(messages);
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    const removed = await loop.compactMessages("s-compact1");
    expect(removed, "前提：这次真的压了").toBeGreaterThan(0);

    const marker = String(createMessageMock.mock.calls[0]?.[0]?.content ?? "");
    const start = marker.indexOf("## 检查点摘要");
    expect(start, "marker 里必须有检查点摘要段").toBeGreaterThanOrEqual(0);
    const afterHeading = marker.indexOf("\n", start) + 1;
    /**
     * ⚠️ 摘要正文**自己就带 `## ` 子标题**（8 段结构），所以不能用「下一个 `## `」当结束符
     * （那只会量到第一个子标题之前）。结束符必须是**标记自己的段头**或尾部分隔线。
     */
    const endCandidates = ["## 之前的摘要", "## 中间档结构化要点", "## 更早的历史", "## 会话笔记", "\n---\n"]
      .map((anchor) => marker.indexOf(anchor, afterHeading))
      .filter((index) => index >= 0);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : marker.length;
    /* 段头之后 `composeCompactionMarkerText` 固定先空一行再放正文 ⇒ 去掉那一个换行再量 */
    const summaryBody = marker.slice(afterHeading, end).replace(/^\n/, "").trimEnd();

    expect(
      summaryBody.length,
      `摘要正文 ${summaryBody.length} 字符 > 上限 ${COMPACTION_SUMMARY_MAX_CHARS}（压缩收益会被吃掉）；` +
        `尾部=${JSON.stringify(summaryBody.slice(-24))} start=${start} end=${end}`,
    ).toBeLessThanOrEqual(COMPACTION_SUMMARY_MAX_CHARS);
    for (const name of SUMMARY_SECTIONS) {
      expect(marker, `段落「${name}」不许整段消失`).toContain(`## ${name}`);
    }
    expect(
      messages.length,
      "检查点模式：旧消息仍是原样（压缩不删除、不隐藏）",
    ).toBe(120);
  });
});

describe("连续压缩上限：24 §P1-2 要求最多 2 次（一个常量）", () => {
  it("常量 = 2，且两条触发路径与硬结论都引用它（不许再写死 3）", () => {
    expect(MAX_CONSECUTIVE_COMPACTIONS, "24 §P1-2：连续压缩最多 2 次").toBe(2);
    const src = readFileSync(path.resolve(__dirname, "../core/llm/agentic-loop.ts"), "utf8");
    const uses = src.match(/MAX_CONSECUTIVE_COMPACTIONS/g) ?? [];
    expect(uses.length, "三处使用点：迭代前压力压缩 / 反应式溢出压缩 / 保留集装不下").toBeGreaterThanOrEqual(3);
    expect(src, "不许再有写死的 >= 3 熔断").not.toMatch(/consecutiveCompactions\s*>=\s*3/);
    expect(src, "不许再有写死的 = 3 顶格").not.toMatch(/consecutiveCompactions\s*=\s*3\s*;/);
  });
});

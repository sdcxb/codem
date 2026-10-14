/**
 * 第 228 波（用户要求，对标「最近 5–6 轮 100% 保留 + 压缩率随距离上升」）：
 * 把压缩从「近端一段逐字 + 其余**一律**压成一条摘要」改成**按距离分三档**。
 *
 * ## 三个缺陷（都在这一族里被钉住）
 *
 * ① **近端只按条数**：保留集 = `min(20, 总数)`，一条大文件读取 / 一段大粘贴就能让最近几轮
 *    **装不满 20 条** ⇒ 压缩切进最近几轮（用户那边：压完连「刚才在干什么」都答不上来）。
 *    ⇒ 现在叠加**轮次保底**：最近 `COMPACTION_MIN_KEEP_TURNS` 轮绝不切断（极端超长轮次按 60 条上限截断并记日志）。
 * ② **没有中间档**：第 11 条与第 800 条同样被丢进同一份 LLM 摘要。
 *    ⇒ 现在待压集分两段：最新的一端（`COMPACTION_MIDDLE_BAND_SIZE` 条）走**确定性结构化要点**
 *      （不调 LLM、保留路径/命令/错误/待办），更早的才走 LLM 检查点。
 * ③ **摘要输入掐中段**：超限时 `head 40% + tail 60%`，**中间整段省略** ——
 *    丢多少取决于「这次压了多少」而不是「多老」，而且那批**连摘要器都没看到**。
 *    ⇒ 现在按消息分块（每块 ≤ 60K 字符、最多 3 块）**滚动摘要、全覆盖**；连分块都装不下的
 *      **最老**部分降到「最低保真清单」，并在标记里**明写**它保真最低。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import {
  COMPACTION_MIDDLE_BAND_SIZE,
  COMPACTION_MIN_KEEP_TURNS,
  COMPACTION_MIN_KEEP_MAX,
  compactionMinKeep,
  composeCompactionMarkerText,
  countMessagesForRecentTurns,
  packPartsForSummary,
  planCompactionKeep,
} from "../core/llm/compaction-budget";

const listMessagesMock = vi.fn();
const deleteMessagesByIdsMock = vi.fn();
const createMessageMock = vi.fn();

vi.mock("../core/storage/message", () => ({
  listMessages: (...a: unknown[]) => listMessagesMock(...a),
  listVisibleMessages: (...a: unknown[]) => listMessagesMock(...a),
  deleteMessagesByIds: (...a: unknown[]) => deleteMessagesByIdsMock(...a),
  /** ★ 全量审计：手动压缩回执会读它（mock 必须覆盖被消费的公开面） */
  getLastDeleteReport: vi.fn(() => ({ requested: 0, unresolved: 0, sessions: [], softDeleteResponded: true })),
  createMessage: (...a: unknown[]) => createMessageMock(...a),
  getLastPersistError: () => null,
  flushPendingPersist: async () => true,
}));

/** 一轮 = 一条 user + 一条 assistant（外加可选的工具结果），与真机形态一致 */
function makeMessages(turns: number): Array<{ id: string; role: string; content: string; timestamp: number }> {
  const out: Array<{ id: string; role: string; content: string; timestamp: number }> = [];
  for (let t = 0; t < turns; t++) {
    out.push({ id: `u${t}`, role: "user", content: `第 ${t} 轮：${"问".repeat(200)}`, timestamp: t * 10 });
    out.push({ id: `a${t}`, role: "assistant", content: `第 ${t} 轮回答：${"答".repeat(200)}`, timestamp: t * 10 + 1 });
  }
  return out;
}

let summaryCalls = 0;

function makeLoop() {
  const provider = {
    id: "test-provider",
    name: "Test",
    async *stream() {
      yield { type: "text_end", text: "" };
    },
    async complete() {
      summaryCalls += 1;
      return { content: `检查点#${summaryCalls}`, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
    },
    async listModels() {
      return [];
    },
    isConfigured() {
      return true;
    },
  };
  return new AgenticLoop(provider as never, createDefaultToolRegistry(), { model: "test-model", maxIterations: 1 } as never);
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  listMessagesMock.mockReset();
  deleteMessagesByIdsMock.mockReset();
  createMessageMock.mockReset();
  summaryCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("CG：按距离分档的压缩（第 228 波）", () => {
  it("CG-1（纯函数）：最近 N 轮覆盖多少条 —— 找不到那么多轮就全留着", () => {
    const msgs = makeMessages(10);
    expect(countMessagesForRecentTurns(msgs, 3), "最近 3 轮 = 最后 3 条 user 起算，共 6 条").toBe(6);
    expect(countMessagesForRecentTurns(msgs, 1), "最近 1 轮 = 2 条").toBe(2);
    expect(countMessagesForRecentTurns(msgs, 99), "user 不够 99 条 ⇒ 全部留着（保守）").toBe(msgs.length);
    expect(countMessagesForRecentTurns([], 3)).toBe(0);

    const floor = compactionMinKeep(msgs, 4);
    expect(floor.minKeep, "保底取 max(条数下限, 轮次覆盖)").toBe(6);
    expect(floor.cappedByMax, "6 条没到上限").toBe(false);
  });

  it("CG-2（纯函数）：极端超长轮次 ⇒ 轮次保底被 60 条上限截断（并如实报告）", () => {
    const msgs: Array<{ role: string }> = [];
    /* 一轮 = 一条 user + 200 条 assistant 工具回执（真机的「大输出刷屏」形态） */
    msgs.push({ role: "user" });
    for (let i = 0; i < 200; i++) msgs.push({ role: "assistant" });
    const floor = compactionMinKeep(msgs, 4);
    expect(floor.turnsCovered, "如实报告「最近 1 轮」其实有 201 条").toBe(201);
    expect(floor.cappedByMax, "超过上限 ⇒ 必须报告被截断").toBe(true);
    expect(floor.minKeep, "按上限截断").toBe(COMPACTION_MIN_KEEP_MAX);
    expect(COMPACTION_MIN_KEEP_TURNS).toBeGreaterThanOrEqual(2);
  });

  it("CG-3（纯函数）：轮次保底**压得住 token 收缩** —— 收缩不许切进最近几轮", () => {
    const estimate = (n: number) => n * 1000; // 每条 1000 token
    const plan = planCompactionKeep({
      totalMessages: 100, desiredKeep: 20, budget: 3000, minKeep: 6,
      estimate, align: (d) => d,
    });
    expect(plan.keepCount, "预算只够 3 条也不许低于轮次保底 6 条").toBe(6);
    expect(plan.shrunk).toBe(true);
    expect(plan.overBudget, "连保底都超预算 ⇒ 如实报告（调用方会按'压缩无效'上报）").toBe(true);

    const noFloor = planCompactionKeep({
      totalMessages: 100, desiredKeep: 20, budget: 3000, minKeep: 2,
      estimate, align: (d) => d,
    });
    expect(noFloor.keepCount, "反向对照：没有轮次保底时确实会收缩到更低").toBeLessThan(plan.keepCount);
  });

  it("CG-4（纯函数）：分块**全覆盖** —— 溢出的是「最老的」，不是被丢掉", () => {
    const parts = Array.from({ length: 10 }, (_, i) => `P${i}:` + "x".repeat(90));
    const { chunks, overflow, consumed } = packPartsForSummary(parts, 300, 2);
    expect(chunks.length, "块数不许超过上限").toBe(2);
    for (const c of chunks) expect(c.length, "每块都不超过上限").toBeLessThanOrEqual(300 + 100);
    expect(consumed, "要如实报告吃掉了几个分片（调用方据此找出溢出的消息）").toBe(6);
    expect(overflow.length, "装不下的部分必须被**返回**（由调用方降级渲染，不许静默丢）").toBeGreaterThan(0);
    expect(overflow.join("")).toContain("P8", "溢出的是最新的？不对 —— 分片是「最老在前」，先装的是最老的");

    const all = packPartsForSummary(parts, 100000, 2);
    expect(all.overflow, "装得下就没有溢出").toEqual([]);
    expect(all.consumed).toBe(parts.length);
  });

  it("CG-5（纯函数）：标记把三档**写清楚**（每档覆盖多少条、保真度高低）", () => {
    const text = composeCompactionMarkerText({
      summary: "S", middleDigest: "M", overflowDigest: "O",
      removedCount: 120, keptCount: 20, summarizedCount: 80, middleCount: 20, overflowCount: 20,
    });
    expect(text).toContain("[上下文已自动压缩]");
    expect(text, "第一档要写明覆盖多少条「).toContain(」覆盖较早的 80 条");
    expect(text, "第二档要说明它不是逐字原文").toMatch(/中间档结构化要点（覆盖较近的 20 条；确定性渲染，不是逐字原文）/);
    expect(text, "第三档要明写保真度最低").toMatch(/更早的历史（20 条，保真度最低/);
    expect(text, "收尾要写清移除/保留与「最近几轮不切断」").toContain("保留最近 20 条（按轮次边界对齐：最近几轮不切断）");

    const noBands = composeCompactionMarkerText({ summary: "S", removedCount: 5, keptCount: 4, summarizedCount: 5, middleCount: 0, overflowCount: 0 });
    expect(noBands, "没有中间档就不该出现那一节「).not.toContain(」中间档结构化要点");
    expect(noBands).not.toContain("更早的历史");
  });

  it("CG-6（行为）：真跑一次压缩 —— 近端几轮**没被删**、中间档走确定性要点、摘要按块调用", async () => {
    const messages = makeMessages(40); // 80 条
    listMessagesMock.mockReturnValue(messages);
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };

    const removed = await loop.compactMessages("s-cg");
    expect(removed, "确实移除了旧消息").toBeGreaterThan(0);

    const removedIds: string[] = deleteMessagesByIdsMock.mock.calls[0][0];
    const lastTurnIds = ["u38", "a38", "u39", "a39"];
    expect(removedIds.filter((id) => lastTurnIds.includes(id)), "最近两轮（4 条）绝不许被删").toEqual([]);

    const marker = String(createMessageMock.mock.calls[0][0].content);
    expect(marker, "标记里要有 LLM 检查点那一档").toContain("## 检查点摘要");
    expect(marker, "待压集有 80-N 条 ⇒ 中间档必然存在（确定性要点）").toContain("## 中间档结构化要点");
    expect(marker, "中间档覆盖条数不超过上限").toMatch(new RegExp(`覆盖较近的 ${COMPACTION_MIDDLE_BAND_SIZE} 条`));
    expect(marker, "保真度必须写在标记里（模型据此决定要不要重新读文件）").toContain("不是逐字原文");
    expect(summaryCalls, "这条会话不大 ⇒ 摘要只调一次（分块只在超限时才用）").toBe(1);
  });

  it("CG-8（行为）：最近几条**很大**时，token 收缩也必须停在轮次边界（不许切进最近 3 轮）", async () => {
    /*
     * 真机形态：最近几轮里有大文件读取 / 大段粘贴 ⇒ "保留集"自己就把 token 预算吃光。
     * 旧实现只按条数收缩（20 → 10 → 5 → 4）⇒ 会切进第 3 轮；现在收缩停在轮次保底（6 条 = 3 轮）。
     */
    const messages = makeMessages(40);
    /* 最后 3 轮（u37..a39 共 6 条）每条 200k 字符 ⇒ 光它们就远超保留预算 */
    for (const m of messages) {
      if (["u37", "a37", "u38", "a38", "u39", "a39"].includes(m.id)) m.content = "大".repeat(200_000);
    }
    listMessagesMock.mockReturnValue(messages);
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    await loop.compactMessages("s-cg8");

    const removedIds: string[] = deleteMessagesByIdsMock.mock.calls[0][0];
    expect(
      removedIds.filter((id) => ["u37", "a37", "u38", "a38", "u39", "a39"].includes(id)),
      "最近 3 轮（6 条）一条都不许被删 —— token 预算再紧也只能切更老的部分",
    ).toEqual([]);
  });

  it("CG-9（行为）：一次压缩要吃掉**超长历史**时 ⇒ 分块滚动摘要（全覆盖，不是只摘要第一块）", async () => {
    const messages = makeMessages(40); // 80 条 ⇒ 保留 20、待压 60；"更早档"= 最老的 40 条
    /*
     * 让"更早档"这 40 条**每条都接近单条上限**（8000 字符）⇒ 合计 ~32 万字符 ≈ 6 块，
     * 超过分块上限 3 ⇒ 必然出现"装不下的最老部分降级成最低保真清单"。
     */
    for (let i = 0; i < 40; i++) messages[i].content = `第 ${i} 条：` + "中".repeat(9000);
    listMessagesMock.mockReturnValue(messages);
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    await loop.compactMessages("s-cg9");

    expect(summaryCalls, "分块上限 3 ⇒ 只调 3 次（装不下的最老那块降级成最低保真清单，而不是静默丢）").toBe(3);
    const marker = String(createMessageMock.mock.calls[0][0].content);
    expect(marker, "滚动摘要要保留**最后一块**的结果（最新一轮摘要覆盖最全）").toContain(`检查点#${summaryCalls}`);
    expect(marker, "装不下的那部分必须以「更早的历史」出现（明写保真度最低）").toContain("## 更早的历史");
    expect(marker, "并如实写出它覆盖多少条").toMatch(/更早的历史（\d+ 条，保真度最低/);
  });

  it("CG-7（结构棘轮）：三处接线都在（近端轮次保底 / 中间档 / 分块全覆盖）", () => {
    const loopSrc = readFileSync(path.resolve(__dirname, "../core/llm/agentic-loop.ts"), "utf8");
    const budgetSrc = readFileSync(path.resolve(__dirname, "../core/llm/compaction-budget.ts"), "utf8");
    const monitorSrc = readFileSync(path.resolve(__dirname, "../components/ContextMonitor.tsx"), "utf8");

    expect(loopSrc, "自动压缩要用轮次保底算 minKeep（且要在**真实消息**上数：压缩标记也是 role=user）").toContain("compactionMinKeep(realMessages, MIN_KEEP_MESSAGES)");
    expect(loopSrc, "待压集要切成中间档 + 更早两段").toMatch(/middleBand = messagesToRemove\.slice\(middleStart\)/);
    expect(loopSrc, "摘要要逐块滚动（全覆盖，不再掐中段）").toMatch(/for \(const chunk of packed\.chunks\)/);
    expect(loopSrc, "中间档走确定性渲染器（与手动压缩同一份实现）").toMatch(
      /renderStructuredHistorySummary\(\s*middleForDigest as never\[\]/,
    );
    expect(loopSrc, "中间档要点必须过滤压缩标记（否则同一份旧摘要进上下文两遍）").toContain(
      "middleBand.filter((m: any) => !isCompactionMarker(m))",
    );
    expect(loopSrc, "标记排版收敛到 composeCompactionMarkerText（不许再手拼字符串）").toContain("composeCompactionMarkerText({");
    expect(budgetSrc, "分块函数必须把溢出**返回**而不是丢掉").toMatch(/overflow: chunks\.slice\(chunkBudget\)/);
    expect(monitorSrc, "手动压缩同样要按轮次保底（两处一条口径），且要在**真实消息**上数（压缩标记不算一轮）").toContain("compactionMinKeep(messages.filter((m) => !isCompactionMarker(m)), 4)");
  });
});

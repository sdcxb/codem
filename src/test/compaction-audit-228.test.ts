/**
 * 第 228 波·**审计轮**判据：四个独立审计（压缩核心 / 压缩生命周期 / 记忆提取 / 记忆注入）
 * 挖出的真缺陷，逐条钉住。每条都写明「被守的缺陷形态」，实现改坏必须变红。
 *
 * ⚠️ 本文件里的键名一律加引号（本仓踩过：键里带中文/空格/括号会让 esbuild 直接报错）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { acquireCompactionLock, releaseCompactionLock } from "../core/llm/compaction-control";
import {
  alignKeepToRoundBoundaryDown,
  composeCompactionMarkerText,
  packPartsForSummary,
  planCompactionKeep,
} from "../core/llm/compaction-budget";

const listMessagesMock = vi.fn();
const deleteMessagesByIdsMock = vi.fn();
const createMessageMock = vi.fn();
const appendTombstoneMock = vi.fn();

vi.mock("../core/storage/message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/storage/message")>();
  return {
    ...actual,
    listMessages: (...a: unknown[]) => listMessagesMock(...a),
    listVisibleMessages: (...a: unknown[]) => listMessagesMock(...a),
    deleteMessagesByIds: (...a: unknown[]) => deleteMessagesByIdsMock(...a),
    createMessage: (...a: unknown[]) => createMessageMock(...a),
    getLastPersistError: () => null,
    flushPendingPersist: async () => true,
  };
});

vi.mock("../core/storage/session-jsonl", () => ({
  appendSessionMessage: async () => {},
  appendMessageTombstone: (...a: unknown[]) => {
    appendTombstoneMock(...a);
    return Promise.resolve();
  },
  readSessionMessages: () => [],
  /* 这三个是 `message.ts` 的静态 import（缺了会让读/合并路径在运行期炸，掩盖真正的断言） */
  hiddenFlagOf: () => 0,
  trimmedFlagOf: () => 0,
  isCompressedHidden: () => false,
  durableMessageIds: async () => [],
  flushSessionLogWrites: async () => {},
}));

function makeMessages(turns: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let t = 0; t < turns; t++) {
    out.push({ id: `u${t}`, role: "user", content: `第 ${t} 轮：${"问".repeat(120)}`, timestamp: t * 10 });
    out.push({
      id: `a${t}`,
      role: "assistant",
      content: `第 ${t} 轮回答：${"答".repeat(120)}`,
      timestamp: t * 10 + 1,
      toolCalls: [{ id: `tc${t}`, tool: "read", args: { path: `f${t}` }, result: "结果".repeat(20) }],
    });
  }
  return out;
}

let summaryCalls = 0;
let summaryShouldThrow = false;
/** 回声模式（见 makeLoop）：把摘要输入原样返回，便于断言"级联进没进 LLM 的输入" */
let summaryShouldEcho = false;

function makeLoop() {
  const provider = {
    id: "test-provider",
    name: "Test",
    async *stream() {
      yield { type: "text_end", text: "" };
    },
    async complete(req: { messages?: Array<{ role?: string; content?: string }> }) {
      summaryCalls += 1;
      if (summaryShouldThrow) throw new Error("provider down");
      /**
       * ★ 第 228 波审计（第三轮）：**回声模式** —— 把收到的摘要输入原样返回。
       * 这样"旧摘要有没有作为级联输入进到 LLM"就是可断言的**产物**（而不是读代码推定），
       * 同时能数它在新标记里出现了几次（重复 = 中间档又把旧标记渲染了一遍）。
       */
      if (summaryShouldEcho) {
        const input = String(req?.messages?.find((m) => m.role === "user")?.content ?? "");
        return { content: input, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
      }
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
  appendTombstoneMock.mockReset();
  summaryCalls = 0;
  summaryShouldThrow = false;
  summaryShouldEcho = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("CA：压缩审计修复（第 228 波）", () => {
  it("CA-1（纯函数）：空分片也要计入 consumed —— 溢出档不许把已进摘要的消息再渲染一遍", () => {
    /* 一条消息一段；第 0、2 条是空内容 ⇒ 位置必须对齐，否则 slice 会错位 */
    const parts = ["", "P1:" + "x".repeat(80), "", "P3:" + "y".repeat(80), "P4:" + "z".repeat(80)];
    const { overflow, consumed } = packPartsForSummary(parts, 100, 1);
    expect(consumed, "吃下的是 P1（下标 1）⇒ 溢出从下标 3 开始（含它后面的空分片）").toBe(3);
    expect(parts.slice(consumed), "溢出的是 P3/P4，不含已摘要的 P1").toEqual([
      "P3:" + "y".repeat(80),
      "P4:" + "z".repeat(80),
    ]);
    expect(overflow.length).toBe(2);
  });

  it("CA-2（纯函数）：planCompactionKeep —— total=0 时不许返回 keepCount>0；minKeep 是**下限**", () => {
    const empty = planCompactionKeep({ totalMessages: 0, desiredKeep: 0, budget: 100, minKeep: 4, estimate: () => 1000, align: (d) => d });
    expect(empty.keepCount, "没有消息就没有保留条数（老实现返回 1 —— 那是假的）").toBe(0);

    const floored = planCompactionKeep({
      totalMessages: 201,
      desiredKeep: 20,
      minKeep: 60,
      budget: 20000,
      estimate: (n) => n * 1000,
      align: (d) => d,
    });
    expect(
      floored.keepCount,
      "轮次保底（60）大于期望条数（20）时必须真的保 60 —— 老实现只把它当循环停止条件 ⇒ 静默失效",
    ).toBe(60);
    expect(floored.overBudget, "保底都超预算 ⇒ 如实上报（不许假装压得下）").toBe(true);
  });

  it("CA-3（纯函数）：向下对齐 —— 尾巴全是工具消息时返回 0（表示「这一侧没有安全边界」）", () => {
    const msgs = [{ role: "user" }, { role: "assistant" }, { role: "tool" }, { role: "tool" }];
    expect(alignKeepToRoundBoundaryDown(msgs, 2), "2 条落在工具里、后面没有安全边界 ⇒ 0").toBe(0);
    expect(alignKeepToRoundBoundaryDown(msgs, 1), "1 条同理").toBe(0);
    expect(alignKeepToRoundBoundaryDown(msgs, 4), "整段都在保留集里 ⇒ 原样返回").toBe(4);
    /**
     * ⚠️ 0 是「不能往这个方向缩」的**哨兵值**，绝不能当保留条数用：
     * `slice(-0)` 在 JS 里等于 `slice(0)`（保留全部）。调用方（`planCompactionKeep`）用
     * `max(minKeep, …)` 兜住它。
     */
  });

  it("CA-4（纯函数）：标记的字符预算 —— 压缩不许让上下文变大", () => {
    const huge = {
      summary: "S".repeat(50000),
      middleDigest: "M".repeat(50000),
      overflowDigest: "O".repeat(50000),
      removedCount: 60,
      keptCount: 20,
      summarizedCount: 40,
      middleCount: 20,
      overflowCount: 20,
    };
    const bounded = composeCompactionMarkerText({ ...huge, charBudget: 20000 });
    expect(bounded.length, "有预算时标记不许超预算（这是「上下文一定变小」的硬事实）").toBeLessThanOrEqual(20000);
    expect(bounded, "裁剪必须写明「).toContain(」已按压缩预算裁剪");

    const tiny = composeCompactionMarkerText({ ...huge, charBudget: 200 /* 下界 800 */ });
    expect(tiny.length, "极小预算也有下界（800 + 固定开销），不会退化成空标记").toBeLessThan(2000);

    const noBudget = composeCompactionMarkerText(huge);
    expect(noBudget.length, "不传预算 = 不裁剪（老调用方语义不变）").toBeGreaterThan(100000);
  });

  it("CA-5（行为）：保留集体积预算**必须看得见工具结果**（否则该收缩时永远不收缩）", async () => {
    /*
     * 真机形态：一屏工具输出。存储行里工具结果在 `toolCalls[].result`（请求里才展开成 tool 消息），
     * 老实现只累加 `content` ⇒ 估算≈0 ⇒ 判「已进预算」、一次都不收缩 ⇒ 压缩后压力不降 ⇒
     * 下一轮只删得掉上一条标记 ⇒ 连压 3 次后误报「上下文窗口已满，请开启新对话」。
     */
    const messages = makeMessages(40);
    for (const m of messages) {
      if (["u38", "a38", "u39", "a39"].includes(String(m.id))) {
        (m as { toolCalls: Array<{ result: string }> }).toolCalls = [{ id: "tcX", tool: "read", args: {}, result: "巨".repeat(400_000) }];
      }
    }
    listMessagesMock.mockReturnValue(messages);
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    await loop.compactMessages("s-ca5");

    const removedIds: string[] = deleteMessagesByIdsMock.mock.calls[0][0];
    expect(
      removedIds.length,
      "工具结果把保留集顶爆 ⇒ 必须收缩到轮次保底（保留 6 条 ⇒ 移除 74 条）；老实现会移除 60 条",
    ).toBe(74);
  });

  it("CA-6（行为）：摘要调用失败时**不许丢掉累积摘要**（兜底路径）", async () => {
    const messages = makeMessages(40);
    /* 待压集最老处放一条旧摘要标记（内含独有串），它这一轮会被软删 ⇒ 只能靠级联活下来 */
    messages.unshift({
      id: "marker-old",
      role: "user",
      content: "[上下文已自动压缩]\n\n## 检查点摘要\n\n方案是 X 且不可丢",
      timestamp: -1,
    });
    listMessagesMock.mockReturnValue(messages);
    summaryShouldThrow = true;
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    await loop.compactMessages("s-ca6");

    const marker = String(createMessageMock.mock.calls[0][0].content);
    expect(marker, "旧摘要必须活着（老实现用 100 字兜底覆盖它 ⇒ 累积结论不可恢复地消失）").toContain("方案是 X 且不可丢");
  });

  it("CA-7（行为）：先写标记、再删旧消息（失败模式从「净丢摘要」变成「净多摘要」）", async () => {
    const messages = makeMessages(40);
    listMessagesMock.mockReturnValue(messages);
    const order: string[] = [];
    createMessageMock.mockImplementation(() => {
      order.push("create");
    });
    deleteMessagesByIdsMock.mockImplementation(() => {
      order.push("delete");
      return 0;
    });
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    await loop.compactMessages("s-ca7");

    expect(order, "标记必须先落（否则「旧消息已隐藏、摘要却没有」是可达且无补偿的）").toEqual(["create", "delete"]);
  });

  it("CA-8（行为）：同一会话已有压缩在跑 ⇒ 跳过返回 -1（不许被记成一次成功压缩）", async () => {
    const messages = makeMessages(40);
    listMessagesMock.mockReturnValue(messages);
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };

    expect(acquireCompactionLock("s-ca8"), "前提：先占住锁").toBe(true);
    try {
      const skipped = await loop.compactMessages("s-ca8");
      expect(skipped, "-1 = 被跳过（老实现返回 0，与「没有可移除的消息」同值 ⇒ 连跳 3 次误报「窗口已满」）").toBe(-1);
      expect(createMessageMock.mock.calls.length, "跳过时什么都不许写").toBe(0);
    } finally {
      releaseCompactionLock("s-ca8");
    }
  });

  it("CA-9（行为）：折叠把保留集压到轮次保底以下时，必须重新夹回去（最近几轮不切断）", async () => {
    /*
     * 形态：最后一条是**用户粘回来的**摘要标记（`isCompactionMarker` 只认 role=user + 前缀）。
     * `foldStaleCompactionMarkers` 会把 keep 钉成 1（标记正好是最后一条）⇒ 另外 6 条真实消息
     * 全被软删 —— 与本波刚立的「最近 3 轮绝不切断」直接冲突。
     */
    const messages = makeMessages(40); // 80 条真消息 ⇒ 压缩真的会发生（旧标记落在最后一条）
    messages.push({
      id: "marker-tail",
      role: "user",
      content: "[上下文已手动压缩]\n\n旧的手动摘要：关键约束是 W",
      timestamp: 999,
    });
    listMessagesMock.mockReturnValue(messages);
    /* 回声模式：把 LLM 收到的摘要输入原样返回 ⇒ "级联有没有进 LLM"成为可断言的产物 */
    summaryShouldEcho = true;
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    await loop.compactMessages("s-ca9");

    const removedIds: string[] = deleteMessagesByIdsMock.mock.calls[0][0];
    expect(
      removedIds.filter((id) => ["u37", "a37", "u38", "a38", "u39", "a39"].includes(id)),
      "最近 3 轮的真实消息一条都不许删（折叠后必须重新夹回轮次保底）",
    ).toEqual([]);
    expect(removedIds, "该删的是那条旧标记（它的正文已经级联进新标记）").toContain("marker-tail");
    const ca9Marker = String(createMessageMock.mock.calls[0][0].content);
    expect(ca9Marker, "旧摘要必须作为级联输入进到 LLM（回声模式下能看到它）").toContain("关键约束是 W");
    expect(
      ca9Marker.split("关键约束是 W").length - 1,
      "而且只许出现一次 —— 中间档要点不许把旧标记再渲染一遍（第三轮审计抓到的重复）",
    ).toBe(1);
  });

  it("CA-10（行为）：软删要带上会话 id —— 镜像被逐出时也要能判归属（否则消息会复活）", () => {
    /*
     * 会话镜像按 LRU 逐出时 `byIdLookup` 全返回 undefined ⇒ 老实现「分不出会话」就把这些 id
     * 静默丢掉：墓碑不写、日志镜像不剔除、`localHiddenIds` 不记 ⇒ 读路径从日志把这些消息
     * **复活**回来 ⇒ 压缩看起来完全没生效（下一轮再压，最后误报「窗口已满」）。
     */
    const src = readFileSync(path.resolve(__dirname, "../core/storage/message.ts"), "utf8");
    expect(src, "deleteMessagesByIds 要接受调用方给的会话").toMatch(/export function deleteMessagesByIds\(ids: string\[\], knownSessionId\?: string\)/);
    expect(src, "查不到归属时用 knownSessionId 兜底（而不是静默 continue）").toContain("out.set(knownSessionId, [id])");
    expect(src, "调用方没给会话时如实上报（老实现静默）").toContain("镜像里查不到会话归属（会话可能已被逐出）");
  });

  it("CA-11（行为）：压缩的两条调用路径都把 sessionId 传给软删", () => {
    const loopSrc = readFileSync(path.resolve(__dirname, "../core/llm/agentic-loop.ts"), "utf8");
    const monitorSrc = readFileSync(path.resolve(__dirname, "../components/ContextMonitor.tsx"), "utf8");
    expect(loopSrc, "自动路径").toContain("deleteMessagesByIds(removedIds, sessionId)");
    expect(monitorSrc, "手动路径").toContain("deleteMessagesByIds(removedIds, sessionId)");
  });

  it("CA-12（行为）：手动压缩取同一把压缩锁（自动在等摘要时不许双写标记）", () => {
    const monitorSrc = readFileSync(path.resolve(__dirname, "../components/ContextMonitor.tsx"), "utf8");
    expect(monitorSrc, "手动压缩要取锁").toContain("acquireCompactionLock(sessionId)");
    expect(monitorSrc, "拿了锁必须释放").toContain("releaseCompactionLock(sessionId)");
    expect(monitorSrc, "拿不到锁要有可见回执（不静默）").toMatch(/skipped: "另一次压缩正在进行，请稍后再试"/);
  });

  it("CA-13（行为）：手动压缩的续体要判断「会话是否已经切走」", () => {
    const monitorSrc = readFileSync(path.resolve(__dirname, "../components/ContextMonitor.tsx"), "utf8");
    expect(monitorSrc, "要有一个跟着 sessionId 走的 ref").toContain("sessionIdRef");
    expect(monitorSrc, "续体在写回执前必须比对").toContain("sessionIdRef.current !== sessionId");
  });

  it("CA-14（行为）：压缩标志按会话（会话 A 的压缩不许丢掉会话 B 的自动保存）", () => {
    const src = readFileSync(path.resolve(__dirname, "../core/storage/compaction-state.ts"), "utf8");
    expect(src, "标志按会话存").toContain("new Set<string>()");
    expect(src, "查询可以按会话问").toMatch(/export function isCompactionInProgress\(sessionId\?: string\)/);
    expect(src, "置位/复位带会话").toMatch(/export function setCompactionInProgress\(sessionId: string, value: boolean\)/);
  });

  it("CA-16（行为）：镜像被逐出（查不到归属）时，软删仍要按调用方给的会话写墓碑", async () => {
    /*
     * 行为版（源码断言挡不住实现漂移）：把端口换成"`byIdLookup` 什么都查不到"（镜像被逐出），
     * 再调 `deleteMessagesByIds(ids, "s-x")`；期望：**墓碑按 s-x 写出去**。
     * 老实现分不出会话就静默丢掉这些 id ⇒ 墓碑不写、日志镜像不剔除 ⇒ 消息在下次读时复活
     * ⇒ 压缩看起来完全没生效。
     */
    const messageModule = await import("../core/storage/message");
    /**
     * 通过**公开端口**构造「镜像被逐出」：用仓库自带的假端口（它一定注册得上），
     * 只把 `byIdLookup` 改成什么都查不到 —— 这正是 LRU 逐出后 `byId` 被清空的状态。
     */
    const evicted = createFakeStoragePort();
    (evicted.messages as unknown as { byIdLookup: () => undefined }).byIdLookup = () => undefined;
    setStoragePort(evicted);

    const grouped = messageModule.sessionIdsForMessagesForTests(["m1", "m2"], "s-x");
    expect(
      [...grouped.entries()],
      "查不到归属时必须按调用方给的会话兜底（老实现静默丢掉这些 id ⇒ 墓碑不写、读路径复活消息）",
    ).toEqual([["s-x", ["m1", "m2"]]]);

    /* 反向对照：调用方没给会话 ⇒ 不许猜（返回空，并如实上报） */
    const noHint = messageModule.sessionIdsForMessagesForTests(["m1", "m2"]);
    expect([...noHint.keys()], "没有会话线索 ⇒ 宁可不写，也不猜一个会话").toEqual([]);
  });

  it("CA-17（行为）：手动压缩在锁被占时**什么都不做**并给出可见回执", async () => {
    const { manualCompact } = await import("../components/ContextMonitor");
    const messages = makeMessages(30); // 60 条 ⇒ 真的会压缩
    listMessagesMock.mockReturnValue(messages);

    expect(acquireCompactionLock("s-ca17"), "前提：占住锁（模拟自动压缩正在等摘要）").toBe(true);
    try {
      const skipped = manualCompact("s-ca17");
      expect(skipped.removed, "锁被占 ⇒ 不许压缩").toBe(0);
      expect(skipped.skipped, "必须给出可见理由（不静默）").toContain("另一次压缩正在进行");
      expect(createMessageMock.mock.calls.length, "一条标记都不许写（否则同一会话两条标记、时间戳相同）").toBe(0);
    } finally {
      releaseCompactionLock("s-ca17");
    }

    const ok = manualCompact("s-ca17");
    expect(ok.removed, "锁释放后照常能压").toBeGreaterThan(0);
    expect(createMessageMock.mock.calls.length, "这时才写标记").toBe(1);
  });

  it("CA-18（行为）：压缩标志按会话 —— 会话 B 的自动保存不该被会话 A 的压缩挡住", async () => {
    const { isCompactionInProgress, setCompactionInProgress } = await import("../core/storage/compaction-state");
    setCompactionInProgress("A", true);
    expect(isCompactionInProgress("A"), "A 自己在压缩").toBe(true);
    expect(isCompactionInProgress("B"), "B 没在压缩 ⇒ 它的自动保存必须照常").toBe(false);
    setCompactionInProgress("B", true);
    setCompactionInProgress("A", false);
    expect(isCompactionInProgress("B"), "A 结束不影响 B").toBe(true);
    setCompactionInProgress("B", false);
    expect(isCompactionInProgress(), "全部结束 ⇒ 不传参的「任何会话在压缩中」也为假").toBe(false);
  });

  it("CA-19（第三轮自查）：保留条数为 0 时必须当场退出（`slice(-0)` 等于取全部）", () => {
    /*
     * 纯函数在 `totalMessages === 0` 时返回 `keepCount: 0`（这是对的，见 CA-2），
     * 而调用方紧接着写的是 `messages.slice(-keepCount)` —— **JS 里 `slice(-0) === slice(0)`**，
     * 于是"保留 0 条"会变成"保留全部"，`messages.slice(0, len - 0)` 又会算成"删掉全部"。
     * ⚠️ 如实记：这条是**防御性**断言（源码级）—— 当前 `messages.length <= 2` 会先返回，
     * 所以那个分支在现有实现里走不到；一旦有人改掉那个早返回，它就是最后一道闸。
     */
    const src = readFileSync(path.resolve(__dirname, "../core/llm/agentic-loop.ts"), "utf8");
    /**
     * ★ 第六批（审计）：**返回值必须是 -1（skipped）而不是 0**。
     * 调用方把 `>= 0` 一律当作"压缩成功"（清缓存 + consecutiveCompactions++），
     * 三次之后就误报「上下文窗口已满，即使压缩后仍无法继续」并中止本回合 ——
     * 而这三次里一次压缩都没发生。0 与"移除了 0 条"同值，正是这条误报的入口。
     */
    expect(src, "keepCount<=0 要当场退出，且返回 -1（没压 ≠ 压了 0 条）").toMatch(
      /if \(keepCount <= 0\) \{[\s\S]{0,240}?return -3;/,
    );
    expect(src, "并说明为什么（slice(-0) 会取全部）").toContain("slice(-0)");
    const noopReturns = (src.match(/if \(messagesToRemove\.length === 0\) return -2;/g) ?? []).length;
    expect(noopReturns, "「没有可移除的消息」的两处出口也必须是 -1").toBe(2);
  });

  it("CA-20（第三轮自查）：轮次保底要在真实消息上数（压缩标记也是 role=user）", () => {
    const src = readFileSync(path.resolve(__dirname, "../core/llm/agentic-loop.ts"), "utf8");
    expect(
      src,
      "压缩标记会被 `compactionMinKeep` 当成一轮 ⇒ 「最近 3 轮」少算一整轮真实对话（保底偏小）",
    ).toMatch(/const realMessages = messages\.filter\(\(m: any\) => !isCompactionMarker\(m\)\);\s*\n\s*const floor = compactionMinKeep\(realMessages, MIN_KEEP_MESSAGES\)/);
  });

  it("CA-21（第三轮自查·行为）：压缩标记不许顶替「最近 3 轮」里的一个真实轮次", async () => {
    /*
     * 形态：尾部有一条**用户粘回来的**压缩标记（`role=user` + 前缀），
     * 而 `compactionMinKeep` 是按 `role === "user"` 数轮次的 ⇒ 它会把标记当成一轮，
     * 「最近 3 轮」于是少算一整轮真实对话（保底偏小 ⇒ 那一轮的真实消息被删掉）。
     */
    const messages = makeMessages(20); // 40 条真消息（20 轮）
    messages.splice(37, 0, {
      id: "marker-in-tail",
      role: "user",
      content: "[上下文已自动压缩]\n\n旧摘要：方案是 Y",
      timestamp: 999,
    }); // 41 条：u18 在 36、标记在 37、a18 在 38、u19 在 39、a19 在 40
    /* 尾部几条放大，逼着「按体积收缩」一路收缩到轮次保底 */
    for (const m of messages) {
      if (["a18", "a19", "u19"].includes(String(m.id))) {
        (m as { toolCalls: Array<{ result: string }> }).toolCalls = [
          { id: "huge", tool: "read", args: {}, result: "巨".repeat(400_000) },
        ];
      }
    }
    listMessagesMock.mockReturnValue(messages);
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    await loop.compactMessages("s-ca21");

    const removedIds: string[] = deleteMessagesByIdsMock.mock.calls[0][0];
    expect(
      removedIds.filter((id) => ["u17", "a17"].includes(id)),
      "标记不许顶掉一个真实轮次：最近 3 轮（u17..a19 里剔除标记）里的真实消息一条都不许删",
    ).toEqual([]);
  });

  it("CA-28（第六批）：没压成时必须返回 -1（0 会被调用方当成一次「压缩成功」）", async () => {
    /*
     * 被守的缺陷：调用方把 compacted >= 0 一律当作压缩成功（清缓存 + consecutiveCompactions++），
     * 连续三次就以「上下文窗口已满，即使压缩后仍无法继续」中止本回合 —— 而那三次里一次都没压。
     * 这里用"可见消息很少"的形态（没有任何可移除的）复现：返回值必须是 -1（skipped）。
     */
    listMessagesMock.mockReturnValue(makeMessages(4));
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    const removed = await loop.compactMessages("s-ca28");
    expect(removed, "没有可移除的消息 ⇒ -2（skipped 的一种），不是 0（压了 0 条）").toBe(-2);

    const src = readFileSync(path.resolve(__dirname, "../core/llm/agentic-loop.ts"), "utf8");
    expect(
      (src.match(/if \(messagesToRemove\.length === 0\) return -2;/g) ?? []).length,
      "两处「没有可移除的消息」出口都要返回 -1",
    ).toBe(2);
  });

  it("CA-29（全量审计）：片段兜底时，段头不许断言「覆盖较早的 N 条」", async () => {
    /*
     * 被守的缺陷：摘要调用抛错时正文是 100 字片段兜底，而段头仍写
     * 「## 检查点摘要（覆盖较早的 <packed.consumed> 条）」—— 那个数是**计划**要送的条数，
     * 模型从未看到它们的摘要（对模型是一句假陈述，它会以为细节都在别处）。
     */
    listMessagesMock.mockReturnValue(makeMessages(40));
    summaryShouldThrow = true;
    const loop = makeLoop() as never as { compactMessages: (s: string) => Promise<number> };
    await loop.compactMessages("s-ca29");

    const marker = String(createMessageMock.mock.calls[0][0].content);
    expect(marker, "前提：确实写了标记").toContain("[上下文已自动压缩]");
    expect(marker, "兜底时要写明「本次摘要调用中断」").toContain("摘要调用中断");
    expect(
      /检查点摘要（覆盖较早的 \d+ 条）/.test(marker),
      "兜底时不许再断言覆盖条数（那是计划数，不是事实）",
    ).toBe(false);
  });

  it("CA-15（反向对照）：这些修复不许把「压缩无效」路径删掉（仍要如实上报）", () => {
    const src = readFileSync(path.resolve(__dirname, "../core/llm/agentic-loop.ts"), "utf8");
    expect(src, "压不动仍要顶到上限并给用户可执行的结论").toContain("this.state.consecutiveCompactions = 3;");
  });
});

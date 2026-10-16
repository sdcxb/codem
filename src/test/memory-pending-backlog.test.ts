/**
 * 第 229 波：**待批准积压上限** + **入队前同主题合并** 的判据。
 *
 * ## 被守的缺陷（用户实报：「修过一次，但一次对话后又是 9 条待批准」）
 *
 * 第 228 波把 `MEMORY_MAX_PER_EXTRACTION` 从 3 降到 2，但它限的是**速率**（每次提取几条），
 * 而用户被烦到的那 9 条是**存量**：待批准区是累积的，且一次对话可以触发多次提取
 * （回合结束 + 压缩完成）。真机取证：历史批次 `count` = 8/6/6/7，第 228 波之后单次降到 1~2 条，
 * 但两条待批准**相隔两天**各自带着批次躺着 ⇒ 速率治不了存量。
 *
 * ## 判据清单
 *
 * - `MEMP-1`：积压已达上限 ⇒ **不再新增 pending**，改为降级为对话级（直接生效、内容不丢）。
 * - `MEMP-1b`（反向对照）：**未达**上限时仍然是 pending（闸门不许做成"永远降级"）。
 * - `MEMP-2`（全局口径）：别的项目/会话里的待批准**也算进积压** —— 与面板的按 ctx 过滤**相反**。
 * - `MEMP-3`（反向对照）：`explicit`（用户明确要求记住）的条目**不受**积压闸门影响。
 * - `MEMP-4`（退化情形）：连「对话级」也需批准时 ⇒ **如实拒绝并计数**（不新增 pending）。
 * - `MEMP-5`：上限本身 = 5 条（写满 5 条之后才降级 —— 把常量钉住，防止有人悄悄调大）。
 * - `MEMP-6`（如实留痕）：降级与拒绝都必须有 console 日志与汇总计数，**不许静默丢弃**。
 * - `MEMP-7`（本轮已写要算进去）：base=4、一次提取给 3 条 ⇒ 积压**不许**被推到 6 条。
 * - `MEMC-*`：入队前的同主题合并（阈值、误合并边界、tags 留痕、正文超限留痕、端到端条数）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting, setSettingJSON } from "../core/storage/settings";
import {
  MemoryService,
  MEMORY_WRITE_APPROVAL_KEY,
  setWriteApprovalSetting,
} from "../core/memory/memory";
import { MEMORY_PENDING_BACKLOG_LIMIT, decidePendingBacklog } from "../core/memory/pending-backlog";
import { mergeSameTopicCandidates, CANDIDATE_MERGE_MAX_CONTENT_CHARS } from "../core/memory/candidate-merge";
/* 前提自检要用**同一把尺**（否则"这条落没落在低档"就成了我自己编的说法） */
import { memorySimilarity } from "../core/memory/similarity";
import { LLMEngine } from "../core/llm/index";
import * as MessageStorage from "../core/storage/message";

const PROJ_A = "c:\\work\\alpha";
const PROJ_B = "c:\\work\\beta";
const SESSION = "s-229-a";
const OTHER_SESSION = "s-229-b";

let port: FakeStoragePort;

beforeEach(() => {
  saveMemory("");
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

/** 与既有判据同一套桩（见 `memory-approve-scope-batch.test.ts`） */
function engineForExtraction(
  memory: MemoryService,
  sessionId: string,
  payload: string,
  /** 第一条第 0 条 user 消息的正文（用来造「用户说了记住」这类结构证据） */
  firstUserContent = "x",
): LLMEngine {
  setSettingJSON(`memory-enabled-${sessionId}`, true);
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = memory;
  const provider = { id: "test", isConfigured: () => true, complete: async () => ({ content: payload }) };
  (engine as unknown as { providers: unknown }).providers = { get: () => provider };
  (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
  vi.spyOn(MessageStorage, "listMessages").mockReturnValue(
    Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? "assistant" : "user",
      content: i === 0 ? firstUserContent : "x",
    })) as never,
  );
  vi.spyOn(engine, "spawnForked").mockResolvedValue(payload);
  return engine;
}

/** 预置 n 条**项目级待批准**条目（模拟"上一次对话没处理完的积压"） */
function seedPendingBacklog(svc: MemoryService, n: number, projectId = PROJ_A): void {
  for (let i = 0; i < n; i++) {
    const r = svc.add({
      scope: "project",
      projectId,
      key: `积压条目 ${i}`,
      content: `这是积压里第 ${i} 条待批准的项目级记忆（内容互不相同，避免被判重挡下）`,
      source: "auto",
      status: "pending",
      batchId: `batch-seed-${i}`,
    });
    expect(r.ok, `前提：第 ${i} 条种子必须写进去`).toBe(true);
  }
}

describe("MEMP：待批准积压上限（速率上限治不了存量）", () => {
  it("MEMP-1：积压已达上限 ⇒ 不再新增 pending，降级为对话级（直接生效、内容不丢）", async () => {
    const svc = new MemoryService();
    seedPendingBacklog(svc, MEMORY_PENDING_BACKLOG_LIMIT);
    expect(svc.countPendingEntries(), "前提：积压已满").toBe(MEMORY_PENDING_BACKLOG_LIMIT);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([
        {
          key: "新学到的项目约定",
          content: "这是一条模型明说跨对话仍成立的项目级事实（本来要进待批准区）",
          scope: "project",
        },
      ]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    expect(svc.countPendingEntries(), "积压满 ⇒ 一条 pending 都不许新增（这正是要治的缺陷）").toBe(
      MEMORY_PENDING_BACKLOG_LIMIT,
    );
    const panel = svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION });
    const demoted = panel.find((e) => e.key === "新学到的项目约定");
    expect(demoted, "内容一条不丢：它必须还在库里（降级 ≠ 丢弃）").toBeTruthy();
    expect(demoted!.scope, "作用域降为对话级").toBe("conversation");
    expect(demoted!.sessionId, "归属当前会话（不跨对话、不跨项目）").toBe(SESSION);
    expect(demoted!.status ?? "active", "直接生效（不再打扰用户）").toBe("active");
    expect(
      svc.buildMemoryPrompt("conversation", PROJ_A, SESSION),
      "直接生效 ⇒ 立刻进这个对话的上下文",
    ).toContain("本来要进待批准区");
    expect(
      svc.buildMemoryPrompt("project", PROJ_A),
      "它**不许**因此变成项目级（否则降级就是偷偷放行了一条跨对话事实）",
    ).not.toContain("本来要进待批准区");
    expect(logs.join("\n"), "降级必须如实留痕（日志点名原作用域）").toContain("降级为对话级");
  });

  it("MEMP-1b（反向对照）：**未达**上限时仍然是待批准（闸门不许做成永远降级）", async () => {
    const svc = new MemoryService();
    seedPendingBacklog(svc, MEMORY_PENDING_BACKLOG_LIMIT - 1);
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([{ key: "照常待批准", content: "积压没满 ⇒ 这条必须照常进待批准区等用户批", scope: "project" }]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    expect(svc.countPendingEntries(), "没满就照常加一条").toBe(MEMORY_PENDING_BACKLOG_LIMIT);
    const entry = svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION }).find((e) => e.key === "照常待批准");
    expect(entry!.scope, "仍是项目级").toBe("project");
    expect(entry!.status, "仍是待批准（不许被降级）").toBe("pending");
    expect(
      svc.buildMemoryPrompt("project", PROJ_A),
      "未批准 ⇒ 不进上下文（这条判据挡的是「闸门把什么都降级」的假修复）",
    ).not.toContain("积压没满");
  });

  it("MEMP-2（全局口径）：别的项目 / 别的会话里的待批准也算进积压（与面板的 ctx 过滤相反）", async () => {
    const svc = new MemoryService();
    /* 积压全部挂在**别的项目**上：面板在 PROJ_A 里一条都看不到，但它照样占用户的决策额度 */
    seedPendingBacklog(svc, MEMORY_PENDING_BACKLOG_LIMIT, PROJ_B);
    expect(
      svc.listPending(undefined, { projectId: PROJ_A, sessionId: SESSION }),
      "前提：按 ctx 过滤时，PROJ_A 面板里看不到它们（界面口径）",
    ).toHaveLength(0);
    expect(svc.countPendingEntries(), "但**闸门**读的是全局总量（5 条）").toBe(MEMORY_PENDING_BACKLOG_LIMIT);

    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([{ key: "跨项目积压也算数", content: "别的项目的积压同样占用户的决策额度，必须一起算", scope: "project" }]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    const entry = svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION }).find((e) => e.key === "跨项目积压也算数");
    expect(entry, "前提：内容写进来了").toBeTruthy();
    expect(
      entry!.scope,
      "全局积压已满 ⇒ 必须降级；若实现按 ctx 过滤再判上限，这里会落成 project+pending（判据变红）",
    ).toBe("conversation");
  });

  it("MEMP-3（反向对照）：用户明确要求记住的条目**不受**积压闸门影响（不降级、也不占待批准）", async () => {
    const svc = new MemoryService();
    seedPendingBacklog(svc, MEMORY_PENDING_BACKLOG_LIMIT);
    const engine = engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([
        { key: "用户点名要记的", content: "这条是用户在对话里明确说「记住」的，直接生效、不走待批准", scope: "project", explicit: true },
      ]),
      /* 用户原话（结构判据的唯一证据面）：`role: user` 的普通消息里出现「记住」 */
      "请记住：这条要长期保留",
    );
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    const entry = svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION }).find((e) => e.key === "用户点名要记的");
    expect(entry, "必须写进来").toBeTruthy();
    expect(entry!.scope, "用户明确要求 ⇒ 保持项目级（闸门不该把它降级）").toBe("project");
    expect(entry!.status ?? "active", "用户就是批准者 ⇒ 直接生效").toBe("active");
    expect(svc.countPendingEntries(), "也不占待批准额度").toBe(MEMORY_PENDING_BACKLOG_LIMIT);
  });

  it("MEMP-4（退化情形）：连「对话级」也需批准时 ⇒ 如实拒绝并计数（不新增 pending、不静默丢弃）", async () => {
    setWriteApprovalSetting({ conversation: true }); // 用户把对话这一档也打开了审批
    const svc = new MemoryService();
    seedPendingBacklog(svc, MEMORY_PENDING_BACKLOG_LIMIT);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([{ key: "降级无效的那条", content: "对话级也要批准 ⇒ 降级等于没做，只能如实拒绝", scope: "project" }]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    expect(svc.countPendingEntries(), "一条待批准都不许新增").toBe(MEMORY_PENDING_BACKLOG_LIMIT);
    expect(
      svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION }).some((e) => e.key === "降级无效的那条"),
      "既没写成 pending 也没写成 active ⇒ 这条内容本次没有落库",
    ).toBe(false);
    const text = logs.join("\n");
    expect(text, "不许静默丢弃：日志必须点名「降级不可用 ⇒ 不写入」").toContain("降级不可用");
    expect(text, "汇总日志要给出如实拒绝的条数").toContain("如实拒绝 1 条");
  });

  it("MEMP-5：上限本身 = 5 条，且**写满第 5 条之后**才开始降级", async () => {
    expect(MEMORY_PENDING_BACKLOG_LIMIT, "上限取值是产品决定（5 条），钉住防止被悄悄调大").toBe(5);
    expect(decidePendingBacklog({ intendedScope: "project", pendingTotal: 4, conversationNeedsApproval: false }).action).toBe("keep");
    expect(decidePendingBacklog({ intendedScope: "project", pendingTotal: 5, conversationNeedsApproval: false }).action).toBe(
      "demote-conversation",
    );
    expect(
      decidePendingBacklog({ intendedScope: "conversation", pendingTotal: 99, conversationNeedsApproval: false }).action,
      "对话级候选根本不走这道闸",
    ).toBe("keep");
  });

  it("MEMP-6（如实留痕）：汇总日志给出降级/拒绝条数与上限", async () => {
    const svc = new MemoryService();
    seedPendingBacklog(svc, MEMORY_PENDING_BACKLOG_LIMIT);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([{ key: "留痕用候选", content: "这条会被降级，汇总日志必须如实报出来", scope: "project" }]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    const summary = logs.find((l) => l.includes("Extracted"));
    expect(summary, "必须有汇总日志").toBeTruthy();
    expect(summary!, "要报上限本身").toContain(`待批准积压上限 ${MEMORY_PENDING_BACKLOG_LIMIT} 条`);
    expect(summary!, "要报这次降级了几条").toMatch(/触发降级 1 条/);
  });

  it("MEMP-7：**本轮已经写成的 pending 要算进积压**（一次提取不许把积压推过上限）", async () => {
    const svc = new MemoryService();
    seedPendingBacklog(svc, MEMORY_PENDING_BACKLOG_LIMIT - 1); // base = 4
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([
        { key: "本轮候选甲", content: "第一条：base=4 ⇒ 写进去把积压推到 5（照常待批准）", scope: "project" },
        { key: "本轮候选乙", content: "第二条：此刻积压已经是 5 ⇒ 必须降级而不是再加一条待批准", scope: "project" },
        { key: "本轮候选丙", content: "第三条：积压仍然是 5 ⇒ 同样降级（不许再新增 pending）", scope: "project" },
      ]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    expect(
      svc.countPendingEntries(),
      "积压上限是硬上限：base=4 + 本轮 3 条候选 ⇒ 最多只能到 5（不许到 6/7）",
    ).toBeLessThanOrEqual(MEMORY_PENDING_BACKLOG_LIMIT);
    expect(svc.countPendingEntries(), "而且必须真的写进去一条（不是全拒绝）").toBe(MEMORY_PENDING_BACKLOG_LIMIT);
    const panel = svc.listAllForPanel({ projectId: PROJ_A, sessionId: SESSION });
    expect(panel.find((e) => e.key === "本轮候选乙")!.scope, "第二条被降级").toBe("conversation");
    expect(panel.find((e) => e.key === "本轮候选丙")!.scope, "第三条被降级").toBe("conversation");
  });
});

/**
 * 真机哨兵对：**原文取自用户机器上的记忆库**（`%APPDATA%\com.codem.app` 的 `memory` 表）。
 *
 * `similarity.ts` 记录的首个误报就是这一对 —— 两条**不同**的事实，
 * 只因为都带 MCP 而落进 0.22~0.30 那个「真重复与误报混在一起」的低档。
 * `MEMC-2b`（不许被合并）与 `MEMC-2c`（把阈值放宽到 0.22 就会被合并）**共用这一份数据**：
 * 两处各写一份的话，调了一处忘了另一处，两条判据就会各自说一套。
 */
const MCP_FALSE_POSITIVE_PAIR = [
  {
    key: "MCP 探针服务器 codem-res-probe",
    content:
      "存在一个用于真机验证的 MCP 服务器 codem-res-probe，暴露两个资源：probe://docs/readme（text/markdown）和 probe://docs/binary（application/octet-stream）。列资源用 list_mcp_resources，读资源用 read_mcp_resource。",
  },
  {
    key: "二进制 MCP 资源不内联",
    content:
      "读取二进制 MCP 资源时不会内联大段 base64，而是返回占位摘要，形如 [binary resource: application/octet-stream, 4096 base64 chars — not inlined]。",
  },
] as const;

describe("MEMC：入队前同主题合并（同批候选不许各占一个待批准名额）", () => {  it("MEMC-1：同主题两条候选并成一条，正文都保留（不丢内容）", () => {
    const out = mergeSameTopicCandidates([
      { key: "开发环境:Windows + PowerShell", content: "本项目在 Windows 上开发，命令走 PowerShell 执行。" },
      { key: "Shell 环境:Windows PowerShell 5.1", content: "本机 shell 是 Windows PowerShell 5.1，注意版本差异。" },
    ]);
    expect(out.candidates, "两条讲同一件事 ⇒ 并成一条").toHaveLength(1);
    expect(out.merges, "合并必须留下可核对的读数").toHaveLength(1);
    expect(out.merges[0].similarity, "读数来自真实相似度（不是拍一个数）").toBeGreaterThan(0);
    expect(out.merges[0].keys, "组内标题都要记下来").toHaveLength(2);
    const merged = out.candidates[0];
    expect(merged.content, "正文必须两条都在（合并 ≠ 丢一条）").toContain("命令走 PowerShell 执行");
    expect(merged.content, "正文必须两条都在（合并 ≠ 丢一条）").toContain("版本差异");
    /*
     * 组内**两个**标题都要能被搜到：正文最长的那条当 `key`（它的标题在条目名上），
     * 被并掉的那条进 `tags` —— 否则用户用那个说法搜不到这条记忆（搜索走 key/content/tags）。
     * 断言刻意写成"两个标题都必须在 key∪tags 里"，而不是钉死哪一条当 keeper
     * （keeper 由"正文最长"决定，那是另一个独立规则）。
     */
    const searchable = [merged.key, ...(merged.tags ?? [])].join(" ");
    expect(searchable, "组内标题要都能搜到（一个在 key，另一个必须在 tags）").toContain(
      "开发环境:Windows + PowerShell",
    );
    expect(searchable, "组内标题要都能搜到（一个在 key，另一个必须在 tags）").toContain(
      "Shell 环境:Windows PowerShell 5.1",
    );
  });

  it("MEMC-2（反向对照）：不相似的候选**不许**被合并", () => {
    const out = mergeSameTopicCandidates([
      { key: "测试入口", content: "跑全量测试用 npx vitest run。" },
      { key: "提交信息语言", content: "提交信息一律用中文，并写清被守的缺陷与判据。" },
    ]);
    expect(out.candidates, "两条本来无关 ⇒ 一条都不许并").toHaveLength(2);
    expect(out.merges).toHaveLength(0);
  });

  it("MEMC-2b（误合并边界）：0.22 那一档还必须**标题自己也像**才合并（挡住真机 0.23 的误报）", () => {
    /* 真机哨兵（数据与注释见文件里的 `MCP_FALSE_POSITIVE_PAIR`） */
    const [a, b] = MCP_FALSE_POSITIVE_PAIR;
    /*
     * 前提自检（否则这条判据会退化成「它们本来就不够像」的哑巴）：这一对必须**真的**
     * 落在 0.22~0.30 那个低档，才谈得上验证那道附加闸。
     */
    const combined = memorySimilarity(`${a.key}\n${a.content}`, `${b.key}\n${b.content}`);
    expect(combined, "前提：正文合并相似度落在低档（≥0.22 且 <0.30）").toBeGreaterThanOrEqual(0.22);
    expect(combined, "前提：正文合并相似度落在低档（≥0.22 且 <0.30）").toBeLessThan(0.3);
    expect(memorySimilarity(a.key, b.key), "前提：标题**不**像（keySim < 0.40）").toBeLessThan(0.4);

    const out = mergeSameTopicCandidates([a, b]);
    expect(
      out.candidates,
      "低档只靠正文相似度不够 —— 还要标题也像；把这道附加闸拆掉，这条会红",
    ).toHaveLength(2);
  });

  it("MEMC-2c（护栏）：把阈值放宽到 0.22 就会短路「标题也像」那道闸 —— 默认值 0.3 才是有依据的", () => {
    /*
     * 这一条钉住的正是第 229 波**实测到的坑**：一开始想「既然只比同一次提取的候选，
     * 就把阈值放宽到 `MEMORY_DUPLICATE_KEY_ASSIST_MIN`（0.22）」，跑出来才发现
     * `clusterDuplicateMemories` 的命中判定里 `combined >= threshold` 与
     * `combined >= 0.22 && keySim >= 0.40` 是**两条并列**条件 ⇒ 阈值一降就把附加闸整条短路，
     * 真机哨兵（MCP 那对误报）当场被误合并。
     *
     * 所以这条判据同时守两件事：① 默认阈值**不许**被改回 0.22（第一段断言）；
     * ② 「放宽就会出错」这个事实本身（第二段断言）—— 后者让后来者**看得到代价**，
     * 而不是只看到一句「默认 0.3」。
     */
    const [a, b] = MCP_FALSE_POSITIVE_PAIR;
    expect(
      mergeSameTopicCandidates([a, b]).candidates,
      "默认阈值（0.3）⇒ 低档靠「标题也像」兜底 ⇒ 误报不许被合并",
    ).toHaveLength(2);
    expect(
      mergeSameTopicCandidates([a, b], 0.22).candidates,
      "显式放宽到 0.22 ⇒ 附加闸被短路，真机哨兵被误合并（这就是不许把默认值改成 0.22 的理由）",
    ).toHaveLength(1);
  });

  it("MEMC-3：合并条留在**组内第一条**的位置（名额分配口径不许被合并改变）", () => {
    const out = mergeSameTopicCandidates([
      { key: "无关的甲", content: "这条与谁都不像，必须原样留在第一位。" },
      { key: "开发环境:Windows + PowerShell", content: "本项目在 Windows 上开发，命令走 PowerShell 执行。" },
      { key: "Shell 环境:Windows PowerShell 5.1", content: "本机 shell 是 Windows PowerShell 5.1，注意版本差异。" },
    ]);
    expect(out.candidates, "三条里前两条并成一条 ⇒ 剩两条").toHaveLength(2);
    expect(out.candidates[0].key, "无关的那条原样留在第一位").toBe("无关的甲");
    expect(out.merges[0].ids, "合并记录里的下标指向**原始数组**（组内第一条是下标 1）").toEqual([1, 2]);
    expect(
      out.candidates[1].content,
      "正文取组内**最长**的那条（信息最全），位置仍沿用组内第一条",
    ).toContain("命令走 PowerShell 执行");
    expect(out.candidates[1].content, "另一条的正文也在（合并 ≠ 丢内容）").toContain("版本差异");
  });

  it("MEMC-4（如实留痕）：正文超过上限时只保留标题，并记进 droppedContentKeys", () => {
    const long = "很长的正文".repeat(Math.ceil(CANDIDATE_MERGE_MAX_CONTENT_CHARS / 5));
    const a = { key: "超长条目", content: long };
    const b = { key: "超长条目的另一种说法", content: `${long}补充说明` };
    /* 前提自检：这两条必须真的落在判重档（否则这条判据测不到"超限留痕"，只是测了"没合并"） */
    expect(
      memorySimilarity(`${a.key}\n${a.content}`, `${b.key}\n${b.content}`),
      "前提：正文几乎一样 + 标题也像 ⇒ 落在判重档",
    ).toBeGreaterThanOrEqual(0.3);
    const out = mergeSameTopicCandidates([a, b]);
    expect(out.candidates, "仍然合并（超限不等于不合并）").toHaveLength(1);
    expect(out.candidates[0].content, "正文取最长的那条").toContain("补充说明");
    expect(
      out.merges[0].droppedContentKeys,
      "被截掉正文的那条必须在这里留痕（静默丢正文是本仓最忌讳的形态）",
    ).toContain("超长条目");
    expect(out.candidates[0].content.length).toBeLessThanOrEqual(CANDIDATE_MERGE_MAX_CONTENT_CHARS + 200);
  });

  it("MEMC-5（端到端）：同批三条同主题候选 ⇒ 只写出一条待批准条目", async () => {
    const svc = new MemoryService();
    await engineForExtraction(
      svc,
      SESSION,
      JSON.stringify([
        { key: "开发环境:Windows + PowerShell", content: "本项目在 Windows 上开发，命令走 PowerShell 执行。", scope: "project" },
        { key: "Shell 环境:Windows PowerShell 5.1", content: "本机 shell 是 Windows PowerShell 5.1，注意版本差异。", scope: "project" },
        { key: "Windows + PowerShell 环境限制", content: "Windows + PowerShell 的组合带来若干环境限制需要注意。", scope: "project" },
      ]),
    ).extractMemoriesFromSession(SESSION, PROJ_A);

    expect(
      svc.countPendingEntries(),
      "三条同主题 ⇒ 只该占一个待批准名额（治的正是「用户要点三次」）",
    ).toBe(1);
    const pending = svc.listPending(undefined, { projectId: PROJ_A, sessionId: SESSION });
    expect(pending, "而且那一条的内容必须含三条的正文").toHaveLength(1);
    expect(pending[0].content).toContain("命令走 PowerShell 执行");
    expect(pending[0].content).toContain("版本差异");
    expect(pending[0].content).toContain("环境限制");
  });
});

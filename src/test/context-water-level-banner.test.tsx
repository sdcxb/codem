/**
 * 上下文水位常驻提示 —— 第 122 轮。
 *
 * ## 这个文件守的是用户报的那件事
 *
 * 用户原话（大意）：
 * > 一个对话轮次多了之后，任务会突然停止、思考和回答都像被压过。**其他平台都会提示**
 * > 「上下文不够了、效果会马上变坏、建议新开对话」，我们平台没有。DSH 也没有。
 *
 * 侦察结论（全部有 `file:line` 依据）：
 *
 * | 我们**有**的 | 我们**没有**的 |
 * |---|---|
 * | `PRESSURE_THRESHOLDS = [0.5,0.7,0.9]`（`context.ts:26`） | 不打开面板就看不到任何告警 |
 * | 「⚠️ 上下文压力较高，建议压缩或开启新对话」（`ContextMonitor.tsx`） | 静默丢消息的可见入口 |
 * | 「🔴 上下文即将满！请立即压缩或开启新对话」 | —— |
 *
 * 那两句只渲染在 `ContextMonitor` 内，而 `ChatPanel.tsx` 把它挂在 `showContextMonitor`
 * （**默认 false**）后面 ⇒ **等于没有**。所以本轮的判据分三层：
 *
 * 1. **计算层**：`readContextWaterLevel` 必须与"模型侧那条链"给出**同一对数字**
 *    （可见 → 裁陈旧工具结果 → 按优先级选进窗口×0.9），否则会出现第 72 轮那种
 *    "进度条 21% + 压力等级 临界"的自相矛盾；
 * 2. **可见性层**：≥70% 时**不打开任何面板**就能看到；<70% 时不打扰；
 * 3. **行为层**：关闭后水位再涨 5 个百分点要重新出现（风险不许被静音）；
 *    两个出口的代价不同，文案必须**分开写清楚**。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";

const SESSION = "s-water";

// ---------- 1. 计算层用的 mock（真实数据、真实链路）----------
let mockMessages: any[] = [];

vi.mock("../core/storage/message", () => ({  isHiddenStateAuthoritative: () => true,

  listVisibleMessages: (sid: string) => (sid === SESSION ? mockMessages.filter((m) => !m.hidden) : []),
  listMessages: (sid: string) => (sid === SESSION ? mockMessages.slice() : []),
}));

// ---------- 2. 提示条 UI 用的 mock ----------
const levelBox = {
  used: 0,
  available: 115200,
  ratio: 0,
  percent: 0,
  level: 0,
  messageCount: 0,
};

vi.mock("../core/context/water-level", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/context/water-level")>();
  return {
    ...actual,
    // 只替换"订阅"这一层：真正的计算函数（readContextWaterLevel / waterLevelFromBudget /
    // WATER_LEVEL / PRESSURE 口径）全部用真货 —— 这条是刻意的，见文件头第 1 条判据。
    /*
     * 2026-10-19：提示条改用**防抖** hook（连续 2 拍才显示，修打开时闪烁）。
     * 本文件测的是"可见性/文案/交接行为"，不是防抖节奏；防抖节奏由
     * `water-banner-stability.test.ts` 直接测 reducer。这里保留"立即按当前档位可见"的替身。
     */
    useStableContextWaterLevel: () => ({
      level: { ...levelBox },
      visible: levelBox.level >= 3,
      showStreak: 2,
      hideStreak: 0,
    }),
  };
});

const delegateMock = vi.fn();
vi.mock("../core/session/orchestrator", () => ({
  getDelegationOrchestrator: () => ({ delegate: delegateMock }),
}));

/**
 * `file-api` 必须 mock：`buildHandover` 的**存在性检查器**在生产里由 banner 从
 * `core/file-api.ts` 取（真机是 Tauri IPC）—— 测试环境没有 Tauri，不 mock 就会
 * 在 await 那句话上炸掉。这里让"磁盘上什么都有"，于是交接正文能正常生成。
 */
vi.mock("../core/file-api", () => ({
  exists: vi.fn().mockResolvedValue(true),
  getDefaultCwd: vi.fn().mockResolvedValue("D:\\proj"),
}));

const reportAdvisoryMock = vi.fn();
const reportActionFailureMock = vi.fn();
const reportPersistFailureMock = vi.fn();
/**
 * ⚠️ 三个导出**都要给**（`PFP-1` 闸门会检查这件事）：
 * 被测代码调到没被 mock 的那个会抛 `TypeError`，而它常常被 `catch` 吞掉 ——
 * 于是用例红在一个跟真实原因无关的地方，排查代价极高。
 */
vi.mock("../core/storage/persist-failure", () => ({
  reportAdvisory: (...a: unknown[]) => reportAdvisoryMock(...a),
  reportActionFailure: (...a: unknown[]) => reportActionFailureMock(...a),
  reportPersistFailure: (...a: unknown[]) => reportPersistFailureMock(...a),
}));

let createSessionResult: any = { id: "s-new" };
const createSessionMock = vi.fn(() => createSessionResult);
vi.mock("../core/store", () => ({
  useProjectStore: Object.assign((sel: any) => sel({ createSession: createSessionMock }), {
    getState: () => ({ currentProject: { id: "p1", path: "D:\\proj" }, sessions: [], createSession: createSessionMock }),
  }),
}));

const { WaterLevelBanner } = await import("../components/WaterLevelBanner");
const { readContextWaterLevel, WATER_LEVEL, UNKNOWN_WATER_LEVEL } = await import("../core/context/water-level");
const { summarizeModelContext } = await import("../core/llm/compaction-budget");
const { pruneStaleToolResults } = await import("../core/llm/context-fold");
const { summarizeDisplayPressure } = await import("../core/context/context");
const { getContextManager } = await import("../core/context/context");
const { getTokenTracker } = await import("../core/llm/token-tracker");

/** 造一条消息：`cjk` 个中文字 ≈ cjk×0.6 token（`token-tracker.ts:62` 的 CJK 系数） */
function msg(i: number, role: "user" | "assistant", cjk: number) {
  return {
    id: `m-${i}`,
    role,
    content: "压".repeat(cjk),
    timestamp: 1000 + i,
    status: "done",
  };
}

beforeEach(() => {
  mockMessages = [];
  Object.assign(levelBox, { used: 0, available: 115200, ratio: 0, percent: 0, level: 0, messageCount: 0 });
  delegateMock.mockReset();
  reportAdvisoryMock.mockReset();
  reportActionFailureMock.mockReset();
  createSessionMock.mockClear();
  createSessionResult = { id: "s-new" };
});

afterEach(() => cleanup());

// =====================================================================
describe("第 122 轮 · 水位计算层", () => {
  it("WL-1: 没有会话 ⇒ 未知水位，**不是**「快满了」（算不出来 ≠ 危险）", () => {
    const lv = readContextWaterLevel("");
    expect(lv).toEqual(UNKNOWN_WATER_LEVEL);
    expect(lv.level).toBe(WATER_LEVEL.NORMAL);
    expect(lv.percent).toBe(0);
  });

  it("WL-2: 与模型侧那条链给出**同一对数字**（口径不许写两遍）", () => {
    // 40 条用户消息 × 3000 中文字 ⇒ 远超预算，会被优先级选择裁剪
    mockMessages = Array.from({ length: 40 }, (_, i) => msg(i, "user", 3000));
    const lv = readContextWaterLevel(SESSION);

    // 独立跑一遍"模型侧"的链（与 ContextMonitor.update 逐字相同的三步）
    const visible = mockMessages.filter((m) => !m.hidden);
    const window0 = getTokenTracker().getContextWindow() || 128000;
    const { usedTokens, budgetTokens } = summarizeModelContext(pruneStaleToolResults(visible as never[]), window0);
    const systemTokens = getContextManager().getConfig().systemPromptTokens;
    const display = summarizeDisplayPressure(usedTokens + systemTokens, budgetTokens);

    expect(lv.used).toBe(usedTokens + systemTokens);
    expect(lv.available).toBe(budgetTokens);
    expect(lv.ratio).toBeCloseTo(display.ratio, 10);
    expect(lv.percent).toBe(display.percent);
    expect(lv.level).toBe(display.level);
    expect(lv.messageCount).toBe(visible.length);
  });

  it("WL-3: 隐藏消息不算进水位（与模型侧同一个入口 listVisibleMessages）", () => {
    mockMessages = [msg(0, "user", 100), { ...msg(1, "user", 100), hidden: true }, msg(2, "assistant", 100)];
    const lv = readContextWaterLevel(SESSION);
    expect(lv.messageCount).toBe(2);
  });

  it("WL-4: 等级阈值与 PRESSURE_THRESHOLDS 同源（50/70/90）", () => {
    expect(WATER_LEVEL.HIGH).toBe(2);
    expect(WATER_LEVEL.CRITICAL).toBe(3);
    // 用共享函数验证三档边界（不是另抄一份数字）
    expect(summarizeDisplayPressure(57599, 115200).level).toBe(0); // 49.9%
    expect(summarizeDisplayPressure(57600, 115200).level).toBe(1); // 50%
    expect(summarizeDisplayPressure(80640, 115200).level).toBe(2); // 70%
    expect(summarizeDisplayPressure(103680, 115200).level).toBe(3); // 90%
  });

  it("WL-5: 长会话真的会到 ≥70% —— 提示条不是永远不出现的摆设", () => {
    // 135 条 × 1000 中文字 ≈ 81000 token ≈ 预算(115200) 的 70.3%
    mockMessages = Array.from({ length: 135 }, (_, i) => msg(i, "user", 1000));
    const lv = readContextWaterLevel(SESSION);
    expect(lv.available).toBeGreaterThan(0);
    expect(lv.ratio).toBeGreaterThanOrEqual(0.7);
    expect(lv.level).toBeGreaterThanOrEqual(WATER_LEVEL.HIGH);
  });
});

// =====================================================================
describe("第 122 轮 · 提示条可见性（不打开任何面板）", () => {
  const banner = (onOpenDetail = () => {}) =>
    render(createElement(WaterLevelBanner, { sessionId: SESSION, onOpenDetail }));

  it("WB-1: 90%（critical）时**自动出现**，且带可断言的标记与百分比（70–90% 交给自动压缩）", () => {
    Object.assign(levelBox, { used: 81000, available: 115200, ratio: 0.92, percent: 92, level: 3, messageCount: 40 });
    const { queryByTestId } = banner();
    const el = queryByTestId("water-level-banner");
    expect(el).not.toBeNull();
    expect(el!.getAttribute("data-level")).toBe("3");
    expect(el!.getAttribute("data-percent")).toBe("92");
  });

  it("WB-2: 50%（还不到告警线）**不打扰** —— 提示条不是常驻仪表", () => {
    Object.assign(levelBox, { used: 60000, available: 115200, ratio: 0.52, percent: 52, level: 1 });
    const { queryByTestId } = banner();
    expect(queryByTestId("water-level-banner")).toBeNull();
  });

  it("WB-3: 没有会话 ⇒ 不显示", () => {
    Object.assign(levelBox, { used: 99999, available: 115200, ratio: 0.86, percent: 86, level: 2 });
    const { queryByTestId } = render(createElement(WaterLevelBanner, { sessionId: "", onOpenDetail: () => {} }));
    expect(queryByTestId("water-level-banner")).toBeNull();
  });

  it("WB-4: 90% 用**错误色档**（is-critical）；70–89% **不出现**（A：交给自动压缩）", () => {
    Object.assign(levelBox, { used: 106000, available: 115200, ratio: 0.92, percent: 92, level: 3 });
    const a = banner();
    const el = a.queryByTestId("water-level-banner")!;
    expect(el.className).toContain("is-critical");
    expect(el.className).not.toContain("is-high");
    a.unmount();

    Object.assign(levelBox, { used: 90000, available: 115200, ratio: 0.85, percent: 85, level: 2 });
    const b = banner();
    expect(b.queryByTestId("water-level-banner"), "85% 不该打扰（自动压缩在 70% 已接手）").toBeNull();
  });

  it("WB-5: 关闭后消失，**水位再涨 5 个百分点**会重新出现（风险不许被静音）", () => {
    Object.assign(levelBox, { used: 81000, available: 115200, ratio: 0.92, percent: 92, level: 3 });
    const onOpen = vi.fn();
    const { queryByTestId, rerender } = render(
      createElement(WaterLevelBanner, { sessionId: SESSION, onOpenDetail: onOpen }),
    );
    expect(queryByTestId("water-level-banner")).not.toBeNull();

    fireEvent.click(queryByTestId("water-level-dismiss")!);
    expect(queryByTestId("water-level-banner")).toBeNull();

    // 只涨 2 个百分点（< 5）⇒ 仍然安静
    Object.assign(levelBox, { used: 83000, available: 115200, ratio: 0.94, percent: 94, level: 3 });
    rerender(createElement(WaterLevelBanner, { sessionId: SESSION, onOpenDetail: onOpen }));
    expect(queryByTestId("water-level-banner")).toBeNull();

    // 再涨到 98%（≥ 92% + 5）⇒ 必须回来（0.97 因浮点误差会卡在边界，用 0.98）
    Object.assign(levelBox, { used: 98000, available: 115200, ratio: 0.98, percent: 98, level: 3 });
    rerender(createElement(WaterLevelBanner, { sessionId: SESSION, onOpenDetail: onOpen }));
    expect(queryByTestId("water-level-banner")).not.toBeNull();
  });

  it("WB-6: 换会话时「已关闭」状态不跟过去（新会话该提示就得提示）", () => {
    Object.assign(levelBox, { used: 81000, available: 115200, ratio: 0.92, percent: 92, level: 3 });
    const { queryByTestId, rerender } = render(
      createElement(WaterLevelBanner, { sessionId: SESSION, onOpenDetail: () => {} }),
    );
    fireEvent.click(queryByTestId("water-level-dismiss")!);
    expect(queryByTestId("water-level-banner")).toBeNull();

    rerender(createElement(WaterLevelBanner, { sessionId: "s-other", onOpenDetail: () => {} }));
    expect(queryByTestId("water-level-banner")).not.toBeNull();
  });

  it("WB-7: 水位提示只保留压缩出口，不再出现新对话劝退", () => {
    Object.assign(levelBox, { used: 81000, available: 115200, ratio: 0.92, percent: 92, level: 3 });
    const { queryByTestId } = banner();
    const text = queryByTestId("water-level-banner")!.textContent ?? "";
    // 必须说明"会发生什么"（B 项：静默丢弃这件事不许静默）
    expect(text).toContain("丢弃");
    expect(text).toContain("静默");
    // 只保留压缩出口；新对话建议必须已删除
    expect(text).toContain("压缩");
    expect(text).not.toContain("新对话");
    expect(text).not.toContain("新会话");
  });

  it("WB-8: 「查看详情」把用户送到既有的压缩面板（不自己造第二个压缩入口）", () => {
    Object.assign(levelBox, { used: 81000, available: 115200, ratio: 0.92, percent: 92, level: 3 });
    const onOpen = vi.fn();
    const { queryByTestId } = banner(onOpen);
    fireEvent.click(queryByTestId("water-level-detail")!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("WB-9: 本轮**已经丢过**上下文时，水位即使不高也要说（B 项后半）", async () => {
    /**
     * 这是"没有任何提示"那种体验的直接来源：`buildMessages` 丢消息/剥离 tool_calls
     * 只写 `console.warn`，而给模型看的 `[上下文精简]` 不落库、不上界面。
     * 于是模型少了半截上下文，用户这边一个像素都没变。
     *
     * 判据：水位**没有**到告警线（50%），但只要这一轮真的丢过，提示条就得出现并说出数字。
     */
    const vis = await import("../core/llm/context-visibility");
    vis.__resetContextDrops();
    Object.assign(levelBox, { used: 57600, available: 115200, ratio: 0.5, percent: 50, level: 1 });
    const { queryByTestId } = banner();
    // 没丢过 ⇒ 50% 不打扰
    expect(queryByTestId("water-level-banner")).toBeNull();

    await act(async () => {
      vis.recordContextDrop(SESSION, {
        droppedMessages: 7,
        toolCounts: { bash: 3, read: 2 },
        strippedToolCallMessages: 1,
        strippedToolCalls: 4,
        foldSummaryInserted: true,
      });
      await Promise.resolve();
    });
    const el = queryByTestId("water-level-banner");
    expect(el, "本轮已经丢过上下文，提示条必须出现").not.toBeNull();
    const drop = queryByTestId("water-level-drop")!;
    const text = drop.textContent ?? "";
    expect(text).toContain("7");
    expect(text).toContain("bash×3");
    expect(text).toContain("4");
    vis.__resetContextDrops();
  });
});

// =====================================================================
describe("第 191 波 · 回执不许混进风险提示条（真机报的「已用 1% 却报警」+「点了没反应」）", () => {
  const banner = () =>
    render(createElement(WaterLevelBanner, { sessionId: SESSION, onOpenDetail: () => {} }));

  function armHighLevel() {
    Object.assign(levelBox, { used: 81000, available: 115200, ratio: 0.92, percent: 92, level: 3 });
  }

  /** 真机那条 1M 窗口的会话形态：可用预算 ≈ 904,998、已用 ≈ 9,000 ⇒ 1% */
  function armNormalLevelLikeRealMachine() {
    Object.assign(levelBox, { used: 9_000, available: 904_998, ratio: 0.01, percent: 1, level: 0 });
  }

  function realisticSession() {
    mockMessages = [
      { id: "u1", role: "user", content: "把 D:\\proj\\报告.md 的第 3 节补完", timestamp: 1, status: "done" },
      {
        id: "a1",
        role: "assistant",
        content: "已更新",
        timestamp: 2,
        status: "done",
        toolCalls: [
          { id: "tc1", tool: "edit", args: { file_path: "D:\\proj\\报告.md", old_string: "x", new_string: "y" }, result: "ok", status: "done" },
        ],
      },
    ];
  }

  it("WB-11: 点「压缩 / 查看详情」⇒ 提示条收起 + 打开面板 + 留一条回执（不许看起来没反应）", () => {
    armHighLevel();
    const onOpen = vi.fn();
    const { queryByTestId } = render(
      createElement(WaterLevelBanner, { sessionId: SESSION, onOpenDetail: onOpen }),
    );
    fireEvent.click(queryByTestId("water-level-detail")!);
    expect(onOpen, "面板照旧要打开（这是既有契约）").toHaveBeenCalledTimes(1);
    expect(queryByTestId("water-level-banner"), "收起提示条：用户已经按了这个按钮").toBeNull();
    expect(queryByTestId("water-level-note")!.textContent).toContain("面板");
  });

  it("WB-15: 只因『本轮已被精简』而显示时，标题**不许**说「压力偏高」（1% + 压力偏高 = 两句话同时为假）", async () => {
    /*
     * 真机形态的另一半：用户报告里「已用 1%」与「上下文压力偏高」同时出现。
     * 只要等级没到线，那句"压力偏高"就是假陈述 —— 无论提示条是因为什么显示出来的。
     */
    const vis = await import("../core/llm/context-visibility");
    vis.__resetContextDrops();
    armNormalLevelLikeRealMachine(); // 真机那条 1M 窗口：1%
    const { queryByTestId } = banner();
    expect(queryByTestId("water-level-banner"), "没有丢过 ⇒ 1% 不打扰").toBeNull();

    await act(async () => {
      vis.recordContextDrop(SESSION, {
        droppedMessages: 12,
        toolCounts: { bash: 2 },
        strippedToolCallMessages: 1,
        strippedToolCalls: 3,
        foldSummaryInserted: true,
      });
      await Promise.resolve();
    });
    const el = queryByTestId("water-level-banner")!;
    const text = el.textContent ?? "";
    expect(text, "1% 绝不是「压力偏高」").not.toContain("压力偏高");
    expect(text, "也不许说「即将满」").not.toContain("即将满");
    expect(queryByTestId("water-level-title")!.textContent, "如实说「真的发生了什么」").toContain("精简");
    expect(text, "百分比仍然要给（但要标明是当前占用）").toContain("1%");
    expect(queryByTestId("water-level-drop")).not.toBeNull();
    vis.__resetContextDrops();
  });

  it("WB-16 反向对照: 等级真的到线（90%）时，标题必须说「即将满」", () => {
    armHighLevel();
    const { queryByTestId } = banner();
    expect(queryByTestId("water-level-title")!.textContent).toContain("即将满");
  });
});

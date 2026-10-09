// @vitest-environment happy-dom
/**
 * 「按天分格」的**窗口口径**判据（第 191 波：GAP-LIST 的 O-40 + O-55）。
 *
 * ## 为什么需要这一簇
 *
 * 「哪一天」已经统一到唯一口径 `localDateString()`（`TIME-SINGLE-SOURCE`），但那个判据只管
 * **格式**（取哪个字段、拼不拼 `Z`），**不管窗口步长**。而 `UsageChart` / `TokenActivityGrid`
 * 曾经把「一天」写成 `now - i * 24h` 到 `+24h`：
 *
 * - 夏令时跳变日里本地日历日是 **23 或 25 小时** ⇒ 窗口边界与本地日 key **错开 1 小时**
 *   （某天的记录被算进相邻格子，而既有判据全绿）；
 * - 更基础的一条：滚动 24h 窗口与「标签上的本地日」本来就**错开一整天**（标签是本地日、
 *   窗口是 `[now, now+24h)`）⇒ 今天那根柱子永远是 0，昨天的格子吃掉最近 24 小时。
 *
 * 修法不是「给这两个组件各改一遍」，而是**窗口只在唯一实现里生成**：
 * `localTimeParts` / `localDayStartMs` / `localDayWindows`（`src/core/time/local-time.ts`），
 * 两个组件与图书馆遥测热力图都从这里取格子。
 *
 * ## 时区确定性：**注入偏移表**，不用 `process.env.TZ`
 *
 * `process.env.TZ` 只在进程启动前可靠，而同一个 vitest 进程里还有别的测试文件依赖「本机时区」
 * （见 `TIME-SINGLE-SOURCE②` 的东八区用例）⇒ 改环境变量有**泄漏**风险。所以这里：
 *
 * 1. **纯函数**：`localDayWindows(days, now, 偏移回调)` / `localTimePartsAt(t, 偏移回调)`
 *    直接注入 `America/New_York` 的**偏移表**（含两次跳变的准确瞬时），与进程时区无关；
 * 2. **组件**：组件内部取的是「系统时区」，所以用 `vi.spyOn(Date.prototype, "getTimezoneOffset")`
 *    把系统口径**钉成同一张纽约表**（本仓既有手法，见 `time-single-source.test.ts` 的东八区用例），
 *    再 `vi.spyOn(Date, "now")` 钉住 `now` ⇒ 断言完全确定，也不依赖 `process.env.TZ`；
 * 3. 两条通路（注入表 vs 被钉住的「系统口径」）在跳变日的读数**必须逐字段一致**（`TIME-DST-3`），
 *    否则「注入表」就只是自说自话。
 *
 * ## 判据清单
 *
 * | # | 判据 | 变异（必须红） |
 * | --- | --- | --- |
 * | TIME-WINDOW-1 | 窗口 = 本地日历日、格子数 = `days`、边界 = 本地 00:00 | 窗口改回 `now - i * 24h` |
 * | TIME-WINDOW-2 | **反向对照**：按 24h 步长推进会被窗口不变量抓红（含具体错格） | 同上 |
 * | TIME-WINDOW-3 | 无 DST 时区：每格代表的本地日与旧实现**逐格相同**（不顺手改掉「哪一天」） | 日归属被改成 UTC 日 / 滚动日 |
 * | TIME-DST-1 | 跳变日前后各一条记录都落进本地日历日对应格子（两个组件都覆盖） | 只改一个组件、另一个绕开共用实现 |
 * | TIME-DST-2 | 本地日 **23 / 25 小时**两种形态各一条（春季前跳 / 秋季回拨） | 本地日 00:00 换算漏掉偏移迭代 |
 * | TIME-DST-3 | 跳变日三个时刻（前 / 瞬间 / 后）`localDateString` / `localTimeParts` 读数一致 | 同上 |
 * | TIME-DST-4 | 解析式对账：`src/**`（除 `src/test/**`）不许出现未登记的裸日长字面量 | 例外表加过期条目 / 组件退回 24h 字面量 |
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { render } from "@testing-library/react";
import {
  localDateString,
  localDayStartMs,
  localDayWindows,
  localTimeParts,
  localTimePartsAt,
  type LocalDayWindow,
  type OffsetMinutesOf,
} from "../core/time/local-time";
import { TokenActivityGrid, UsageChart } from "../components/UsageVisuals";
import type { UsageRecord } from "../core/llm/cost-tracker";

// ===================== 时区模型（注入表，与进程 TZ 无关） =====================

/** 纽约 2024 春季前跳：本地 02:00（EST，-05:00）直接跳到 03:00（EDT，-04:00）⇒ UTC 07:00Z */
const NY_SPRING_FORWARD = Date.UTC(2024, 2, 10, 7, 0, 0);
/** 纽约 2024 秋季回拨：本地 02:00（EDT）退回 01:00（EST）⇒ UTC 06:00Z */
const NY_FALL_BACK = Date.UTC(2024, 10, 3, 6, 0, 0);

/**
 * `America/New_York` 2024 年的偏移表（分钟，**东为正**）。
 *
 * 跳变时刻用**准确瞬时**（跳变瞬间立即生效新偏移 —— 这与 `getTimezoneOffset()` 的语义一致：
 * `07:00:00Z` 那一毫秒已经是 -04:00）。
 */
const NY: OffsetMinutesOf = (instantMs) =>
  instantMs >= NY_SPRING_FORWARD && instantMs < NY_FALL_BACK ? -240 : -300;

/** 无 DST 的固定时区（东八区，+08:00）：`TIME-WINDOW-3` 的对照臂 */
const EAST8: OffsetMinutesOf = () => 480;

/**
 * 「跳变正好发生在本地 00:00」的时区形态（真实例子：Asia/Beirut 2024-03-31 的
 * 本地 00:00 → 01:00，UTC+02:00 → UTC+03:00）⇒ 2024-03-31 **不存在本地 00:00**。
 *
 * 该日「实际最早的瞬时」= 跳变结束那一刻 = `2024-03-30T22:00Z`（本地 01:00）。
 * 这条也顺手钉住「本地日 00:00 换算必须迭代收敛」（只按一次偏移猜会落到**前一天** 23:00）。
 */
const MIDNIGHT_GAP_START = Date.UTC(2024, 2, 30, 22, 0, 0);
const MIDNIGHT_GAP: OffsetMinutesOf = (instantMs) => (instantMs >= MIDNIGHT_GAP_START ? 180 : 120);

const HOUR = 3_600_000;

// ===================== 夹具与工具 =====================

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 用**注入的**时区算「哪一天」（本地日 key）；`localDateString` 只认系统口径，故这里自己拼 */
function dayKeyAt(instantMs: number, offsetMinutesOf: OffsetMinutesOf): string {
  const p = localTimePartsAt(instantMs, offsetMinutesOf);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 把「系统时区」钉成注入表（组件内部只认系统口径，见文件头说明） */
function withSystemZone<T>(offsetMinutesOf: OffsetMinutesOf, fn: () => T): T {
  const spy = vi
    .spyOn(Date.prototype, "getTimezoneOffset")
    .mockImplementation(function (this: Date) {
      return -offsetMinutesOf(this.getTime());
    });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

/** 钉住 `now`（组件内部调 `Date.now()`） */
function withNow<T>(nowMs: number, fn: () => T): T {
  const spy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

let recordSeq = 0;
function rec(timestamp: number, tokens: number, cost = 0.001): UsageRecord {
  recordSeq++;
  return {
    id: `r${recordSeq}`,
    sessionId: "s1",
    timestamp,
    model: "test-model",
    provider: "test",
    inputTokens: tokens,
    outputTokens: 0,
    cost,
    duration: 1,
    toolCalls: 0,
    success: true,
  };
}

function cellIndexContaining(windows: LocalDayWindow[], at: number): number {
  return windows.findIndex((w) => at >= w.start && at < w.end);
}

/**
 * **窗口不变量**：每一格都必须是「本地日历日 `[00:00, 次日 00:00)`」。
 *
 * 这就是把「24h 步长」判红的那条判据 —— 它不看实现、只看结果（`TIME-WINDOW-2` 的反向对照臂
 * 就是拿这条去量旧实现）。
 */
function windowViolations(
  windows: LocalDayWindow[],
  days: number,
  offsetMinutesOf: OffsetMinutesOf,
): string[] {
  const problems: string[] = [];
  if (windows.length !== days) problems.push(`格子数 ${windows.length} ≠ days=${days}`);
  windows.forEach((w, i) => {
    if (w.date !== w.start) problems.push(`第 ${i} 格的 date 必须等于 start`);
    if (localDayStartMs(w.start, offsetMinutesOf) !== w.start) {
      problems.push(`第 ${i} 格的 start 不是本地日 00:00：${new Date(w.start).toISOString()}`);
    }
    if (w.end <= w.start) problems.push(`第 ${i} 格的 end ≤ start`);
    // end - 1ms 必须仍落在**同一**本地日 ⇒ end 恰好等于次日 00:00（而不是 start + 24h）
    if (localDayStartMs(w.end - 1, offsetMinutesOf) !== w.start) {
      problems.push(`第 ${i} 格的 end 不是次日 00:00：${new Date(w.end).toISOString()}`);
    }
  });
  for (let i = 0; i + 1 < windows.length; i++) {
    if (windows[i].end !== windows[i + 1].start) {
      problems.push(`第 ${i} / ${i + 1} 格不相接（有缝隙或重叠）`);
    }
  }
  return problems;
}

/**
 * **旧实现**（O-40 要修掉的那一份）：`now - i * 24h` 到 `+24h`，标签取窗口起点的本地日。
 *
 * ⚠️ 这段 24h 常量**故意**写在判据里当反向对照臂：`src/test/**` 被 `TIME-DST-4` 的扫描排除
 * （测试夹具不是产品口径）—— 见该判据的说明。
 */
function legacyWindows(days: number, nowMs: number): LocalDayWindow[] {
  const dayMs = 86_400_000;
  const out: LocalDayWindow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = nowMs - i * dayMs;
    out.push({ start, end: start + dayMs, date: start });
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ===================== TIME-WINDOW-1 =====================

describe("TIME-WINDOW-1：窗口 = 本地日历日（格子数 = days、边界 = 本地 00:00）", () => {
  /** 纽约 2024-03-10 16:00（EDT，跳变之后） */
  const NOW = Date.UTC(2024, 2, 10, 20, 0, 0);
  const DAYS = 3;

  it("格子数恒为 days、日 key 逐格是本地日历日、相邻首尾相接", () => {
    const windows = localDayWindows(DAYS, NOW, NY);
    expect(windows.length).toBe(DAYS);
    expect(windows.map((w) => dayKeyAt(w.start, NY))).toEqual([
      "2024-03-08",
      "2024-03-09",
      "2024-03-10",
    ]);
    expect(windowViolations(windows, DAYS, NY)).toEqual([]);
    // 最老一格的起点就是「本地 03-08 00:00」（EST，-05:00 ⇒ 05:00Z）
    expect(windows[0].start).toBe(Date.UTC(2024, 2, 8, 5, 0, 0));
    // 最后一格是今天，且它的 end 是**明天**的本地 00:00（EDT，-04:00 ⇒ 04:00Z）
    expect(windows[DAYS - 1].start).toBe(Date.UTC(2024, 2, 10, 5, 0, 0));
    expect(windows[DAYS - 1].end).toBe(Date.UTC(2024, 2, 11, 4, 0, 0));
  });

  it("跳变日两条记录（跳变前 01:30 EST / 跳变后 03:30 EDT）落在**同一格**（今天）", () => {
    const windows = localDayWindows(DAYS, NOW, NY);
    const before = Date.UTC(2024, 2, 10, 6, 30, 0); // 纽约 01:30 EST
    const after = Date.UTC(2024, 2, 10, 7, 30, 0); // 纽约 03:30 EDT
    expect(dayKeyAt(before, NY)).toBe("2024-03-10");
    expect(dayKeyAt(after, NY)).toBe("2024-03-10");
    expect(cellIndexContaining(windows, before)).toBe(DAYS - 1);
    expect(cellIndexContaining(windows, after)).toBe(DAYS - 1);
  });

  it("窗口边界就是本地日界（左闭右开）：本地 00:00 整算今天，前一毫秒算昨天", () => {
    const windows = localDayWindows(DAYS, NOW, NY);
    const midnightToday = Date.UTC(2024, 2, 10, 5, 0, 0); // 纽约 03-10 00:00 EST
    expect(cellIndexContaining(windows, midnightToday)).toBe(DAYS - 1);
    expect(cellIndexContaining(windows, midnightToday - 1)).toBe(DAYS - 2);
    // 下一天 00:00 整（EDT 04:00Z）不属于任何一格（窗口是左闭右开）
    expect(cellIndexContaining(windows, Date.UTC(2024, 2, 11, 4, 0, 0))).toBe(-1);
  });

  it("「跳变吞掉本地 00:00」的时区：该日起点 = 该日**实际最早的瞬时**（不是前一天 23:00）", () => {
    const ref = Date.UTC(2024, 2, 31, 12, 0, 0); // 贝鲁特形态的 2024-03-31 中午
    const start = localDayStartMs(ref, MIDNIGHT_GAP);
    expect(start).toBe(MIDNIGHT_GAP_START); // 22:00Z = 本地 01:00（跳变结束那一刻）
    expect(dayKeyAt(start, MIDNIGHT_GAP)).toBe("2024-03-31");
    const windows = localDayWindows(2, ref, MIDNIGHT_GAP);
    expect(windowViolations(windows, 2, MIDNIGHT_GAP)).toEqual([]);
    expect(windows[0].end).toBe(windows[1].start); // 前一日与这一日严丝合缝
    // 这一日仍有 23 小时（00:00 那一小时被跳掉了）
    expect(windows[1].end - windows[1].start).toBe(23 * HOUR);
  });
});

// ===================== TIME-WINDOW-2 =====================

describe("TIME-WINDOW-2：反向对照 —— 按 24h 步长推进必须被判据抓红", () => {
  const DAYS = 3;

  it("秋季回拨（25 小时那天）：旧实现把该日最早一小时的记录算进**前一天**格子", () => {
    const NOW = Date.UTC(2024, 10, 4, 17, 0, 0); // 纽约 2024-11-04 12:00 EST
    const good = localDayWindows(DAYS, NOW, NY);
    const legacy = legacyWindows(DAYS, NOW);

    // 新实现：不变量全过
    expect(windowViolations(good, DAYS, NY)).toEqual([]);
    // 旧实现：被同一条不变量判红（start 不是本地 00:00、end 不是次日 00:00）
    const problems = windowViolations(legacy, DAYS, NY);
    expect(problems.length, "24h 步长必须被窗口不变量抓红（否则这条判据是恒真的）").toBeGreaterThan(0);

    // 具体形态：11-03 最早一小时（本地 01:00 EDT）的记录
    const r = Date.UTC(2024, 10, 3, 5, 0, 0);
    expect(dayKeyAt(good[cellIndexContaining(good, r)].start, NY), "新实现：落在 11-03").toBe(
      "2024-11-03",
    );
    expect(dayKeyAt(legacy[cellIndexContaining(legacy, r)].start, NY), "旧实现：落进 11-02").toBe(
      "2024-11-02",
    );
  });

  it("春季前跳（23 小时那天）：旧实现把该日**最早一小时**的记录算进**前一天**格子", () => {
    const NOW = Date.UTC(2024, 2, 10, 20, 0, 0); // 纽约 2024-03-10 16:00 EDT
    const good = localDayWindows(DAYS, NOW, NY);
    const legacy = legacyWindows(DAYS, NOW);
    const r = Date.UTC(2024, 2, 10, 6, 0, 0); // 纽约 03-10 01:00 EST（本地日刚过一小时）

    expect(dayKeyAt(good[cellIndexContaining(good, r)].start, NY)).toBe("2024-03-10");
    expect(dayKeyAt(legacy[cellIndexContaining(legacy, r)].start, NY)).toBe("2024-03-09");
    expect(windowViolations(legacy, DAYS, NY).length).toBeGreaterThan(0);
  });

  it("旧实现的日 key 与「格子内容」本来就错开一整天（这才是 O-40 的正身）", () => {
    const NOW = Date.UTC(2024, 10, 4, 17, 0, 0);
    const legacy = legacyWindows(DAYS, NOW);
    // 旧实现的最后一格叫「今天」，但窗口是 [now, now + 24h) —— **未来**
    expect(legacy[DAYS - 1].start).toBe(NOW);
    expect(legacy[DAYS - 1].end).toBe(NOW + 86_400_000);
    expect(
      legacy[DAYS - 1].start,
      "旧实现的「今天」这一格不含今天 00:00 到此刻的记录",
    ).toBeGreaterThan(Date.UTC(2024, 10, 4, 5, 0, 0));
    // 而新实现的今天那一格从本地 00:00 开始
    expect(localDayWindows(DAYS, NOW, NY)[DAYS - 1].start).toBe(Date.UTC(2024, 10, 4, 5, 0, 0));
  });
});

// ===================== TIME-WINDOW-3 =====================

describe("TIME-WINDOW-3：无 DST 时区（东八区）—— 日归属与旧实现逐格相同", () => {
  /**
   * 「逐格相同」指的是**每格代表的本地日历日（日 key）**：这正是「哪一天」的口径，
   * 不许因为改窗口步长而被改掉（否则就是「改口径顺手改了正常读数」）。
   * 窗口**边界**是刻意改掉的（旧边界与标签错开一整天，见 `TIME-WINDOW-2`）。
   */
  it("东八区：格子数、日 key、每格 24 小时、首尾相接", () => {
    const NOW = Date.UTC(2026, 9, 7, 2, 30, 0); // 本地 2026-10-07 10:30
    const DAYS = 7;
    const windows = localDayWindows(DAYS, NOW, EAST8);
    const legacy = legacyWindows(DAYS, NOW);

    expect(windows.length).toBe(DAYS);
    expect(windowViolations(windows, DAYS, EAST8)).toEqual([]);
    // 无 DST ⇒ 每格恰好 24 小时
    expect(windows.map((w) => w.end - w.start)).toEqual(new Array(DAYS).fill(24 * HOUR));
    // 日 key 与旧实现逐格相同（旧实现的日 key = 窗口起点的本地日）
    expect(windows.map((w) => dayKeyAt(w.start, EAST8))).toEqual(
      legacy.map((w) => dayKeyAt(w.date, EAST8)),
    );
    expect(windows.map((w) => dayKeyAt(w.start, EAST8))).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
  });

  it("系统口径 = 注入表（把 getTimezoneOffset 钉成东八区后，localDateString 与注入表一致）", () => {
    const NOW = Date.UTC(2026, 9, 7, 2, 30, 0);
    const windows = localDayWindows(7, NOW, EAST8);
    withSystemZone(EAST8, () => {
      expect(windows.map((w) => localDateString(new Date(w.start)))).toEqual(
        windows.map((w) => dayKeyAt(w.start, EAST8)),
      );
    });
  });
});

// ===================== TIME-DST-1 =====================

describe("TIME-DST-1：跳变日前后各一条记录都落在本地日历日对应的格子（两个组件都覆盖）", () => {
  /** 纽约 2024-03-10 16:00 EDT（跳变之后） */
  const NOW = Date.UTC(2024, 2, 10, 20, 0, 0);
  const DAYS = 3;
  const records = [
    rec(Date.UTC(2024, 2, 10, 6, 30, 0), 100), // 跳变**前**：纽约 01:30 EST（本地日 03-10）
    rec(Date.UTC(2024, 2, 10, 7, 30, 0), 50), // 跳变**后**：纽约 03:30 EDT（本地日 03-10）
    rec(Date.UTC(2024, 2, 9, 20, 0, 0), 20), // 前一天：纽约 03-09 15:00 EDT
  ];

  it("TokenActivityGrid：格子数 = days，两条跳变日记录进**同一格**（今天）", () => {
    withSystemZone(NY, () =>
      withNow(NOW, () => {
        const { container } = render(createElement(TokenActivityGrid, { records, days: DAYS }));
        const cells = Array.from(container.querySelectorAll(".token-activity-cell"));
        expect(cells.length, "格子数必须等于声明的 days").toBe(DAYS);
        const titles = cells.map((c) => c.getAttribute("title") ?? "");
        expect(titles[0]).toContain("0 tokens");
        expect(titles[1]).toContain("20 tokens");
        expect(titles[2], "跳变日两条记录必须合并进今天这一格（100 + 50）").toContain("150 tokens");
        expect(cells[2].className).toContain("level-4");
        expect(cells[1].className).toContain("level-1");
      }),
    );
  });

  it("UsageChart：格子数 = days、标签按本地日、`[start, end)` 用窗口边界", () => {
    withSystemZone(NY, () =>
      withNow(NOW, () => {
        const { container } = render(createElement(UsageChart, { records, days: DAYS }));
        const labels = Array.from(container.querySelectorAll(".usage-chart-label")).map(
          (e) => e.textContent,
        );
        expect(labels).toEqual(["3/8", "3/9", "3/10"]);
        const tips = Array.from(container.querySelectorAll(".usage-chart-bar-tooltip")).map(
          (e) => e.textContent ?? "",
        );
        expect(tips.length).toBe(DAYS);
        expect(tips[0]).toContain("0 tokens");
        expect(tips[1]).toContain("20 tokens");
        expect(tips[2]).toContain("150 tokens");
      }),
    );
  });

  it("UsageChart：本地 00:00 整算今天、前一毫秒算昨天（左闭右开，按本地日界而不是 now - 24h）", () => {
    const edge = [
      rec(Date.UTC(2024, 2, 10, 5, 0, 0), 7), // 纽约 03-10 00:00 整
      rec(Date.UTC(2024, 2, 10, 4, 59, 59), 3), // 纽约 03-09 23:59:59
    ];
    withSystemZone(NY, () =>
      withNow(NOW, () => {
        const { container } = render(createElement(UsageChart, { records: edge, days: 2 }));
        const labels = Array.from(container.querySelectorAll(".usage-chart-label")).map(
          (e) => e.textContent,
        );
        expect(labels).toEqual(["3/9", "3/10"]);
        const tips = Array.from(container.querySelectorAll(".usage-chart-bar-tooltip")).map(
          (e) => e.textContent ?? "",
        );
        expect(tips[0], "前一毫秒属于昨天").toContain("3 tokens");
        expect(tips[1], "本地 00:00 整属于今天").toContain("7 tokens");
      }),
    );
  });
});

// ===================== TIME-DST-2 =====================

describe("TIME-DST-2：本地日 23 / 25 小时两种形态各一条（春季前跳 / 秋季回拨）", () => {
  it("春季前跳日 = 23 小时；秋季回拨日 = 25 小时；普通日仍是 24 小时", () => {
    const spring = localDayWindows(2, Date.UTC(2024, 2, 11, 12, 0, 0), NY);
    expect(spring[0].start, "纽约 2024-03-10 00:00 EST").toBe(Date.UTC(2024, 2, 10, 5, 0, 0));
    expect(spring[0].end, "纽约 2024-03-11 00:00 EDT").toBe(Date.UTC(2024, 2, 11, 4, 0, 0));
    expect(spring[0].end - spring[0].start).toBe(23 * HOUR);

    const fall = localDayWindows(2, Date.UTC(2024, 10, 4, 12, 0, 0), NY);
    expect(fall[0].start, "纽约 2024-11-03 00:00 EDT").toBe(Date.UTC(2024, 10, 3, 4, 0, 0));
    expect(fall[0].end, "纽约 2024-11-04 00:00 EST").toBe(Date.UTC(2024, 10, 4, 5, 0, 0));
    expect(fall[0].end - fall[0].start).toBe(25 * HOUR);

    const plain = localDayWindows(3, Date.UTC(2024, 2, 13, 12, 0, 0), NY);
    expect(plain.map((w) => w.end - w.start)).toEqual([24 * HOUR, 24 * HOUR, 24 * HOUR]);
  });

  it("跨跳变日连续多天：首尾相接、无缝隙、无重叠（23h / 25h 都不能破这条）", () => {
    for (const ref of [
      Date.UTC(2024, 2, 13, 12, 0, 0), // 覆盖 03-10（23h）
      Date.UTC(2024, 10, 6, 12, 0, 0), // 覆盖 11-03（25h）
    ]) {
      const windows = localDayWindows(5, ref, NY);
      expect(windowViolations(windows, 5, NY)).toEqual([]);
      const total = windows.reduce((sum, w) => sum + (w.end - w.start), 0);
      // 逐格相加 = 首尾之差 ⇒ 既没有缝隙也没有重叠
      expect(total).toBe(windows[windows.length - 1].end - windows[0].start);
    }
  });
});

// ===================== TIME-DST-3 =====================

describe("TIME-DST-3：跳变日三个时刻（前 / 瞬间 / 后）的读数", () => {
  const CASES: Array<{ t: number; when: string; ymd: string; clock: string; offset: number }> = [
    {
      t: Date.UTC(2024, 2, 10, 6, 59, 59),
      when: "春季前跳前",
      ymd: "2024-03-10",
      clock: "01:59:59",
      offset: -300,
    },
    {
      t: Date.UTC(2024, 2, 10, 7, 0, 0),
      when: "春季前跳瞬间",
      ymd: "2024-03-10",
      clock: "03:00:00",
      offset: -240,
    },
    {
      t: Date.UTC(2024, 2, 10, 7, 0, 1),
      when: "春季前跳后",
      ymd: "2024-03-10",
      clock: "03:00:01",
      offset: -240,
    },
    {
      t: Date.UTC(2024, 10, 3, 5, 59, 59),
      when: "秋季回拨前",
      ymd: "2024-11-03",
      clock: "01:59:59",
      offset: -240,
    },
    {
      t: Date.UTC(2024, 10, 3, 6, 0, 0),
      when: "秋季回拨瞬间",
      ymd: "2024-11-03",
      clock: "01:00:00",
      offset: -300,
    },
    {
      t: Date.UTC(2024, 10, 3, 6, 0, 1),
      when: "秋季回拨后",
      ymd: "2024-11-03",
      clock: "01:00:01",
      offset: -300,
    },
  ];

  it("注入表的读数：日期不变、时刻按跳变前后各自前进、偏移随瞬时变化", () => {
    for (const c of CASES) {
      const p = localTimePartsAt(c.t, NY);
      expect(dayKeyAt(c.t, NY), `${c.when} 的本地日`).toBe(c.ymd);
      expect(`${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`, `${c.when} 的本地时刻`).toBe(
        c.clock,
      );
      expect(p.offsetMinutes, `${c.when} 的偏移`).toBe(c.offset);
    }
  });

  it("系统口径与注入表**逐字段一致**（两条通路不许各说各话）", () => {
    for (const c of CASES) {
      const injected = localTimePartsAt(c.t, NY);
      withSystemZone(NY, () => {
        const at = new Date(c.t);
        expect(localTimeParts(at)).toEqual(injected);
        expect(localDateString(at)).toBe(c.ymd);
      });
    }
  });
});

// ===================== TIME-DST-4 =====================

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
/** 唯一实现（「日窗口」的算法只允许在这里） */
const SHARED = "src/core/time/local-time.ts";

/**
 * 「裸日长」的**可解析形态**。
 *
 * 认的是**字面量本身**（不是「文件里含某个字符串」的伪判据），并且把等价写法一起收进来
 * （`24 * 60 * 60 * 1000` / `86_400_000` / `86400000` / `24 * 3600_000` / `24 * 3600 * 1000`），
 * 免得「换个写法」就绕过对账。
 */
const DAY_LITERAL_FORMS: Array<{ literal: string; re: RegExp }> = [
  { literal: "24 * 60 * 60 * 1000", re: /\b24\s*\*\s*60\s*\*\s*60\s*\*\s*1000\b/ },
  { literal: "86_400_000", re: /\b86_400_000\b/ },
  { literal: "86400000", re: /\b86400000\b/ },
  { literal: "24 * 3600_000", re: /\b24\s*\*\s*3600_000\b/ },
  { literal: "24 * 3600 * 1000", re: /\b24\s*\*\s*3600\s*\*\s*1000\b/ },
];

/**
 * **例外表**：每条都必须是「**经过时长**」（retention / TTL / 多久以前 / 复习间隔），
 * 而**不是**「按本地日历日分格 / 按天展示」。`occurrences` 是「该字面量在该文件里出现的次数」——
 * 它是**防过期**的机械约束：字面量被删掉（条目过期）或同文件里又新加一处（漏登记）
 * 都会让次数对不上 ⇒ 判据红。
 *
 * `kind: "residual"` 是**如实登记的残留**：本轮任务限定了可改文件清单，这些位置确实是
 * 「把 24h 当日历日」的同类形态，但不在允许改动范围内 ⇒ 登记 + 在报告里点名，
 * 不伪装成「经过时长」。
 */
interface DayLiteralException {
  file: string;
  literal: string;
  occurrences: number;
  kind: "elapsed" | "residual";
  reason: string;
}

const DAY_LITERAL_EXCEPTIONS: DayLiteralException[] = [
  {
    file: "src/components/UsageStats.tsx",
    literal: "24 * 60 * 60 * 1000",
    occurrences: 1,
    kind: "elapsed",
    reason:
      "历史页取数窗口 = **滚动 7 × 24 小时**（HISTORY_LOOKBACK_DAYS * 24h）：它是一张按时间倒序的记录清单 + 缓存命中率的分母（「多久以前」），不参与按本地日历日分格；可视化那张（28 格）已改走 localDayWindows（见该文件注释）",
  },
  {
    file: "src/components/task-center/OverviewTab.tsx",
    literal: "86400000",
    occurrences: 1,
    kind: "elapsed",
    reason:
      "formatRelativeTime：diff < 86400000 决定显示「x 小时前」还是日期 —— **相对时间分档**（经过时长），不是按天分格",
  },
  {
    file: "src/components/task-center/InboxTab.tsx",
    literal: "86400000",
    occurrences: 1,
    kind: "elapsed",
    reason: "formatTime：同上，「x 小时前」vs 日期的**相对时间分档**",
  },
  {
    file: "src/components/SnapshotPanel.tsx",
    literal: "86400000",
    occurrences: 1,
    kind: "elapsed",
    reason: "formatTime：同上，「x 小时前」vs 日期的**相对时间分档**",
  },
  {
    file: "src/core/provider/time-context-provider.ts",
    literal: "86_400_000",
    occurrences: 2,
    kind: "elapsed",
    reason:
      "relative()：Intl.RelativeTimeFormat 的**单位分档**（小时 / 天 / 周）与除数 —— 「3 小时前」这类相对时间，不是日历日",
  },
  {
    file: "src/plugins/library-ops/core/format.ts",
    literal: "86_400_000",
    occurrences: 2,
    kind: "elapsed",
    reason: "formatAge()：相对时间分档（小时 / 天）与除数 —— 经过时长",
  },
  {
    file: "src/core/inbox/inbox-storage.ts",
    literal: "24 * 60 * 60 * 1000",
    occurrences: 1,
    kind: "elapsed",
    reason:
      "RETENTION_MS（通知保留 30 天）：**保留期**（retention），删的是「多久以前的」，与本地日历日无关",
  },
  {
    file: "src/core/llm/catalog-health.ts",
    literal: "24 * 60 * 60 * 1000",
    occurrences: 1,
    kind: "elapsed",
    reason: "ENTRY_TTL_MS（目录健康记录 30 天有效期）：**TTL**，过期即作废，与日历日无关",
  },
  {
    file: "src/core/memory/memory.ts",
    literal: "24 * 60 * 60 * 1000",
    occurrences: 2,
    kind: "elapsed",
    reason:
      "两处都是时长：maxAgeMs = maxAgeDays * 24h（条目最长存活期 = retention）与 oldestAge = (now - oldest) / 24h（「多少天前」的展示）",
  },
  {
    file: "src/core/knowledge/flashcard-store.ts",
    literal: "24 * 60 * 60 * 1000",
    occurrences: 1,
    kind: "elapsed",
    reason:
      "nextReview = now + intervalDays * 24h：SM-2 复习**间隔**（从现在起经过多久），不是本地日历日",
  },
  {
    file: "src/core/storage/spill.ts",
    literal: "24 * 60 * 60 * 1000",
    occurrences: 1,
    kind: "elapsed",
    reason: "pruneSpillFiles 的 cutoff = now - keepDays * 24h：**保留期**水位线（retention）",
  },
  {
    file: "src/core/storage/maintenance.ts",
    literal: "24 * 60 * 60 * 1000",
    occurrences: 2,
    kind: "elapsed",
    reason:
      "两处都是裁剪水位线：遥测 keepTelemetryDays * 24h 与审计 AUDIT_RETENTION_DAYS * 24h —— retention",
  },
  {
    file: "src/plugins/library-ops/core/telemetry-adapter.ts",
    literal: "24 * 3600_000",
    occurrences: 2,
    kind: "elapsed",
    reason:
      "perHour 分桶口径是「**近 24 小时**内」（滚动时长），不是「今天这个本地日」；按天分格的 perDay 补齐已改走 localDayWindows（同文件）",
  },
];

/** 去掉注释（否则注释里的示例会变成假阳性；与 `TIME-SINGLE-SOURCE` 同一手法） */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1} `);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

interface DayLiteralHit {
  rel: string;
  literal: string;
  line: number;
  text: string;
}

/** 扫 `src/**`（**排除 `src/test/**`**：测试夹具不是产品口径），返回逐条命中 */
function scanDayLiterals(): { scanned: number; hits: DayLiteralHit[] } {
  const hits: DayLiteralHit[] = [];
  let scanned = 0;
  for (const full of walk(SRC)) {
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (rel.startsWith("src/test/")) continue;
    scanned++;
    const code = stripComments(readFileSync(full, "utf8"));
    code.split("\n").forEach((line, i) => {
      for (const form of DAY_LITERAL_FORMS) {
        // 用 split 计数（不给正则加 g，免得 .test() 带状态）
        const count = line.split(form.re).length - 1;
        for (let k = 0; k < count; k++) {
          hits.push({ rel, literal: form.literal, line: i + 1, text: line.trim() });
        }
      }
    });
  }
  return { scanned, hits };
}

/** 按「文件 || 字面量」汇总次数（有序，便于对账与打印） */
function tally(pairs: Array<{ rel: string; literal: string }>): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const p of pairs) {
    const key = `${p.rel}||${p.literal}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

describe("TIME-DST-4：裸日长解析式对账（不许把 24h 当日历日；例外逐条登记且不过期）", () => {
  it("规则有判别力：五种等价写法都命中，共享口径的写法不误伤", () => {
    const dirty = [
      "const dayMs = 24 * 60 * 60 * 1000;",
      "const key = dayKey(now - i * 86_400_000);",
      "if (diff < 86400000) fmt();",
      "if (now - at < 24 * 3600_000) bucket();",
      "const hours = 24 * 3600 * 1000;",
    ].join("\n");
    const clean = [
      "const windows = localDayWindows(days, Date.now());",
      "const p = localTimeParts(new Date(t));",
      "const day = localDateString(new Date(t));",
    ].join("\n");
    for (const form of DAY_LITERAL_FORMS) {
      expect(form.re.test(dirty), `规则「${form.literal}」连要挡的形态都命不中 ⇒ 失效`).toBe(true);
      expect(form.re.test(clean), `规则「${form.literal}」误伤了共享口径的写法`).toBe(false);
    }
    // 逐条计数也要对（否则「命中几次」的对账是空转）
    expect(dirty.split(DAY_LITERAL_FORMS[0].re).length - 1).toBe(1);
    expect(dirty.split(DAY_LITERAL_FORMS[1].re).length - 1).toBe(1);
  });

  it("扫描本身不是空转（文件数与命中数都 > 0）", () => {
    const { scanned, hits } = scanDayLiterals();
    expect(scanned, "扫到的产品源码文件太少 ⇒ 目录遍历写错了").toBeGreaterThan(200);
    expect(hits.length, "一条都没扫到 ⇒ 下面那句对账等于没跑").toBeGreaterThan(0);
  });

  it("唯一实现（local-time.ts）里刻意**不含**裸日长（日界用 Date.UTC / setUTCDate 推）", () => {
    const { hits } = scanDayLiterals();
    const inShared = hits.filter((h) => h.rel === SHARED);
    expect(
      inShared.map((h) => `${h.rel}:${h.line} [${h.literal}] ${h.text}`),
      "唯一实现里出现了裸日长：本文件的日界是 Date.UTC/setUTCDate 推出来的，不需要它；" +
        "若确实要在这里写，请连同理由一起更新本判据（别让「日窗口的唯一实现」自己变成第二套口径）",
    ).toEqual([]);
  });

  it("`src/**`（除 src/test）里每一条命中都被例外表覆盖，且例外表不许过期", () => {
    const { hits } = scanDayLiterals();
    const actual = tally(hits.filter((h) => h.rel !== SHARED).map((h) => ({ rel: h.rel, literal: h.literal })));
    const declared = tally(
      DAY_LITERAL_EXCEPTIONS.map((e) => ({ rel: e.file, literal: e.literal })),
    ).map(([key]) => {
      const e = DAY_LITERAL_EXCEPTIONS.find((x) => `${x.file}||${x.literal}` === key)!;
      return [key, e.occurrences] as [string, number];
    });

    const detail = [
      "实际命中（文件 || 字面量 → 次数）：",
      ...actual.map(([k, n]) => `  - ${k} → ${n}`),
      "例外表声明：",
      ...declared.map(([k, n]) => `  - ${k} → ${n}`),
      "未登记的裸字面量 ⇒ 判据红；例外表计数不符（条目过期 / 同文件漏登记）⇒ 判据红。",
    ].join("\n");

    expect(declared.length, "例外表里有重复键（同一 file+literal 写了两条）").toBe(
      new Set(DAY_LITERAL_EXCEPTIONS.map((e) => `${e.file}||${e.literal}`)).size,
    );
    expect(actual, detail).toEqual(declared);
  });

  it("例外表的每条：文件存在、字面量受扫描、理由写清「为什么是经过时长」；残留必须逐条列出", () => {
    for (const e of DAY_LITERAL_EXCEPTIONS) {
      expect(
        () => statSync(path.join(ROOT, e.file)),
        `例外表里的 ${e.file} 不存在了 ⇒ 条目该删`,
      ).not.toThrow();
      expect(e.occurrences).toBeGreaterThan(0);
      expect(e.reason.length).toBeGreaterThan(10);
      expect(
        DAY_LITERAL_FORMS.some((f) => f.literal === e.literal),
        `例外条目的 literal「${e.literal}」不在受扫描的形态里 ⇒ 它挡不住任何东西`,
      ).toBe(true);
    }
    // 残留（不是「经过时长」、但当时不在允许改动范围内）必须被**逐条**列出来，不许混进 elapsed
    const residuals = DAY_LITERAL_EXCEPTIONS.filter((e) => e.kind === "residual");
    expect(
      residuals.map((r) => r.file),
      "新增「把 24h 当日历日」的残留位置时，必须显式登记为 residual 并在报告里点名" +
        "（第 191 波收尾：Sidebar 的「今天」分组与 OverviewTab 的本地日 00:00 都已改走唯一实现 ⇒ 残留清零；" +
        "若这里又出现新条目，说明有人往产品代码里塞回了滚动 24h 当日历日）",
    ).toEqual([]);
  });
});

/**
 * `TIME-WINDOW-4`（第 191 波收尾：把「同一簇」的两个残留一并做掉）。
 *
 * 上一段 `TIME-DST-4` 只对账**裸日长字面量**，它覆盖不到两种同族形态 ——
 * 这正是「同一簇 bug 会以不同形态出现」的现场：
 *
 * | 残留 | 形态 | 为什么 `TIME-DST-4` 覆盖不到 | 后果 |
 * | --- | --- | --- | --- |
 * | `components/Sidebar.tsx` | `now - sessionTime < 24h` 分组，标题却是「今天」 | 字面量**确实**被例外表登记了（当时判为残留） | 昨天 10:30 的会话在 23.5h 内被标成「今天」 |
 * | `components/task-center/OverviewTab.tsx` | `new Date(); setHours(0,0,0,0)` | 它根本不是 24h 常量（是另一处**本地日 00:00** 实现） | 与唯一实现两套口径（DST 日的边界可能差一小时） |
 *
 * 现在两处都改走 `localDayStartMs`（唯一实现），并由本段钉住接线：
 * **改回滚动 24h / `setHours(0,0,0,0)` ⇒ 判据红**（变异见 `tools/mutate/specs/time-window-191.mjs`）。
 */
describe("TIME-WINDOW-4：「今天」的边界与本地日 00:00 全仓只许一处实现", () => {
  const mustUseShared = ["src/components/Sidebar.tsx", "src/components/task-center/OverviewTab.tsx"];

  it("TIME-WINDOW-4a: 两个消费方都走 localDayStartMs，且不许再出现滚动 24h 当「今天」", () => {
    for (const rel of mustUseShared) {
      const code = stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
      expect(code, `${rel} 必须用唯一实现 localDayStartMs 判定「今天」`).toContain("localDayStartMs");
    }
    const sidebar = stripComments(readFileSync(path.join(ROOT, "src/components/Sidebar.tsx"), "utf8"));
    expect(/sessionTime\s*>=\s*todayStart/.test(sidebar), "Sidebar 的「今天」必须是「>= 本地日 00:00」").toBe(true);
    expect(
      /now\s*-\s*sessionTime/.test(sidebar),
      "Sidebar 不许再用「now - 会话时间 < 24h」判「今天」（那是滚动时长，不是本地日历日）",
    ).toBe(false);
  });

  it("TIME-WINDOW-4b: 全仓产品代码里不许有第二处「本地日 00:00」实现（setHours(0,0,0,0)）", () => {
    const offenders: string[] = [];
    // `walk` 返回的是**绝对路径**（同文件的 scanDayLiterals 就是这么用的）
    for (const full of walk(SRC)) {
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (rel.startsWith("src/test/")) continue; // 夹具不算产品口径
      if (rel === "src/core/time/local-time.ts") continue; // 唯一实现（它用 Date.UTC 推，不用 setHours）
      const code = stripComments(readFileSync(full, "utf8"));
      if (/setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(code)) offenders.push(rel);
    }
    expect(
      offenders,
      `这些文件自己算了一遍「本地日 00:00」（应改用 src/core/time/local-time.ts 的 localDayStartMs）：\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("TIME-WINDOW-4c: 规则有判别力（历史形态必须命中、唯一实现不误伤）", () => {
    expect(/setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test("const today = new Date(); today.setHours(0, 0, 0, 0);")).toBe(true);
    expect(/setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test("const todayStart = localDayStartMs(Date.now());")).toBe(false);
    // Sidebar 的历史形态必须能被"滚动 24h 判今天"这条规则抓出来
    const historical = "if (sessionTime && (now - sessionTime) < 24 * 60 * 60 * 1000) { today.push(s); }";
    expect(/now\s*-\s*sessionTime/.test(historical), "历史形态必须被规则命中").toBe(true);
    expect(/sessionTime\s*>=\s*todayStart/.test(historical), "历史形态不许被误判为已修好").toBe(false);
  });
});

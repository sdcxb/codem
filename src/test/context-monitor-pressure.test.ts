/**
 * 上下文面板：**进度条与压力等级必须自洽**（第 72 轮真机走查抓到）
 *
 * ## 现场（装机版读数，可复核）
 *
 * 打开「上下文监控」面板，屏幕上同时写着：
 *
 * ```
 * 📊 上下文状态   23,678 / 115,200 tokens   21%
 * 压力等级  临界      剩余 91,522 tokens
 * 🔴 上下文即将满！请立即压缩或开启新对话
 * ```
 *
 * **21% 却说"即将满"** —— 用户看到的两个结论互相矛盾。
 *
 * ## 根因（同一件事被两套口径各算一遍）
 *
 * - 进度条：`budget.used / budget.available`，其中 used/available 来自**模型侧那条链**
 *   （可见消息 → 裁剪陈旧工具结果 → 按优先级选进"真实窗口 × 0.9"的预算）；
 * - 压力等级：另一个 `pressure` state，走 `getPressureLevelFromMessages(可见消息)`，
 *   它**自己另算一遍** `available = maxContextWindow − systemPrompt − outputReserve`，
 *   且**不裁剪、不按优先级选择** —— 分子分母都不同。
 *
 * 这与第 71 轮"概览卡 0 已完成 vs 委派页签 3 已完成"是同一个病。修法：阈值收成唯一实现
 * （`pressureLevelForRatio`），面板上那两个数字统一由 `summarizeDisplayPressure`
 * 从**同一对数字**导出，`ContextMonitor` 里的 `pressure` state 整个删掉。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | CMP-1 | `pressureLevelForRatio` 的边界（0.49/0.5、0.69/0.7、0.89/0.9、非有限值） |
 * | CMP-2 | `summarizeDisplayPressure` 给的一对数字**自洽**：percent 与 level 必须来自同一个 ratio |
 * | CMP-3 | `getPressureLevelFromMessages` 与 `pressureLevelForRatio(used/available)` 完全一致（阈值只有一份） |
 * | CMP-4 | 结构判据：`ContextMonitor` 里**不再有** `pressure` state / `setPressure`；等级必须由 `summarizeDisplayPressure(budget.used, budget.available)` 导出 |
 * | CMP-5 | 真机那个现场的组合（21% ⇒ 正常；95% ⇒ 临界）在纯函数上判对（这就是屏幕上那对数字的来源） |
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  pressureLevelForRatio,
  summarizeDisplayPressure,
  getContextManager,
  PRESSURE_THRESHOLDS,
} from "../core/context/context";

const ROOT = process.cwd();
const COMPONENT = "src/components/ContextMonitor.tsx";
const code = () =>
  fs
    .readFileSync(path.join(ROOT, COMPONENT), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

describe("上下文面板：占用率与压力等级必须自洽（第 72 轮）", () => {
  it("CMP-1: 压力等级阈值是唯一一份，边界按 0.5/0.7/0.9", () => {
    expect([...PRESSURE_THRESHOLDS]).toEqual([0.5, 0.7, 0.9]);
    expect(pressureLevelForRatio(0)).toBe(0);
    expect(pressureLevelForRatio(0.49)).toBe(0);
    expect(pressureLevelForRatio(0.5)).toBe(1);
    expect(pressureLevelForRatio(0.69)).toBe(1);
    expect(pressureLevelForRatio(0.7)).toBe(2);
    expect(pressureLevelForRatio(0.89)).toBe(2);
    expect(pressureLevelForRatio(0.9)).toBe(3);
    expect(pressureLevelForRatio(1.4)).toBe(3);
    // 非有限值/负数不许抛、也不许算成"临界"
    expect(pressureLevelForRatio(Number.NaN)).toBe(0);
    expect(pressureLevelForRatio(-3)).toBe(0);
    expect(pressureLevelForRatio(Number.POSITIVE_INFINITY)).toBe(3);
  });

  it("CMP-2: `summarizeDisplayPressure` 给出的百分比与等级来自同一个比值", () => {
    const cases: Array<[number, number]> = [
      [23678, 115200], // 真机现场：21%
      [0, 115200],
      [57600, 115200],
      [109440, 115200],
      [200000, 115200],
      [5, 0], // 分母为 0（无预算）→ 不许 NaN
    ];
    for (const [used, available] of cases) {
      const d = summarizeDisplayPressure(used, available);
      expect(Number.isFinite(d.percent), `percent 必须是有限数（used=${used}/${available}）`).toBe(true);
      expect(d.percent).toBe(Math.round(d.ratio * 100));
      expect(d.level, "等级必须就是「该比值」的等级 —— 这正是真机上缺的那一环").toBe(pressureLevelForRatio(d.ratio));
    }
  });

  it("CMP-3: `getPressureLevelFromMessages` 用的就是同一份阈值", () => {
    const cm = getContextManager();
    const messages = [
      { content: "a".repeat(400) },
      { content: "b".repeat(4000) },
      { content: "c".repeat(40000) },
    ];
    const b = cm.calculateBudgetFromMessages(messages as never);
    expect(cm.getPressureLevelFromMessages(messages as never)).toBe(
      pressureLevelForRatio(b.available > 0 ? b.used / b.available : 0),
    );
  });

  it("CMP-4: `ContextMonitor` 不再有独立的 pressure 口径", () => {
    const src = code();
    expect(src, "`pressure` state 必须删掉（它就是第二套口径）").not.toMatch(/useState[^\n]*\bpressure\b/);
    expect(src, "不许再有 setPressure").not.toContain("setPressure");
    expect(
      src,
      "压力等级必须由 summarizeDisplayPressure 从**进度条那两个数**导出",
    ).toMatch(/summarizeDisplayPressure\s*\(\s*budget\.used\s*,\s*budget\.available\s*\)/);
    // 反向：进度条的百分比也必须来自同一个导出（不许各算各的）
    expect(src, "usagePercent 必须来自 display.percent").toMatch(/usagePercent\s*=\s*display\.percent/);
  });

  it("CMP-5: 真机现场那对数字现在自洽（21% ⇒ 正常；95% ⇒ 临界）", () => {
    const low = summarizeDisplayPressure(23678, 115200);
    expect(low.percent).toBe(21);
    expect(low.level, "21% 必须是「正常」，不许再显示「临界 / 即将满」").toBe(0);

    const high = summarizeDisplayPressure(109440, 115200);
    expect(high.percent).toBe(95);
    expect(high.level, "95% 才是「临界」").toBe(3);
  });
});

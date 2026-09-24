/**
 * 运行状态条（`RunStatusBar`）依赖的纯函数：**第一次有测试**（第 97 轮）。
 *
 * ## 为什么这一条值得写
 *
 * 覆盖率盘点（第 96 轮）把 `src/core/llm/run-status-tracker.ts` 列为**行覆盖 0%**。
 * 但它的函数不少是**用户直接看得见的文字**：状态条上的「思考中 / 执行中 / 呈现中 / 审查中」、
 * 正在处理时的「正在思考…」、以及已用时长「刚刚 / 3秒 / 2分5秒 / 1时3分」
 * （`src/components/RunStatusBar.tsx` 用的就是它们）。
 *
 * 同一轮还删掉了这个文件里**没有消费方**的 `buildActivityTimeline()`（连同它的两个类型）——
 * 原因写在源码注释里：全仓只剩注释在提它，而且实现是半成品（`slice(cursor, cursor)` 恒为空、
 * `cursor` 从不前进，内容会被整段误挂到末尾）。所以这个文件现在只剩"在用的那部分"，也就能被完整测到。
 *
 * ## 口径
 *
 * 只测**真实契约**（∈ 取值域内的输入）。刻意不测 NaN / Infinity 这类越界输入：
 * 那些值在生产里来自 `Date.now()` 的差值，取不到；给不存在的输入编断言只会制造假判据。
 */
import { describe, it, expect } from "vitest";
import {
  createRunStatus,
  formatRunDuration,
  getRunElapsed,
  phaseIcon,
  phaseLabel,
  processingMessage,
  shouldShowRunBar,
  type RunPhase,
  type RunStatus,
} from "../core/llm/run-status-tracker";

const ALL_PHASES: RunPhase[] = ["idle", "thinking", "working", "presenting", "reviewing", "completed", "error"];

describe("运行状态追踪（第 97 轮首次覆盖）", () => {
  it("RUN-1 初始态：待命、没开始、没目标、没错误、不在跑", () => {
    const s = createRunStatus();
    expect(s).toEqual({ phase: "idle", startedAt: null, target: null, error: "", isRunning: false });
  });

  it("RUN-2 每个阶段都有中文标签与图标（新增阶段必须同时补这两处）", () => {
    const labels = ALL_PHASES.map((p) => phaseLabel(p));
    expect(labels).toEqual(["待命", "思考中", "执行中", "呈现中", "审查中", "已完成", "出错"]);
    // 标签互不相同（否则界面上两个阶段长得一样）
    expect(new Set(labels).size, `阶段标签重复：${labels.join("/")}`).toBe(labels.length);

    const icons = ALL_PHASES.map((p) => phaseIcon(p));
    expect(icons).toEqual(["circle", "brain", "loader", "sparkles", "check-circle", "check", "alert-triangle"]);
    expect(new Set(icons).size, `阶段图标重复：${icons.join("/")}`).toBe(icons.length);

    // 未知阶段（未来新增但忘了分支）→ 空标签 + 兜底图标，不许崩
    expect(phaseLabel("bogus" as RunPhase)).toBe("");
    expect(phaseIcon("bogus" as RunPhase)).toBe("circle");
  });

  it("RUN-3 「正在处理」只在四个进行中的阶段有文案，其余为空", () => {
    expect(processingMessage("thinking")).toBe("正在思考...");
    expect(processingMessage("working")).toBe("正在执行工具调用...");
    expect(processingMessage("presenting")).toBe("正在生成回复...");
    expect(processingMessage("reviewing")).toBe("正在审查结果...");
    // 非进行中：空串（`RunStatusBar` 会回落到 phaseLabel，见它自己的 `processingMessage(phase) || phaseLabel(phase)`）
    for (const p of ["idle", "completed", "error"] as RunPhase[]) {
      expect(processingMessage(p), `${p} 不该有"正在处理"文案`).toBe("");
    }
  });

  it("RUN-4 时长文案：四档边界逐个钉住（刚刚 / 秒 / 分秒 / 时分）", () => {
    expect(formatRunDuration(0)).toBe("刚刚");
    expect(formatRunDuration(999)).toBe("刚刚"); // 边界：< 1s
    expect(formatRunDuration(1000)).toBe("1秒");
    expect(formatRunDuration(59_999)).toBe("59秒");
    expect(formatRunDuration(60_000)).toBe("1分0秒"); // 边界：正好 1 分钟
    expect(formatRunDuration(125_000)).toBe("2分5秒");
    expect(formatRunDuration(3_599_000)).toBe("59分59秒");
    expect(formatRunDuration(3_600_000)).toBe("1时0分"); // 边界：正好 1 小时
    expect(formatRunDuration(7_380_000)).toBe("2时3分");
  });

  it("RUN-5 经过时间：没开始就是 0；开始了就按传入的 now 算（可注入 ⇒ 不依赖真实时钟）", () => {
    const fresh = createRunStatus();
    expect(getRunElapsed(fresh, 1_000_000)).toBe(0);

    const running: RunStatus = { ...fresh, phase: "working", startedAt: 1_000_000, isRunning: true };
    expect(getRunElapsed(running, 1_000_000)).toBe(0);
    expect(getRunElapsed(running, 1_002_500)).toBe(2500);
    // 默认参数用 Date.now()：只断言"是正数且不太离谱"，不去和真实时钟较劲
    const auto = getRunElapsed(running);
    expect(auto).toBeGreaterThan(0);
  });

  it("RUN-6 状态条该不该显示：跑着要显示；出错要显示；**已完成且有过开始时间**要显示；其余不显示", () => {
    const base = createRunStatus();
    expect(shouldShowRunBar(base), "待命不显示").toBe(false);
    expect(shouldShowRunBar({ ...base, phase: "thinking", isRunning: true }), "跑着要显示").toBe(true);
    expect(shouldShowRunBar({ ...base, phase: "error" }), "出错要显示（否则用户看不到失败）").toBe(true);
    // 已完成：只有"确实跑过"（startedAt 非 null）才显示 —— 避免打开界面就挂一条空的"已完成"
    expect(shouldShowRunBar({ ...base, phase: "completed" })).toBe(false);
    expect(shouldShowRunBar({ ...base, phase: "completed", startedAt: 1 })).toBe(true);
    expect(shouldShowRunBar({ ...base, phase: "idle", isRunning: false })).toBe(false);
  });
});

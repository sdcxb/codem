/**
 * C04：**请求清单在产品界面里有真实入口**（可查看 / 可对比）。
 *
 * ## 被修的形态（独立复核的 P0 之一）
 *
 * `loadManifests` / `diffManifests` / `replayManifest` 早就有实现与判据，但全仓只有
 * **测试**在调用 —— 用户和复核者没有任何产品入口能回答「这一轮模型到底看到了什么、
 * 比上一轮少了什么」。判据再绿，这条能力对用户也不存在。
 *
 * 现在 `ContextMonitor` 增加「请求清单」区：读当前会话的 `loadManifests`，显示最近 5 条
 * （段号 / 消息数 / 四类来源字符 / 压力 / 预算 / 时间）以及**与真实上一条**的 added/removed。
 * 它只读现有导出，**不新增 IPC / 存储 / 事件**；与 `segmentEpochs` 开关无关（纯诊断）。
 *
 * ## 判据
 *
 * | id | 钉什么 |
 * |---|---|
 * | CM-UI-1 | 两条 manifest ⇒ 渲染段号、消息数、四类来源、压力/预算，且差异是**真实数字**（新增 2 / 移除 1） |
 * | CM-UI-2 | 没有记录 ⇒ 明确的空态文案，不抛错、不渲染假行 |
 *
 * 变红方式：把组件里的差异数字写死 0（`新增 0 / 移除 0`）⇒ CM-UI-1 红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

import { ContextMonitor } from "../components/ContextMonitor";
import { buildContextManifest, recordManifest, forgetManifests } from "../core/context/manifest";
import { getContextManager } from "../core/context/context";

const SESSION = "cm-manifest";

function makeManifest(params: {
  at: number;
  segmentSeq?: number;
  pressure?: number;
  estimated?: number;
  messages: Array<{ id?: string; role?: string; content?: string }>;
  /** C03：工作集数字（不传 = 这一轮没走工作集） */
  workingSet?: { budgetTokens: number; selected: number; evicted: number; indexLines: number };
}) {
  return buildContextManifest({
    sessionId: SESSION,
    at: params.at,
    segmentSeq: params.segmentSeq ?? 1,
    pressure: params.pressure ?? 0.4,
    budgetTokens: 1000,
    estimatedTokens: params.estimated ?? 400,
    messages: params.messages,
    ...(params.workingSet ? { workingSet: params.workingSet } : {}),
  });
}

beforeEach(() => {
  forgetManifests(SESSION);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  forgetManifests(SESSION);
  vi.restoreAllMocks();
});

describe("C04：ContextMonitor 请求清单（可查看 / 可对比）", () => {
  it("CM-UI-1：两条 manifest ⇒ 段号/消息数/来源/预算 + 真实的 added/removed 差异", async () => {
    /* 上一条：system 3 字符 + user 5 字符，2 条消息 */
    recordManifest(
      makeManifest({
        at: 1_000,
        messages: [
          { id: "a", role: "system", content: "sys" },
          { id: "b", role: "user", content: "hello" },
        ],
      }),
    );
    /* 这一条：保留 b，新增 tool（11 字符）与记忆消息；a 被移出 ⇒ 新增 2 / 移除 1 */
    recordManifest(
      makeManifest({
        at: 2_000,
        pressure: 0.4,
        estimated: 400,
        messages: [
          { id: "b", role: "user", content: "hello" },
          { id: "c", role: "tool", content: "tool output" },
          { id: "d", role: "user", content: "## 记忆\nfoo" },
        ],
      }),
    );

    render(<ContextMonitor sessionId={SESSION} visible={true} />);
    await waitFor(() => expect(screen.getByTestId("context-manifests")).toBeTruthy());

    const rows = screen.getAllByTestId("context-manifest-row");
    expect(rows, "最近两条 manifest 都要显示").toHaveLength(2);

    const newest = rows[0];
    expect(newest.textContent).toContain("第 1 段");
    expect(newest.textContent).toContain("3 条消息");
    /* 四类来源字符（这是"请求里到底装了什么"的最小可复查事实） */
    expect(newest.textContent).toContain("系统 0");
    expect(newest.textContent).toContain("对话 5");
    expect(newest.textContent).toContain("工具 11");
    expect(newest.textContent).toContain("记忆 9");
    /* pressure / 预算 / 时间 */
    expect(newest.textContent).toContain("压力 40%");
    expect(newest.textContent).toContain("400");
    expect(newest.textContent).toContain("1,000 tokens");

    /* ★ 变异点：这两个数字必须是 diffManifests 算出来的真实值（写死 0 ⇒ 本行红） */
    const diffs = screen.getAllByTestId("context-manifest-diff");
    expect(diffs[0].textContent, "最新一条必须显示与上一条的真实差异").toContain("新增 2 条");
    expect(diffs[0].textContent).toContain("移除 1 条");
    expect(diffs[1].textContent, "最早一条没有可对比的上一条").toContain("首条");
  });

  it("CM-UI-2：开关关闭时入口仍可见；没有记录 ⇒ 空态文案，不渲染假行、不抛错", async () => {
    /* 它只是诊断入口 ⇒ 与 segmentEpochs 开关无关（显式关闭/灰度回滚时也必须能看） */
    getContextManager().updateConfig({ segmentEpochs: false });
    render(<ContextMonitor sessionId={SESSION} visible={true} />);
    await waitFor(() => expect(screen.getByTestId("context-manifests-empty")).toBeTruthy());
    expect(screen.getByTestId("context-manifests"), "开关关闭也必须能看到请求清单").toBeTruthy();
    expect(screen.getByTestId("context-manifests-empty").textContent).toContain("本次运行还没有记录");
    expect(screen.queryAllByTestId("context-manifest-row")).toHaveLength(0);
  });

  /**
   * C03 / WS-6c：**工作集那一行**。
   *
   * 界面必须能回答「这一轮预算多少、选中几条、移出几条」—— 这三个数字正是用户
   * 判断"上下文是不是被程序动过"的唯一入口。没有该字段（没走工作集 / 旧数据）时
   * **不渲染这一行**（空数据不显示，避免「工作集：选中 0」这种误导）。
   */
  it("WS-6c：有 workingSet 的清单行显示「选中 / 移出 / 预算」；没有该字段的行不显示", async () => {
    /* 旧的那条：没走工作集（字段不存在） */
    recordManifest(
      makeManifest({
        at: 1_000,
        messages: [{ id: "b", role: "user", content: "hello" }],
      }),
    );
    /* 新的那条：真的走了工作集（3 选中 / 2 移出 / 4 行索引 / 预算 1234） */
    recordManifest(
      makeManifest({
        at: 2_000,
        messages: [
          { id: "b", role: "user", content: "hello" },
          { id: "c", role: "user", content: "world" },
        ],
        workingSet: { budgetTokens: 1_234, selected: 3, evicted: 2, indexLines: 4 },
      }),
    );

    render(<ContextMonitor sessionId={SESSION} visible={true} />);
    await waitFor(() => expect(screen.getAllByTestId("context-manifest-row")).toHaveLength(2));

    const lines = screen.getAllByTestId("context-manifest-working-set");
    expect(lines, "只有走了工作集的那一行才有这个元素").toHaveLength(1);
    expect(lines[0].textContent).toContain("工作集：选中 3");
    expect(lines[0].textContent).toContain("移出 2");
    expect(lines[0].textContent, "预算用千分位显示（与清单其它行同一写法）").toContain("1,234 tokens");

    /* 反过来：没有该字段的清单**不许**长出一行「选中 0 / 移出 0」 */
    expect(
      screen.getAllByTestId("context-manifest-row")[1].textContent,
      "没走工作集的那一行不许显示工作集",
    ).not.toContain("工作集：");
  });
});

/**
 * JobsPanel（底部「任务」页签的宿主兜底面板）行为判据 —— JOBSP-1..4。
 *
 * ## 为什么需要它
 *
 * `jobs` 这个 `BottomTab` 成员此前**没有任何面板组件**（全仓只有会话头部的 `JobsBadge`），
 * 恢复入口之后如果面板只是个壳，等于换一种形态的「假入口」。这条判据守三件事：
 *
 * 1. 空态要**如实**（没有后台任务时说没有，不摆假行）；
 * 2. 真起过 PTY 后台任务时，行与「终止」按钮真的接在 `TerminalManager` 上（点了真的调用 API）；
 * 3. **三态回执如实**：`already-finished`（命令早就自己跑完）不许显示成「已终止」——
 *    第 185 波 T3 定性过这条假成功（对还在跑/已跑完的进程报 ✅），界面侧不能后退。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("../core/llm/tools/terminal-tools", () => ({
  listTerminalBackgroundJobs: mocks.list,
  killTerminalBackgroundJob: mocks.kill,
}));

import { JobsPanel } from "../components/JobsPanel";

function ptyJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "pty-job-1",
    sessionId: "term-1",
    status: "running",
    startedAt: Date.now() - 5000,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.kill.mockReset();
  mocks.list.mockReturnValue([]);
});

afterEach(() => {
  cleanup();
});

describe("JobsPanel", () => {
  it("JOBSP-1: 没有后台任务时如实显示空态（面板根节点在，且没有任务行）", () => {
    const { container } = render(<JobsPanel />);
    expect(container.querySelector(".jobs-panel"), "面板根节点必须存在").toBeTruthy();
    expect(container.querySelector(".empty-hint"), "空态提示必须存在（走共享空态类 .empty-hint）").toBeTruthy();
    expect(container.querySelectorAll(".jobs-panel-row").length, "没有任务就不许有任务行").toBe(0);
  });

  it("JOBSP-2: 运行中的后台任务渲染成一行，点「终止」真的调用 TerminalManager.killBackgroundJob", async () => {
    mocks.list.mockReturnValue([ptyJob()]);
    mocks.kill.mockResolvedValue("killed");
    const { container } = render(<JobsPanel />);
    expect(container.querySelectorAll(".jobs-panel-row").length).toBe(1);

    const killBtn = container.querySelector(".jobs-panel-btn.is-danger") as HTMLButtonElement;
    expect(killBtn, "运行中的任务必须有终止按钮").toBeTruthy();
    expect(killBtn.disabled, "运行中的任务终止按钮必须可点").toBe(false);

    fireEvent.click(killBtn);
    await waitFor(() => expect(mocks.kill).toHaveBeenCalledWith("pty-job-1"));
    await waitFor(() => expect(container.querySelector(".jobs-panel-notice")).toBeTruthy());
  });

  it("JOBSP-3: already-finished 不许显示成「已终止」（三态回执如实）", async () => {
    mocks.list.mockReturnValue([ptyJob()]);
    mocks.kill.mockResolvedValue("already-finished");
    const { container } = render(<JobsPanel />);
    fireEvent.click(container.querySelector(".jobs-panel-btn.is-danger") as HTMLButtonElement);
    await waitFor(() => {
      const notice = container.querySelector(".jobs-panel-notice")!.textContent || "";
      expect(notice, "已经自己结束的任务不许报「已终止」").not.toContain("已终止");
      expect(notice.length, "必须有回执文字").toBeGreaterThan(0);
    });
  });

  it("JOBSP-4: 已结束的任务行，终止按钮必须禁用（不许对一个不在跑的任务报成功）", () => {
    mocks.list.mockReturnValue([ptyJob({ status: "completed", completedAt: Date.now() })]);
    const { container } = render(<JobsPanel />);
    const killBtn = container.querySelector(".jobs-panel-btn.is-danger") as HTMLButtonElement;
    expect(killBtn.disabled, "非 running 状态不许给可点的终止按钮").toBe(true);
  });
});

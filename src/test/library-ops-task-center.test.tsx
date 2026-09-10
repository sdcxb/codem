/**
 * LO-TASK — 图书馆功能并入「任务管理 → 看板」页签（不再有独立页签/面板）
 *
 * 覆盖：
 * - LO-TASK-1 任务管理固定 8 个页签（没有「图书馆」），「看板」页签存在
 * - LO-TASK-2 无插件贡献 → 看板显示宿主自带 Issues 看板；有贡献者 → 显示 slot 内容
 * - LO-TASK-3 `initialTab="board"` 直接落在看板页签
 * - LO-TASK-4 真实 provider 装配后，看板里渲染出 `.lo-task`（7 个视图）
 * - LO-TASK-5 贡献者在打开期间被移除 → 回退到宿主 Issues 看板
 * - LO-TASK-6 Ctrl+Shift+L / 事件别名 → 打开「任务管理 → 看板」
 * - LO-TASK-7 宿主声明了 task-center.board slot，BoardTab 用它做回退
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, fireEvent, cleanup } from "@testing-library/react";
import { Context } from "../core/cordis/src/index.ts";
import { SlotsService } from "../core/slots/index.ts";
import { setActiveContext } from "../core/consumer/index.ts";
import { TaskCenter, TASK_CENTER_BOARD_SLOT, type TaskCenterTab } from "../components/TaskCenter";
import { LIBRARY_TASK_SLOT, openLibraryView, uiLibraryOpsProvider } from "../core/provider/ui-library-ops-provider";
import { useLibraryOps } from "../plugins/library-ops/store";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NOW = 1_800_000_000_000;

/** 固定快照，避免真实采集宿主服务 */
vi.mock("../plugins/library-ops/core/telemetry-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/library-ops/core/telemetry-adapter")>();
  return {
    ...actual,
    collectSnapshot: vi.fn(async () => ({
      at: NOW,
      actors: [],
      teams: [],
      metrics: {
        sessions: 0, activeSessions: 0, teams: 0, tasksTotal: 0, tasksDone: 0, tasksFailed: 0,
        tasksRunning: 0, tasksPending: 0, actors: 0, actorsWorking: 0, actorsIdle: 0,
        actorsBlocked: 0, actorsError: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costTotal: 0,
        costToday: 0, toolCalls: 0, toolErrors: 0, filesTouched: 0, messages: 0, health: 1,
      },
      events: [],
      activity: { perDay: {}, perHour: new Array(24).fill(0), kinds: {} },
      sources: {
        sessions: 0, activeSessions: 0, teams: 0, teamMembers: 0, subagents: 0,
        teamTemplates: 0, agentProfiles: 0, telemetryEvents: 0, failed: [],
      },
      sampleMs: 0,
    })),
  };
});

function bootCtx(): { ctx: Context; slots: SlotsService } {
  const ctx = new Context();
  const slots = new SlotsService(ctx);
  slots.declareSlot(TASK_CENTER_BOARD_SLOT, { kind: "single", scope: "root" }, "test");
  setActiveContext(ctx);
  return { ctx, slots };
}

/** 每个用例装配的 provider dispose（避免 window 监听器跨用例累积） */
const disposers: Array<() => unknown> = [];

function tabLabels(): string[] {
  return [...document.querySelectorAll(".task-center-panel button")]
    .map((b) => b.textContent?.trim() ?? "")
    .filter((t) => t.length > 0 && !t.includes("×"));
}

function boardButton(): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>(".task-center-panel button")].find(
    (b) => b.textContent?.trim() === "看板",
  )!;
}

async function openTaskCenter(initialTab: TaskCenterTab = "overview") {
  const utils = render(<TaskCenter onClose={() => undefined} initialTab={initialTab} />);
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

/** 等 React.lazy（provider 里的动态导入）解析完成 */
async function flushLazy() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });
}

describe("LO-TASK 图书馆并入看板", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useLibraryOps.getState()._reset();
  });

  afterEach(() => {
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch {
        /* 忽略 */
      }
    }
    cleanup();
  });

  it("LO-TASK-1: 任务管理固定 8 个页签（没有「图书馆」），含「看板」", async () => {
    bootCtx();
    await openTaskCenter();
    const labels = tabLabels();
    expect(labels).toContain("概览");
    expect(labels).toContain("看板");
    expect(labels).toContain("团队");
    expect(labels).not.toContain("图书馆");
    expect(labels.filter((l) => l === "看板").length).toBe(1);
  });

  it("LO-TASK-2: 无贡献者 → 看板渲染宿主 Issues 看板；有贡献者 → 渲染 slot 内容", async () => {
    const { slots } = bootCtx();
    await openTaskCenter();
    await act(async () => {
      fireEvent.click(boardButton());
    });
    // 宿主看板：列标题（Backlog 等）
    expect(document.body.textContent).toContain("Backlog");
    expect(document.querySelector('[data-testid="stub-board"]')).toBeNull();

    slots.register({ name: TASK_CENTER_BOARD_SLOT, id: "stub-board", priority: 10 }, () => (
      <div data-testid="stub-board">接管后的看板</div>
    ));
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="stub-board"]')).toBeTruthy();
    // 看板页签会把面板加宽（happy-dom 不解析 min()，用 data-wide 断言）
    expect(document.querySelector<HTMLElement>(".task-center-panel")!.getAttribute("data-wide")).toBe("1");
  });

  it("LO-TASK-3: initialTab=board 直接落在看板页签", async () => {
    const { slots } = bootCtx();
    slots.register({ name: TASK_CENTER_BOARD_SLOT, id: "stub-board", priority: 10 }, () => (
      <div data-testid="stub-board">接管后的看板</div>
    ));
    await openTaskCenter("board");
    expect(document.querySelector('[data-testid="stub-board"]')).toBeTruthy();
  });

  it("LO-TASK-4: 真实 provider 装配后，看板里渲染出接管视图（7 个视图）", async () => {
    const { ctx } = bootCtx();
    const dispose = (uiLibraryOpsProvider as any)(ctx);
    if (typeof dispose === "function") disposers.push(dispose);
    // provider 用 React.lazy 加载视图：先预热模块，避免 happy-dom 下首帧停在 Suspense
    await import("../plugins/library-ops/components/LibraryOpsBoardView");
    await openTaskCenter("board");
    await flushLazy();
    expect(document.querySelector(".lo-task")).toBeTruthy();
    expect(document.querySelector(".lo-task__rail")).toBeTruthy();
    // 视图：看板 / 场景 / 用量 / 工具 / 错误 / 时间线 / 设置
    expect(document.querySelectorAll(".lo-task__rail .lo-nav__btn").length).toBe(7);
    // 默认视图是看板（宿主 Issues 看板）
    expect(document.body.textContent).toContain("Backlog");
  });

  it("LO-TASK-5: 贡献者在打开期间被移除 → 回退到宿主 Issues 看板", async () => {
    const { slots } = bootCtx();
    const unreg = slots.register({ name: TASK_CENTER_BOARD_SLOT, id: "stub-board", priority: 10 }, () => (
      <div data-testid="stub-board">接管后的看板</div>
    ));
    await openTaskCenter("board");
    expect(document.querySelector('[data-testid="stub-board"]')).toBeTruthy();

    await act(async () => {
      unreg();
    });
    expect(document.querySelector('[data-testid="stub-board"]')).toBeNull();
    expect(document.body.textContent).toContain("Backlog");
  });

  it("LO-TASK-6: Ctrl+Shift+L 打开「任务管理 → 看板」", async () => {
    const { ctx } = bootCtx();
    const dispose = (uiLibraryOpsProvider as any)(ctx);
    if (typeof dispose === "function") disposers.push(dispose);
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("codem:open-task-center", listener);
    try {
      await act(async () => {
        fireEvent.keyDown(window, { key: "l", ctrlKey: true, shiftKey: true });
      });
      expect(seen).toEqual([{ tab: "board" }]);
      await act(async () => {
        window.dispatchEvent(new CustomEvent("codem:open-library-ops"));
      });
      expect(seen.length).toBe(2);
      expect(openLibraryView()).toEqual({ opened: true });
      expect(seen.length).toBe(3);
    } finally {
      window.removeEventListener("codem:open-task-center", listener);
    }
  });

  it("LO-TASK-7: 宿主声明了 task-center.board slot，BoardTab 用它做回退", () => {
    const declare = readFileSync(join(__dirname, "..", "core", "slots", "declare-slots.ts"), "utf8");
    expect(declare).toContain("task-center.board");
    expect(declare).toMatch(/declareSlot\('task-center\.board',\s*\{\s*kind:\s*'single'/);
    const board = readFileSync(join(__dirname, "..", "components", "task-center", "BoardTab.tsx"), "utf8");
    expect(board).toContain("SlotBridge");
    expect(board).toContain("task-center.board");
    expect(board).toContain("IssueBoard");
    expect(LIBRARY_TASK_SLOT).toBe(TASK_CENTER_BOARD_SLOT);
    // 旧 tab id 兼容：library → board
    const tc = readFileSync(join(__dirname, "..", "components", "TaskCenter.tsx"), "utf8");
    expect(tc).toContain('if (t === "library") return "board"');
  });
});

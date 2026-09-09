/**
 * LO-TASK — 图书馆功能融合进「任务管理」面板（不再有独立面板）
 *
 * 覆盖：
 * - LO-TASK-1 没有插件贡献时，任务管理只有原有的 8 个页签（无「图书馆」）
 * - LO-TASK-2 有贡献者时出现「图书馆」页签，点击渲染 slot 内容
 * - LO-TASK-3 `initialTab="library"` 直接落在图书馆页签
 * - LO-TASK-4 真实 provider 装配后，任务管理里渲染出 `.lo-task` 视图
 * - LO-TASK-5 贡献者在面板打开期间被移除 → 页签消失并回落到概览
 * - LO-TASK-6 Ctrl/Cmd+Shift+L 打开「任务管理 → 图书馆」
 * - LO-TASK-7 宿主声明了 task-center.library slot（declare-slots）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, fireEvent, cleanup } from "@testing-library/react";
import { Context } from "../core/cordis/src/index.ts";
import { SlotsService } from "../core/slots/index.ts";
import { setActiveContext } from "../core/consumer/index.ts";
import { TaskCenter, TASK_CENTER_LIBRARY_SLOT, type TaskCenterTab } from "../components/TaskCenter";
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
  slots.declareSlot(TASK_CENTER_LIBRARY_SLOT, { kind: "single", scope: "root" }, "test");
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

describe("LO-TASK 图书馆融合进任务管理", () => {
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
        /* 忽略：dispose 失败不影响用例结论 */
      }
    }
    cleanup();
  });

  it("LO-TASK-1: 无插件贡献 → 只有原有 8 个页签，没有「图书馆」", async () => {
    bootCtx();
    await openTaskCenter();
    const labels = tabLabels();
    expect(labels).toContain("概览");
    expect(labels).toContain("团队");
    expect(labels).not.toContain("图书馆");
    expect(document.querySelector(".task-center-panel")).toBeTruthy();
  });

  it("LO-TASK-2: 有贡献者 → 出现「图书馆」页签，点击渲染 slot 内容", async () => {
    const { slots } = bootCtx();
    slots.register({ name: TASK_CENTER_LIBRARY_SLOT, id: "stub-view", priority: 10 }, () => (
      <div data-testid="stub-library">图书馆内容</div>
    ));
    await openTaskCenter();
    expect(tabLabels()).toContain("图书馆");
    expect(document.querySelector('[data-testid="stub-library"]')).toBeNull();

    const tab = [...document.querySelectorAll<HTMLButtonElement>(".task-center-panel button")].find((b) =>
      b.textContent?.includes("图书馆"),
    )!;
    await act(async () => {
      fireEvent.click(tab);
    });
    expect(document.querySelector('[data-testid="stub-library"]')).toBeTruthy();
    // 图书馆页签会把面板加宽（happy-dom 不解析 min()，用 data-wide 断言）
    const panel = document.querySelector<HTMLElement>(".task-center-panel")!;
    expect(panel.getAttribute("data-wide")).toBe("1");
  });

  it("LO-TASK-3: initialTab=library 直接落在图书馆页签", async () => {
    const { slots } = bootCtx();
    slots.register({ name: TASK_CENTER_LIBRARY_SLOT, id: "stub-view", priority: 10 }, () => (
      <div data-testid="stub-library">图书馆内容</div>
    ));
    await openTaskCenter("library");
    expect(document.querySelector('[data-testid="stub-library"]')).toBeTruthy();
  });

  it("LO-TASK-4: 真实 provider 装配后，任务管理里渲染出图书馆视图", async () => {
    const { ctx } = bootCtx();
    const dispose = (uiLibraryOpsProvider as any)(ctx);
    if (typeof dispose === "function") disposers.push(dispose);
    // provider 用 React.lazy 加载视图：先预热模块，避免 happy-dom 下首帧停在 Suspense
    await import("../plugins/library-ops/components/LibraryOpsTaskView");
    await openTaskCenter("library");
    await flushLazy();
    expect(document.querySelector(".lo-task")).toBeTruthy();
    expect(document.querySelector(".lo-task__rail")).toBeTruthy();
    // 子视图：场景/用量/会话/工具/成本/错误/时间线/设置
    expect(document.querySelectorAll(".lo-task__rail .lo-nav__btn").length).toBe(8);
    // 默认场景视图挂载（像素场景）
    expect(document.querySelector('.lo-scene[data-scene="pixel"]')).toBeTruthy();
  });

  it("LO-TASK-5: 贡献者在打开期间被移除 → 页签消失并回落概览", async () => {
    const { slots } = bootCtx();
    const unreg = slots.register({ name: TASK_CENTER_LIBRARY_SLOT, id: "stub-view", priority: 10 }, () => (
      <div data-testid="stub-library">图书馆内容</div>
    ));
    await openTaskCenter("library");
    expect(document.querySelector('[data-testid="stub-library"]')).toBeTruthy();

    await act(async () => {
      unreg();
    });
    expect(tabLabels()).not.toContain("图书馆");
    expect(document.querySelector('[data-testid="stub-library"]')).toBeNull();
    // 回落到概览（概览内容出现）
    expect(document.querySelector(".task-center-panel")!.textContent).toContain("概览");
  });

  it("LO-TASK-6: Ctrl+Shift+L 打开「任务管理 → 图书馆」", async () => {
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
      expect(seen).toEqual([{ tab: "library" }]);
      // 事件别名（旧代码）同样可用
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

  it("LO-TASK-7: 宿主声明了 task-center.library slot（declare-slots）", () => {
    const src = readFileSync(join(__dirname, "..", "core", "slots", "declare-slots.ts"), "utf8");
    expect(src).toContain("task-center.library");
    expect(src).toMatch(/declareSlot\('task-center\.library',\s*\{\s*kind:\s*'single'/);
    // 宿主的 TaskCenter 用 useSlotHasEntries + SlotBridge 消费它
    const tc = readFileSync(join(__dirname, "..", "components", "TaskCenter.tsx"), "utf8");
    expect(tc).toContain("useSlotHasEntries");
    expect(tc).toContain("SlotBridge");
    expect(tc).toContain("TASK_CENTER_LIBRARY_SLOT");
    // provider 注册的 id 与 slot 名一致
    expect(LIBRARY_TASK_SLOT).toBe(TASK_CENTER_LIBRARY_SLOT);
  });
});

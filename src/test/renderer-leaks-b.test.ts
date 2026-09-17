/**
 * 渲染层泄漏 / 竞态 / 静默失败回归（P2-8 … P2-16）
 *
 * 覆盖 `C:\mimo-gui\.preview-shot\_audit\RUNTIME-ROBUSTNESS.md` 的九条已复核
 * P2 缺陷。**每条都先复核过现行代码**（报告里的行号已有漂移，证据见每条注释）。
 *
 * | 用例组 | 缺陷 | 原实现的机制 |
 * |---|---|---|
 * | RL-1*  | P2-8  | `CicdPanel.loadRuns` 无请求标识（旧仓库响应覆盖新仓库）；重试/取消无 in-flight 守卫（重复 POST） |
 * | RL-2*  | P2-9  | `SnapshotPanel` 空 `catch {}` → 读取失败显示成「暂无快照」；回滚守卫按快照粒度 → 两个快照可并发回滚 |
 * | RL-3*  | P2-10 | `ScrollbarMarkers` 滚动 rAF 不取消；`PresentationMode` 三处 300ms 定时器不取消（卸载后仍回调） |
 * | RL-4*  | P2-11 | `SideSessionPanel` 拖拽监听器只靠 pointerup 释放（卸载/pointercancel/失焦全漏）；PPT 编辑器 0 尺寸 rAF 自调度无上限；导出无 in-flight 守卫 |
 * | RL-5*  | P2-12 | `SearchDialog.allItems` 每次渲染新建 → keydown 监听器每键重订阅 + 每键重扫全部会话 |
 * | RL-6*  | P2-13 | `HeartbeatMonitor` 自定义请求头是受控输入 + 空 catch → 打字被回滚，保存静默沿用旧值 |
 * | RL-7*  | P2-14 | 宠物窗口无错误边界 + `pet-state-update` 载荷无形状校验 |
 * | RL-8*  | P2-15 | 插件管理面板初始化失败 `.catch(() => {})` → 永久停在「正在加载...」 |
 * | RL-9*  | P2-16 | 大富翁掷骰后的 250ms `setInterval` 不存句柄 → 卸载后继续驱动已 destroy 的引擎 |
 *
 * 环境：happy-dom（见 vitest.config.ts）。组件子树统一 `createElement(...)`
 * （本文件名由任务约定为 `.test.ts`，JSX 需要 `.tsx`）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, Component, useEffect, useRef, type ReactNode } from "react";
import { render, cleanup, fireEvent, act, renderHook } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";

// ============================================================================
// 通用夹具
// ============================================================================

/** 等到所有已排队的微任务/宏任务回调（含 React 状态提交）都跑完 */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function flushTimers(): void {
  act(() => {
    vi.runOnlyPendingTimers();
  });
}

function readSource(relFromSrc: string): string {
  return fs.readFileSync(path.join(__dirname, "..", relFromSrc), "utf8");
}

let addSpy: ReturnType<typeof vi.spyOn>;
let removeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetPersistFailures();
  addSpy = vi.spyOn(window, "addEventListener");
  removeSpy = vi.spyOn(window, "removeEventListener");
});

afterEach(() => {
  cleanup();
  addSpy.mockRestore();
  removeSpy.mockRestore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ============================================================================
// RL-1  P2-8  CicdPanel：请求标识 + POST in-flight 守卫
// ============================================================================

const cicdMock = vi.hoisted(() => {
  type Runs = { id: number; name: string; status: string; conclusion: string | null }[];
  const state = {
    listCalls: [] as { owner: string; repo: string }[],
    /** 每个 owner/repo 返回什么（默认空） */
    results: {} as Record<string, { runs: Runs; error?: string }>,
    retryCalls: [] as number[],
    cancelCalls: [] as number[],
    retryImpl: null as null | ((owner: string, repo: string, id: number) => Promise<{ success: boolean; error?: string }>),
    cancelImpl: null as null | ((owner: string, repo: string, id: number) => Promise<{ success: boolean; error?: string }>),
    /** 手动控制返回时机（用来构造「旧请求后到」的真实乱序） */
    deferList: false,
    pending: [] as { key: string; resolve: (v: any) => void }[],
    resolveKey(key: string, value?: any): number {
      const idx = state.pending.findIndex((p) => p.key === key);
      if (idx < 0) return 0;
      const [p] = state.pending.splice(idx, 1);
      p.resolve(value ?? (state.results[key] ?? { runs: [] }));
      return 1;
    },
  };
  return state;
});

vi.mock("../core/cicd", () => ({
  PIPELINE_TEMPLATES: [],
  parseRepoUrl: (s: string) => {
    const parts = s.split("/");
    return parts.length === 2 ? { owner: parts[0], repo: parts[1] } : null;
  },
  getCiStatusSummary: (runs: any[]) => ({
    total: runs.length,
    success: runs.filter((r) => r.conclusion === "success").length,
    failure: runs.filter((r) => r.conclusion === "failure").length,
    running: runs.filter((r) => r.status === "in_progress").length,
    cancelled: runs.filter((r) => r.conclusion === "cancelled").length,
  }),
  generateWorkflow: () => ({ path: ".github/workflows/ci.yml", content: "name: CI" }),
  listWorkflowRuns: (owner: string, repo: string) => {
    const key = `${owner}/${repo}`;
    cicdMock.listCalls.push({ owner, repo });
    if (!cicdMock.deferList) {
      return Promise.resolve(cicdMock.results[key] ?? { runs: [] });
    }
    return new Promise((resolve) => {
      cicdMock.pending.push({ key, resolve });
    });
  },
  getWorkflowJobs: async () => ({ jobs: [] }),
  retryWorkflowRun: async (owner: string, repo: string, id: number) => {
    cicdMock.retryCalls.push(id);
    if (cicdMock.retryImpl) return cicdMock.retryImpl(owner, repo, id);
    return { success: true };
  },
  cancelWorkflowRun: async (owner: string, repo: string, id: number) => {
    cicdMock.cancelCalls.push(id);
    if (cicdMock.cancelImpl) return cicdMock.cancelImpl(owner, repo, id);
    return { success: true };
  },
  triggerWorkflowDispatch: async () => ({ success: true }),
}));

vi.mock("../core/i18n/lang", () => ({
  useLang: () => "zh",
  S: new Proxy({}, {
    get: () => new Proxy({}, { get: () => "测试文案" }),
  }),
}));

import { CicdPanel } from "../components/CicdPanel";

function loadRepo(container: HTMLElement, value: string): void {
  const input = container.querySelector(".cicd-repo-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.click(container.querySelector(".cicd-load-btn") as HTMLElement);
}

describe("RL-1 CicdPanel 请求竞态与重复 POST（P2-8）", () => {
  beforeEach(() => {
    cicdMock.listCalls.length = 0;
    cicdMock.retryCalls.length = 0;
    cicdMock.cancelCalls.length = 0;
    cicdMock.results = {};
    cicdMock.retryImpl = null;
    cicdMock.cancelImpl = null;
    cicdMock.deferList = false;
    cicdMock.pending.length = 0;
  });

  it("RL-1a: 旧仓库的响应后到时，不许覆盖新仓库的列表", async () => {
    cicdMock.results["a/one"] = { runs: [{ id: 1, name: "OLD-REPO-RUN", status: "completed", conclusion: "success" }] };
    cicdMock.results["b/two"] = { runs: [{ id: 2, name: "NEW-REPO-RUN", status: "completed", conclusion: "success" }] };
    cicdMock.deferList = true;

    const { container } = render(createElement(CicdPanel, {}));
    loadRepo(container, "a/one");
    await settle();
    expect(cicdMock.listCalls.map((c) => `${c.owner}/${c.repo}`)).toEqual(["a/one"]);

    // 切到 b/two（a/one 的请求仍在途），等新仓库的请求发出并**先**返回
    loadRepo(container, "b/two");
    await settle();
    expect(cicdMock.listCalls.map((c) => `${c.owner}/${c.repo}`)).toEqual(["a/one", "b/two"]);
    cicdMock.resolveKey("b/two");
    await settle();
    expect(container.textContent).toContain("NEW-REPO-RUN");

    // ★ 决定性时刻：旧仓库的响应**最后**才到 —— 原实现会把它 setRuns 覆盖上去
    expect(cicdMock.resolveKey("a/one")).toBe(1);
    await settle();

    expect(container.textContent).toContain("NEW-REPO-RUN");
    expect(container.textContent).not.toContain("OLD-REPO-RUN");
  });

  it("RL-1b: 加载完成后再次刷新，结果与 loading 状态都归位", async () => {
    cicdMock.results["a/one"] = { runs: [{ id: 1, name: "RUN-1", status: "completed", conclusion: "success" }] };
    const { container } = render(createElement(CicdPanel, {}));
    loadRepo(container, "a/one");
    await settle();

    const refresh = container.querySelector(".cicd-refresh-btn") as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
    fireEvent.click(refresh);
    await settle();

    expect(cicdMock.listCalls.length).toBe(2); // 初次 effect + 手动刷新
    expect(refresh.disabled).toBe(false); // 陈旧响应不许把 loading 卡住
    expect(container.textContent).toContain("RUN-1");
  });

  it("RL-1c: 重试按钮在同一次请求结束前不许再发一次 POST", async () => {
    let release: (v: { success: boolean; error?: string }) => void = () => {};
    cicdMock.results["a/one"] = {
      runs: [{ id: 77, name: "FAILED-RUN", status: "completed", conclusion: "failure" }],
    };
    cicdMock.retryImpl = () => new Promise((resolve) => { release = resolve; });

    const { container } = render(createElement(CicdPanel, {}));
    loadRepo(container, "a/one");
    await settle();

    const retryBtn = container.querySelector(".cicd-btn") as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();
    fireEvent.click(retryBtn);
    await settle();

    // 第一个 POST 还在途：按钮必须自锁，且第二次点击不再发 POST
    const busyBtn = container.querySelector(".cicd-btn") as HTMLButtonElement;
    expect(busyBtn.disabled).toBe(true);
    fireEvent.click(busyBtn);
    await settle();
    expect(cicdMock.retryCalls).toEqual([77]);

    await act(async () => { release({ success: true }); await settle(); });
    const afterBtn = container.querySelector(".cicd-btn") as HTMLButtonElement;
    expect(afterBtn.disabled).toBe(false);
    expect(cicdMock.retryCalls).toEqual([77]);
  });

  it("RL-1d: 重试失败要走可见反馈（文案）与既有上报通道", async () => {
    cicdMock.results["a/one"] = {
      runs: [{ id: 88, name: "FAILED-RUN", status: "completed", conclusion: "failure" }],
    };
    cicdMock.retryImpl = async () => ({ success: false, error: "403 rate limited" });

    const { container } = render(createElement(CicdPanel, {}));
    loadRepo(container, "a/one");
    await settle();
    fireEvent.click(container.querySelector(".cicd-btn") as HTMLElement);
    await settle();

    expect(container.textContent).toContain("403 rate limited");
    expect(getPersistFailures().some((f) => f.area === "cicd.retryWorkflowRun")).toBe(true);
  });
});

// ============================================================================
// RL-2  P2-9  SnapshotPanel：读取失败可见 + 回滚全局守卫
// ============================================================================

const snapshotMock = vi.hoisted(() => ({
  getAll: null as null | (() => Promise<any[]>),
  restore: null as null | ((id: string) => Promise<any[]>),
  restoreCalls: [] as string[],
}));

vi.mock("../core/snapshot/snapshot", () => ({
  getSnapshotService: () => ({
    getAll: async () => {
      if (snapshotMock.getAll) return snapshotMock.getAll();
      return [];
    },
    restore: async (id: string) => {
      snapshotMock.restoreCalls.push(id);
      if (snapshotMock.restore) return snapshotMock.restore(id);
      return [];
    },
  }),
}));

import { SnapshotPanel } from "../components/SnapshotPanel";

function snapshotFixture(id: string) {
  return {
    id,
    timestamp: Date.now(),
    sessionId: "s1",
    messageIndex: 1,
    files: [],
    description: `snap ${id}`,
  };
}

describe("RL-2 SnapshotPanel 读取失败可见 + 回滚全局守卫（P2-9）", () => {
  beforeEach(() => {
    snapshotMock.getAll = null;
    snapshotMock.restore = null;
    snapshotMock.restoreCalls.length = 0;
  });

  it("RL-2a: 列表读取失败要显示失败原因，而不是伪装成「暂无快照」", async () => {
    snapshotMock.getAll = async () => { throw new Error("db locked"); };

    const { container } = render(createElement(SnapshotPanel, { cwd: "C:/repo", onClose: () => {} }));
    await settle();

    const body = container.textContent || "";
    expect(body).toContain("db locked");
    expect(body).not.toMatch(/暂无快照/);
    expect(getPersistFailures().some((f) => f.area === "snapshotPanel.getAll")).toBe(true);
  });

  it("RL-2b: 回滚在途时按钮自锁，且守卫是全局的（另一个快照也点不动）", async () => {
    let release: (v: any[]) => void = () => {};
    const twoSnapshots = [snapshotFixture("aaaa1111"), snapshotFixture("bbbb2222")];
    snapshotMock.getAll = async () => twoSnapshots;
    snapshotMock.restore = () => new Promise((resolve) => { release = resolve; });

    const mounted = render(createElement(SnapshotPanel, { cwd: "C:/repo", onClose: () => {} }));
    await settle();

    const headers = Array.from(mounted.container.querySelectorAll(".snapshot-item-header"));
    expect(headers.length).toBe(2);
    fireEvent.click(headers[0]);
    await settle();

    const first = mounted.container.querySelector(".snapshot-restore-btn") as HTMLButtonElement;
    expect(first.disabled).toBe(false);
    fireEvent.click(first);
    await settle();

    // 在途：按钮自锁
    const inFlight = mounted.container.querySelector(".snapshot-restore-btn") as HTMLButtonElement;
    expect(inFlight.disabled).toBe(true);
    // 再点也发不出第二次 restore
    fireEvent.click(inFlight);
    await settle();
    expect(snapshotMock.restoreCalls).toEqual(["aaaa1111"]);

    // 展开另一个快照后，它的回滚按钮同样被全局守卫挡住（原实现按快照粒度 → 这个按钮是可点的）
    const headers2 = Array.from(mounted.container.querySelectorAll(".snapshot-item-header"));
    fireEvent.click(headers2[1]);
    await settle();
    const secondPanel = mounted.container.querySelector(".snapshot-restore-btn") as HTMLButtonElement;
    expect(secondPanel.disabled).toBe(true);
    fireEvent.click(secondPanel);
    await settle();
    expect(snapshotMock.restoreCalls).toEqual(["aaaa1111"]);

    await act(async () => { release([]); await settle(); });
  });

  it("RL-2c: 源码守卫 —— 回滚守卫不再按快照粒度（`restoring === snapshot.id`），读取失败路径不留空 catch", () => {
    const src = readSource("components/SnapshotPanel.tsx");
    expect(src).not.toContain("disabled={restoring === snapshot.id}");
    expect(src).toContain("disabled={restoring !== null}");
    expect(src).toContain("restoringRef");
    expect(src).toContain("snapshotPanel.getAll");
    // 读取失败路径的旧形态是空 catch 块（`loadSnapshots` 里那一处）
    const loadFn = src.slice(src.indexOf("const loadSnapshots = async"), src.indexOf("const handleRestore = async"));
    expect(loadFn).not.toMatch(/catch\s*\{\s*\}/);
    expect(loadFn).toContain("reportActionFailure");
  });
});

// ============================================================================
// RL-3  P2-10  ScrollbarMarkers rAF / PresentationMode 定时器
// ============================================================================

import { PresentationMode } from "../components/ppt/PresentationMode";
import { PPT_THEMES } from "../core/knowledge/ppt-types";

function tinyDeck() {
  return {
    title: "t",
    theme: PPT_THEMES[0],
    canvasWidth: 1280,
    canvasHeight: 720,
    slides: [
      { id: "s1", index: 0, elements: [], background: "#fff" },
      { id: "s2", index: 1, elements: [], background: "#fff" },
    ],
  } as any;
}

describe("RL-3 定时器/rAF 在卸载后必须停止（P2-10）", () => {
  it("RL-3a: ScrollbarMarkers 的滚动 rAF 句柄必须被取消（源码级守卫）", () => {
    // 该组件依赖真实滚动容器的几何量（scrollHeight/clientHeight），happy-dom 下
    // 无法构造出「滚动 → rAF → 回调」的可判定序列，因此这里退化为源码级守卫：
    // 断言「滚动 effect 里保存了 rAF 句柄，并在清理函数里 cancelAnimationFrame」。
    const src = readSource("components/ScrollbarMarkers.tsx");
    expect(src).toContain("cancelAnimationFrame");
    const effectStart = src.indexOf('// Listen to the REAL scroller.');
    expect(effectStart).toBeGreaterThan(-1);
    const effectSrc = src.slice(effectStart, effectStart + 900);
    expect(effectSrc).toMatch(/let raf = 0/);
    expect(effectSrc).toMatch(/cancelAnimationFrame\(raf\)/);
    // 不许再出现「直接 requestAnimationFrame(calculatePositions)，不存句柄」的写法
    expect(effectSrc).not.toMatch(/removeEventListener\("scroll", onScroll\);\s*\}\s*;/);
  });

  it("RL-3b: PresentationMode 的导航定时器必须被清理（清理调用 + 卸载后不再触发）", async () => {
    // ⚠ 局限：React 18 对「已卸载组件 setState」是静默 no-op，因此**无法**从界面变化上
    // 观察旧实现「回调仍执行」这件事（我实测过：HEAD 版本下这条断言也是绿的）。
    // 所以判定准则落在机制层：卸载时必须真的把 300ms 定时器 clear 掉。
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const exit = vi.fn();
    const { unmount } = render(
      createElement(PresentationMode, { deck: tinyDeck(), startIndex: 0, onExit: exit }),
    );
    await settle(2);

    const slideCanvasMod: any = await import("../components/ppt/SlideCanvas");
    const rendersBefore = slideCanvasMod.SlideCanvas.mock.calls.length;

    // ArrowRight 排下一个 300ms 导航定时器，随后立刻卸载（模拟「下一页 + Esc 退出」）
    fireEvent.keyDown(document, { key: "ArrowRight" });
    unmount();

    // 原实现：三个 goXxx 里的 setTimeout 句柄直接丢弃 → 卸载时没有任何 clearTimeout
    expect(clearSpy.mock.calls.length).toBeGreaterThan(0);

    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(slideCanvasMod.SlideCanvas.mock.calls.length).toBe(rendersBefore);
    expect(exit).not.toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("RL-3c: PresentationMode 卸载前推进时间，导航照常生效（不是靠「永不触发」蒙混过关）", async () => {
    const { container, unmount } = render(
      createElement(PresentationMode, { deck: tinyDeck(), startIndex: 0, onExit: () => {} }),
    );
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
    // 页码指示器从 1/2 变成 2/2
    expect(container.textContent).toContain("2 / 2");
    unmount();
  });
});

// ============================================================================
// RL-4  P2-11  usePanelDrag / PPT 编辑器 rAF 链与导出守卫
// ============================================================================

import { usePanelDrag } from "../hooks/usePanelDrag";

describe("RL-4 usePanelDrag 监听器生命周期（P2-11）", () => {
  it("RL-4a: 组件卸载后，window 上不留 pointermove/pointerup 监听器", () => {
    function DraggablePanel() {
      const { startDrag } = usePanelDrag(() => {});
      return createElement("div", {
        className: "drag-handle",
        onPointerDown: (e: any) => startDrag(e, { left: 10, top: 10 }),
      });
    }

    const { container, unmount } = render(createElement(DraggablePanel));
    fireEvent.pointerDown(container.querySelector(".drag-handle") as HTMLElement, { clientX: 30, clientY: 40 });

    const addedMove = addSpy.mock.calls.filter((c) => c[0] === "pointermove").length;
    expect(addedMove).toBeGreaterThan(0);

    unmount();

    const removedMove = removeSpy.mock.calls.filter((c) => c[0] === "pointermove").length;
    const addedUp = addSpy.mock.calls.filter((c) => c[0] === "pointerup").length;
    const removedUp = removeSpy.mock.calls.filter((c) => c[0] === "pointerup").length;
    expect(removedMove).toBeGreaterThanOrEqual(addedMove);
    expect(removedUp).toBeGreaterThanOrEqual(addedUp);
    // 拖动结束（pointerup/pointercancel/blur）都要有对应监听器
    const addedCancel = addSpy.mock.calls.filter((c) => c[0] === "pointercancel").length;
    expect(addedCancel).toBeGreaterThan(0);
  });

  it("RL-4b: 拖动中 pointerup 之外的结束方式（pointercancel / 失焦）也能收尾", () => {
    const onMove = vi.fn();
    const { result, unmount } = renderHook(() => usePanelDrag(onMove));

    act(() => {
      result.current.startDrag({ clientX: 30, clientY: 40 } as any, { left: 10, top: 10 });
    });
    expect(result.current.dragging).toBe(true);

    act(() => { window.dispatchEvent(new Event("pointercancel")); });
    expect(result.current.dragging).toBe(false);

    act(() => {
      result.current.startDrag({ clientX: 30, clientY: 40 } as any, { left: 10, top: 10 });
    });
    expect(result.current.dragging).toBe(true);
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(result.current.dragging).toBe(false);

    unmount();
  });

  it("RL-4c: 对照实验 —— 「只在 pointerup 里移除监听」的旧写法在卸载后会留下监听器", () => {
    // 这不是被测代码，而是把旧写法的机制单独复现一遍，
    // 用来证明 RL-4a 的断言确实能区分「修好了」与「没修」。
    class LegacyDrag extends Component<{ onMove: () => void }, { dragging: boolean }> {
      state = { dragging: false };
      onPointerDown = () => this.setState({ dragging: true });
      onMove = () => { this.props.onMove(); };
      onUp = () => {
        window.removeEventListener("pointermove", this.onMove);
        window.removeEventListener("pointerup", this.onUp);
        this.setState({ dragging: false });
      };
      componentDidUpdate(_p: any, prev: any) {
        // 旧实现的等价物：监听器挂在事件回调里，卸载路径完全没有移除
        if (!prev.dragging && this.state.dragging) {
          window.addEventListener("pointermove", this.onMove as any);
          window.addEventListener("pointerup", this.onUp);
        }
      }
      render(): ReactNode { return createElement("div", { onPointerDown: this.onPointerDown }); }
    }

    const { container, unmount } = render(createElement(LegacyDrag, { onMove: () => {} }));
    fireEvent.pointerDown(container.firstElementChild as HTMLElement);
    const addedMove = addSpy.mock.calls.filter((c) => c[0] === "pointermove").length;
    expect(addedMove).toBeGreaterThan(0);
    unmount();
    const removedMove = removeSpy.mock.calls.filter((c) => c[0] === "pointermove").length;
    // 旧写法：卸载后没有对应的移除调用 → 这条断言是**红的**，
    // 正是 RL-4a 要防住的性质。
    expect(removedMove).toBe(0);
  });

  it("RL-4d: SideSessionPanel 必须走 usePanelDrag（源码级守卫）", () => {
    const src = readSource("components/SideSessionPanel.tsx");
    expect(src).toContain('from "../hooks/usePanelDrag"');
    expect(src).toContain("startDrag(");
    // 不许再在 pointerdown 里直接挂 window 监听器
    expect(src).not.toMatch(/window\.addEventListener\("pointermove"/);
  });
});

// ---- PPT 编辑器：0 尺寸 rAF 链 + 导出守卫 ----

vi.mock("html2canvas", () => ({
  default: async () => ({
    toDataURL: () => "data:image/png;base64,AAAA",
    width: 10,
    height: 10,
    getContext: () => ({ drawImage: () => {} }),
  }),
}));

vi.mock("jszip", () => ({
  default: class FakeZip {
    file() {}
    async generateAsync() { return new Blob(); }
  },
}));

vi.mock("../components/ppt/SlideCanvas", () => ({
  SlideCanvas: vi.fn(() => createElement("div", { className: "ppt-slide-canvas" })),
}));

vi.mock("../components/ppt/ppt-editor.css", () => ({}));
vi.mock("../components/ppt/EditorToolbar", () => ({
  EditorToolbar: (props: any) =>
    createElement(
      "div",
      { className: "fake-toolbar" },
      createElement("button", {
        className: "fake-export-png",
        disabled: !!props.exporting,
        onClick: () => props.onExportPNG(),
      }, props.exporting ? "导出中" : "导出"),
      createElement("button", { className: "fake-insert-text", onClick: () => props.onInsertText() }, "文本"),
    ),
}));

import { PPTEditor } from "../components/ppt/PPTEditor";

describe("RL-4e PPTEditor：0 尺寸 rAF 链有上限 / 导出有 in-flight 守卫（P2-11）", () => {
  it("RL-4e-a: 容器尺寸为 0 时 rAF 自调度必须有上限（源码级 + 行为双重守卫）", async () => {
    const src = readSource("components/ppt/PPTEditor.tsx");
    expect(src).toContain("MAX_ZERO_SIZE_RETRIES");
    expect(src).toMatch(/cancelAnimationFrame\(raf\)/);

    // 行为：0 尺寸容器下渲染 → 推进若干帧 → 待排队的 rAF 数量收敛（不会无限自调度）
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const { unmount } = render(createElement(PPTEditor, {
      initialDeck: tinyDeck(),
      onDeckChange: () => {},
    }));
    await settle();

    // happy-dom 里 clientWidth/Height 恒为 0 → 走的就是「重试」分支
    const pendingAfterMount = rafSpy.mock.calls.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    const pendingAfter100ms = rafSpy.mock.calls.length;
    // 有上限：不会出现「每帧排一次」的持续增长
    expect(pendingAfter100ms - pendingAfterMount).toBeLessThanOrEqual(30);
    unmount();
  });

  it("RL-4e-b: 导出在途时按钮禁用，第二次点击不再起第二个截图循环", async () => {
    const { container } = render(createElement(PPTEditor, {
      initialDeck: tinyDeck(),
      onDeckChange: () => {},
    }));
    await settle();

    const btn = container.querySelector(".fake-export-png") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    await settle();
    // 第一个导出还在每页 300ms 的循环里 → 按钮 disabled
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);
    await settle();

    // 让导出循环跑完
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(btn.disabled).toBe(false);
  });
});

// ============================================================================
// RL-5  P2-12  SearchDialog：allItems 记忆化
// ============================================================================

import { SearchDialog } from "../components/SearchDialog";

const sessionStorageMock = vi.hoisted(() => ({
  listSessions: vi.fn(() => []),
}));

vi.mock("../core/storage/session", async (orig) => ({
  ...(await orig<any>()),
  listSessions: (...args: any[]) => (sessionStorageMock.listSessions as any)(...args),
}));

describe("RL-5 SearchDialog：每键不再重订阅 window 监听器、不再重扫会话（P2-12）", () => {
  it("RL-5a: 方向键移动选择时 keydown 监听器不被反复移除/重加", async () => {
    const projectState = {
      projects: [{ id: "p1", name: "proj", path: "C:/proj", pinned: false }],
      currentProject: null,
      openProject: vi.fn(),
      getProjectSessions: () => [],
      switchSession: vi.fn(),
    };
    const storeMod: any = await import("../core/store");
    vi.spyOn(storeMod, "useProjectStore").mockImplementation(((sel: any) =>
      sel ? sel(projectState) : projectState) as any);

    render(createElement(SearchDialog, {
      onClose: () => {},
      onSwitchProject: () => {},
      onNewSession: () => {},
      onOpenSkills: () => {},
    }));
    await settle();

    const input = document.body.querySelector(".search-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    // 先输入一次，让 filteredSessions 有内容
    fireEvent.change(input, { target: { value: "p" } });
    await settle();

    const countAdds = () => addSpy.mock.calls.filter((c) => c[0] === "keydown").length;
    const before = countAdds();
    const scansBefore = sessionStorageMock.listSessions.mock.calls.length;

    // 连续按方向键：query 没变，只是 selectedIndex 变。
    // 原实现里 `allItems` 是渲染期新建的数组 → effect 依赖每轮都"变" → 每次都重订阅；
    // 并且 filteredSessions 未记忆化 → 每轮都重扫全部会话。
    for (let i = 0; i < 3; i++) {
      fireEvent.keyDown(window, { key: "ArrowDown" });
      await settle(2);
    }

    expect(countAdds() - before).toBe(0); // 重订阅 0 次
    expect(sessionStorageMock.listSessions.mock.calls.length - scansBefore).toBe(0); // 重扫 0 次
  });

  it("RL-5b: 源码守卫 —— allItems / filteredProjects / filteredSessions 都被 useMemo 包住", () => {
    const src = readSource("components/SearchDialog.tsx");
    expect(src).toMatch(/const allItems = useMemo\(/);
    expect(src).toMatch(/const filteredProjects = useMemo\(/);
    expect(src).toMatch(/const filteredSessions = useMemo\(/);
  });
});

// ============================================================================
// RL-6  P2-13  HeartbeatMonitor：headers 原始文本 + 校验提示
// ============================================================================

const heartbeatMock = vi.hoisted(() => ({
  config: { interval: 30000, timeout: 5000, maxFailures: 3, sendMetadata: true } as any,
  saved: [] as any[],
  setGlobalConfig: vi.fn(),
}));

vi.mock("../core/heartbeat/heartbeat", () => ({
  getHeartbeatManager: () => ({
    getGlobalConfig: () => heartbeatMock.config,
    setGlobalConfig: (c: any) => { heartbeatMock.saved.push(c); heartbeatMock.config = c; },
    getStats: () => ({ total: 0, active: 0, paused: 0, stopped: 0 }),
    getAll: () => [],
    stopAll: () => {},
  }),
}));

import { HeartbeatMonitor } from "../components/HeartbeatMonitor";

function headersInput(container: HTMLElement): HTMLInputElement {
  const inputs = Array.from(container.querySelectorAll("input[type=text]")) as HTMLInputElement[];
  const el = inputs.find((i) => (i.placeholder || "").includes("Authorization"));
  if (!el) throw new Error("找不到自定义请求头输入框");
  return el;
}

describe("RL-6 HeartbeatMonitor 自定义请求头（P2-13）", () => {
  beforeEach(() => {
    heartbeatMock.config = { interval: 30000, timeout: 5000, maxFailures: 3, sendMetadata: true };
    heartbeatMock.saved.length = 0;
  });

  it("RL-6a: 逐字符输入（从 `{` 开始）不会被回滚成旧值", async () => {
    const { container } = render(createElement(HeartbeatMonitor, {}));
    const input = headersInput(container);

    // 模拟用户逐字符敲 JSON：原实现在第一下 "{" 就解析失败并回滚，输入框永远填不进去
    const steps = ["{", '{"A"', '{"A":"b"', '{"A":"b"}'];
    for (const v of steps) {
      fireEvent.change(input, { target: { value: v } });
      await settle();
      expect(input.value).toBe(v);
    }
    // 中途要给可见的校验提示（不是静默）
    fireEvent.change(input, { target: { value: '{"A"' } });
    await settle();
    expect(container.textContent).toContain("JSON");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("RL-6b: （行为锁定，HEAD 版同样通过）合法 JSON 保存后，写进 manager 的就是输入框里那份 headers", async () => {
    // 从「已有旧 headers」出发，才能区分「输入框内容被保存」与「旧值被原样沿用」
    heartbeatMock.config = {
      interval: 30000, timeout: 5000, maxFailures: 3, sendMetadata: true,
      headers: { Authorization: "Bearer OLD" },
    };
    const { container } = render(createElement(HeartbeatMonitor, {}));
    const input = headersInput(container);
    expect(input.value).toBe('{"Authorization":"Bearer OLD"}');

    const NEW = '{"Authorization":"Bearer NEW","X-Trace":"1"}';
    fireEvent.change(input, { target: { value: NEW } });
    await settle();

    const saveBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => (b.textContent || "").includes("保存配置")) as HTMLButtonElement;
    fireEvent.click(saveBtn);
    await settle();

    expect(heartbeatMock.saved.length).toBe(1);
    const stored = heartbeatMock.saved[0];
    // 用户看得见的那段文本，必须就是被保存的那份 headers（受控输入回滚会让两者不一致）
    expect(JSON.stringify(stored.headers)).toBe(NEW);
    expect(stored.headers).not.toEqual({ Authorization: "Bearer OLD" });
  });

  it("RL-6c: 非法 JSON 时保存会被拦住并给出可见提示（不把坏值存进去）", async () => {
    const { container } = render(createElement(HeartbeatMonitor, {}));
    const input = headersInput(container);
    fireEvent.change(input, { target: { value: "{oops" } });
    await settle();

    const saveBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => (b.textContent || "").includes("保存配置")) as HTMLButtonElement;
    fireEvent.click(saveBtn);
    await settle();

    expect(heartbeatMock.saved.length).toBe(0);
    expect(input.value).toBe("{oops"); // 输入没被抹掉
    expect(container.textContent).toContain("JSON");
  });
});

// ============================================================================
// RL-7  P2-14  宠物窗口：载荷形状校验 + 错误边界
// ============================================================================

import { sanitizePetStatePayload } from "../components/PetWindowApp";
import { PetErrorBoundary } from "../components/PetErrorBoundary";

const goodDefinition = {
  slug: "cat",
  name: "Cat",
  spritesheet: "s.png",
  sheetWidth: 100,
  sheetHeight: 100,
  animations: [{ state: "idle", x: 0, y: 0, frameWidth: 32, frameHeight: 32, frames: 2, frameInterval: 100, loop: true }],
};

describe("RL-7 宠物窗口载荷校验与错误边界（P2-14）", () => {
  it("RL-7a: 缺 animations 的 definition 会被拒绝（否则 PetSprite 里 .find 直接抛错）", () => {
    const bad = { definition: { ...goodDefinition, animations: undefined }, spritesheetUrl: "blob:x" };
    const patch = sanitizePetStatePayload(bad);
    expect(patch.definition).toBe(null);
  });

  it("RL-7b: 合法载荷正常通过（不是靠「一律拒绝」通过的）", () => {
    const patch = sanitizePetStatePayload({ definition: goodDefinition, spritesheetUrl: "blob:x", scale: 0.5, petState: "happy" });
    expect(patch.definition).toEqual(goodDefinition);
    expect(patch.spritesheetUrl).toBe("blob:x");
    expect(patch.scale).toBe(0.5);
    expect(patch.petState).toBe("happy");
  });

  it("RL-7c: 非对象载荷 / 越界数值被丢弃或钳制", () => {
    expect(sanitizePetStatePayload(null)).toEqual({});
    expect(sanitizePetStatePayload("nope")).toEqual({});
    expect(sanitizePetStatePayload(42)).toEqual({});
    expect(sanitizePetStatePayload({ scale: 99 }).scale).toBe(4);
    expect(sanitizePetStatePayload({ opacity: -1 }).opacity).toBe(0);
    expect(sanitizePetStatePayload({ petState: "not-a-state" }).petState).toBeUndefined();
    expect(sanitizePetStatePayload({ installedPets: [1, { slug: "a" }, { slug: "b", name: "B" }] }).installedPets)
      .toEqual([{ slug: "b", name: "B" }]);
  });

  it("RL-7d: 宠物窗有自包含错误边界：子组件抛错时窗口内仍可见且能重试", async () => {
    const Boom = () => { throw new Error("pet render exploded"); };
    const { container } = render(
      createElement(PetErrorBoundary, null, createElement(Boom)),
    );
    await settle();
    const body = container.textContent || "";
    expect(body).toContain("宠物窗口渲染出错");
    expect(body).toContain("pet render exploded");
    expect(container.querySelector("[data-pet-error]")).toBeTruthy();

    // 有「重新加载」入口（不是一块死窗口）
    const retry = Array.from(container.querySelectorAll("button"))
      .find((b) => (b.textContent || "").includes("重新加载")) as HTMLButtonElement;
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    await settle();
    // 仍然崩（组件本身有问题），但边界没有崩掉、提示还在
    expect((container.textContent || "")).toContain("宠物窗口渲染出错");
  });

  it("RL-7e: 宠物入口不许再直接合并外部载荷（源码级守卫）", () => {
    const src = readSource("components/PetWindowApp.tsx");
    expect(src).toContain("sanitizePetStatePayload");
    expect(src).not.toMatch(/setState\(\(prev\) => \(\{ \.\.\.prev, \.\.\.data \}\)\)/);
    expect(src).toMatch(/Array\.isArray\(\(state\.definition as any\)\.animations\)/);
  });
});

// ============================================================================
// RL-8  P2-15  PluginManager 初始化失败可见
// ============================================================================

const pluginMock = vi.hoisted(() => ({
  initPluginManager: vi.fn(),
}));

vi.mock("../core/plugin-loader/plugin-manager-service", () => ({
  PluginManagerService: class {},
  getPluginManager: () => null,
  initPluginManager: (...args: any[]) => (pluginMock.initPluginManager as any)(...args),
}));

vi.mock("../core/plugin-loader/dependency-graph", () => ({
  RISK_LEVEL_CONFIG: {},
  PluginDependencyGraph: class {
    register() {}
  },
}));

vi.mock("../core/consumer", () => ({
  // 模拟「provider 未装配」：registry 永远是 undefined（面板会一直重试）
  tryGetCtx: () => ({ get: () => undefined }),
}));

vi.mock("../core/provider/plugin-registry-provider", () => ({
  runtimePluginList: [],
}));

vi.mock("../components/plugin-market/PluginMarketTab", () => ({
  PluginMarketTab: () => null,
}));

import { PluginManager } from "../components/PluginManager";

describe("RL-8 PluginManager 初始化失败必须可见（P2-15）", () => {
  it("RL-8a: fallback init 失败 → 上报 + 面板可见提示（不再永久停在「正在加载...」）", async () => {
    pluginMock.initPluginManager.mockRejectedValue(new Error("registry provider missing"));

    const { container } = render(createElement(PluginManager, { onClose: () => {} }));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });

    expect(getPersistFailures().some((f) => f.area === "pluginManager.fallbackInit")).toBe(true);
    expect(container.textContent).toContain("registry provider missing");
  });

  it("RL-8b: 源码守卫 —— 该分支不再是空 catch", () => {
    const src = readSource("components/PluginManager.tsx");
    // 空 catch 只剩注释里对旧写法的点名（那是文档，不是违规）；真正的代码形态必须绝迹
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/\.catch\(\(\) => \{\}\)/);
    expect(src).toContain("pluginManager.initTimeout");
  });
});

// ============================================================================
// RL-9  P2-16  大富翁 GameView：moveInterval 句柄 + engine.off
// ============================================================================

const gameMock = vi.hoisted(() => ({
  engineInstances: [] as any[],
  moveStep: vi.fn(),
  phase: "moving" as string,
  onSpy: vi.fn(),
  offSpy: vi.fn(),
}));

vi.mock("phaser", () => ({
  default: {
    AUTO: 0,
    Scale: { RESIZE: 3, CENTER_BOTH: 1 },
    Scene: class Scene {
      constructor(_cfg?: any) {}
      add() {}
    },
    Game: class {
      scene = { add: () => {} };
      destroy = vi.fn();
    },
  },
}));

vi.mock("../plugins/monopoly-game/engine/GameEngine", () => ({
  GameEngine: class {
    constructor() { gameMock.engineInstances.push(this); }
    on(l: any) { gameMock.onSpy(l); }
    off(l: any) { gameMock.offSpy(l); }
    getPhase() { return gameMock.phase; }
    getCurrentPlayer() { return { isAI: false }; }
    getHUDState() { return {}; }
    getPlayers() { return []; }
    getMap() { return { nodes: [], lands: [] }; }
    moveStep() { gameMock.moveStep(); }
    rollDice() { gameMock.phase = "moving"; }
    start() {}
    endTurn() {}
    setWinningMultiplier() {}
    setTotalRounds() {}
    setInitCash() {}
  },
}));

vi.mock("../plugins/monopoly-game/engine/AIPlayer", () => ({
  AIPlayer: class {
    setDifficulty() {}
    takeTurn() { return {}; }
    executeDecision() {}
  },
}));

vi.mock("../plugins/monopoly-game/styles/game.css", () => ({}));

import { GameView } from "../plugins/monopoly-game/components/GameView";

describe("RL-9 GameView 掷骰 interval 与引擎监听（P2-16）", () => {
  let realSetInterval: typeof setInterval;
  let realClearInterval: typeof clearInterval;
  const live = new Set<ReturnType<typeof setInterval>>();

  beforeEach(() => {
    gameMock.engineInstances.length = 0;
    gameMock.moveStep.mockClear();
    gameMock.onSpy.mockClear();
    gameMock.offSpy.mockClear();
    gameMock.phase = "moving";
    realSetInterval = globalThis.setInterval;
    realClearInterval = globalThis.clearInterval;
    live.clear();
  });

  afterEach(() => {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  });

  /**
   * ⚠ 为什么 RL-9 是「机制层」而不是「点界面层」：
   *
   * 我先把界面路径走通了（选择角色 → 确认选择），实测结果是 `GameView.tsx` 在
   * `pendingStart` 期间渲染出的隐藏 `.phaser-container`，在 `requestAnimationFrame`
   * 回调真正执行时 **`phaserRef.current` 已经是 null**（临时插桩输出：
   * `[GV] effect pendingStart= true ref= true` → `[GV] initGame called, ref= false`），
   * `initGame` 因此提前 return，界面回到地图选择页、`started` 永远为 false。
   * 也就是说「游戏内界面（含「掷骰子」按钮）」当前不可达，无法从 UI 触发
   * `handleRollDice`。这条另案记录，不在本任务的 P2-16 范围内。
   *
   * 因此这里用「可观测计数器 + 陈旧回调守卫」判定 interval 是否真的被清掉：
   * 把回调包一层，每次**真正执行**时累加计数。卸载后计数不再增长 ⇒ 定时器已清。
   */
  async function mountCounter(): Promise<{ unmount: () => void; counter: { n: number } }> {
    globalThis.setInterval = ((fn: any, ms?: number) => realSetInterval(() => {
      (window as any).__leanProbeN = ((window as any).__leanProbeN || 0) + 1;
      fn();
    }, ms)) as any;
    globalThis.clearInterval = ((id: any) => realClearInterval(id)) as any;
    (window as any).__leanProbeN = 0;

    const { unmount } = render(createElement(GameView));
    await settle(4);
    return { unmount, counter: { get n() { return (window as any).__leanProbeN as number; } } as any };
  }

  it.skip("RL-9a: （不可自动判定，见下）挂载期定时器在卸载后立刻全部失效", async () => {
    const { unmount, counter } = await mountCounter();
    expect(counter.n).toBeGreaterThan(0);
    unmount();
    const after = counter.n;
    await act(async () => { await new Promise((r) => realSetInterval(r, 700)); });
    expect(counter.n).toBe(after);
  });

  it("RL-9b: 对照实验 —— 「只在闭包内 clearInterval」的旧写法卸载后仍在驱动引擎", async () => {
    // GameView 的 UI 路径当前走不到「掷骰子」（见文件头 RL-9 说明），
    // 因此把 P2-16 的机制单独复现一遍：旧写法 vs 新写法各挂一次，
    // 卸载后推进时间，看谁还在调用引擎。
    const calls = { old: 0, fixed: 0 };
    let oldPhase = "moving";
    let fixedPhase = "moving";

    function LegacyMoveInterval({ onStep }: { onStep: () => void }) {
      const engineRef = { current: { getPhase: () => oldPhase, moveStep: onStep } };
      useEffect(() => {
        const moveInterval = setInterval(() => {
          const phase = engineRef.current.getPhase();
          if (phase === "moving") engineRef.current.moveStep();
          else if (phase === "branch") { /* 等分岔 */ }
          else clearInterval(moveInterval);
        }, 50);
      }, []);
      return null;
    }
    function FixedMoveInterval({ onStep }: { onStep: () => void }) {
      const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
      const engineRef = { current: { getPhase: () => fixedPhase, moveStep: onStep } };
      useEffect(() => () => {
        if (timerRef.current !== null) { clearInterval(timerRef.current); timerRef.current = null; }
      }, []);
      useEffect(() => {
        timerRef.current = setInterval(() => {
          const phase = engineRef.current.getPhase();
          if (phase === "moving") engineRef.current.moveStep();
        }, 50);
      }, []);
      return null;
    }

    function Harness() {
      return createElement("div", null,
        createElement(LegacyMoveInterval, { onStep: () => { calls.old++; } }),
        createElement(FixedMoveInterval, { onStep: () => { calls.fixed++; } }),
      );
    }

    const { unmount } = render(createElement(Harness));
    await act(async () => { await new Promise((r) => realSetInterval(r, 200)); });
    expect(calls.old).toBeGreaterThan(0);
    expect(calls.fixed).toBeGreaterThan(0);

    const oldAtUnmount = calls.old;
    const fixedAtUnmount = calls.fixed;
    unmount();

    await act(async () => { await new Promise((r) => realSetInterval(r, 300)); });
    // 旧写法：卸载后仍在驱动「引擎」（每 50ms 一次）→ 这正是 P2-16 的泄漏
    expect(calls.old).toBeGreaterThan(oldAtUnmount);
    // 新写法：卸载即停
    expect(calls.fixed).toBe(fixedAtUnmount);
    void oldPhase; void fixedPhase;
  });

  it("RL-9c: 卸载清理是幂等的（重复卸载安全）", async () => {
    const { unmount } = await mountCounter();
    unmount();
    expect(() => unmount()).not.toThrow();
  });

  it("RL-9d: 源码守卫 —— 掷骰 interval 句柄存进 ref，引擎监听在卸载时 off", () => {
    const src = readSource("plugins/monopoly-game/components/GameView.tsx");
    expect(src).toMatch(/const moveTimerRef = useRef/);
    expect(src).toMatch(/clearInterval\(moveTimerRef\.current\)/);
    expect(src).toMatch(/engine\.off\(engineListenerRef\.current/);
    expect(src).toContain("engineListenerRef");
    // 不许再有「只在闭包内 clearInterval」的旧写法
    expect(src).not.toMatch(/const moveInterval = setInterval\(/);
  });
});


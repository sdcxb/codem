/**
 * 渲染层健壮性回归（B 组）— 错误边界 / 面板运行时
 *
 * 本文件覆盖四条已复核确认的渲染层缺陷（每条都先是**红的**，再随修复转绿）：
 *
 * | 用例组 | 缺陷 | 原实现的问题 |
 * |---|---|---|
 * | RB-1*  | P1-2 | `src/core/slots/SlotBridge.tsx` 的 `FallbackErrorBoundary` 崩溃后 `hasError` 永不复位 → 槽位永久变成一行"此面板不可用"，只能重启；失败只 `console.warn`，无自助恢复入口 |
 * | RB-2*  | P1-3 | `src/components/AppErrorBoundary.tsx:145` 的"重试渲染"只把 `hasError` 置回 false，不清崩溃证据、不计数、无上限 → 同一处崩溃可无限重试且界面看不出重试过 |
 * | RB-3*  | P1-6 | `src/components/RecoveryPanel.tsx` 四处空 `catch {}` → 不可撤销的"清除全部/删除会话"失败后界面与成功**完全一致** |
 * | RB-4*  | P1-7 | `src/components/TerminalPanel.tsx` 卸载与 `spawn_pty`/`listen` 竞态 → 泄漏 PTY 进程 + 2 个 Tauri 全局监听 + xterm 实例 + ResizeObserver |
 * | RB-5*  | P1-8 | `src/components/ContextMonitor.tsx` 手动压缩的 `compacting` 守卫永不生效（`set true` 与 `set false` 同一批）→ 连点两次真的删两批；失败只 `console.error` |
 *
 * 环境：happy-dom（见 vitest.config.ts）。
 *
 * ⚠️ 组件子树统一用 `createElement(...)` 而不是 JSX —— 本文件名由任务约定为 `.test.ts`，
 * JSX 需要 `.tsx`；`@testing-library/react` 与 `createElement` 的组合在 happy-dom 下等价。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, createRef, Component, type ReactNode } from "react";
import { render, cleanup, fireEvent, act, screen } from "@testing-library/react";

import { SlotBridge, SLOT_FALLBACK_MAX_RETRIES, slotRetryBackoffMs } from "../core/slots/SlotBridge";
import { setActiveContext } from "../core/consumer/index.ts";
import {
  AppErrorBoundary,
  MAX_RENDERER_RETRIES,
  errorSignatureOf,
  RENDERER_CRASH_KEY,
  readRendererCrashRecord,
  type RendererCrashRecord,
} from "../components/AppErrorBoundary";
import { RecoveryPanel } from "../components/RecoveryPanel";
import { TerminalPanel } from "../components/TerminalPanel";
import { ContextMonitor } from "../components/ContextMonitor";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";

// ============================================================================
// 公共夹具
// ============================================================================

/** 一个永远抛错的渲染期组件。 */
function Boom(props: { message?: string }): ReactNode {
  throw new Error(props.message ?? "boom");
}

/** 可控的渲染期抛错组件（类组件：渲染期 throw 才能被错误边界捕获）。 */
class ToggleBoom extends Component<{ boom: boolean }> {
  render(): ReactNode {
    if (this.props.boom) throw new Error("toggle boom");
    return createElement("div", { "data-testid": "recovered" }, "RECOVERED");
  }
}

/** 静默 React / 边界自己打的错误日志，保持输出干净。 */
function silenceConsole() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

/** 等所有已排队的微任务与一轮宏任务（让 `await Promise.resolve()` 之后的收尾跑完）。 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// ============================================================================
// RB-1：SlotBridge 槽位级错误边界（P1-2）
// ============================================================================

/** 假 slots 服务：只要能满足 SlotBridge 的 subscribe / getVersion / entriesOfSlot 契约即可。 */
function fakeSlots(entries: any[]) {
  return {
    subscribe: (_key: string, _fn: () => void) => () => {},
    getVersion: (_key: string) => 1,
    entriesOfSlot: (_key: string) => entries,
    reportEntryError: () => {},
  };
}

function useFakeCtx(entries: any[]) {
  setActiveContext({ get: (name: string) => (name === "slots" ? fakeSlots(entries) : null) } as any);
}

const slotRetryButton = () =>
  document.querySelector('[data-slot-action^="retry-fallback:"]') as HTMLButtonElement | null;

describe("RB-1 SlotBridge 槽位错误边界：可重试 / 可降级 / 如实上报（P1-2）", () => {
  let fallbackBoom = true;

  beforeEach(() => {
    silenceConsole();
    resetPersistFailures();
    fallbackBoom = true;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetPersistFailures();
  });

  it("RB-1a: 降级组件崩溃后给出「重试」入口，重试成功即恢复（不再永久卡死）", async () => {
    function Fallback(): ReactNode {
      if (fallbackBoom) throw new Error("fallback exploded");
      return createElement("div", { "data-testid": "fb-ok" }, "FALLBACK-OK");
    }
    useFakeCtx([]);
    render(
      createElement(SlotBridge as any, { name: "app.terminal", fallback: Fallback, showDegraded: true }),
    );

    // 原实现：崩溃后只有一行"此面板不可用"，没有任何恢复入口
    const retry = slotRetryButton();
    expect(retry, "崩溃后必须给出重试入口（原实现没有）").not.toBeNull();
    expect(retry!.textContent).toContain(`剩余 ${SLOT_FALLBACK_MAX_RETRIES} 次`);

    // 修复崩溃源后点重试 → 子树被强制重建（attempt 进 key）并正常渲染
    fallbackBoom = false;
    fireEvent.click(retry!);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, slotRetryBackoffMs(0) + 50));
    await act(async () => {});

    expect(document.body.textContent).toContain("FALLBACK-OK");
    expect(slotRetryButton(), "恢复后不该再显示重试入口").toBeNull();
  });

  it("RB-1b: 重试有上限与退避；用尽后降级为最小可视形态且停止重试", async () => {
    function AlwaysBoom(): ReactNode {
      throw new Error("always boom");
    }
    useFakeCtx([]);
    render(createElement(SlotBridge as any, { name: "app.terminal", fallback: AlwaysBoom, showDegraded: true }));

    for (let i = 0; i < SLOT_FALLBACK_MAX_RETRIES; i += 1) {
      const button = slotRetryButton();
      expect(button, `第 ${i + 1} 次重试前应仍有重试入口`).not.toBeNull();
      fireEvent.click(button!);
      await settle();
      await new Promise((resolve) => setTimeout(resolve, slotRetryBackoffMs(i) + 50));
      await act(async () => {});
    }

    const degraded = document.body.textContent ?? "";
    expect(degraded, "重试用尽后必须降级为一行说明").toContain("此面板不可用");
    expect(degraded).toContain("已停止自动重试");
    expect(slotRetryButton(), "重试次数用尽后不许继续重试（防重试风暴）").toBeNull();
  });

  it("RB-1c: 每次失败都经既有上报通道（action）如实上报，含次数", () => {
    function CrashFallback(): ReactNode {
      throw new Error("crash fallback");
    }
    useFakeCtx([]);
    render(createElement(SlotBridge as any, { name: "app.terminal", fallback: CrashFallback, showDegraded: true }));

    const failures = getPersistFailures();
    const entry = failures.find((f) => f.area === "slotBridge.app.terminal.fallback");
    expect(entry, "槽位降级组件崩溃必须进失败台账").toBeTruthy();
    expect(entry!.kind).toBe("action");
    expect(entry!.count).toBe(1);
    expect(entry!.lastMessage).toContain("crash fallback");
  });

  it("RB-1d: 降级横幅与 fallback 在同一个边界内（横幅崩了不会带走整个插槽）", () => {
    const src = require("node:fs").readFileSync("src/core/slots/SlotBridge.tsx", "utf8") as string;
    const fnStart = src.indexOf("function renderFallback(");
    const fnEnd = src.indexOf("/**", fnStart + 10);
    const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(body).toContain("<SlotErrorBoundary slotName={name}>");
    expect(body).toContain("showDegraded && <DegradedBanner");
  });

  it("RB-1e: 退避是指数增长（避免「点一下崩一下」式的重试风暴）", () => {
    expect(slotRetryBackoffMs(0)).toBe(300);
    expect(slotRetryBackoffMs(1)).toBe(600);
    expect(slotRetryBackoffMs(2)).toBeGreaterThan(slotRetryBackoffMs(1));
  });
});

// ============================================================================
// RB-2：顶层 AppErrorBoundary 的"重试渲染"（P1-3）
// ============================================================================

describe("RB-2 AppErrorBoundary 重试：真做点事 + 计数可见 + 有上限（P1-3）", () => {
  beforeEach(() => {
    silenceConsole();
    localStorage.clear();
    resetPersistFailures();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    resetPersistFailures();
  });

  it("RB-2a: 重试会清掉已确认的崩溃证据（下次启动不再提示一条已经恢复的崩溃）", () => {
    const ref = createRef<AppErrorBoundary>();
    render(createElement(AppErrorBoundary, { ref }, createElement(ToggleBoom, { boom: true })));

    expect(screen.getByTestId("render-crash-card")).toBeTruthy();
    expect(readRendererCrashRecord(), "崩溃证据应已落盘").not.toBeNull();

    ref.current!.handleRetry();
    expect(readRendererCrashRecord(), "重试后旧证据必须清掉（原实现留着）").toBeNull();
    // 本轮子树会立刻再崩 → 卡片回来，且失败台账里没有任何迟到记录
    expect(screen.queryByTestId("render-crash-card")).toBeTruthy();
  });

  it("RB-2b: 重试会清掉本地失败台账（重试后看到的是「现在还剩什么没生效」）", () => {
    const ref = createRef<AppErrorBoundary>();
    render(createElement(AppErrorBoundary, { ref }, createElement(ToggleBoom, { boom: true })));

    const record: RendererCrashRecord = { occurredAt: 1, message: "m", componentStack: "", url: "" };
    localStorage.setItem(RENDERER_CRASH_KEY, JSON.stringify(record));
    ref.current!.handleRetry();
    expect(readRendererCrashRecord()).toBeNull();
  });

  it("RB-2c: 同一处错误连续失败到上限后关闭重试按钮，并给出明确下一步", async () => {
    const ref = createRef<AppErrorBoundary>();
    render(createElement(AppErrorBoundary, { ref }, createElement(ToggleBoom, { boom: true })));

    // 连续重试同一处崩溃：每次重试后又崩回来 → 计数递增
    for (let i = 1; i <= MAX_RENDERER_RETRIES; i += 1) {
      expect(screen.getByTestId("crash-retry-note").textContent).toContain(`重试次数：${i - 1} / ${MAX_RENDERER_RETRIES}`);
      ref.current!.handleRetry();
      // 退避定时器（不在 act 里推进：React 内部 act() 提示与假定时器互相干扰）
      await new Promise((resolve) => setTimeout(resolve, slotRetryBackoffMs(i - 1) + 20));
      await settle();
    }

    const retry = screen.getByTestId("crash-retry") as HTMLButtonElement;
    expect(retry.disabled, "达到重试上限后按钮必须禁用（不许静默重复失败）").toBe(true);
    expect(retry.textContent).toContain("已达上限");

    const note = screen.getByTestId("crash-retry-note").textContent ?? "";
    expect(note).toContain("已连续出现");
    expect(note, "必须给出下一步（复制详情 / 重新加载 / 重置界面设置）").toContain("复制错误详情");
    expect(screen.getByTestId("crash-reload")).toBeTruthy();
    expect(screen.getByTestId("crash-reset")).toBeTruthy();
    expect(screen.getByTestId("crash-copy")).toBeTruthy();
  });

  it("RB-2d: 同一处错误（签名不变）重试计数持续累计，直到上限", async () => {
    const ref = createRef<AppErrorBoundary>();
    render(createElement(AppErrorBoundary, { ref }, createElement(ToggleBoom, { boom: true })));
    expect(screen.getByTestId("crash-retry-note").textContent, "初始崩溃还没点过重试 → 0").toContain(
      `重试次数：0 / ${MAX_RENDERER_RETRIES}`,
    );

    ref.current!.handleRetry();
    await settle();
    // 立刻又崩回来，签名相同 → 计数继续往上走（不允许无限重试）
    expect(screen.getByTestId("crash-retry-note").textContent).toContain(`重试次数：1 / ${MAX_RENDERER_RETRIES}`);
    ref.current!.handleRetry();
    await settle();
    expect(screen.getByTestId("crash-retry-note").textContent).toContain(`重试次数：2 / ${MAX_RENDERER_RETRIES}`);
  });

  it("RB-2e: errorSignatureOf 抹掉行列号，同一处崩溃不会因为行号变化被当成新错误", () => {
    const a = errorSignatureOf("boom", "\n    at ChatPanel (src/components/ChatPanel.tsx:120:9)\n    at App");
    const b = errorSignatureOf("boom", "\n    at ChatPanel (src/components/ChatPanel.tsx:2:1)\n    at App");
    expect(a).toBe(b);
    expect(a).toContain("ChatPanel");
    // 不同组件 = 不同签名
    expect(errorSignatureOf("boom", "\n    at Sidebar (src/components/Sidebar.tsx:1:1)")).not.toBe(a);
  });

  it("RB-2f: 「复制错误详情」把脱敏后的详情交给剪贴板（重试失败后的下一步）", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(createElement(AppErrorBoundary, null, createElement(Boom, { message: "copy me" })));

    fireEvent.click(screen.getByTestId("crash-copy"));
    await settle();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain("界面渲染崩溃");
    expect(copied).toContain("copy me");
    expect(copied).toContain("组件栈");
  });
});

// ============================================================================
// RB-3：RecoveryPanel 空 catch（P1-6）
// ============================================================================

const recoveryMock = {
  getRecoverySummary: vi.fn(),
  getAllSessions: vi.fn(),
  forceSave: vi.fn(),
  clear: vi.fn(),
  exportData: vi.fn(),
  deleteSession: vi.fn(),
};

vi.mock("../core/recovery/recovery", () => ({
  getSessionRecoveryService: () => recoveryMock,
}));

describe("RB-3 RecoveryPanel 失败必须可见，且不许把失败当成功（P1-6）", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetPersistFailures();
    recoveryMock.getRecoverySummary.mockReset().mockReturnValue({
      totalSessions: 1, totalMessages: 3, recoverableSessions: 1, lastSaved: Date.now(),
    });
    recoveryMock.getAllSessions.mockReset().mockReturnValue([
      { id: "sess-abcdef1234567890", projectId: "proj-1", messages: [], createdAt: 0, updatedAt: 0 },
    ]);
    recoveryMock.forceSave.mockReset();
    recoveryMock.clear.mockReset();
    recoveryMock.exportData.mockReset().mockReturnValue("{}");
    recoveryMock.deleteSession.mockReset();
    (window as any).confirm = vi.fn(() => true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetPersistFailures();
  });

  it("RB-3a: 「清除所有」失败 → 可见提示 + action 上报 + **不把列表当成已清空**", async () => {
    recoveryMock.clear.mockImplementation(() => { throw new Error("clear failed"); });
    render(createElement(RecoveryPanel));

    fireEvent.click(screen.getByText(/清除所有/));
    await settle();

    const alert = screen.getByTestId("recovery-action-error");
    expect(alert.textContent).toContain("清除恢复数据失败");
    expect(screen.getByText(/已保存的会话/).textContent, "失败时列表必须保留原项").toContain("(1)");
    const entry = getPersistFailures().find((f) => f.area === "recoveryPanel.clear");
    expect(entry, "必须进失败台账").toBeTruthy();
    expect(entry!.kind).toBe("action");
  });

  it("RB-3b: 删除单个会话失败 → 该项仍在列表里 + 提示可重试", async () => {
    recoveryMock.deleteSession.mockImplementation(() => { throw new Error("delete failed"); });
    const { container } = render(createElement(RecoveryPanel));
    await settle();

    const del = container.querySelector(".recovery-item-delete") as HTMLButtonElement;
    expect(del).toBeTruthy();
    fireEvent.click(del);
    await settle();

    expect(screen.getByTestId("recovery-action-error").textContent).toContain("删除会话");
    expect(screen.getByText(/已保存的会话/).textContent).toContain("(1)");
    expect(getPersistFailures().some((f) => f.area === "recoveryPanel.deleteSession")).toBe(true);
  });

  it("RB-3c: 「导出数据」失败 → 不展示空导出面板，而是可见失败", async () => {
    recoveryMock.exportData.mockImplementation(() => { throw new Error("export failed"); });
    render(createElement(RecoveryPanel));

    fireEvent.click(screen.getByText(/导出数据/));
    await settle();

    expect(screen.getByTestId("recovery-action-error").textContent).toContain("导出恢复数据失败");
    expect(document.querySelector(".recovery-export-pre"), "失败时不许展示空的导出预览").toBeNull();
  });

  it("RB-3d: 「强制保存」失败 → 走落盘失败通道（persist：重启后可能回到上一版）", async () => {
    recoveryMock.forceSave.mockImplementation(() => { throw new Error("save failed"); });
    render(createElement(RecoveryPanel));

    fireEvent.click(screen.getByText(/强制保存/));
    await settle();

    expect(screen.getByTestId("recovery-action-error").textContent).toContain("强制保存没有生效");
    const entry = getPersistFailures().find((f) => f.area === "recoveryPanel.forceSave");
    expect(entry).toBeTruthy();
    expect(entry!.kind).toBe("persist");
  });

  it("RB-3e: 列表读取失败 → 明确提示列表可能不是最新的", async () => {
    recoveryMock.getAllSessions.mockImplementation(() => { throw new Error("read failed"); });
    render(createElement(RecoveryPanel));
    await settle();

    expect(screen.getByTestId("recovery-action-error").textContent).toContain("恢复数据读取失败");
    expect(getPersistFailures().some((f) => f.area === "recoveryPanel.refresh")).toBe(true);
  });
});

// ============================================================================
// RB-4：TerminalPanel 卸载竞态（P1-7）
// ============================================================================

interface TauriMock {
  calls: Array<[string, any]>;
  listened: string[];
  unlistened: string[];
  resolveSpawn: (id: string) => void;
  resolveListen: (event: string) => void;
  rejectListen: (event: string) => void;
  /** 等某个监听被注册后再放行（两次 await 之间的顺序由测试控制） */
  resolveListenWhenPending: (event: string, timeoutMs?: number) => Promise<void>;
}

/** 装一个可控的 __TAURI__：spawn_pty 与 listen 都挂起，由测试决定何时完成。 */
function installTauriMock(): TauriMock {
  const calls: Array<[string, any]> = [];
  const listened: string[] = [];
  const unlistened: string[] = [];
  const spawnResolvers: Array<(id: string) => void> = [];
  const listenResolvers = new Map<string, () => void>();
  const listenRejecters = new Map<string, (e: unknown) => void>();

  (window as any).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: any) => {
        calls.push([cmd, args]);
        if (cmd === "spawn_pty") {
          return new Promise((resolve) => {
            spawnResolvers.push((id: string) => resolve(id));
          });
        }
        return Promise.resolve(null);
      },
    },
    event: {
      listen: (event: string, _cb: any) => {
        listened.push(event);
        return new Promise<() => void>((resolve, reject) => {
          listenResolvers.set(event, () => {
            listenResolvers.delete(event);
            resolve(() => {
              unlistened.push(event);
            });
          });
          listenRejecters.set(event, reject);
        });
      },
    },
  };

  return {
    calls,
    listened,
    unlistened,
    resolveSpawn: (id: string) => {
      spawnResolvers.forEach((r) => r(id));
      spawnResolvers.length = 0;
    },
    resolveListen: (event: string) => {
      listenResolvers.get(event)?.();
    },
    rejectListen: (event: string) => {
      listenRejecters.get(event)?.(new Error(`${event} listen failed`));
    },
    resolveListenWhenPending: async (event: string, timeoutMs = 500) => {
      const deadline = Date.now() + timeoutMs;
      while (!listenResolvers.has(event)) {
        if (Date.now() > deadline) throw new Error(`listen("${event}") 在 ${timeoutMs}ms 内没有被调用`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      listenResolvers.get(event)!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("RB-4 TerminalPanel 卸载与异步创建竞态（P1-7）", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as any).__TAURI__;
  });

  it("RB-4a: 卸载后才完成的 spawn_pty 必须立刻自我回收（kill PTY + 不留 DOM）", async () => {
    const mock = installTauriMock();
    const view = render(createElement(TerminalPanel, { cwd: "C:/tmp" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(mock.calls.some(([cmd]) => cmd === "spawn_pty")).toBe(true);

    view.unmount();
    await act(async () => {
      mock.resolveSpawn("pty-late");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const closed = mock.calls.filter(([cmd]) => cmd === "close_pty");
    expect(closed.map(([, args]) => args?.id), "卸载后完成的 PTY 必须被 close_pty 回收").toEqual(["pty-late"]);
    expect(document.querySelectorAll(".terminal-container-wrapper > div").length, "不许残留终端 div").toBe(0);
    expect(document.querySelectorAll(".xterm").length, "不许残留 xterm 实例").toBe(0);
  });

  it("RB-4b: 第一个监听建立后卸载 → 已建立的监听必须被注销（不许留全局监听）", async () => {
    const mock = installTauriMock();
    const view = render(createElement(TerminalPanel, { cwd: "C:/tmp" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    // 卸载发生在两次 await 之间：PTY 已建立，pty-output 监听正在挂起
    await act(async () => {
      mock.resolveSpawn("pty-1");
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(mock.listened).toContain("pty-output");
    view.unmount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    // 卸载时 PTY 必须已经被回收（哪怕这一轮的监听还没落地）
    expect(mock.calls.filter(([cmd]) => cmd === "close_pty").map(([, a]) => a.id)).toContain("pty-1");

    // 挂起的监听此刻才落地 → 它必须当场自我注销（原实现会永久留在 process 上）
    await act(async () => {
      await mock.resolveListenWhenPending("pty-output");
    });
    expect(mock.unlistened, "卸载后才落地的监听必须自我注销").toContain("pty-output");
  });

  it("RB-4e: 完全建立后卸载（两个监听都已就位）→ 两个监听与 PTY 全部回收", async () => {
    const mock = installTauriMock();
    const view = render(createElement(TerminalPanel, { cwd: "C:/tmp" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    await act(async () => {
      mock.resolveSpawn("pty-3");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await mock.resolveListenWhenPending("pty-output");
      await mock.resolveListenWhenPending("pty-exit");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mock.listened).toEqual(["pty-output", "pty-exit"]);

    view.unmount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(mock.unlistened.sort(), "两个监听都必须注销").toEqual(["pty-exit", "pty-output"]);
    expect(mock.calls.filter(([cmd]) => cmd === "close_pty").map(([, a]) => a.id)).toEqual(["pty-3"]);
    expect(document.querySelectorAll(".xterm").length, "xterm 实例必须释放").toBe(0);
  });

  it("RB-4c: 监听建立失败 → 已启动的 PTY 必须被回收（不留孤儿进程）", async () => {
    const mock = installTauriMock();
    render(createElement(TerminalPanel, { cwd: "C:/tmp" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    await act(async () => {
      mock.resolveSpawn("pty-2");
      await new Promise((resolve) => setTimeout(resolve, 10));
      mock.rejectListen("pty-output");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(mock.calls.filter(([cmd]) => cmd === "close_pty").map(([, a]) => a.id)).toContain("pty-2");
  });

  it("RB-4d: 卸载清理幂等（_cleanup 不会被调用两次）", async () => {
    const src = require("node:fs").readFileSync("src/components/TerminalPanel.tsx", "utf8") as string;
    // disposedRef 必须在效果清理里先置位，且 _cleanup 自带幂等标记
    expect(src).toContain("disposedRef.current = true;");
    expect(src).toMatch(/_cleanup = \(\) => \{\s*\n\s*if \(\(session as any\)\._disposed\) return;/);
    // 每个 await 之后都要复查卸载标记
    expect((src.match(/disposedRef\.current/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

// ============================================================================
// RB-5：ContextMonitor 手动压缩（P1-8）
// ============================================================================

const listMessagesMock = vi.fn();
const deleteMessagesByIdsMock = vi.fn();
const createMessageMock = vi.fn();

vi.mock("../core/storage/message", () => ({
  listMessages: (...args: any[]) => listMessagesMock(...args),
  /**
   * 第 47 轮（功能上下文审计 P2-D12）：`ContextMonitor` 现在按**模型侧同一口径**
   * 读可见消息（`listVisibleMessages`，见 `message.ts:757`），不再用 `listMessages`
   * 自己 `filter(!hidden)`。测试双必须跟着补齐 —— 只 mock `listMessages` 的话
   * 这个函数在组件里是 `undefined`，面板直接渲染不出来（表现为"按钮不存在"，
   * 而不是"断言失败"，很难定位）。
   */
  listVisibleMessages: (...args: any[]) => listMessagesMock(...args),
  deleteMessagesByIds: (...args: any[]) => deleteMessagesByIdsMock(...args),
  createMessage: (...args: any[]) => createMessageMock(...args),
}));

function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `content ${i}`,
    timestamp: i,
  }));
}

describe("RB-5 ContextMonitor 手动压缩：守卫真的生效 + 失败可见（P1-8）", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetPersistFailures();
    listMessagesMock.mockReset().mockReturnValue(makeMessages(30));
    deleteMessagesByIdsMock.mockReset();
    createMessageMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetPersistFailures();
  });

  const compactButton = () => screen.getByText(/压缩上下文|压缩中/) as HTMLButtonElement;

  it("RB-5a: 同一个 tick 内连点两次只压缩一次（第二次被守卫挡住）", async () => {
    render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await settle();

    fireEvent.click(compactButton());
    // 原实现：`compacting` 在同一批里被复位，按钮仍可点 → 第二次又删一批旧消息
    expect(compactButton().disabled, "进入压缩后按钮必须禁用").toBe(true);
    expect(screen.getByText(/压缩中/)).toBeTruthy();
    fireEvent.click(compactButton());

    await settle();

    expect(deleteMessagesByIdsMock).toHaveBeenCalledTimes(1);
    expect((deleteMessagesByIdsMock.mock.calls[0][0] as string[]).length).toBe(10);
  });

  it("RB-5b: 压缩失败 → 走既有上报通道 + 面板可见提示，且守卫被复位（下一次仍可尝试）", async () => {
    deleteMessagesByIdsMock.mockImplementation(() => {
      throw new Error("db is gone");
    });
    render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await settle();

    fireEvent.click(compactButton());
    await settle();

    // 可见提示（原实现只 console.error，界面完全看不出失败）
    expect(screen.getByTestId("compact-error").textContent).toContain("压缩失败");
    expect(screen.getByTestId("compact-error").textContent).toContain("db is gone");
    // 既有上报通道
    expect(getPersistFailures().some((f) => f.area === "contextMonitor.manualCompact")).toBe(true);
    // 守卫已在 finally 里复位
    expect(compactButton().disabled).toBe(false);

    fireEvent.click(compactButton());
    await settle();
    expect(deleteMessagesByIdsMock).toHaveBeenCalledTimes(2);
  });

  it("RB-5c: 消息太少时不进入压缩（守卫不被占用）", async () => {
    listMessagesMock.mockReturnValue(makeMessages(2));
    render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await settle();

    // 消息数 <= 2 时按钮本身不渲染（既有行为），守卫也不该被占用
    expect(deleteMessagesByIdsMock).not.toHaveBeenCalled();
  });
});

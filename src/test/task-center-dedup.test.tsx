/**
 * TC-DEDUP — 任务管理「功能结构树去重」回归（v1.15.0）
 *
 * 覆盖结构树分析出的重复/坏点：
 * - DEDUP-1 面板里的「定位 / 点角色」必须把场景调出来（否则是死按钮）
 * - DEDUP-2 子智能体页签被场景接管后，「打开父会话」仍可用（宿主事件 codem:open-session）
 * - DEDUP-3 采样调度全插件共享一个定时器（概览嵌入 + 页签外壳不会各起一条轮询）
 * - DEDUP-4 Issue 状态元数据单一来源（看板列 / 筛选 / 详情 / 自动化监听状态）
 * - DEDUP-5 SquadsTab 跟随当前项目重查（对齐 P2-12 项目边界约定）
 * - DEDUP-6 底栏委派限制读真实配置
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const NOW = 1_800_000_000_000;
const PROJECT_ID = "proj-dedup";

function snapshot() {
  const actor = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `角色-${id}`,
    roleLabel: "成员 · 测试",
    kind,
    look: { paletteId: 1, body: 1, hair: 1, hat: 0, prop: 0, face: 0, scale: 1, hueShift: 0 },
    activity: "working",
    statusLabel: "执行中",
    lastEventAt: NOW - 1000,
    metrics: { tasks: 1, done: 0, failed: 0, tools: 2, tokens: 0, cost: 0, errors: 0 },
    preferredZoneId: "code-forge",
    ...extra,
  });
  return {
    at: NOW,
    actors: [
      actor("s1", "captain", { roleLabel: "队长 · 主控" }),
      actor("sub-1", "subagent", { parentId: "sess-parent", roleLabel: "子智能体 · explore" }),
      actor("sub-2", "subagent", { parentId: "sess-parent", roleLabel: "子智能体 · build" }),
      actor("m1", "member"),
    ],
    teams: [],
    metrics: {
      sessions: 1, activeSessions: 1, teams: 0, tasksTotal: 0, tasksDone: 0, tasksFailed: 0,
      tasksRunning: 0, tasksPending: 0, actors: 4, actorsWorking: 4, actorsIdle: 0,
      actorsBlocked: 0, actorsError: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0,
      costTotal: 0, costToday: 0, toolCalls: 3, toolErrors: 1, filesTouched: 1, messages: 2, health: 1,
    },
    events: [{ id: "e1", at: NOW - 100, kind: "tool", severity: "active", text: "write · a.ts" }],
    activity: { perDay: {}, perHour: new Array(24).fill(0), kinds: {} },
    sources: { sessions: 1, activeSessions: 1, teams: 0, teamMembers: 0, subagents: 2, teamTemplates: 0, agentProfiles: 0, telemetryEvents: 1, failed: [] },
    sampleMs: 1,
  };
}

vi.mock("../plugins/library-ops/core/telemetry-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/library-ops/core/telemetry-adapter")>();
  return { ...actual, collectSnapshot: vi.fn(async () => snapshot()) };
});

beforeEach(async () => {
  const { useLibraryOps } = await import("../plugins/library-ops/store");
  useLibraryOps.getState()._reset();
  const { useProjectStore } = await import("../core/store");
  useProjectStore.setState({
    projects: [{ id: PROJECT_ID, name: "去重项目", path: "C:/dedup", createdAt: 0, lastAccessedAt: 0 } as any],
    sessions: [],
    currentProject: { id: PROJECT_ID, name: "去重项目", path: "C:/dedup", createdAt: 0, lastAccessedAt: 0 } as any,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TC-DEDUP 面板里的角色跳转", () => {
  it("DEDUP-1: 错误面板「定位」会请求切到场景视图（不再是死按钮）", async () => {
    const { ErrorsPanel } = await import("../plugins/library-ops/components/monitor/ErrorsPanel");
    const { useLibraryOps } = await import("../plugins/library-ops/store");
    // 造一个出错角色，让「定位」按钮出现
    const snap = snapshot();
    snap.actors[0].activity = "error";

    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("codem:open-task-center", listener);
    try {
      const { container } = render(<ErrorsPanel snapshot={snap as any} zh />);
      const locate = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("定位"))!;
      expect(locate).toBeTruthy();
      await act(async () => {
        fireEvent.click(locate);
      });
      expect(useLibraryOps.getState().selectedActorId).toBe("s1");
      expect(seen).toEqual([{ tab: "subagents", view: "scene" }]);
    } finally {
      window.removeEventListener("codem:open-task-center", listener);
    }
  });

  it("DEDUP-2: 场景里的子智能体可「打开父会话」（派发 codem:open-session）", async () => {
    const { LibraryPanel } = await import("../plugins/library-ops/components/monitor/LibraryPanel");
    const { useLibraryOps } = await import("../plugins/library-ops/store");
    useLibraryOps.getState().selectActor("sub-1");

    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("codem:open-session", listener);
    try {
      const { container } = render(<LibraryPanel snapshot={snapshot() as any} zh />);
      const btn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("打开父会话"),
      )!;
      expect(btn).toBeTruthy();
      await act(async () => {
        fireEvent.click(btn);
      });
      expect(seen).toEqual([{ sessionId: "sess-parent" }]);
    } finally {
      window.removeEventListener("codem:open-session", listener);
    }
  });
});

describe("TC-DEDUP 采样调度", () => {
  it("DEDUP-3: 多个挂载点共享同一个轮询定时器（卸载最后一个才停）", async () => {
    const adapter = await import("../plugins/library-ops/core/telemetry-adapter");
    const collect = vi.mocked(adapter.collectSnapshot);
    const { LibraryOpsViewShell } = await import("../plugins/library-ops/components/LibraryOpsViewShell");
    collect.mockClear();

    const a = render(
      <LibraryOpsViewShell dataView="t" views={[]} active={"board" as never} onSelect={() => {}} showFeed={false}>
        <span>a</span>
      </LibraryOpsViewShell>,
    );
    const b = render(
      <LibraryOpsViewShell dataView="t2" views={[]} active={"board" as never} onSelect={() => {}} showFeed={false}>
        <span>b</span>
      </LibraryOpsViewShell>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    const afterMounts = collect.mock.calls.length;
    // 挂载即采样（store 的 sampling 守卫会合并并发请求，所以这里是 ≥1 而不是 2）
    expect(afterMounts).toBeGreaterThanOrEqual(1);

    // 卸载第一个：共享定时器仍在（另一个还在用）→ 后续仍有采样
    await act(async () => {
      a.unmount();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1700));
    });
    expect(collect.mock.calls.length).toBeGreaterThan(afterMounts);

    // 卸载最后一个：定时器停掉 → 计数不再增长
    await act(async () => {
      b.unmount();
    });
    const afterAll = collect.mock.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1700));
    });
    expect(collect.mock.calls.length).toBe(afterAll);
  }, 10_000);
});

describe("TC-DEDUP 单一元数据来源", () => {
  it("DEDUP-4: Issue 状态清单/标签只有一份（看板列、筛选、详情、自动化都取自它）", () => {
    const meta = read("components/task-center/issue-status-meta.ts");
    for (const s of ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]) {
      expect(meta).toContain(`"${s}"`);
    }
    // 各处不再各自硬编码清单
    expect(read("components/task-center/IssueBoard.tsx")).toContain("ISSUE_STATUS_META");
    expect(read("components/task-center/IssueBoard.tsx")).not.toContain('{ status: "backlog"');
    expect(read("components/task-center/IssuesTab.tsx")).toContain("ISSUE_STATUS_FILTERS");
    expect(read("components/task-center/IssueDetailPanel.tsx")).toContain("ISSUE_STATUSES");
    const automation = read("components/task-center/AutomationTab.tsx");
    expect(automation).toContain("ISSUE_STATUS_META");
    // 原先漏掉的 backlog/todo 现在由表驱动
    expect(automation).not.toContain('<option value="in_progress">');
  });

  it("DEDUP-5: SquadsTab 把当前项目放进依赖（切项目会重查）", () => {
    const src = read("components/task-center/SquadsTab.tsx");
    expect(src).toContain("useCurrentProjectId");
    expect(src).toMatch(/\}, \[projectId\]\)/);
    expect(src).not.toContain("useProjectStore.getState()");
  });

  it("DEDUP-6: 任务管理底栏读真实委派限制（不再写死 2 / 5）", () => {
    const src = read("components/TaskCenter.tsx");
    expect(src).toContain("getDelegationOrchestrator().getLimits()");
    expect(src).not.toContain("委派深度限制: 2");
  });

  it("DEDUP-7: 内容区滚动规则与面板宽度解耦 —— 概览可滚动，看板/子智能体由插件外壳管滚动", () => {
    const src = read("components/TaskCenter.tsx");
    // 宽度（wide）与「是否铺满一屏」（fillsViewport）必须是两个判断
    expect(src).toMatch(/const wide = activeTab === "board" \|\| activeTab === "subagents" \|\| activeTab === "overview"/);
    expect(src).toMatch(/const fillsViewport = activeTab === "board" \|\| activeTab === "subagents"/);
    expect(src).toContain('overflow: fillsViewport ? "hidden" : "auto"');
    // 不能再把 overflow 绑在 wide 上（那会让概览被裁掉、没有滚动条）
    expect(src).not.toContain('overflow: wide ? "hidden" : "auto"');
  });
});

describe("TC-DEDUP 概览页可滚动", () => {
  it("DEDUP-8: 概览页签的内容区 overflow=auto（用量面板再长也能滚到底）", async () => {
    const { TaskCenter } = await import("../components/TaskCenter");
    const { Context } = await import("../core/cordis/src/index.ts");
    const { SlotsService } = await import("../core/slots/index.ts");
    const { setActiveContext } = await import("../core/consumer/index.ts");

    const ctx = new Context();
    const slots = new SlotsService(ctx);
    setActiveContext(ctx);

    const { rerender } = render(<TaskCenter onClose={() => {}} initialTab="overview" />);
    // TaskCenter 用 createPortal 渲染到 body，所以要查 document
    const contentOf = (tab: string) => document.querySelector<HTMLElement>(`[data-task-center-content="${tab}"]`);
    // 概览：普通文档流 → 必须可滚动
    expect(contentOf("overview")?.style.overflow).toBe("auto");

    // 看板 / 子智能体：由插件外壳自己管滚动 → 内容区必须 hidden
    rerender(<TaskCenter onClose={() => {}} initialTab="board" />);
    expect(contentOf("board")?.style.overflow).toBe("hidden");
    rerender(<TaskCenter onClose={() => {}} initialTab="subagents" />);
    expect(contentOf("subagents")?.style.overflow).toBe("hidden");

    // 其它普通页签同样是 auto
    rerender(<TaskCenter onClose={() => {}} initialTab="inbox" />);
    expect(contentOf("inbox")?.style.overflow).toBe("auto");

    void slots;
  });
});

/**
 * Library Ops 视觉预览入口（开发工具，不参与打包）。
 *
 * 用固定快照渲染图书馆场景与监控面板，供 headless 浏览器截图做视觉审计。
 */

import { createRoot } from "react-dom/client";
import { LibraryScene } from "../../src/plugins/library-ops/components/library/LibraryScene";
import { PixelLibraryScene } from "../../src/plugins/library-ops/components/library/PixelLibraryScene";
import { CostPanel } from "../../src/plugins/library-ops/components/monitor/CostPanel";
import { ErrorsPanel } from "../../src/plugins/library-ops/components/monitor/ErrorsPanel";
import { SettingsPanel } from "../../src/plugins/library-ops/components/monitor/SettingsPanel";
import { TimelinePanel } from "../../src/plugins/library-ops/components/monitor/TimelinePanel";
import { ToolsPanel } from "../../src/plugins/library-ops/components/monitor/ToolsPanel";
import { LibraryPanel } from "../../src/plugins/library-ops/components/monitor/LibraryPanel";
import { OverviewPanel } from "../../src/plugins/library-ops/components/monitor/OverviewPanel";
import { SceneImageCard } from "../../src/plugins/library-ops/components/monitor/SceneImageCard";
import { useLibraryOps } from "../../src/plugins/library-ops/store";
import type { LibraryActor, LibrarySnapshot } from "../../src/plugins/library-ops/types";
import { generateLook } from "../../src/plugins/library-ops/data/characters";
import { resolveZoneId } from "../../src/plugins/library-ops/data/library-map";
import { advanceScene, createSceneState, stepActorMovement } from "../../src/plugins/library-ops/core/scene-engine";
import { advancePixelScene, createPixelSceneState, stepPixelMovement } from "../../src/plugins/library-ops/core/pixel-scene";
import "../../src/plugins/library-ops/styles/library-ops.css";

const NOW = Date.now();

function actor(id: string, name: string, roleLabel: string, activity: LibraryActor["activity"], kind: LibraryActor["kind"] = "member"): LibraryActor {
  return {
    id,
    name,
    roleLabel,
    kind,
    teamId: "team-1",
    teamName: "前端重构小队",
    model: "deepseek-v4",
    look: generateLook(id, roleLabel),
    activity,
    statusLabel: "",
    focus: `正在处理 ${name} 的任务`,
    lastEventAt: NOW - 30_000,
    metrics: { tasks: 3, done: 1, failed: 0, tools: 12, tokens: 4200, cost: 0.05, errors: 0 },
    preferredZoneId: resolveZoneId(roleLabel),
  };
}

const actors: LibraryActor[] = [
  actor("s1", "主控会话", "队长 · 前端重构小队", "thinking", "captain"),
  actor("m1", "小前", "成员 · 前端实现", "working"),
  actor("m2", "小研", "成员 · 研究分析", "reading"),
  actor("m3", "小索", "成员 · 检索索引", "searching"),
  actor("m4", "小笔", "成员 · 文档写作", "writing"),
  actor("m5", "小运", "成员 · 运维部署", "working"),
  actor("m6", "小记", "成员 · 记忆归档", "working"),
  actor("m7", "小审", "成员 · 评审测试", "blocked"),
  actor("m8", "小交", "成员 · 交付汇总", "done"),
  actor("m9", "小闲", "成员 · 空闲待命", "idle"),
  actor("sub1", "审计插件", "子智能体 · explore", "reading", "subagent"),
  actor("sub2", "跑测试", "子智能体 · build", "error", "subagent"),
];

const snapshot: LibrarySnapshot = {
  at: NOW,
  actors,
  teams: [
    {
      id: "team-1",
      name: "前端重构小队",
      captainSessionId: "s1",
      captainName: "主控会话",
      memberCount: 9,
      members: actors
        .filter((a) => a.kind === "member")
        .map((a) => ({ id: a.id, name: a.name, role: a.roleLabel, status: "working", tasks: 3, done: 1, currentTask: "实现登录页" })),
      tasks: [
        { id: "t1", subject: "实现登录页", status: "in_progress", assignee: "小前", dependencies: [], attempt: 1 },
        { id: "t2", subject: "调研方案", status: "completed", assignee: "小研", dependencies: [], attempt: 1 },
        { id: "t3", subject: "部署验证", status: "failed", assignee: "小运", dependencies: ["t2"], attempt: 2 },
      ],
      taskCounts: { pending: 2, claimed: 1, in_progress: 1, completed: 1, failed: 1, cancelled: 0 },
      unread: 3,
      createdAt: NOW - 600_000,
      updatedAt: NOW - 10_000,
      archived: false,
      completion: 0.4,
    },
  ],
  metrics: {
    sessions: 3,
    activeSessions: 2,
    teams: 1,
    tasksTotal: 5,
    tasksDone: 2,
    tasksFailed: 1,
    tasksRunning: 2,
    tasksPending: 2,
    actors: actors.length,
    actorsWorking: 6,
    actorsIdle: 2,
    actorsBlocked: 1,
    actorsError: 1,
    tokensIn: 320_000,
    tokensOut: 84_000,
    tokensCached: 120_000,
    costTotal: 12.34,
    costToday: 4.21,
    toolCalls: 128,
    toolErrors: 6,
    filesTouched: 17,
    messages: 96,
    health: 0.74,
  },
  events: [
    { id: "e1", at: NOW - 2_000, kind: "tool", severity: "active", text: "write · src/App.tsx" },
    { id: "e2", at: NOW - 5_000, kind: "task", severity: "ok", text: "[前端重构小队] t2 调研方案", teamId: "team-1" },
    { id: "e3", at: NOW - 9_000, kind: "tool", severity: "bad", text: "bash · npm test" },
    { id: "e4", at: NOW - 20_000, kind: "agent", severity: "active", text: "审计插件 — grep" },
  ],
  activity: {
    perDay: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`2026-08-${String(i + 28).padStart(2, "0")}`, (i * 7) % 19])),
    perHour: new Array(24).fill(0).map((_, h) => (h > 8 && h < 20 ? (h * 3) % 11 : 0)),
    kinds: { chat: 2, captain: 1, worktree: 1 },
  },
  sources: {
    sessions: 3,
    activeSessions: 2,
    teams: 1,
    teamMembers: 9,
    subagents: 2,
    teamTemplates: 1,
    agentProfiles: 4,
    telemetryEvents: 22,
    failed: [],
  },
  sampleMs: 1.4,
};

const series = {
  tokens: Array.from({ length: 40 }, (_, i) => ({ at: NOW - (40 - i) * 1500, value: 320_000 + i * 1200 })),
  cost: Array.from({ length: 40 }, (_, i) => ({ at: NOW - (40 - i) * 1500, value: 10 + i * 0.06 })),
  tools: Array.from({ length: 40 }, (_, i) => ({ at: NOW - (40 - i) * 1500, value: 100 + (i % 7) })),
  actors: Array.from({ length: 40 }, (_, i) => ({ at: NOW - (40 - i) * 1500, value: 4 + (i % 3) })),
  tasks: Array.from({ length: 40 }, (_, i) => ({ at: NOW - (40 - i) * 1500, value: i % 4 })),
  health: Array.from({ length: 40 }, (_, i) => ({ at: NOW - (40 - i) * 1500, value: 0.7 + (i % 5) * 0.05 })),
};

useLibraryOps.setState({
  snapshot,
  series,
  selectedActorId: null,
  selectedZoneId: "code-forge",
});

/**
 * 确定性「已到岗」场景：在 Node/浏览器里跑与运行时相同的推进循环
 * （advanceScene 规划路径 + stepActorMovement 逐帧位移），让审计看到角色
 * 真正站在各自岗位上的状态，而不是刚入场的一团人。
 */
function settledScene() {
  let state = createSceneState(NOW);
  let t = NOW;
  for (let i = 0; i < 600; i++) {
    t += 100;
    state = advanceScene(state, { ...snapshot, at: t }, 100);
    for (const a of Object.values(state.actors)) stepActorMovement(a, 100);
  }
  return state;
}
const INITIAL_SCENE = settledScene();

/** 像素场景的确定性「已到岗」状态（同一套推进循环） */
function settledPixelScene() {
  let state = createPixelSceneState(NOW);
  let t = NOW;
  for (let i = 0; i < 900; i++) {
    t += 100;
    state = advancePixelScene(state, { ...snapshot, at: t }, 100);
    for (const a of Object.values(state.actors)) stepPixelMovement(a, 100);
  }
  return state;
}
const INITIAL_PIXEL_SCENE = settledPixelScene();

function Preview() {
  // ?audit=1 → 只渲染「看板页签」里的插件视图（按宿主面板尺寸铺满视口），
  // 供 audit-layout.mjs 在不同窗口宽度下逐个视图检查裁切/重叠。
  // 注意：这里不渲染 IssueBoard（宿主看板，依赖 node 内建模块，浏览器预览构建不了），
  // 只审计插件自己的视图；宿主看板的布局由任务管理自身的测试覆盖。
  const auditMode = typeof location !== "undefined" && location.search.includes("audit");
  if (auditMode) {
    return (
      <div
        className="preview-wrap"
        style={{ padding: 0, gap: 0, width: "min(1180px, 96vw)", height: "min(720px, 88vh)", margin: "0 auto" }}
      >
        <div style={{ position: "relative", height: "100%", border: "1px solid var(--border-primary)", borderRadius: 12, overflow: "hidden" }}>
          <div className="lo-task" data-lo-view="task-center-board">
            <div className="lo-task__body">
              <main className="lo-task__content">
                <AuditedView />
              </main>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="preview-wrap">
      <h3 style={{ margin: 0, fontSize: 14 }}>看板页签「场景」视图（融合后的形态 · 无独立面板）</h3>
      <div
        style={{
          width: "min(1180px, 96vw)",
          height: "min(720px, 88vh)",
          position: "relative",
          border: "1px solid var(--border-primary)",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <div className="lo-task" data-lo-view="task-center-board">
          <div className="lo-task__body">
            <main className="lo-task__content">
              <LibraryPanel snapshot={snapshot} zh />
            </main>
          </div>
        </div>
      </div>
      <h3 style={{ margin: 0, fontSize: 14 }}>像素图书馆（内置场景图预设 · 可在设置里换图 / 上传自己的图）</h3>
      <div className="preview-scene">
        <PixelLibraryScene
          snapshot={snapshot}
          initialScene={INITIAL_PIXEL_SCENE}
          showZoneLabels
          showNameplates
          showBubbles
          speed={1}
          maxActors={24}
        />
      </div>
      <h3 style={{ margin: 0, fontSize: 14 }}>场景图片设置卡（画廊 / 上传 / 微调 / 对位预览）</h3>
      <div style={{ width: 620 }}>
        <SceneImageCard zh />
      </div>
      <h3 style={{ margin: 0, fontSize: 14 }}>等距矢量场景（备用 · 本项目自绘）</h3>
      <div className="preview-scene">
        <LibraryScene
          snapshot={snapshot}
          initialScene={INITIAL_SCENE}
          showZoneLabels
          showNameplates
          showBubbles
          speed={1}
          maxActors={24}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, width: 1180 }}>
        <OverviewPanel snapshot={snapshot} series={series} zh onOpenLibrary={() => {}} onOpenTab={() => {}} />
        <CostPanel snapshot={snapshot} series={series} zh />
      </div>
      <div style={{ width: 1180, height: 640, position: "relative", border: "1px solid var(--border-primary)", borderRadius: 12 }}>
        <LibraryPanel snapshot={snapshot} zh />
      </div>
    </div>
  );
}

/** 审计模式下按 store.tab 渲染对应的插件视图 */
function AuditedView() {
  const tab = useLibraryOps((s) => s.tab);
  if (tab === "scene") return <LibraryPanel snapshot={snapshot} zh />;
  if (tab === "usage")
    return (
      <div className="lo-usage">
        <OverviewPanel snapshot={snapshot} series={series} zh onOpenLibrary={() => {}} onOpenTab={() => {}} />
        <CostPanel snapshot={snapshot} series={series} zh />
      </div>
    );
  if (tab === "tools") return <ToolsPanel snapshot={snapshot} zh />;
  if (tab === "errors") return <ErrorsPanel snapshot={snapshot} zh />;
  if (tab === "timeline") return <TimelinePanel snapshot={snapshot} zh />;
  if (tab === "settings") return <SettingsPanel zh />;
  return <div className="lo-empty">board</div>;
}

createRoot(document.getElementById("root")!).render(<Preview />);

/**
 * 版面自检（?audit=1）：逐个渲染「图书馆」页签的每个子视图，把
 * 「被裁切 / 元素互相重叠」写进 DOM，供 headless 抓取。
 *
 * 判定三类问题：
 * 1. **横向裁切**：元素的 scrollWidth 明显大于 clientWidth（内容放不下）
 * 2. **纵向裁切**：overflow-y: hidden 且 scrollHeight > clientHeight（内容被切掉）
 * 3. **元素重叠**：同一容器内两个非绝对定位兄弟的包围盒重叠面积 > 4×4px
 *    （这就是用户看到的「堆叠到一起」）
 *
 * 排除：场景画布内部（可平移缩放，重叠是设计）、绝对定位元素、纯装饰容器。
 */
if (typeof location !== "undefined" && location.search.includes("audit")) {
  const measureView = (tab: string) => {
    const root = document.querySelector(".lo-task");
    const view: {
      tab: string;
      rootWidth: number;
      clipped: Array<Record<string, unknown>>;
      overlapping: Array<Record<string, unknown>>;
      minFontPx: number;
    } = {
      tab,
      rootWidth: root ? Math.round((root as HTMLElement).getBoundingClientRect().width) : 0,
      clipped: [],
      overlapping: [],
      minFontPx: 0,
    };
    if (!root) return view;
    const sel = (el: Element) =>
      `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ").filter(Boolean).slice(0, 2).join(".")}`;
    const visible = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const style = getComputedStyle(el);
      if (!visible(el)) continue;
      if (el.closest(".lo-scene") || style.position === "absolute" || style.position === "fixed") continue;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
      const fs = parseFloat(style.fontSize);
      if (fs && fs < (view.minFontPx || 999)) view.minFontPx = Math.round(fs * 10) / 10;

      const scrollableX = style.overflowX === "auto" || style.overflowX === "scroll";
      const scrollableY = style.overflowY === "auto" || style.overflowY === "scroll";
      // 省略号截断是设计（不是布局问题）
      const ellipsis = style.textOverflow === "ellipsis";
      const dx = el.scrollWidth - el.clientWidth;
      const dy = el.scrollHeight - el.clientHeight;
      // 横向 6px 以内视为亚像素/字距噪声（视觉上看不出裁切）
      if (!scrollableX && !ellipsis && dx > 6 && (hasText || el.classList.contains("lo-card"))) {
        view.clipped.push({ sel: sel(el), dx, w: el.clientWidth });
      }
      if (!scrollableY && style.overflowY === "hidden" && dy > 4 && (hasText || el.classList.contains("lo-card"))) {
        view.clipped.push({ sel: sel(el), dy, h: el.clientHeight });
      }
    }

    // 同一容器的直接子元素两两比较（只在 grid/flex 容器里，绝对定位元素跳过）
    for (const box of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const style = getComputedStyle(box);
      if (style.display !== "grid" && style.display !== "flex") continue;
      if (box.closest(".lo-scene")) continue;
      const kids = Array.from(box.children).filter(
        (k): k is HTMLElement => k instanceof HTMLElement && visible(k) && getComputedStyle(k).position === "static",
      );
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const ra = kids[i].getBoundingClientRect();
          const rb = kids[j].getBoundingClientRect();
          const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (ox > 4 && oy > 4) {
            view.overlapping.push({ a: sel(kids[i]), b: sel(kids[j]), ox: Math.round(ox), oy: Math.round(oy) });
          }
        }
      }
    }
    return view;
  };

  const SUB_VIEWS = ["scene", "usage", "tools", "errors", "timeline", "settings"] as const;

  window.setTimeout(async () => {
    const { useLibraryOps } = await import("../../src/plugins/library-ops/store");
    const report: { viewport: string; views: unknown[] } = {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      views: [],
    };
    for (const tab of SUB_VIEWS) {
      useLibraryOps.getState().setTab(tab);
      // 等 React 提交 + 图表/场景布局稳定
      await new Promise((r) => setTimeout(r, 420));
      const v = measureView(tab);
      // 调试用：附带容器样式与子元素矩形，便于定位重叠原因
      const container = document.querySelector(".lo-settings, .lo-grid--lp, .lo-tools, .lo-errors");
      if (container) {
        const cs = getComputedStyle(container);
        (v as Record<string, unknown>).containerDebug = {
          sel: `${container.tagName.toLowerCase()}.${(container.className || "").toString().split(" ").join(".")}`,
          display: cs.display,
          columns: cs.gridTemplateColumns,
          rows: cs.gridTemplateRows,
          alignContent: cs.alignContent,
          alignItems: cs.alignItems,
          gap: cs.gap,
          height: Math.round((container as HTMLElement).getBoundingClientRect().height),
          children: Array.from(container.children).map((c) => {
            const r = (c as HTMLElement).getBoundingClientRect();
            return {
              cls: (c.className || "").toString().split(" ").slice(0, 2).join("."),
              top: Math.round(r.top),
              h: Math.round(r.height),
              left: Math.round(r.left),
              w: Math.round(r.width),
            };
          }),
        };
      }
      report.views.push(v);
    }
    const pre = document.createElement("pre");
    pre.id = "layout-audit";
    pre.textContent = JSON.stringify(report, null, 2);
    document.body.appendChild(pre);
  }, 1200);
}

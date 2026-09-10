/**
 * LibraryOpsBoardView —— 「看板」页签的接管视图（渲染在 `task-center.board` slot 里）。
 *
 * 为什么并进看板：图书馆场景的初衷就是「谁在做什么、在哪做」的可视化看板，
 * 与宿主「看板」页签（Issues 按状态分列）是同一类信息的不同表达；
 * 分成两个页签会让用户在两处看到同一批团队/会话/任务。
 * 现在合成一个页签：**看板（宿主 Issues）为默认视图**，插件追加
 * 场景 / 用量 / 工具 / 错误 / 时间线 / 设置 六个视图。
 *
 * 版面（自适应，见 styles/library-ops.css 的 @container 规则）：
 * ```
 * ┌ 状态条（自动换行）───────────────────────────────┐
 * ├ 视图导航 │ 内容区（自然高度 + 滚动） │ 事件流（窄屏自动收起）┤
 * └──────────────────────────────────────────────┘
 * ```
 *
 * 采样生命周期：挂载即采样，卸载（切视图/关面板）立即停止 —— 宿主零后台开销。
 */

import { useEffect, useState } from "react";
import type { LoIconName, MonitorTab } from "../types";
import { ACTIVITY_META } from "../types";
import { useLibraryOps } from "../store";
import { useLang } from "../../../core/i18n/lang";
import { formatClock } from "../core/format";
import { IssueBoard } from "../../../components/task-center/IssueBoard";
import { LoIcon } from "./icons";
import { OverviewPanel } from "./monitor/OverviewPanel";
import { CostPanel } from "./monitor/CostPanel";
import { LibraryPanel } from "./monitor/LibraryPanel";
import { ToolsPanel } from "./monitor/ToolsPanel";
import { ErrorsPanel } from "./monitor/ErrorsPanel";
import { TimelinePanel } from "./monitor/TimelinePanel";
import { SettingsPanel } from "./monitor/SettingsPanel";
import { EventList } from "./monitor/EventList";
import { Pill } from "./monitor/common";
import "../styles/library-ops.css";

/** 视图导航（看板 = 宿主 Issues 看板；其余为本插件视图） */
const VIEWS: Array<{ id: MonitorTab; zh: string; en: string; icon: LoIconName }> = [
  { id: "board", zh: "看板", en: "Board", icon: "columns" },
  { id: "scene", zh: "场景", en: "Scene", icon: "users" },
  { id: "usage", zh: "用量", en: "Usage", icon: "bar-chart-3" },
  { id: "tools", zh: "工具", en: "Tools", icon: "wrench" },
  { id: "errors", zh: "错误", en: "Errors", icon: "triangle-alert" },
  { id: "timeline", zh: "时间线", en: "Timeline", icon: "clock" },
  { id: "settings", zh: "设置", en: "Settings", icon: "settings" },
];

export function LibraryOpsBoardView() {
  const zh = useLang() === "zh";
  const tab = useLibraryOps((s) => s.tab);
  const setTab = useLibraryOps((s) => s.setTab);
  const refresh = useLibraryOps((s) => s.refresh);
  const snapshot = useLibraryOps((s) => s.snapshot);
  const series = useLibraryOps((s) => s.series);
  const settings = useLibraryOps((s) => s.settings);
  const error = useLibraryOps((s) => s.error);
  const sampling = useLibraryOps((s) => s.sampling);
  /**
   * 看板子视图默认**不渲染实时事件流**：看板 7 列本来就需要横向空间，
   * 事件流再占 200–280px 会把右侧列挤出可视区（用户反馈「看板被实时事件遮挡」）。
   * 需要时可以点状态条的按钮临时打开。
   */
  const [feedOnBoard, setFeedOnBoard] = useState(false);
  /** 实时事件流是否显示：看板视图默认收起（见上），其它视图按设置显示 */
  const feedVisible = settings.showEventFeed && tab !== "timeline" && (tab !== "board" || feedOnBoard);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), settings.refreshMs);
    return () => clearInterval(timer);
  }, [settings.refreshMs, refresh]);

  // 宿主「概览 → 查看完整时间线」会派发 codem:open-task-center { tab: 'board', view: 'timeline' }，
  // 这里消费 detail.view 切到对应子视图（插件依赖宿主事件，方向正确）。
  useEffect(() => {
    const handler = (e: Event) => {
      const view = (e as CustomEvent).detail?.view;
      if (typeof view === "string" && VIEWS.some((v) => v.id === view)) {
        setTab(view as MonitorTab);
      }
    };
    window.addEventListener("codem:open-task-center", handler as EventListener);
    return () => window.removeEventListener("codem:open-task-center", handler as EventListener);
  }, [setTab]);

  const live = (() => {
    if (!snapshot) return { token: "--text-muted", zh: "无数据", en: "no data", icon: "gauge" as LoIconName };
    const m = snapshot.metrics;
    if (m.actorsError > 0) return { token: "--error", zh: "有异常", en: "errors", icon: "triangle-alert" as LoIconName };
    if (m.actorsBlocked > 0) return { token: "--security-ask", zh: "待授权", en: "blocked", icon: "pause" as LoIconName };
    if (m.actorsWorking > 0) return { token: "--success", zh: "工作中", en: "working", icon: "cog" as LoIconName };
    return { token: "--text-muted", zh: "待命", en: "idle", icon: "coffee" as LoIconName };
  })();

  return (
    <div className="lo-task" data-lo-view="task-center-board">
      {/* 状态条 */}
      <header className="lo-task__bar">
        <span className="lo-task__live" style={{ ["--lo-live-token" as string]: `var(${live.token})` }}>
          <span className="lo-task__live-dot" />
          <LoIcon name={live.icon} size={12} />
          {zh ? live.zh : live.en}
        </span>
        {snapshot && (
          <span className="lo-task__meta">
            <span>
              <LoIcon name={ACTIVITY_META.working.icon} size={12} /> {snapshot.metrics.actorsWorking}
            </span>
            <span>
              <LoIcon name={ACTIVITY_META.idle.icon} size={12} /> {snapshot.metrics.actorsIdle}
            </span>
            <span>
              <LoIcon name="wrench" size={12} /> {snapshot.metrics.toolCalls}
            </span>
          </span>
        )}
        <span className="lo-task__clock">{formatClock(snapshot?.at ?? Date.now())}</span>
        {settings.showEventFeed && tab === "board" && (
          <button
            className={`lo-icon-btn${feedOnBoard ? " is-active" : ""}`}
            onClick={() => setFeedOnBoard((v) => !v)}
            title={
              feedOnBoard
                ? zh
                  ? "收起实时事件（看板占满宽度）"
                  : "Hide live feed (full-width board)"
                : zh
                  ? "显示实时事件（会占用右侧宽度）"
                  : "Show live feed (takes right-side width)"
            }
            aria-label={zh ? "实时事件" : "Live feed"}
            aria-pressed={feedOnBoard}
          >
            <LoIcon name="layout-panel-left" size={14} />
          </button>
        )}
        <button
          className={`lo-icon-btn${sampling ? " is-busy" : ""}`}
          onClick={() => void refresh()}
          title={zh ? "立即刷新" : "Refresh now"}
          aria-label={zh ? "立即刷新" : "Refresh now"}
        >
          <LoIcon name="refresh-cw" size={14} />
        </button>
      </header>

      {error && (
        <div className="lo-task__error">
          <Pill token="--error">
            <LoIcon name="triangle-alert" size={11} /> {zh ? "采样失败" : "Sample failed"}
          </Pill>
          <span>{error}</span>
        </div>
      )}

      <div className="lo-task__body">
        <nav className="lo-task__rail" aria-label={zh ? "看板视图" : "Board views"}>
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`lo-nav__btn${tab === v.id ? " is-active" : ""}`}
              onClick={() => setTab(v.id)}
              title={zh ? v.zh : v.en}
              aria-pressed={tab === v.id}
            >
              <LoIcon name={v.icon} size={14} />
              <span className="lo-nav__label">{zh ? v.zh : v.en}</span>
            </button>
          ))}
        </nav>

        <main className="lo-task__content">
          {tab === "board" && (
            // 包一层 flex 宿主：让宿主 IssueBoard（inline height:100% + overflow:auto）
            // 始终正好填满内容区，横向滚动条不会被挤出可视区
            <div className="lo-board-host">
              <IssueBoard />
            </div>
          )}
          {tab === "scene" && <LibraryPanel snapshot={snapshot} zh={zh} />}
          {tab === "usage" && (
            <div className="lo-usage">
              <OverviewPanel
                snapshot={snapshot}
                series={series}
                zh={zh}
                onOpenLibrary={() => setTab("scene")}
                onOpenTab={setTab}
              />
              <CostPanel snapshot={snapshot} series={series} zh={zh} />
            </div>
          )}
          {tab === "tools" && <ToolsPanel snapshot={snapshot} zh={zh} />}
          {tab === "errors" && <ErrorsPanel snapshot={snapshot} zh={zh} />}
          {tab === "timeline" && <TimelinePanel snapshot={snapshot} zh={zh} />}
          {tab === "settings" && <SettingsPanel zh={zh} />}
        </main>

        {feedVisible && (
          <aside className="lo-task__feed">
            <div className="lo-task__feed-title">
              <LoIcon name="radio" size={12} /> {zh ? "实时事件" : "Live feed"}
            </div>
            <div className="lo-task__feed-body">
              {snapshot ? (
                <EventList snapshot={snapshot} zh={zh} limit={40} />
              ) : (
                <div className="lo-empty">{zh ? "等待采样…" : "Waiting…"}</div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export default LibraryOpsBoardView;

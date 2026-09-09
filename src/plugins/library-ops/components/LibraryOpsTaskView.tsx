/**
 * LibraryOpsTaskView —— 图书馆视图（渲染在宿主「任务管理」面板的
 * `task-center.library` slot 里，**没有独立面板**）。
 *
 * 版面设计（自适应，不写死宽度）：
 * ```
 * ┌ 状态条（自动换行）───────────────────────────────┐
 * ├ 子导航 │ 内容区（场景 / 用量 / 工具 / 成本 …） │ 事件流（窄屏自动收起）┤
 * └──────────────────────────────────────────────┘
 * ```
 * - 容器宽度 ≥ 1080px：导航带文字 + 右侧事件流
 * - 900–1080px：导航带文字，事件流收起（设置里可手动关）
 * - < 900px：导航变图标条（文字隐藏），内容区单列
 *
 * 采样生命周期：本组件挂载时按 `settings.refreshMs` 采样，卸载（切到别的页签
 * 或关闭任务管理）立即停止 —— 宿主零后台开销。
 */

import { useEffect } from "react";
import type { LoIconName, MonitorTab } from "../types";
import { ACTIVITY_META } from "../types";
import { useLibraryOps } from "../store";
import { useLang } from "../../../core/i18n/lang";
import { formatClock } from "../core/format";
import { LoIcon } from "./icons";
import { OverviewPanel } from "./monitor/OverviewPanel";
import { LibraryPanel } from "./monitor/LibraryPanel";
import { SessionsPanel } from "./monitor/SessionsPanel";
import { ToolsPanel } from "./monitor/ToolsPanel";
import { CostPanel } from "./monitor/CostPanel";
import { ErrorsPanel } from "./monitor/ErrorsPanel";
import { TimelinePanel } from "./monitor/TimelinePanel";
import { SettingsPanel } from "./monitor/SettingsPanel";
import { EventList } from "./monitor/EventList";
import { Pill } from "./monitor/common";
import "../styles/library-ops.css";

/** 子导航（去掉与任务管理重复的「总览 / 团队」） */
const SUB_NAV: Array<{ id: MonitorTab; zh: string; en: string; icon: LoIconName }> = [
  { id: "library", zh: "场景", en: "Scene", icon: "library" },
  { id: "usage", zh: "用量", en: "Usage", icon: "bar-chart-3" },
  { id: "sessions", zh: "会话", en: "Sessions", icon: "message-square" },
  { id: "tools", zh: "工具", en: "Tools", icon: "wrench" },
  { id: "cost", zh: "成本", en: "Cost", icon: "circle-dollar-sign" },
  { id: "errors", zh: "错误", en: "Errors", icon: "triangle-alert" },
  { id: "timeline", zh: "时间线", en: "Timeline", icon: "clock" },
  { id: "settings", zh: "设置", en: "Settings", icon: "settings" },
];

export function LibraryOpsTaskView() {
  const zh = useLang() === "zh";
  const tab = useLibraryOps((s) => s.tab);
  const setTab = useLibraryOps((s) => s.setTab);
  const refresh = useLibraryOps((s) => s.refresh);
  const snapshot = useLibraryOps((s) => s.snapshot);
  const series = useLibraryOps((s) => s.series);
  const settings = useLibraryOps((s) => s.settings);
  const error = useLibraryOps((s) => s.error);
  const sampling = useLibraryOps((s) => s.sampling);

  // 挂载即采样；卸载立即停止（无后台轮询）
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), settings.refreshMs);
    return () => clearInterval(timer);
  }, [settings.refreshMs, refresh]);

  const live = (() => {
    if (!snapshot) return { token: "--text-muted", zh: "无数据", en: "no data", icon: "gauge" as LoIconName };
    const m = snapshot.metrics;
    if (m.actorsError > 0) return { token: "--error", zh: "有异常", en: "errors", icon: "triangle-alert" as LoIconName };
    if (m.actorsBlocked > 0) return { token: "--security-ask", zh: "待授权", en: "blocked", icon: "pause" as LoIconName };
    if (m.actorsWorking > 0) return { token: "--success", zh: "工作中", en: "working", icon: "cog" as LoIconName };
    return { token: "--text-muted", zh: "待命", en: "idle", icon: "coffee" as LoIconName };
  })();

  return (
    <div className="lo-task" data-lo-view="task-center">
      {/* 状态条（窄屏自动换行） */}
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
        <nav className="lo-task__rail" aria-label={zh ? "图书馆子视图" : "Library sub views"}>
          {SUB_NAV.map((n) => (
            <button
              key={n.id}
              className={`lo-nav__btn${tab === n.id ? " is-active" : ""}`}
              onClick={() => setTab(n.id)}
              title={zh ? n.zh : n.en}
              aria-pressed={tab === n.id}
            >
              <LoIcon name={n.icon} size={14} />
              <span className="lo-nav__label">{zh ? n.zh : n.en}</span>
            </button>
          ))}
        </nav>

        <main className="lo-task__content">
          {tab === "library" && <LibraryPanel snapshot={snapshot} zh={zh} />}
          {tab === "usage" && (
            <OverviewPanel
              snapshot={snapshot}
              series={series}
              zh={zh}
              onOpenLibrary={() => setTab("library")}
              onOpenTab={setTab}
            />
          )}
          {tab === "sessions" && <SessionsPanel snapshot={snapshot} zh={zh} />}
          {tab === "tools" && <ToolsPanel snapshot={snapshot} zh={zh} />}
          {tab === "cost" && <CostPanel snapshot={snapshot} series={series} zh={zh} />}
          {tab === "errors" && <ErrorsPanel snapshot={snapshot} zh={zh} />}
          {tab === "timeline" && <TimelinePanel snapshot={snapshot} zh={zh} />}
          {tab === "settings" && <SettingsPanel zh={zh} />}
        </main>

        {settings.showEventFeed && tab !== "timeline" && (
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

export default LibraryOpsTaskView;

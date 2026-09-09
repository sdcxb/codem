/**
 * LibraryOpsTaskView —— 图书馆视图（渲染在宿主「任务管理」面板的
 * `task-center.library` slot 里，**没有独立面板**）。
 *
 * 为什么这样合并：任务管理已经有「概览 / 委派 / 子智能体 / 自动化 / Issues /
 * 看板 / 团队 / 收件箱」8 个页签，图书馆原先那 9 个页签里
 * 「总览」≈任务管理概览、「团队」≈任务管理团队，属于重复入口；而
 * 「场景 + 花名册 + 用量/工具/成本/错误/会话/时间线」是任务管理缺的部分。
 * 于是把后者整体搬进任务管理的「图书馆」页签，删掉重复页签与独立面板。
 *
 * 布局（撑满 TaskCenter 内容区）：
 *   ┌ 状态条：实时状态 · 指标 · 时钟 · 刷新 ────────────────┐
 *   ├ 左侧子导航 │ 内容区（场景 / 用量 / 工具 / 成本 …） │ 事件流（可选）┤
 *   └──────────────────────────────────────────────┘
 *
 * 采样生命周期：本组件挂载时按 `settings.refreshMs` 采样，卸载（切到别的页签
 * 或关闭任务管理）立即停止 —— 宿主零后台开销。
 */

import { useEffect } from "react";
import type { MonitorTab } from "../types";
import { ACTIVITY_META } from "../types";
import { useLibraryOps } from "../store";
import { useLang } from "../../../core/i18n/lang";
import { formatClock } from "../core/format";
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
const SUB_NAV: Array<{ id: MonitorTab; zh: string; en: string; icon: string }> = [
  { id: "library", zh: "场景", en: "Scene", icon: "📚" },
  { id: "usage", zh: "用量", en: "Usage", icon: "📊" },
  { id: "sessions", zh: "会话", en: "Sessions", icon: "💬" },
  { id: "tools", zh: "工具", en: "Tools", icon: "🔧" },
  { id: "cost", zh: "成本", en: "Cost", icon: "💰" },
  { id: "errors", zh: "错误", en: "Errors", icon: "⚠️" },
  { id: "timeline", zh: "时间线", en: "Timeline", icon: "🕒" },
  { id: "settings", zh: "设置", en: "Settings", icon: "⚙️" },
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
    if (!snapshot) return { token: "--text-muted", zh: "无数据", en: "no data", icon: "○" };
    const m = snapshot.metrics;
    if (m.actorsError > 0) return { token: "--error", zh: "有异常", en: "errors", icon: "⚠️" };
    if (m.actorsBlocked > 0) return { token: "--security-ask", zh: "待授权", en: "blocked", icon: "⏸" };
    if (m.actorsWorking > 0) return { token: "--success", zh: "工作中", en: "working", icon: "⚡" };
    return { token: "--text-muted", zh: "待命", en: "idle", icon: "☕" };
  })();

  return (
    <div className="lo-task" data-lo-view="task-center">
      {/* 状态条 */}
      <header className="lo-task__bar">
        <span className="lo-task__live" style={{ ["--lo-live-token" as string]: `var(${live.token})` }}>
          <span className="lo-task__live-dot" />
          {live.icon} {zh ? live.zh : live.en}
        </span>
        {snapshot && (
          <span className="lo-task__meta">
            {ACTIVITY_META.working.icon} {snapshot.metrics.actorsWorking} · {ACTIVITY_META.idle.icon} {snapshot.metrics.actorsIdle} ·{" "}
            {zh ? "工具" : "tools"} {snapshot.metrics.toolCalls}
          </span>
        )}
        <span className="lo-task__clock">{formatClock(snapshot?.at ?? Date.now())}</span>
        <button
          className={`lo-icon-btn${sampling ? " is-busy" : ""}`}
          onClick={() => void refresh()}
          title={zh ? "立即刷新" : "Refresh now"}
          aria-label={zh ? "立即刷新" : "Refresh now"}
        >
          🔄
        </button>
      </header>

      {error && (
        <div className="lo-task__error">
          <Pill token="--error">⚠ {zh ? "采样失败" : "Sample failed"}</Pill>
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
              <span className="lo-nav__icon">{n.icon}</span>
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
            <div className="lo-task__feed-title">📡 {zh ? "实时事件" : "Live feed"}</div>
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

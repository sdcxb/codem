/**
 * LibraryOpsPanel —— 监控界面外壳（对标 lobster-pet `DetailPanel` 的
 * 「标题栏 + 卡片网格」布局，扩展为「标题栏 + 左侧导航 + 内容区 + 事件流」）。
 *
 * 通过 createPortal 挂到 document.body：梦幻皮肤的 `.sidebar` 有
 * backdrop-filter，会为 position:fixed 子元素创建包含块，必须 Portal 才能
 * 正确全屏（与宿主所有弹窗组件同一策略）。
 */

import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import type { MonitorTab } from "../types";
import { ACTIVITY_META } from "../types";
import { useLibraryOps } from "../store";
import { useLang } from "../../../core/i18n/lang";
import { formatClock } from "../core/format";
import { OverviewPanel } from "./monitor/OverviewPanel";
import { LibraryPanel } from "./monitor/LibraryPanel";
import { TeamsPanel } from "./monitor/TeamsPanel";
import { SessionsPanel } from "./monitor/SessionsPanel";
import { ToolsPanel } from "./monitor/ToolsPanel";
import { CostPanel } from "./monitor/CostPanel";
import { ErrorsPanel } from "./monitor/ErrorsPanel";
import { TimelinePanel } from "./monitor/TimelinePanel";
import { SettingsPanel } from "./monitor/SettingsPanel";
import { EventList } from "./monitor/OverviewPanel";
import { Pill } from "./monitor/common";
import "../styles/library-ops.css";

const NAV: Array<{ id: MonitorTab; zh: string; en: string; icon: string }> = [
  { id: "overview", zh: "总览", en: "Overview", icon: "📊" },
  { id: "library", zh: "图书馆", en: "Library", icon: "📚" },
  { id: "teams", zh: "团队", en: "Teams", icon: "👥" },
  { id: "sessions", zh: "会话", en: "Sessions", icon: "💬" },
  { id: "tools", zh: "工具", en: "Tools", icon: "🔧" },
  { id: "cost", zh: "成本", en: "Cost", icon: "💰" },
  { id: "errors", zh: "错误", en: "Errors", icon: "⚠️" },
  { id: "timeline", zh: "时间线", en: "Timeline", icon: "🕒" },
  { id: "settings", zh: "设置", en: "Settings", icon: "⚙️" },
];

export function LibraryOpsPanel() {
  const lang = useLang();
  const zh = lang === "zh";
  const open = useLibraryOps((s) => s.open);
  const tab = useLibraryOps((s) => s.tab);
  const setTab = useLibraryOps((s) => s.setTab);
  const close = useLibraryOps((s) => s.closePanel);
  const refresh = useLibraryOps((s) => s.refresh);
  const snapshot = useLibraryOps((s) => s.snapshot);
  const series = useLibraryOps((s) => s.series);
  const settings = useLibraryOps((s) => s.settings);
  const error = useLibraryOps((s) => s.error);
  const sampling = useLibraryOps((s) => s.sampling);

  // 打开时按设置间隔采样；关闭立即停止（插件关闭后宿主零开销）
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), settings.refreshMs);
    return () => clearInterval(timer);
  }, [open, settings.refreshMs, refresh]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const liveState = useMemo(() => {
    if (!snapshot) return { token: "--text-muted", zh: "无数据", en: "no data", icon: "○" };
    const m = snapshot.metrics;
    if (m.actorsError > 0) return { token: "--error", zh: "有异常", en: "errors", icon: "⚠️" };
    if (m.actorsBlocked > 0) return { token: "--security-ask", zh: "待授权", en: "blocked", icon: "⏸" };
    if (m.actorsWorking > 0) return { token: "--success", zh: "工作中", en: "working", icon: "⚡" };
    return { token: "--text-muted", zh: "待命", en: "idle", icon: "☕" };
  }, [snapshot]);

  if (!open) return null;

  const node = (
    <div className="lo-overlay" role="dialog" aria-modal="true" aria-label={zh ? "图书馆运营监控" : "Library Ops Monitor"}>
      <div className="lo-shell">
        {/* ===== 标题栏 ===== */}
        <header className="lo-shell__header">
          <span className="lo-shell__title">📚 {zh ? "图书馆运营监控" : "Library Ops Monitor"}</span>
          <span className="lo-shell__live" style={{ ["--lo-live-token" as string]: `var(${liveState.token})` }}>
            <span className="lo-shell__live-dot" />
            {liveState.icon} {zh ? liveState.zh : liveState.en}
          </span>
          {snapshot && (
            <span className="lo-shell__meta">
              {ACTIVITY_META.working.icon} {snapshot.metrics.actorsWorking} · {ACTIVITY_META.idle.icon} {snapshot.metrics.actorsIdle}
            </span>
          )}
          <span className="lo-shell__clock">{formatClock(snapshot?.at ?? Date.now())}</span>
          <div className="lo-shell__actions">
            <button
              className={`lo-icon-btn${sampling ? " is-busy" : ""}`}
              onClick={() => void refresh()}
              title={zh ? "立即刷新" : "Refresh now"}
              aria-label={zh ? "立即刷新" : "Refresh now"}
            >
              🔄
            </button>
            <button className="lo-icon-btn" onClick={close} title={zh ? "关闭（Esc）" : "Close (Esc)"} aria-label={zh ? "关闭" : "Close"}>
              ✕
            </button>
          </div>
        </header>

        {error && (
          <div className="lo-shell__error">
            <Pill token="--error">⚠ {zh ? "采样失败" : "Sample failed"}</Pill>
            <span>{error}</span>
          </div>
        )}

        {/* ===== 主体 ===== */}
        <div className="lo-shell__body">
          <nav className="lo-shell__nav" aria-label={zh ? "监控页签" : "Monitor tabs"}>
            {NAV.map((n) => (
              <button
                key={n.id}
                className={`lo-nav__btn${tab === n.id ? " is-active" : ""}`}
                onClick={() => setTab(n.id)}
                title={zh ? n.zh : n.en}
              >
                <span className="lo-nav__icon">{n.icon}</span>
                <span className="lo-nav__label">{zh ? n.zh : n.en}</span>
              </button>
            ))}
          </nav>

          <main className="lo-shell__content">
            {tab === "overview" && (
              <OverviewPanel snapshot={snapshot} series={series} zh={zh} onOpenLibrary={() => setTab("library")} onOpenTab={setTab} />
            )}
            {tab === "library" && <LibraryPanel snapshot={snapshot} zh={zh} />}
            {tab === "teams" && <TeamsPanel snapshot={snapshot} zh={zh} />}
            {tab === "sessions" && <SessionsPanel snapshot={snapshot} zh={zh} />}
            {tab === "tools" && <ToolsPanel snapshot={snapshot} zh={zh} />}
            {tab === "cost" && <CostPanel snapshot={snapshot} series={series} zh={zh} />}
            {tab === "errors" && <ErrorsPanel snapshot={snapshot} zh={zh} />}
            {tab === "timeline" && <TimelinePanel snapshot={snapshot} zh={zh} />}
            {tab === "settings" && <SettingsPanel zh={zh} />}
          </main>

          {settings.showEventFeed && tab !== "timeline" && (
            <aside className="lo-shell__feed">
              <div className="lo-shell__feed-title">📡 {zh ? "实时事件" : "Live feed"}</div>
              <div className="lo-shell__feed-body">
                {snapshot ? <EventList snapshot={snapshot} zh={zh} limit={40} /> : <div className="lo-empty">{zh ? "等待采样…" : "Waiting…"}</div>}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return node;
  return createPortal(node, document.body);
}

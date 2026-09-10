/**
 * LibraryOpsViewShell —— 两个宿主页签共用的外壳（状态条 + 左侧子导航 + 内容区 + 可选事件流）。
 *
 * v1.15.0 起插件在宿主里占两个页签：
 * - `task-center.board`（看板）：看板 / 用量 / 工具 / 错误 / 时间线
 * - `task-center.subagents`（子智能体）：场景 / 设置
 * 两者共享同一份采样快照、状态条与「谁在做什么」的可视化，只是视图集合不同。
 *
 * 采样生命周期：挂载即采样，卸载立即停止（宿主零后台开销）。
 */

import { useEffect, type ReactNode } from "react";
import type { LoIconName, MonitorTab } from "../types";
import { ACTIVITY_META } from "../types";
import { useLibraryOps } from "../store";
import { useLang } from "../../../core/i18n/lang";
import { formatClock } from "../core/format";
import { LoIcon } from "./icons";
import { EventList } from "./monitor/EventList";
import { Pill } from "./monitor/common";
// ★ 插件样式的唯一入口：所有插件视图（两个宿主页签 + 概览里的用量嵌入）都从这里挂载，
//   之前分散在各视图里，重写视图时漏掉 import 会导致整片样式丢失（v1.15.1 修复）。
import "../styles/library-ops.css";

/**
 * 采样调度：**全插件共享一个定时器**（引用计数）。
 *
 * 为什么不是每个挂载点各自 `setInterval`：概览页签里的「用量」嵌入与看板/子智能体页签
 * 可能同时挂载，各起一条 1.5s 轮询会让同一个 `collectSnapshot()`（扇出到 8 个宿主服务）
 * 被重复调度 —— store 的 `sampling` 守卫只防重入、不防重复调度。
 *
 * 挂载即采样一次；最后一个使用者卸载时清掉定时器。
 */
let samplingRefs = 0;
let samplingTimer: ReturnType<typeof setInterval> | null = null;

export function useLibraryOpsSampling(): void {
  const refresh = useLibraryOps((s) => s.refresh);
  const refreshMs = useLibraryOps((s) => s.settings.refreshMs);

  useEffect(() => {
    samplingRefs += 1;
    void refresh();
    if (!samplingTimer) {
      samplingTimer = setInterval(() => void useLibraryOps.getState().refresh(), refreshMs);
    }
    return () => {
      samplingRefs = Math.max(0, samplingRefs - 1);
      if (samplingRefs === 0 && samplingTimer) {
        clearInterval(samplingTimer);
        samplingTimer = null;
      }
    };
  }, [refreshMs, refresh]);
}

export interface ShellView {
  id: MonitorTab;
  zh: string;
  en: string;
  icon: LoIconName;
}

export interface LibraryOpsViewShellProps {
  /** 本宿主托管的视图（顺序即导航顺序） */
  views: readonly ShellView[];
  /** 当前视图 */
  active: MonitorTab;
  onSelect: (view: MonitorTab) => void;
  /** 内容区 */
  children: ReactNode;
  /** 是否允许渲染右侧「实时事件」事件流（由调用方决定当前视图是否显示） */
  showFeed: boolean;
  /** 状态条上的额外操作（事件流开关等） */
  actions?: ReactNode;
  /** 状态条上的额外计数（如子智能体数量） */
  extraMeta?: ReactNode;
  /** slot 归属标记（DOM 审计用） */
  dataView: string;
}

export function LibraryOpsViewShell({
  views,
  active,
  onSelect,
  children,
  showFeed,
  actions,
  extraMeta,
  dataView,
}: LibraryOpsViewShellProps) {
  const zh = useLang() === "zh";
  const refresh = useLibraryOps((s) => s.refresh);
  const snapshot = useLibraryOps((s) => s.snapshot);
  const settings = useLibraryOps((s) => s.settings);
  const error = useLibraryOps((s) => s.error);
  const sampling = useLibraryOps((s) => s.sampling);

  // 挂载即采样 + 按设置轮询；卸载立即停止
  useLibraryOpsSampling();

  const live = (() => {
    if (!snapshot) return { token: "--text-muted", zh: "无数据", en: "no data", icon: "gauge" as LoIconName };
    const m = snapshot.metrics;
    if (m.actorsError > 0) return { token: "--error", zh: "有异常", en: "errors", icon: "triangle-alert" as LoIconName };
    if (m.actorsBlocked > 0) return { token: "--security-ask", zh: "待授权", en: "blocked", icon: "pause" as LoIconName };
    if (m.actorsWorking > 0) return { token: "--success", zh: "工作中", en: "working", icon: "cog" as LoIconName };
    return { token: "--text-muted", zh: "待命", en: "idle", icon: "coffee" as LoIconName };
  })();

  return (
    <div className="lo-task" data-lo-view={dataView}>
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
            {extraMeta}
          </span>
        )}
        <span className="lo-task__clock">{formatClock(snapshot?.at ?? Date.now())}</span>
        {actions}
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
          {views.map((v) => (
            <button
              key={v.id}
              className={`lo-nav__btn${active === v.id ? " is-active" : ""}`}
              onClick={() => onSelect(v.id)}
              title={zh ? v.zh : v.en}
              aria-pressed={active === v.id}
            >
              <LoIcon name={v.icon} size={14} />
              <span className="lo-nav__label">{zh ? v.zh : v.en}</span>
            </button>
          ))}
        </nav>

        <main className="lo-task__content">{children}</main>

        {showFeed && (
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

export default LibraryOpsViewShell;

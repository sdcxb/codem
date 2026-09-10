/**
 * TimelinePanel —— 时间线页（对标 lobster-pet 的实时事件流 / `CronList`）。
 *
 * 全量事件按时间倒序展示，按严重度着色，支持按类别过滤；
 * 这是「运维视角」的一屏：谁在什么时候做了什么、哪里出错了。
 */

import { useMemo, useState } from "react";
import type { LibraryEvent, LibraryEventKind, LibrarySnapshot } from "../../types";
import { formatClock } from "../../core/format";
import { Card, Empty, Pill } from "./common";
import { eventKindLabel, eventKindToken } from "./labels";
const KINDS: LibraryEventKind[] = ["session", "team", "task", "tool", "agent", "error", "cost", "system"];

export interface TimelinePanelProps {
  snapshot: LibrarySnapshot | null;
  zh: boolean;
}

export function TimelinePanel({ snapshot, zh }: TimelinePanelProps) {
  const [filter, setFilter] = useState<LibraryEventKind | "all">("all");
  const events = useMemo(() => {
    if (!snapshot) return [];
    return filter === "all" ? snapshot.events : snapshot.events.filter((e) => e.kind === filter);
  }, [snapshot, filter]);

  if (!snapshot) return <Empty text={zh ? "等待采样…" : "Waiting…"} />;

  return (
    <Card
      title={zh ? `事件时间线 (${events.length})` : `Timeline (${events.length})`}
      icon="clock"
      scroll
      className="lo-card--timeline"
      actions={
        <div className="lo-filter">
          <button className={`lo-filter__btn${filter === "all" ? " is-active" : ""}`} onClick={() => setFilter("all")}>
            {zh ? "全部" : "All"}
          </button>
          {KINDS.map((k) => (
            <button
              key={k}
              className={`lo-filter__btn${filter === k ? " is-active" : ""}`}
              onClick={() => setFilter(k)}
            >
              {eventKindLabel(k, zh)}
            </button>
          ))}
        </div>
      }
    >
      {events.length === 0 ? (
        <EmptyDiag snapshot={snapshot} zh={zh} filtered={filter !== "all"} />
      ) : (
        <ul className="lo-timeline">
          {events.map((e) => (
            <TimelineRow key={e.id} event={e} zh={zh} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * 空态诊断 —— 时间线为空时，直接把「采样看到了什么」列出来，
 * 用户（和我们）一眼能判断是「真的没事件」还是「某个数据源没接上」。
 */
function EmptyDiag({ snapshot, zh, filtered }: { snapshot: LibrarySnapshot; zh: boolean; filtered: boolean }) {
  const m = snapshot.metrics;
  const s = snapshot.sources;
  const rows: Array<[string, string | number]> = [
    [zh ? "会话" : "Sessions", `${s.sessions}${zh ? "（活跃 " : " (active "}${s.activeSessions}${zh ? "）" : ")"}`],
    [zh ? "消息" : "Messages", m.messages],
    [zh ? "工具调用" : "Tool calls", m.toolCalls],
    [zh ? "子智能体" : "Sub-agents", s.subagents],
    [zh ? "运行时团队" : "Runtime teams", s.teams],
    [zh ? "遥测事件" : "Telemetry events", s.telemetryEvents],
  ];
  return (
    <div className="lo-empty lo-empty--diag">
      <p className="lo-empty__title">
        {filtered
          ? zh
            ? "该类别下暂无事件"
            : "No events in this category"
          : zh
            ? "这个窗口里暂时没有事件"
            : "No events in this window"}
      </p>
      <ul className="lo-diag">
        {rows.map(([k, v]) => (
          <li key={k}>
            <span>{k}</span>
            <b>{v}</b>
          </li>
        ))}
      </ul>
      {s.failed.length > 0 && (
        <p className="lo-note" style={{ color: "var(--error)" }}>
          {zh ? "采集失败的来源：" : "Failed sources: "}
          {s.failed.join(", ")}
        </p>
      )}
      <p className="lo-note">
        {zh
          ? "时间线的事件来自：对话消息（用户发言 / 助手回复）、工具调用、团队任务、子智能体活动、宿主遥测。"
          : "The timeline collects: chat messages, tool calls, team tasks, sub-agent activity and host telemetry."}
      </p>
    </div>
  );
}

function TimelineRow({ event, zh }: { event: LibraryEvent; zh: boolean }) {
  return (
    <li className="lo-timeline__item" data-severity={event.severity}>
      <span className="lo-timeline__rail" />
      <span className="lo-timeline__dot" />
      <span className="lo-timeline__time">{formatClock(event.at)}</span>
      <Pill token={eventKindToken(event.kind)}>{eventKindLabel(event.kind, zh)}</Pill>
      <span className="lo-timeline__text" title={event.text}>
        {event.text}
      </span>
      {event.value !== undefined && <span className="lo-timeline__value">{event.value}</span>}
    </li>
  );
}

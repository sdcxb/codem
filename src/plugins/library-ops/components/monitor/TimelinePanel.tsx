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
      icon="🕒"
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
        <Empty text={zh ? "暂无事件" : "No events"} />
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

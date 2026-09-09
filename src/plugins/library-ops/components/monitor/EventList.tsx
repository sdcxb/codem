/**
 * EventList —— 实时事件流列表（总览卡与右侧事件流共用）。
 */

import type { LibrarySnapshot } from "../../types";
import { Empty } from "./common";
import { eventKindLabel, hhmmOf } from "./labels";

export function EventList({ snapshot, zh, limit = 30 }: { snapshot: LibrarySnapshot; zh: boolean; limit?: number }) {
  const events = snapshot.events.slice(0, limit);
  if (events.length === 0) return <Empty text={zh ? "暂无事件" : "No events yet"} />;
  return (
    <ul className="lo-events">
      {events.map((e) => (
        <li key={e.id} className="lo-events__item" data-severity={e.severity}>
          <span className="lo-events__dot" />
          <span className="lo-events__kind">{eventKindLabel(e.kind, zh)}</span>
          <span className="lo-events__text" title={e.text}>
            {e.text}
          </span>
          <span className="lo-events__time">{hhmmOf(e.at)}</span>
        </li>
      ))}
    </ul>
  );
}

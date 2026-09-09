/**
 * SessionsPanel —— 会话页（对标 lobster-pet `TaskGrid`：最近会话卡片网格）。
 */

import type { LibrarySnapshot } from "../../types";
import { ACTIVITY_META, KIND_META } from "../../types";
import { formatAge, shortId } from "../../core/format";
import { useLibraryOps } from "../../store";
import { Card, Empty, Pill } from "./common";

export interface SessionsPanelProps {
  snapshot: LibrarySnapshot | null;
  zh: boolean;
}

export function SessionsPanel({ snapshot, zh }: SessionsPanelProps) {
  if (!snapshot) return <Empty text={zh ? "等待采样…" : "Waiting…"} />;
  const sessions = snapshot.actors.filter((a) => a.kind === "captain" || a.kind === "session");
  const selectActor = useLibraryOps((s) => s.selectActor);

  if (sessions.length === 0) return <Card title={zh ? "会话" : "Sessions"} icon="💬"><Empty text={zh ? "暂无会话" : "No sessions"} /></Card>;

  return (
    <div className="lo-sessions">
      {sessions.map((a) => {
        const meta = ACTIVITY_META[a.activity];
        return (
          <Card
            key={a.id}
            title={a.name}
            icon={KIND_META[a.kind].icon}
            className="lo-card--session"
            actions={<Pill token={meta.token}>{meta.icon} {zh ? meta.zh : meta.en}</Pill>}
          >
            <div className="lo-session">
              <div className="lo-session__row">
                <span className="lo-session__k">{zh ? "会话 ID" : "Session"}</span>
                <span className="lo-session__v" title={a.id}>
                  {shortId(a.id.replace(/^session:/, ""), 12)}
                </span>
              </div>
              <div className="lo-session__row">
                <span className="lo-session__k">{zh ? "岗位" : "Zone"}</span>
                <span className="lo-session__v">{a.roleLabel}</span>
              </div>
              <div className="lo-session__row">
                <span className="lo-session__k">{zh ? "模型" : "Model"}</span>
                <span className="lo-session__v">{a.model ?? "—"}</span>
              </div>
              <div className="lo-session__row">
                <span className="lo-session__k">{zh ? "最近活动" : "Last"}</span>
                <span className="lo-session__v">{formatAge(a.lastEventAt)}</span>
              </div>
              {a.focus && (
                <div className="lo-session__row">
                  <span className="lo-session__k">{zh ? "当前" : "Focus"}</span>
                  <span className="lo-session__v" title={a.focus}>
                    {a.focus}
                  </span>
                </div>
              )}
              <div className="lo-session__stats">
                <span>{zh ? "工具" : "tools"} {a.metrics.tools}</span>
                <span>{zh ? "错误" : "errors"} {a.metrics.errors}</span>
                {a.teamName && <span>{zh ? "团队" : "team"} {a.teamName}</span>}
              </div>
              <button className="lo-link-btn" onClick={() => selectActor(a.id)}>
                {zh ? "在场景中查看 →" : "Locate in scene →"}
              </button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * ErrorsPanel —— 异常 / 阻塞页。
 *
 * 汇总三类「需要人看」的信号：
 * 1. 工具失败（来自真实 toolCalls.status === "error"）
 * 2. 阻塞态角色（等待授权 / 等待用户）
 * 3. 团队任务失败 / 取消
 * 以及采集失败的宿主数据源（可见性优先）。
 */

import type { LibrarySnapshot } from "../../types";
import { ACTIVITY_META } from "../../types";
import { formatAge } from "../../core/format";
import { useLibraryOps } from "../../store";
import { Card, Empty, Pill, SectionTitle, StatCard } from "./common";
import { LoIcon } from "../icons";

export interface ErrorsPanelProps {
  snapshot: LibrarySnapshot | null;
  zh: boolean;
}

export function ErrorsPanel({ snapshot, zh }: ErrorsPanelProps) {
  const selectActor = useLibraryOps((s) => s.selectActor);
  if (!snapshot) return <Empty text={zh ? "等待采样…" : "Waiting…"} />;

  const errorEvents = snapshot.events.filter((e) => e.severity === "bad");
  const blocked = snapshot.actors.filter((a) => a.activity === "blocked");
  const errored = snapshot.actors.filter((a) => a.activity === "error");
  const failedTasks = snapshot.teams.flatMap((t) =>
    t.tasks
      .filter((x) => x.status === "failed" || x.status === "cancelled")
      .map((x) => ({ team: t.name, ...x })),
  );

  return (
    <div className="lo-errors">
      <div className="lo-kpi-grid">
        <StatCard label={zh ? "工具失败" : "Tool failures"} value={snapshot.metrics.toolErrors} token="--error" />
        <StatCard label={zh ? "阻塞角色" : "Blocked actors"} value={blocked.length} token="--security-ask" />
        <StatCard label={zh ? "出错角色" : "Errored actors"} value={errored.length} token="--error" />
        <StatCard label={zh ? "失败任务" : "Failed tasks"} value={failedTasks.length} token="--warning" />
        <StatCard label={zh ? "采集失败源" : "Failed sources"} value={snapshot.sources.failed.length} token="--text-muted" />
      </div>

      <div className="lo-errors__row">
        <Card title={zh ? "阻塞 / 出错角色" : "Blocked & errored"} icon="pause" scroll>
          {blocked.length + errored.length === 0 ? (
            <Empty text={zh ? "没有阻塞或出错的角色" : "All clear"} />
          ) : (
            <ul className="lo-alerts">
              {[...errored, ...blocked].map((a) => {
                const meta = ACTIVITY_META[a.activity];
                return (
                  <li key={a.id} className="lo-alerts__item" data-severity={meta.severity}>
                    <LoIcon name={meta.icon} size={13} className="lo-alerts__icon" />
                    <span className="lo-alerts__name" title={a.name}>
                      {a.name}
                    </span>
                    <span className="lo-alerts__role" title={a.roleLabel}>
                      {a.roleLabel}
                    </span>
                    <Pill token={meta.token}>{zh ? meta.zh : meta.en}</Pill>
                    <span className="lo-alerts__age">{formatAge(a.lastEventAt)}</span>
                    <button className="lo-link-btn" onClick={() => selectActor(a.id)}>
                      {zh ? "定位" : "Locate"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title={zh ? "失败任务" : "Failed tasks"} icon="circle-x" scroll>
          {failedTasks.length === 0 ? (
            <Empty text={zh ? "没有失败任务" : "No failed tasks"} />
          ) : (
            <ul className="lo-alerts">
              {failedTasks.map((t) => (
                <li key={`${t.team}-${t.id}`} className="lo-alerts__item" data-severity="bad">
                  <LoIcon name="circle-x" size={13} className="lo-alerts__icon" />
                  <span className="lo-alerts__name">{t.id}</span>
                  <span className="lo-alerts__role" title={t.subject}>
                    {t.subject}
                  </span>
                  <Pill token="--error">{zh ? "失败" : "failed"}</Pill>
                  <span className="lo-alerts__age">{t.team}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={zh ? "错误事件" : "Error events"} icon="triangle-alert" scroll>
        {errorEvents.length === 0 ? (
          <Empty text={zh ? "暂无错误事件" : "No error events"} />
        ) : (
          <ul className="lo-stream">
            {errorEvents.slice(0, 60).map((e) => (
              <li key={e.id} className="lo-stream__item" data-severity="bad">
                <span className="lo-stream__time">{clock(e.at)}</span>
                <span className="lo-stream__text" title={e.text}>
                  {e.text}
                </span>
                <Pill token="--error">{e.kind}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={zh ? "数据源健康" : "Source health"} icon="plug">
        <SectionTitle hint={zh ? "失败来源会在这里显式列出（不静默）" : "Failures are listed explicitly"}>
          {zh ? "采集来源" : "Sources"}
        </SectionTitle>
        {snapshot.sources.failed.length === 0 ? (
          <Empty text={zh ? "全部来源正常" : "All sources healthy"} />
        ) : (
          <ul className="lo-alerts">
            {snapshot.sources.failed.map((s) => (
              <li key={s} className="lo-alerts__item" data-severity="wait">
                <LoIcon name="plug" size={13} className="lo-alerts__icon" />
                <span className="lo-alerts__name">{s}</span>
                <Pill token="--warning">{zh ? "采集失败" : "failed"}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

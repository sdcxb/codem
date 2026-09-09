/**
 * OverviewPanel —— 运营总览（对标 lobster-pet `DetailPanel` 第一行：
 * StatusCard + TaskGrid + ActivityViz 的三卡布局，并补充团队/成本/健康度）。
 */

import type { LibrarySnapshot } from "../../types";
import { LIBRARY_MAP } from "../../data/library-map";
import { formatCost, formatPercent, formatTokens } from "../../core/format";
import { Card, Empty, Field, Pill, SectionTitle, StatCard } from "./common";
import { DonutChart, Heatmap, HourBars, ProgressRing } from "./charts";
import { eventKindLabel, hhmmOf } from "./labels";

export interface OverviewPanelProps {
  snapshot: LibrarySnapshot | null;
  series: {
    tokens: Array<{ at: number; value: number }>;
    cost: Array<{ at: number; value: number }>;
    tools: Array<{ at: number; value: number }>;
    actors: Array<{ at: number; value: number }>;
    tasks: Array<{ at: number; value: number }>;
    health: Array<{ at: number; value: number }>;
  };
  zh: boolean;
  onOpenLibrary: () => void;
  onOpenTab: (tab: "teams" | "sessions" | "tools" | "cost" | "errors") => void;
}

export function OverviewPanel({ snapshot, series, zh, onOpenLibrary, onOpenTab }: OverviewPanelProps) {
  if (!snapshot) return <Empty text={zh ? "等待第一次采样…" : "Waiting for first sample…"} />;
  const m = snapshot.metrics;
  const days = Object.keys(snapshot.activity.perDay).sort();
  const dayValues = days.map((d) => snapshot.activity.perDay[d]);
  const todayKey = days[days.length - 1];
  const todayIdx = days.length - 1;
  const nowHour = new Date().getHours();
  const donut = [
    { label: zh ? "主控会话" : "Main", value: snapshot.activity.kinds.chat ?? 0, token: "--accent" },
    { label: zh ? "队长会话" : "Captain", value: snapshot.activity.kinds.captain ?? 0, token: "--success" },
    { label: zh ? "分支会话" : "Worktree", value: snapshot.activity.kinds.worktree ?? 0, token: "--info" },
  ];
  const completion = m.tasksTotal > 0 ? m.tasksDone / m.tasksTotal : 0;

  return (
    <div className="lo-overview">
      <div className="lo-kpi-grid">
        <StatCard
          label={zh ? "活动会话" : "Active sessions"}
          value={m.activeSessions}
          unit={`/ ${m.sessions}`}
          token="--accent"
          points={series.actors}
          hint={zh ? "正在跑 agent loop 的会话" : "sessions running a loop"}
        />
        <StatCard
          label={zh ? "在馆角色" : "Actors in library"}
          value={m.actors}
          token="--info"
          points={series.actors}
          hint={`${m.actorsWorking} ${zh ? "工作" : "working"} · ${m.actorsIdle} ${zh ? "待命" : "idle"}`}
        />
        <StatCard
          label={zh ? "团队 / 任务" : "Teams / Tasks"}
          value={`${m.teams}`}
          unit={`/ ${m.tasksTotal}`}
          token="--success"
          points={series.tasks}
          hint={`${m.tasksDone} ${zh ? "完成" : "done"} · ${m.tasksRunning} ${zh ? "执行中" : "running"}`}
        />
        <StatCard
          label={zh ? "Token 用量" : "Tokens"}
          value={formatTokens(m.tokensIn + m.tokensOut)}
          token="--warning"
          points={series.tokens}
          hint={`↑${formatTokens(m.tokensIn)} ↓${formatTokens(m.tokensOut)}`}
        />
        <StatCard
          label={zh ? "成本" : "Cost"}
          value={formatCost(m.costTotal)}
          token="--security-full"
          points={series.cost}
          hint={`${zh ? "今日" : "today"} ${formatCost(m.costToday)}`}
        />
        <StatCard
          label={zh ? "工具调用" : "Tool calls"}
          value={m.toolCalls}
          token="--accent-hover"
          points={series.tools}
          hint={`${m.toolErrors} ${zh ? "出错" : "errors"}`}
        />
      </div>

      <div className="lo-overview__row">
        <Card
          title={zh ? "运营健康度" : "Operational health"}
          icon="🩺"
          className="lo-card--health"
        >
          <div className="lo-health">
            <ProgressRing ratio={m.health} size={78} token={m.health > 0.75 ? "--success" : m.health > 0.45 ? "--warning" : "--error"} label={zh ? "健康" : "health"} />
            <div className="lo-health__fields">
              <Field label={zh ? "任务完成率" : "Task completion"}>{formatPercent(completion)}</Field>
              <Field label={zh ? "工具错误率" : "Tool error rate"}>
                {formatPercent(m.toolCalls > 0 ? m.toolErrors / m.toolCalls : 0, 1)}
              </Field>
              <Field label={zh ? "产出文件" : "Files touched"}>{m.filesTouched}</Field>
              <Field label={zh ? "消息总数" : "Messages"}>{m.messages}</Field>
            </div>
          </div>
        </Card>

        <Card
          title={zh ? "图书馆实况" : "Library live"}
          icon="📚"
          actions={
            <button className="lo-link-btn" onClick={onOpenLibrary}>
              {zh ? "进入场景 →" : "Open scene →"}
            </button>
          }
          className="lo-card--mini-scene"
        >
          <MiniScenePreview snapshot={snapshot} zh={zh} />
        </Card>

        <Card title={zh ? "活动概览" : "Activity"} icon="📊" className="lo-card--activity">
          <SectionTitle hint={`${zh ? "今天" : "today"} ${snapshot.activity.perDay[todayKey] ?? 0}`}>
            {zh ? "过去 14 天活跃" : "Last 14 days"}
          </SectionTitle>
          <Heatmap values={dayValues} titles={days} highlightIndex={todayIdx} token="--accent" columns={7} />
          <SectionTitle>{zh ? "会话类型" : "Session kinds"}</SectionTitle>
          <DonutChart slices={donut} size={86} />
          <SectionTitle>{zh ? "今日活跃时段" : "Hourly today"}</SectionTitle>
          <HourBars values={snapshot.activity.perHour} token="--info" highlightIndex={nowHour} />
        </Card>
      </div>

      <div className="lo-overview__row lo-overview__row--bottom">
        <Card title={zh ? "数据源" : "Data sources"} icon="🔌">
          <div className="lo-fields">
            <Field label={zh ? "会话" : "Sessions"}>{snapshot.sources.sessions}</Field>
            <Field label={zh ? "活跃会话" : "Active"}>{snapshot.sources.activeSessions}</Field>
            <Field label={zh ? "运行时团队" : "Runtime teams"}>{snapshot.sources.teams}</Field>
            <Field label={zh ? "团队成员" : "Members"}>{snapshot.sources.teamMembers}</Field>
            <Field label={zh ? "子智能体" : "Subagents"}>{snapshot.sources.subagents}</Field>
            <Field label={zh ? "团队模板" : "Templates"}>{snapshot.sources.teamTemplates}</Field>
            <Field label={zh ? "智能体定义" : "Agent profiles"}>{snapshot.sources.agentProfiles}</Field>
            <Field label={zh ? "遥测事件" : "Telemetry events"}>{snapshot.sources.telemetryEvents}</Field>
            <Field label={zh ? "采样耗时" : "Sample time"}>{snapshot.sampleMs}ms</Field>
          </div>
          {snapshot.sources.failed.length > 0 && (
            <div className="lo-warn">
              <Pill token="--warning">⚠ {zh ? "采集失败" : "Failed"}</Pill>
              <span>{snapshot.sources.failed.join(", ")}</span>
            </div>
          )}
        </Card>

        <Card
          title={zh ? "最近事件" : "Recent events"}
          icon="📡"
          scroll
          actions={
            <button className="lo-link-btn" onClick={() => onOpenTab("errors")}>
              {zh ? "全部 →" : "All →"}
            </button>
          }
        >
          <EventList snapshot={snapshot} zh={zh} limit={10} />
        </Card>
      </div>
    </div>
  );
}

/** 总览里的小场景缩略：按区域统计角色数，直观展示「团队分布」 */
function MiniScenePreview({ snapshot, zh }: { snapshot: LibrarySnapshot; zh: boolean }) {
  const counts = new Map<string, number>();
  for (const a of snapshot.actors) {
    counts.set(a.preferredZoneId, (counts.get(a.preferredZoneId) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <Empty />;
  return (
    <div className="lo-mini-scene">
      {rows.map(([zoneId, count]) => {
        const zone = snapshot.actors.length > 0 ? zoneOf(zoneId) : null;
        return (
          <div key={zoneId} className="lo-mini-scene__row">
            <span className="lo-mini-scene__icon">{zone?.icon ?? "•"}</span>
            <span className="lo-mini-scene__name">{zone ? (zh ? zone.name : zone.nameEn) : zoneId}</span>
            <span className="lo-mini-scene__bar">
              {Array.from({ length: Math.min(count, 8) }, (_, i) => (
                <span key={i} className="lo-mini-scene__dot" style={{ background: `var(${zone?.token ?? "--accent"})` }} />
              ))}
            </span>
            <span className="lo-mini-scene__count">{count}</span>
          </div>
        );
      })}
    </div>
  );
}

// 区域元数据来自地图数据层（同层引用，无循环依赖）
function zoneOf(id: string) {
  return LIBRARY_MAP.zones.find((z) => z.id === id);
}

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

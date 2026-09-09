/**
 * OverviewPanel —— 运营总览（**布局对标 lobster-pet 的 DetailPanel**）。
 *
 * lobster-pet 的监控界面是「单屏卡片网格」：
 *   行 1：状态卡(240px) | 最近会话(1fr) | 活动概览(1.5fr)
 *   行 2：左栈（智能体卡 + 定时任务卡，750px）+ 备忘卡 | **场景大卡(1fr)**
 *
 * 本面板照此布局，把「迷你办公室」换成**我们的图书馆场景**——
 * 这就是「把图书馆作为 lobster-pet 监控界面内的场景」的落地形态：
 * 场景与其它监控卡同屏、共享同一份快照。
 */

import { useMemo } from "react";
import type { LibrarySnapshot } from "../../types";
import { ACTIVITY_META, KIND_META } from "../../types";
import { formatCost, formatAge, formatPercent, formatTokens } from "../../core/format";
import { useLibraryOps, sortedActors } from "../../store";
import { Card, Empty, Field, Pill, SectionTitle, StatCard } from "./common";
import { DonutChart, Heatmap, HourBars, ProgressRing } from "./charts";
import { eventKindLabel, hhmmOf } from "./labels";
import { PixelLibraryScene } from "../library/PixelLibraryScene";
import { LibraryScene } from "../library/LibraryScene";
import type { PixelSceneState } from "../../core/pixel-scene";
import type { SceneState } from "../../types";

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
  const settings = useLibraryOps((s) => s.settings);
  const selectActor = useLibraryOps((s) => s.selectActor);
  const initialPixelScene = useMemo(() => useLibraryOps.getState().pixelScene, []);
  const initialIsoScene = useMemo(() => useLibraryOps.getState().isoScene, []);

  if (!snapshot) return <Empty text={zh ? "等待第一次采样…" : "Waiting for first sample…"} />;
  const m = snapshot.metrics;
  const days = Object.keys(snapshot.activity.perDay).sort();
  const dayValues = days.map((d) => snapshot.activity.perDay[d]);
  const todayIdx = days.length - 1;
  const nowHour = new Date().getHours();
  const completion = m.tasksTotal > 0 ? m.tasksDone / m.tasksTotal : 0;
  const actors = sortedActors(snapshot);
  const sessions = actors.filter((a) => a.kind === "captain" || a.kind === "session").slice(0, 6);

  return (
    <div className="lo-grid lo-grid--lp">
      {/* ===== 行 1 ===== */}
      <div className="lo-grid__row lo-grid__row--top">
        {/* 状态卡 */}
        <Card className="lo-card--status" icon={ACTIVITY_META[topActivity(snapshot)].icon} title={zh ? "运行状态" : "Status"}>
          <div className="lo-status">
            <span
              className="lo-status__dot"
              style={{ background: `var(${ACTIVITY_META[topActivity(snapshot)].token})` }}
            />
            <span className="lo-status__text" style={{ color: `var(${ACTIVITY_META[topActivity(snapshot)].token})` }}>
              {zh ? ACTIVITY_META[topActivity(snapshot)].zh : ACTIVITY_META[topActivity(snapshot)].en}
            </span>
          </div>
          <div className="lo-status__desc">
            {zh
              ? `${m.actorsWorking} 个角色在岗工作 · ${m.actorsIdle} 个待命`
              : `${m.actorsWorking} working · ${m.actorsIdle} idle`}
          </div>
          <div className="lo-status__section">
            <div className="lo-status__label">
              {zh ? "活跃会话" : "Active sessions"} ({m.activeSessions})
            </div>
            <div className="lo-status__list">
              {sessions.slice(0, 4).map((a) => (
                <div key={a.id} className="lo-status__item" onClick={() => selectActor(a.id)}>
                  <span className="lo-status__item-name" title={a.name}>
                    {KIND_META[a.kind].icon} {a.name}
                  </span>
                  <span className="lo-status__item-type">{zh ? ACTIVITY_META[a.activity].zh : ACTIVITY_META[a.activity].en}</span>
                </div>
              ))}
              {sessions.length === 0 && <span className="lo-empty">{zh ? "暂无会话" : "No sessions"}</span>}
            </div>
          </div>
          <div className="lo-status__usage">
            <span className="lo-status__tokens">{formatTokens(m.tokensIn + m.tokensOut)}</span>
            <span className="lo-status__unit">tokens</span>
            <span className="lo-status__cost">💰 {formatCost(m.costTotal)}</span>
          </div>
        </Card>

        {/* 最近会话（对标 TaskGrid） */}
        <Card
          title={zh ? "最近会话" : "Recent sessions"}
          icon="💬"
          actions={<span className="lo-card__count">{m.sessions}</span>}
          className="lo-card--sessions"
        >
          {sessions.length === 0 ? (
            <Empty text={zh ? "暂无会话记录" : "No sessions"} />
          ) : (
            <div className="lo-session-cards">
              {sessions.map((a) => (
                <button key={a.id} className="lo-session-card" onClick={() => selectActor(a.id)} title={a.roleLabel}>
                  <span className="lo-session-card__top">
                    <span className="lo-session-card__icon">{KIND_META[a.kind].icon}</span>
                    <span className="lo-session-card__name">{a.name}</span>
                    {a.activity !== "idle" && a.activity !== "sleeping" && <span className="lo-session-card__live">●</span>}
                  </span>
                  <span className="lo-session-card__bottom">
                    <span className="lo-session-card__age">{formatAge(a.lastEventAt)}</span>
                    <span className="lo-session-card__tools">{a.metrics.tools}t</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* 活动概览（对标 ActivityViz） */}
        <Card title={zh ? "活动概览" : "Activity"} icon="📊" className="lo-card--activity">
          <div className="lo-av">
            <div className="lo-av__col">
              <SectionTitle hint={`${zh ? "今天" : "today"} ${dayValues[todayIdx] ?? 0}`}>
                {zh ? "过去 14 天" : "Last 14 days"}
              </SectionTitle>
              <Heatmap values={dayValues} titles={days} highlightIndex={todayIdx} token="--accent" columns={7} />
            </div>
            <div className="lo-av__col">
              <SectionTitle>{zh ? "会话类型" : "Kinds"}</SectionTitle>
              <DonutChart
                size={80}
                slices={[
                  { label: zh ? "主控" : "Main", value: snapshot.activity.kinds.chat ?? 0, token: "--accent" },
                  { label: zh ? "队长" : "Captain", value: snapshot.activity.kinds.captain ?? 0, token: "--success" },
                  { label: zh ? "分支" : "Worktree", value: snapshot.activity.kinds.worktree ?? 0, token: "--info" },
                ]}
              />
            </div>
          </div>
          <SectionTitle>{zh ? "今日活跃时段" : "Hourly today"}</SectionTitle>
          <HourBars values={snapshot.activity.perHour} token="--info" highlightIndex={nowHour} />
        </Card>
      </div>

      {/* ===== 行 2 ===== */}
      <div className="lo-grid__row lo-grid__row--mid">
        {/* 左栈 */}
        <div className="lo-stack">
          <div className="lo-stack__row">
            {/* 团队卡（对标 GatewayAgentsCard） */}
            <Card
              title={zh ? "团队" : "Teams"}
              icon="👥"
              scroll
              actions={
                <button className="lo-link-btn" onClick={() => onOpenTab("teams")}>
                  {zh ? "全部 →" : "All →"}
                </button>
              }
            >
              {snapshot.teams.filter((t) => !t.archived).length === 0 ? (
                <Empty text={zh ? "暂无活动团队" : "No active team"} />
              ) : (
                snapshot.teams
                  .filter((t) => !t.archived)
                  .map((t) => (
                    <div key={t.id} className="lo-team-mini">
                      <div className="lo-team-mini__head">
                        <span className="lo-team-mini__name">{t.name}</span>
                        <Pill token={t.completion >= 1 ? "--success" : "--warning"}>{formatPercent(t.completion)}</Pill>
                      </div>
                      <ul className="lo-team-mini__members">
                        {t.members.slice(0, 6).map((mem) => (
                          <li key={mem.id}>
                            <span className="lo-members__dot" style={{ background: `var(${memberToken(mem.status)})` }} />
                            <span className="lo-team-mini__mname" title={mem.name}>
                              {mem.name}
                            </span>
                            <span className="lo-team-mini__mtasks">
                              {mem.done}/{mem.tasks}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
              )}
            </Card>

            {/* 工具/任务卡（对标 CronList） */}
            <Card
              title={zh ? "任务与工具" : "Tasks & tools"}
              icon="🔧"
              scroll
              actions={
                <button className="lo-link-btn" onClick={() => onOpenTab("tools")}>
                  {zh ? "全部 →" : "All →"}
                </button>
              }
            >
              <div className="lo-fields">
                <Field label={zh ? "任务总数" : "Tasks"}>{m.tasksTotal}</Field>
                <Field label={zh ? "完成" : "Done"}>{m.tasksDone}</Field>
                <Field label={zh ? "执行中" : "Running"}>{m.tasksRunning}</Field>
                <Field label={zh ? "待领取" : "Pending"}>{m.tasksPending}</Field>
                <Field label={zh ? "失败" : "Failed"}>
                  <span style={{ color: m.tasksFailed > 0 ? "var(--error)" : undefined }}>{m.tasksFailed}</span>
                </Field>
                <Field label={zh ? "工具调用" : "Tool calls"}>{m.toolCalls}</Field>
                <Field label={zh ? "工具失败" : "Tool errors"}>
                  <span style={{ color: m.toolErrors > 0 ? "var(--error)" : undefined }}>{m.toolErrors}</span>
                </Field>
                <Field label={zh ? "产出文件" : "Files"}>{m.filesTouched}</Field>
              </div>
              <SectionTitle hint={`${snapshot.events.length}`}>{zh ? "最近事件" : "Recent events"}</SectionTitle>
              <ul className="lo-events">
                {snapshot.events.slice(0, 8).map((e) => (
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
            </Card>
          </div>

          {/* 数据源 / 健康度（对标 MemoCard） */}
          <Card title={zh ? "数据源与健康度" : "Sources & health"} icon="🩺" className="lo-card--memo">
            <div className="lo-health lo-health--row">
              <ProgressRing ratio={m.health} size={62} token={m.health > 0.75 ? "--success" : m.health > 0.45 ? "--warning" : "--error"} label={zh ? "健康" : "health"} />
              <div className="lo-fields">
                <Field label={zh ? "任务完成率" : "Completion"}>{formatPercent(completion)}</Field>
                <Field label={zh ? "工具错误率" : "Tool error rate"}>{formatPercent(m.toolCalls > 0 ? m.toolErrors / m.toolCalls : 0, 1)}</Field>
                <Field label={zh ? "运行时团队" : "Teams"}>{snapshot.sources.teams}</Field>
                <Field label={zh ? "团队成员" : "Members"}>{snapshot.sources.teamMembers}</Field>
                <Field label={zh ? "子智能体" : "Subagents"}>{snapshot.sources.subagents}</Field>
                <Field label={zh ? "采样耗时" : "Sample time"}>{snapshot.sampleMs}ms</Field>
              </div>
            </div>
            {snapshot.sources.failed.length > 0 && (
              <div className="lo-warn">
                <Pill token="--warning">⚠ {zh ? "采集失败" : "Failed"}</Pill>
                <span>{snapshot.sources.failed.join(", ")}</span>
              </div>
            )}
          </Card>
        </div>

        {/* 场景大卡（对标 MiniOffice，但换成我们的图书馆） */}
        <Card
          title={zh ? "图书馆实况" : "Library live"}
          icon="📚"
          className="lo-card--scene"
          actions={
            <span className="lo-card__actions-row">
              <Pill token="--accent">
                {m.actorsWorking} {zh ? "工作中" : "working"}
              </Pill>
              <button className="lo-link-btn" onClick={onOpenLibrary}>
                {zh ? "全屏 →" : "Full →"}
              </button>
            </span>
          }
        >
          <div className="lo-scene-host">
            {settings.sceneStyle === "pixel" ? (
              <PixelLibraryScene
                snapshot={snapshot}
                initialScene={(initialPixelScene as PixelSceneState | null) ?? undefined}
                showZoneLabels={settings.showZoneLabels}
                showNameplates={settings.showNameplates}
                showBubbles={settings.showBubbles}
                speed={settings.speed}
                maxActors={settings.maxActors}
                onSelectActor={selectActor}
              />
            ) : (
              <LibraryScene
                snapshot={snapshot}
                initialScene={(initialIsoScene as SceneState | null) ?? undefined}
                showZoneLabels={settings.showZoneLabels}
                showNameplates={settings.showNameplates}
                showBubbles={settings.showBubbles}
                speed={settings.speed}
                maxActors={settings.maxActors}
                onSelectActor={selectActor}
              />
            )}
          </div>
        </Card>
      </div>

      {/* ===== 行 3：KPI 细项 ===== */}
      <div className="lo-kpi-grid lo-kpi-grid--compact">
        <StatCard label={zh ? "活动会话" : "Active sessions"} value={m.activeSessions} unit={`/ ${m.sessions}`} token="--accent" points={series.actors} />
        <StatCard label={zh ? "在馆角色" : "Actors"} value={m.actors} token="--info" points={series.actors} />
        <StatCard label={zh ? "团队 / 任务" : "Teams / Tasks"} value={`${m.teams}`} unit={`/ ${m.tasksTotal}`} token="--success" points={series.tasks} />
        <StatCard label={zh ? "Token" : "Tokens"} value={formatTokens(m.tokensIn + m.tokensOut)} token="--warning" points={series.tokens} />
        <StatCard label={zh ? "成本" : "Cost"} value={formatCost(m.costTotal)} token="--security-full" points={series.cost} />
        <StatCard label={zh ? "工具调用" : "Tool calls"} value={m.toolCalls} token="--accent-hover" points={series.tools} />
      </div>
    </div>
  );
}

/** 快照里最「值得注意」的状态（异常 > 等待 > 工作 > 待命） */
function topActivity(snapshot: LibrarySnapshot) {
  const m = snapshot.metrics;
  if (m.actorsError > 0) return "error" as const;
  if (m.actorsBlocked > 0) return "blocked" as const;
  if (m.actorsWorking > 0) return "working" as const;
  return "idle" as const;
}

function memberToken(status: string): string {
  switch (status) {
    case "working":
      return "--warning";
    case "idle":
      return "--success";
    default:
      return "--text-muted";
  }
}

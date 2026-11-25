/**
 * OverviewPanel —— 运营总览。
 *
 * 概览只留两块核心：**当前工作**（状态行 + 最多 4 个会话）与一张更宽的**活动概览**；
 * 场景画布只在「子智能体」页签渲染（这里保留一个「场景 →」入口，不再塞第二块画布）。
 * 14 天没有任何活动时，活动概览退化成一行空状态 + 时间线入口，不摆空图表。
 */

import type { LibrarySnapshot, MonitorTab } from "../../types";
import { ACTIVITY_META, KIND_META } from "../../types";
import { formatCost, formatAge, formatPercent, formatTokens } from "../../core/format";
import { useLibraryOps, sortedActors } from "../../store";
// R7：当前小时（热力图高亮）走唯一本地口径
import { localTimeParts } from "../../../../core/time/local-time";
import { Card, Empty, Field, Pill, SectionTitle, StatCard } from "./common";
import { DonutChart, Heatmap, HourBars, ProgressRing } from "./charts";
import { EventList } from "./EventList";
import { LoIcon } from "../icons";

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
  onOpenTab: (tab: MonitorTab) => void;
}

/** 跳转到任务管理的其它页签（团队/委派/子智能体等已并入任务管理） */
function openTaskCenterTab(tab: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("codem:open-task-center", { detail: { tab } }));
}

export function OverviewPanel({ snapshot, series, zh, onOpenLibrary, onOpenTab }: OverviewPanelProps) {
  const selectActor = useLibraryOps((s) => s.selectActor);
  /**
   * 会话点击仍然要**先把场景调出来**再选中角色 —— 场景画布现在只渲染在
   * 「子智能体」页签，少了这一步用户会"选中了但看不见"。这就是概览页
   * `requestView("scene")` 入口必须保留的原因（不是场景卡的残留）。
   */
  const requestView = useLibraryOps((s) => s.requestView);

  if (!snapshot) return <Empty text={zh ? "等待第一次采样…" : "Waiting for first sample…"} />;
  const m = snapshot.metrics;
  const days = Object.keys(snapshot.activity.perDay).sort();
  const dayValues = days.map((d) => snapshot.activity.perDay[d]);
  const todayIdx = days.length - 1;
  const nowHour = localTimeParts(new Date()).hour;
  const completion = m.tasksTotal > 0 ? m.tasksDone / m.tasksTotal : 0;
  const actors = sortedActors(snapshot);
  // 「当前工作」最多列 4 个会话；更长的历史在「看板 → 时间线」
  const sessions = actors.filter((a) => a.kind === "captain" || a.kind === "session").slice(0, 4);
  // 14 天全 0 ⇒ 不摆空热力图/圆环/小时柱，退化成一行空状态（快照没有 perDay 也算没有活动）
  const hasActivity = dayValues.some((v) => v > 0);
  const top = topActivity(snapshot);
  const topMeta = ACTIVITY_META[top];

  /**
   * 「有没有可计算的团队/任务数据」。
   *
   * 团队任务与工具调用都没有时，`完成率 0%` / `错误率 0.0%` / 健康环（无任务时按中性值算）
   * 是一个纯模板：三个仪表都没有样本，却排成一行 0% —— 本轮不再渲染它们，
   * 只留一句说明 + 真实的数据源计数（`sources.*` 的口径一个字不改）。
   */
  const liveTeams = snapshot.teams.filter((t) => !t.archived);
  const hasTeams = liveTeams.length > 0;
  const hasTaskData = m.tasksTotal > 0 || m.toolCalls > 0 || m.filesTouched > 0;

  return (
    <div className="lo-grid lo-grid--lp">
      {/* ===== 当前工作 + 活动概览 ===== */}
      <div className="lo-overview-top">
        {/* 当前工作：状态行 + 最多 4 个会话（原「运行状态」「最近会话」两张等高卡合并） */}
        <Card
          title={zh ? "当前工作" : "Current work"}
          icon={topMeta.icon}
          className="lo-overview-current"
          actions={
            <span className="lo-card__actions-row">
              <span className="lo-card__count" title={zh ? "会话总数" : "Total sessions"}>
                {m.sessions}
              </span>
              <button className="lo-link-btn" onClick={onOpenLibrary}>
                {zh ? "场景 →" : "Scene →"}
              </button>
            </span>
          }
        >
          <div className="lo-status">
            <span className="lo-status__dot" style={{ background: `var(${topMeta.token})` }} />
            <span className="lo-status__text" style={{ color: `var(${topMeta.token})` }}>
              {zh ? topMeta.zh : topMeta.en}
            </span>
          </div>
          <div className="lo-status__desc">
            {zh
              ? `${m.actorsWorking} 个角色在岗工作 · ${m.actorsIdle} 个待命`
              : `${m.actorsWorking} working · ${m.actorsIdle} idle`}
          </div>
          <div className="lo-status__section">
            <div className="lo-status__label">
              {zh ? "最近会话" : "Recent sessions"} ({m.activeSessions} {zh ? "活跃" : "active"} / {m.sessions})
            </div>
            <div className="lo-status__list">
              {sessions.map((a) => (
                // 场景画布在「子智能体」页签：点击角色要先把场景调出来，否则选中了也看不见
                <div
                  key={a.id}
                  className="lo-status__item"
                  onClick={() => {
                    selectActor(a.id);
                    requestView("scene");
                  }}
                  title={a.roleLabel}
                >
                  <span className="lo-status__item-name" title={a.name}>
                    <LoIcon name={KIND_META[a.kind].icon} size={12} /> {a.name}
                  </span>
                  <span className="lo-status__item-type">
                    {zh ? ACTIVITY_META[a.activity].zh : ACTIVITY_META[a.activity].en} · {formatAge(a.lastEventAt)}
                  </span>
                </div>
              ))}
              {sessions.length === 0 && <span className="lo-empty">{zh ? "暂无会话" : "No sessions"}</span>}
            </div>
          </div>
        </Card>

        {/* 活动概览：有数据才画三张图；空数据只给一行说明 + 时间线入口 */}
        <Card
          title={zh ? "活动概览" : "Activity"}
          icon="bar-chart-3"
          className="lo-card--activity lo-overview-activity"
        >
          {hasActivity ? (
            <>
              <div className="lo-av">
                <div className="lo-av__col">
                  <div
                    className="lo-overview-activity__caption"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "var(--space-4)",
                      marginBottom: "var(--space-2)",
                      fontSize: "var(--fs-xs)",
                      color: "var(--text-muted)",
                    }}
                  >
                    <span>{zh ? "过去 14 天" : "Last 14 days"}</span>
                    <span>
                      {zh ? "今天" : "today"} {dayValues[todayIdx] ?? 0}
                    </span>
                  </div>
                  <Heatmap values={dayValues} titles={days} highlightIndex={todayIdx} token="--accent" columns={7} />
                </div>
                <div className="lo-av__col">
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
              <div
                className="lo-overview-activity__caption"
                style={{
                  marginBottom: "var(--space-2)",
                  fontSize: "var(--fs-xs)",
                  color: "var(--text-muted)",
                }}
              >
                {zh ? "今日活跃时段" : "Hourly today"}
              </div>
              <HourBars values={snapshot.activity.perHour} token="--info" highlightIndex={nowHour} />
            </>
          ) : (
            <div
              className="lo-overview-activity__empty empty-hint is-compact"
              style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-4)" }}
            >
              <span>{zh ? "最近 14 天没有活动" : "No activity in the last 14 days"}</span>
              <button type="button" className="lo-link-btn" onClick={() => onOpenTab("timeline")}>
                {zh ? "查看时间线" : "View timeline"}
              </button>
            </div>
          )}
        </Card>
      </div>

      {/* ===== 团队 / 任务 / 数据源（场景画布归「子智能体」页签） ===== */}
      <div className="lo-overview-lower">
        <div className="lo-stack">
          <div className="lo-stack__row">
            {/* 团队卡（对标 GatewayAgentsCard） */}
            <Card
              title={zh ? "团队" : "Teams"}
              icon="users"
              scroll
              actions={
                <button className="lo-link-btn" onClick={() => openTaskCenterTab("teams")}>
                  {zh ? "全部 →" : "All →"}
                </button>
              }
            >
              {!hasTeams ? (
                /*
                 * 空态不是「暂无数据」四个字：团队是要**建**出来的，
                 * 所以给一句「去哪儿建」+ 一个直达入口（卡片右上「全部 →」仍然保留）。
                 */
                <div className="lo-overview-empty lo-overview-empty--team empty-hint is-compact" data-empty="team">
                  <span>
                    {zh
                      ? "还没有活动团队。团队模板与运行时团队在「任务管理 → 团队」，也可以在对话里用 squad_dispatch / agent_teams_* 建队。"
                      : "No active team yet. Templates and running teams live in Task Center → Teams; you can also create one from chat via squad_dispatch / agent_teams_*."}
                  </span>
                  <button type="button" className="lo-link-btn" onClick={() => openTaskCenterTab("teams")}>
                    {zh ? "打开团队 →" : "Open teams →"}
                  </button>
                </div>
              ) : (
                liveTeams.map((t) => (
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
              icon="wrench"
              scroll
              actions={
                <button className="lo-link-btn" onClick={() => onOpenTab("tools")}>
                  {zh ? "全部 →" : "All →"}
                </button>
              }
            >
              {/*
                团队任务与工具调用都没有时，不再摆 8 个全零字段（那是一条「空进度条模板」）；
                有任一数据后，字段与口径与之前完全一致。
              */}
              {hasTaskData ? (
                <div className="lo-fields">
                  <Field label={zh ? "团队任务总数" : "Team tasks"}>{m.tasksTotal}</Field>
                  <Field label={zh ? "完成" : "Done"}>{m.tasksDone}</Field>
                  <Field label={zh ? "执行中" : "Running"}>{m.tasksRunning}</Field>
                  <Field label={zh ? "待领取" : "Pending"}>{m.tasksPending}</Field>
                  <Field label={zh ? "失败" : "Failed"}>
                    <span style={{ color: m.tasksFailed > 0 ? "var(--error)" : undefined }}>{m.tasksFailed}</span>
                  </Field>
                  <Field label={zh ? "工具调用（按事件流）" : "Tool calls (events)"}>{m.toolCalls}</Field>
                  <Field label={zh ? "工具失败" : "Tool errors"}>
                    <span style={{ color: m.toolErrors > 0 ? "var(--error)" : undefined }}>{m.toolErrors}</span>
                  </Field>
                  <Field label={zh ? "产出文件" : "Files"}>{m.filesTouched}</Field>
                </div>
              ) : (
                <div className="lo-overview-empty lo-overview-empty--task empty-hint is-compact" data-empty="task">
                  <span>
                    {zh
                      ? "还没有团队任务或工具调用。任务总数 / 完成 / 执行中 / 待领取 / 失败 / 工具调用与失败 / 产出文件会在有数据后按原口径汇总。"
                      : "No team tasks or tool calls yet. Totals, completion, running/pending/failed, tool calls/errors and files touched appear here once activity exists."}
                  </span>
                </div>
              )}
              {/* 最近事件复用 EventList（原先这里手写了一份同构列表，属于重复实现）；
                  全量事件与筛选在「看板 → 时间线」 */}
              <SectionTitle hint={`${snapshot.events.length}`}>{zh ? "最近事件" : "Recent events"}</SectionTitle>
              {snapshot.events.length === 0 ? (
                <Empty text={zh ? "暂无事件" : "No events"} />
              ) : (
                <EventList snapshot={snapshot} zh={zh} limit={8} />
              )}
            </Card>
          </div>

          {/* 数据源 / 健康度（对标 MemoCard） */}
          <Card title={zh ? "数据源与健康度" : "Sources & health"} icon="stethoscope" className="lo-card--memo">
            {/*
              没有团队任务/工具调用时**不画 0% 仪表**：健康环、任务完成率、工具错误率都没有样本，
              排成一行 0% 只是模板。此时只留一句说明 + 真实的数据源计数（口径不变）。
            */}
            {hasTaskData ? (
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
            ) : (
              <div className="lo-overview-empty lo-overview-empty--health empty-hint is-compact" data-empty="health">
                <span>
                  {zh
                    ? "还没有团队任务与工具调用，完成率 / 错误率没有可计算的样本（健康环不显示 0%）。"
                    : "No team tasks or tool calls yet, so completion and error rates have no sample (the health ring is hidden instead of showing 0%)."}
                </span>
                <div className="lo-fields">
                  <Field label={zh ? "运行时团队" : "Teams"}>{snapshot.sources.teams}</Field>
                  <Field label={zh ? "团队成员" : "Members"}>{snapshot.sources.teamMembers}</Field>
                  <Field label={zh ? "子智能体" : "Subagents"}>{snapshot.sources.subagents}</Field>
                  <Field label={zh ? "采样耗时" : "Sample time"}>{snapshot.sampleMs}ms</Field>
                </div>
              </div>
            )}
            {snapshot.sources.failed.length > 0 && (
              <div className="lo-warn">
                <Pill token="--warning"><LoIcon name="triangle-alert" size={12} /> {zh ? "采集失败" : "Failed"}</Pill>
                <span>{snapshot.sources.failed.join(", ")}</span>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* ===== KPI 细项 ===== */}
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

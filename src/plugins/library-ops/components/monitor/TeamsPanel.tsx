/**
 * TeamsPanel —— 团队页（对标 lobster-pet `GatewayAgentsCard` + `TaskGrid`）。
 *
 * 展示运行时团队（队长 + 成员 + 任务看板），数据来自 AgentTeamsService
 * 的真实快照（成员状态、任务状态机、依赖链、邮箱未读）。
 */

import type { LibrarySnapshot, TeamSummary } from "../../types";
import { TASK_STATUS_META } from "../../types";
import { formatAge, formatPercent } from "../../core/format";
import { Card, Empty, Field, Pill, SectionTitle } from "./common";
import { ProgressRing } from "./charts";
import { LoIcon } from "../icons";

export interface TeamsPanelProps {
  snapshot: LibrarySnapshot | null;
  zh: boolean;
}

export function TeamsPanel({ snapshot, zh }: TeamsPanelProps) {
  if (!snapshot) return <Empty text={zh ? "等待采样…" : "Waiting…"} />;
  const teams = snapshot.teams.filter((t) => !t.archived);
  if (teams.length === 0) {
    return (
      <Card title={zh ? "团队" : "Teams"} icon="users">
        <Empty
          text={
            zh
              ? "本会话还没有活动团队。对助手说：「建一个团队，分别做 X / Y / Z，最后汇总」，助手会用 agent_teams_* 工具建队并派活。"
              : 'No active team. Ask the assistant to "create a team to do X / Y / Z in parallel and summarize".'
          }
        />
      </Card>
    );
  }
  return (
    <div className="lo-teams">
      {teams.map((team) => (
        <TeamCard key={team.id} team={team} zh={zh} />
      ))}
    </div>
  );
}

function TeamCard({ team, zh }: { team: TeamSummary; zh: boolean }) {
  const counts = team.taskCounts;
  const donut = [
    { label: zh ? "已完成" : "Done", value: counts.completed, token: "--success" },
    { label: zh ? "执行中" : "Running", value: counts.in_progress + counts.claimed, token: "--warning" },
    { label: zh ? "待领取" : "Pending", value: counts.pending, token: "--text-muted" },
    { label: zh ? "失败" : "Failed", value: counts.failed + counts.cancelled, token: "--error" },
  ];
  const maxCount = Math.max(1, ...donut.map((d) => d.value));

  return (
    <Card
      title={team.name}
      icon="users"
      className="lo-card--team"
      actions={
        <span className="lo-team__meta">
          <Pill token="--accent">{zh ? "队长" : "Captain"}: {team.captainName}</Pill>
          <span className="lo-team__age">{formatAge(team.updatedAt)}</span>
        </span>
      }
    >
      <div className="lo-team__grid">
        <div className="lo-team__col">
          <SectionTitle hint={`${team.memberCount}`}>{zh ? "成员" : "Members"}</SectionTitle>
          <ul className="lo-members">
            {team.members.map((m) => {
              const token = m.status === "working" ? "--warning" : m.status === "idle" ? "--success" : "--text-muted";
              return (
                <li key={m.id} className="lo-members__item">
                  <span className="lo-members__dot" style={{ background: `var(${token})` }} />
                  <span className="lo-members__name" title={m.name}>
                    {m.name}
                  </span>
                  <span className="lo-members__role" title={m.role}>
                    {m.role ?? "—"}
                  </span>
                  <span className="lo-members__tasks">
                    {m.done}/{m.tasks}
                  </span>
                  <span className="lo-members__status" style={{ color: `var(${token})` }}>
                    {zh ? statusZh(m.status) : m.status}
                  </span>
                  {m.currentTask && (
                    <span className="lo-members__focus" title={m.currentTask}>
                      {m.currentTask}
                    </span>
                  )}
                </li>
              );
            })}
            {team.members.length === 0 && <Empty text={zh ? "暂无成员" : "No members"} />}
          </ul>
        </div>

        <div className="lo-team__col">
          <SectionTitle hint={`${team.tasks.length}`}>{zh ? "任务" : "Tasks"}</SectionTitle>
          <ul className="lo-tasks">
            {team.tasks.map((t) => {
              const meta = TASK_STATUS_META[t.status];
              return (
                <li key={t.id} className="lo-tasks__item" data-status={t.status}>
                  <span className="lo-tasks__id">{t.id}</span>
                  <span className="lo-tasks__subject" title={t.subject}>
                    {t.subject}
                  </span>
                  <span className="lo-tasks__assignee">{t.assignee ?? (zh ? "共享池" : "pool")}</span>
                  {t.dependencies.length > 0 && <span className="lo-tasks__deps"><LoIcon name="package-check" size={11} />{t.dependencies.join(",")}</span>}
                  <Pill token={meta.token}>{zh ? meta.zh : meta.en}</Pill>
                </li>
              );
            })}
            {team.tasks.length === 0 && <Empty text={zh ? "暂无任务" : "No tasks"} />}
          </ul>
        </div>

        <div className="lo-team__col lo-team__col--side">
          <SectionTitle>{zh ? "进度" : "Progress"}</SectionTitle>
          <div className="lo-team__ring">
            <ProgressRing ratio={team.completion} size={72} token="--success" label={zh ? "完成率" : "done"} />
            <span className="lo-team__pct">{formatPercent(team.completion)}</span>
          </div>
          <div className="lo-fields">
            {donut.map((d) => (
              <Field key={d.label} label={d.label}>
                <span style={{ color: `var(${d.token})` }}>{d.value}</span>
                <span className="lo-team__bar">
                  <span style={{ width: `${Math.round((d.value / maxCount) * 100)}%`, background: `var(${d.token})` }} />
                </span>
              </Field>
            ))}
            <Field label={zh ? "未读消息" : "Unread"}>{team.unread}</Field>
          </div>
        </div>
      </div>
    </Card>
  );
}

function statusZh(status: string): string {
  const map: Record<string, string> = { idle: "空闲", working: "工作中", absent: "离线", removed: "已移除" };
  return map[status] ?? status;
}

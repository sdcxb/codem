/**
 * AgentTeamsPanel — 团队活动面板（B3，对标 EAC agent-teams 活动面板/团队卡）
 *
 * 展示当前队长会话的活动团队：成员（角色/状态/路由）+ 任务看板（状态/
 * 负责人/依赖链/attempt）+ 未读消息计数。订阅服务变更实时刷新。
 * 只读监控面板——建队/派活由 LLM 通过 agent_teams_* 工具完成
 * （队长在对话中用自然语言组织团队）。
 */
import { useState, useEffect, useCallback } from "react";
import { X, Users, ListChecks, GitBranch } from "lucide-react";
import { useProjectStore } from "../core/store";
import { useLang } from "../core/i18n/lang";
import { AgentTeamsService } from "../core/provider/agent-teams-service";
import type { TeamSnapshot } from "../core/agent-teams/engine";

interface AgentTeamsPanelProps {
  onClose: () => void;
}

const STATUS_META: Record<string, { color: string; zh: string }> = {
  pending: { color: "#8b8b8b", zh: "待领取" },
  claimed: { color: "#3b82f6", zh: "已领取" },
  in_progress: { color: "#f59e0b", zh: "执行中" },
  completed: { color: "#10b981", zh: "已完成" },
  failed: { color: "#ef4444", zh: "失败" },
  cancelled: { color: "#6b7280", zh: "已取消" },
};

const MEMBER_STATUS: Record<string, { color: string; zh: string }> = {
  idle: { color: "#10b981", zh: "空闲" },
  working: { color: "#f59e0b", zh: "工作中" },
  absent: { color: "#8b8b8b", zh: "离线" },
  removed: { color: "#6b7280", zh: "已移除" },
};

export function AgentTeamsPanel({ onClose }: AgentTeamsPanelProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const currentSession = useProjectStore((s) => s.currentSession);
  const [snap, setSnap] = useState<TeamSnapshot | null>(null);

  const refresh = useCallback(() => {
    if (!currentSession) { setSnap(null); return; }
    const svc = AgentTeamsService.getInstance();
    const team = svc.activeTeamOf(currentSession.id);
    if (!team) { setSnap(null); return; }
    try { setSnap(svc.status(team.id)); } catch { setSnap(null); }
  }, [currentSession]);

  useEffect(() => {
    refresh();
    const svc = AgentTeamsService.getInstance();
    const unsub = svc.subscribe(refresh);
    return unsub;
  }, [refresh]);

  if (!snap) {
    return (
      <div className="agent-teams-panel" style={{ padding: 16, display: "grid", gap: 10, justifyItems: "center", color: "var(--text-muted)", fontSize: 'var(--fs-sm)', textAlign: "center" }}>
        <Users size={28} style={{ opacity: 0.4 }} />
        <div>
          {zh
            ? "本会话还没有活动团队。对助手说：\n“建一个团队，分别做 X / Y / Z，最后汇总”\n助手会用 agent_teams_* 工具建队并派活。"
            : "No active team for this session. Ask the assistant to \"create a team to do X / Y / Z in parallel and summarize\" — it will use the agent_teams_* tools."}
        </div>
        <button className="inline-edit-btn cancel" onClick={onClose}>{zh ? "关闭" : "Close"}</button>
      </div>
    );
  }

  return (
    <div className="agent-teams-panel" style={{ display: "flex", flexDirection: "column", height: "100%", fontSize: 'var(--fs-sm)' }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border-primary, rgba(0,0,0,.08))" }}>
        <GitBranch size={15} style={{ color: "var(--accent)" }} />
        <strong style={{ flex: 1 }}>{snap.name}</strong>
        <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>{snap.id.slice(0, 10)}</span>
        <button className="toolbar-btn" aria-label={zh ? "关闭" : "Close"} onClick={onClose}><X size={14} /></button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "grid", gap: 12, alignContent: "start" }}>
        {/* Members */}
        <section>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, color: "var(--text-secondary)", fontWeight: 600 }}>
            <Users size={13} /> {zh ? "成员" : "Members"} ({snap.members.length})
          </div>
          {snap.members.length === 0 ? (
            <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>{zh ? "暂无成员 — 请助手添加成员" : "No members yet"}</div>
          ) : (
            <div style={{ display: "grid", gap: 4 }}>
              {snap.members.map((m) => {
                const meta = MEMBER_STATUS[m.status] || { color: "var(--text-muted)", zh: m.status };
                return (
                  <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", background: "var(--bg-secondary, #232834)", borderRadius: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600 }}>{m.name}</span>
                    {m.role && <span style={{ color: "var(--text-muted)", fontSize: 'var(--fs-xs)' }}>{m.role}</span>}
                    <span style={{ marginLeft: "auto", fontSize: 'var(--fs-xs)', color: meta.color }}>{zh ? meta.zh : m.status}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Tasks */}
        <section>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, color: "var(--text-secondary)", fontWeight: 600 }}>
            <ListChecks size={13} /> {zh ? "任务" : "Tasks"} ({snap.tasks.length})
          </div>
          {snap.tasks.length === 0 ? (
            <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>{zh ? "暂无任务" : "No tasks yet"}</div>
          ) : (
            <div style={{ display: "grid", gap: 4 }}>
              {snap.tasks.map((t) => {
                const meta = STATUS_META[t.status] || { color: "var(--text-muted)", zh: t.status };
                const depText = t.dependencies.length ? ` ⛓${t.dependencies.join(",")}` : "";
                return (
                  <div key={t.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "4px 6px", background: "var(--bg-secondary, #232834)", borderRadius: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color, flexShrink: 0, marginTop: 4 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <span style={{ fontWeight: 600 }}>{t.id}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.subject}</span>
                      </div>
                      <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
                        {zh ? meta.zh : t.status}
                        {t.assignee ? ` · @${t.assignee}` : ""}
                        {depText}
                        {t.hasAttemptId ? ` · attempt#${t.attempt}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Unread mailbox */}
        {Object.keys(snap.unreadFor).length > 0 && (
          <section>
            <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
              {zh ? "未读消息：" : "Unread: "}
              {Object.entries(snap.unreadFor).map(([to, n]) => `${to} (${n})`).join(", ")}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

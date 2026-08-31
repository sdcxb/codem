/**
 * OverviewTab — 任务管理概览页
 *
 * 聚合委派、子智能体、自动化的实时统计 + 最近活动时间线。
 */

import { useState, useEffect, useCallback } from "react";
import { Link2, Clock, ChevronRight, CheckCircle2, Loader2, XCircle, Timer, FileClock, ClipboardList, Inbox as InboxIcon } from "lucide-react";
import { getDelegationOrchestrator } from "../../core/session";
import { getAutomationConfig } from "../../core/automation/automation-manager";
import { getIssueManager } from "../../core/issue/issue";
import { getInboxManager } from "../../core/inbox/inbox";
import { useProjectStore } from "../../core/store";
import { useLang } from "../../core/i18n/lang";
import type { TaskCenterTab } from "../TaskCenter";

interface OverviewTabProps {
  onNavigate: (tab: TaskCenterTab) => void;
}

interface ActivityEntry {
  icon: typeof Link2;
  iconColor: string;
  text: string;
  timestamp: number;
}

export function OverviewTab({ onNavigate }: OverviewTabProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const sessions = useProjectStore((s) => s.sessions);

  const [delegationStats, setDelegationStats] = useState({ total: 0, running: 0, completed: 0, failed: 0, pending: 0 });
  const [automationCount, setAutomationCount] = useState({ active: 0, total: 0, todayTriggered: 0 });
  const [issueStats, setIssueStats] = useState({ total: 0, inProgress: 0, inReview: 0, done: 0 });
  const [inboxUnread, setInboxUnread] = useState(0);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);

  const loadData = useCallback(() => {
    // Delegation stats
    const orch = getDelegationOrchestrator();
    setDelegationStats(orch.getStats());

    // Automation stats
    const config = getAutomationConfig();
    const active = config.triggers.filter((t) => t.enabled).length;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTriggered = (config.history || []).filter((h) => h.timestamp >= today.getTime()).length;
    setAutomationCount({ active, total: config.triggers.length, todayTriggered });

    // Issue stats
    const issueMgr = getIssueManager();
    const stats = issueMgr.getStats(useProjectStore.getState().currentProject?.id);
    setIssueStats({
      total: Object.values(stats).reduce((a, b) => a + b, 0),
      inProgress: stats.in_progress || 0,
      inReview: stats.in_review || 0,
      done: stats.done || 0,
    });

    // Inbox stats
    setInboxUnread(getInboxManager().getUnreadCount(useProjectStore.getState().currentProject?.id));

    // Build activity timeline from delegation tasks + automation history
    const allActivities: ActivityEntry[] = [];

    // Delegation activities
    const allTasks = sessions.flatMap((s) => [
      ...orch.getDelegationsBySource(s.id),
      ...orch.getDelegationsByTarget(s.id),
    ]);
    const seen = new Set<string>();
    for (const t of allTasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const Icon = t.status === "completed" ? CheckCircle2 :
                   t.status === "running" ? Loader2 :
                   t.status === "failed" ? XCircle : Timer;
const iconColor = t.status === "completed" ? "var(--success)" :
    t.status === "running" ? "var(--accent)" :
    t.status === "failed" ? "var(--error)" : "var(--text-muted)";
      const taskLabel = zh ? "委派任务" : "Delegation";
      allActivities.push({
        icon: Icon,
        iconColor,
        text: `${taskLabel}: ${t.task.substring(0, 60)}${t.task.length > 60 ? "..." : ""}`,
        timestamp: t.completedAt || t.createdAt,
      });
    }

    // Automation activities
    for (const h of (config.history || []).slice(0, 10)) {
      allActivities.push({
        icon: FileClock,
        iconColor: "var(--warning)",
        text: `${zh ? "自动化" : "Automation"}: ${h.triggerName}`,
        timestamp: h.timestamp,
      });
    }

    allActivities.sort((a, b) => b.timestamp - a.timestamp);
    setActivities(allActivities.slice(0, 15));
  }, [sessions, zh]);

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 2000);
    const orch = getDelegationOrchestrator();
    const unsub = orch.onStateChange(() => loadData());

    const configHandler = () => loadData();
    window.addEventListener("codem-automation-config-changed", configHandler);

    return () => {
      clearInterval(timer);
      unsub();
      window.removeEventListener("codem-automation-config-changed", configHandler);
    };
  }, [loadData]);

  const cards = [
    {
      tab: "inbox" as TaskCenterTab,
      icon: InboxIcon,
      label: zh ? "收件箱" : "Inbox",
      stats: [
        { label: zh ? "未读" : "Unread", value: inboxUnread, color: inboxUnread > 0 ? "var(--error)" : "var(--text-muted)" },
      ],
    },
    {
      tab: "issues" as TaskCenterTab,
      icon: ClipboardList,
      label: zh ? "Issues" : "Issues",
      stats: [
{ label: zh ? "进行中" : "Active", value: issueStats.inProgress, color: "var(--accent)" },
    { label: zh ? "待审查" : "Review", value: issueStats.inReview, color: "var(--warning)" },
    { label: zh ? "已完成" : "Done", value: issueStats.done, color: "var(--success)" },
      ],
    },
    {
      tab: "delegation" as TaskCenterTab,
      icon: Link2,
      label: zh ? "委派任务" : "Delegation",
      stats: [
{ label: zh ? "运行中" : "Running", value: delegationStats.running, color: "var(--accent)" },
    { label: zh ? "已完成" : "Completed", value: delegationStats.completed, color: "var(--success)" },
        { label: zh ? "等待中" : "Pending", value: delegationStats.pending, color: "var(--text-muted)" },
      ],
    },
    {
      tab: "automation" as TaskCenterTab,
      icon: Clock,
      label: zh ? "自动化" : "Automation",
      stats: [
        { label: zh ? "活跃" : "Active", value: automationCount.active, color: "var(--success)" },
        { label: zh ? "总计" : "Total", value: automationCount.total, color: "var(--accent)" },
        { label: zh ? "今日触发" : "Today", value: automationCount.todayTriggered, color: "var(--warning)" },
      ],
    },
  ];

  return (
    <div style={{ padding: "20px" }}>
      {/* Stat cards */}
      <div style={{ display: "flex", gap: "16px", marginBottom: "24px", flexWrap: "wrap" }}>
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.tab}
              onClick={() => onNavigate(card.tab)}
              style={{
                flex: "1 1 200px",
                background: "var(--bg-tertiary)",
                borderRadius: "8px",
                border: "1px solid var(--border-primary)",
                padding: "16px",
                cursor: "pointer",
                transition: "border-color 0.2s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-primary)")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                <Icon size={16} style={{ color: "var(--accent)" }} />
                <span style={{ fontSize: "var(--fs-md)", fontWeight: 600, color: "var(--text-primary)" }}>
                  {card.label}
                </span>
                <ChevronRight size={14} style={{ marginLeft: "auto", color: "var(--text-secondary, #666)" }} />
              </div>
              <div style={{ display: "flex", gap: "16px" }}>
                {card.stats.map((s) => (
                  <div key={s.label}>
                    <div style={{ fontSize: "var(--fs-3xl)", fontWeight: 700, color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary, #888)" }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent activity timeline */}
      <div>
        <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, color: "var(--text-primary)", marginBottom: "12px" }}>
          {zh ? "最近活动" : "Recent Activity"}
        </div>
        {activities.length === 0 ? (
          <div style={{ padding: "20px", textAlign: "center", color: "var(--text-secondary, #666)", fontSize: "var(--fs-base)" }}>
            {zh ? "暂无活动记录" : "No activity yet"}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {activities.map((act, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  background: "var(--bg-tertiary)",
                  fontSize: "var(--fs-sm)",
                }}
              >
                <act.icon size={14} style={{ color: act.iconColor, flexShrink: 0 }} />
                <span style={{ flex: 1, color: "var(--text-secondary, #aaa)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {act.text}
                </span>
                <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted, #555)", flexShrink: 0 }}>
                  {formatRelativeTime(act.timestamp, zh)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(timestamp: number, zh: boolean): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return zh ? `${Math.floor(diff / 1000)}秒前` : `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return zh ? `${Math.floor(diff / 60000)}分钟前` : `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return zh ? `${Math.floor(diff / 3600000)}小时前` : `${Math.floor(diff / 3600000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

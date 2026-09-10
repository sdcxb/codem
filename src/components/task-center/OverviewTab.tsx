/**
 * OverviewTab — 任务管理概览页
 *
 * 只做「导航 + 关键计数」：委派 / 自动化 / Issue / 收件箱四张统计卡，
 * 以及一个进入「看板 → 用量 / 时间线」的入口。
 * 活动明细不在这里重复渲染（那是插件「用量 / 时间线」的职责）；
 * 插件未启用时才回退到宿主自带的最近活动预览。
 */

import { useState, useEffect, useCallback } from "react";
import { Link2, Clock, ChevronRight, CheckCircle2, Loader2, XCircle, Timer, FileClock, ClipboardList, Inbox as InboxIcon } from "lucide-react";
import { getDelegationOrchestrator } from "../../core/session";
import { getAutomationConfig } from "../../core/automation/automation-manager";
import { getIssueManager } from "../../core/issue/issue";
import { getInboxManager } from "../../core/inbox/inbox";
import { useLang } from "../../core/i18n/lang";
import { SlotBridge } from "../../core/slots/SlotBridge";
import { TASK_CENTER_OVERVIEW_SLOT, type TaskCenterTab } from "../TaskCenter";
import { getCurrentProjectId } from "./use-current-project";

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

  /** 跳到「看板」页签的某个子视图（插件监听 codem:open-task-center 的 detail.view） */
  const openBoardView = (view: "usage" | "timeline") => {
    onNavigate("board");
    try {
      window.dispatchEvent(new CustomEvent("codem:open-task-center", { detail: { tab: "board", view } }));
    } catch {
      /* 忽略：事件派发失败不影响切页签 */
    }
  };

  const [delegationStats, setDelegationStats] = useState({ total: 0, running: 0, completed: 0, failed: 0, pending: 0 });
  const [automationCount, setAutomationCount] = useState({ active: 0, total: 0, todayTriggered: 0 });
  const [issueStats, setIssueStats] = useState({ total: 0, inProgress: 0, inReview: 0, done: 0 });
  const [inboxUnread, setInboxUnread] = useState(0);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);

  const loadData = useCallback(() => {
    const projectId = getCurrentProjectId();

    // Delegation stats（与「委派」页签严格同口径：无项目 → 0 条，有项目 → 按项目过滤，P1-6）
    const orch = getDelegationOrchestrator();
    const allTasks = projectId
      ? orch.getAllDelegations().filter((t) => !t.projectId || t.projectId === projectId)
      : [];
    setDelegationStats({
      total: allTasks.length,
      running: allTasks.filter((t) => t.status === "running").length,
      completed: allTasks.filter((t) => t.status === "completed").length,
      failed: allTasks.filter((t) => t.status === "failed").length,
      pending: allTasks.filter((t) => t.status === "pending").length,
    });

    // Automation stats
    const config = getAutomationConfig();
    const active = config.triggers.filter((t) => t.enabled).length;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTriggered = (config.history || []).filter((h) => h.timestamp >= today.getTime()).length;
    setAutomationCount({ active, total: config.triggers.length, todayTriggered });

    // Issue stats（无项目时不做全局统计，避免跨项目串数据，P2-12）
    const issueMgr = getIssueManager();
    const stats = projectId
      ? issueMgr.getStats(projectId)
      : ({} as Record<string, number>);
    setIssueStats({
      total: Object.values(stats).reduce((a, b) => a + b, 0),
      inProgress: stats.in_progress || 0,
      inReview: stats.in_review || 0,
      done: stats.done || 0,
    });

    // Inbox stats
    setInboxUnread(projectId ? getInboxManager().getUnreadCount(projectId) : 0);

    // Build activity timeline from delegation tasks + automation history
    const allActivities: ActivityEntry[] = [];

    // Delegation activities（复用上面已按项目过滤的列表）
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
  }, [zh]);

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

      {/* 「用量」（KPI / 健康度 / 活动分布 / token 与成本）由插件贡献到本页签
          （slot: task-center.overview）；插件禁用时回退宿主自带的最近活动预览。 */}
      <SlotBridge
        name={TASK_CENTER_OVERVIEW_SLOT}
        fallback={RecentActivity}
        activities={activities}
        zh={zh}
      />
    </div>
  );
}

/** 宿主自带的「最近活动」预览（仅在插件未接管概览时显示） */
function RecentActivity({ activities, zh }: { activities: ActivityEntry[]; zh: boolean }) {
  return (
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
          {activities.slice(0, 5).map((act, i) => (
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
  );
}

function formatRelativeTime(timestamp: number, zh: boolean): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return zh ? `${Math.floor(diff / 1000)}秒前` : `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return zh ? `${Math.floor(diff / 60000)}分钟前` : `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return zh ? `${Math.floor(diff / 3600000)}小时前` : `${Math.floor(diff / 3600000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

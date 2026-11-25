/**
 * OverviewTab — 任务管理概览页
 *
 * 只做「导航 + 关键计数」：一条紧凑指标条（未读 / 运行中委派 / 今日自动化触发 /
 * 进行中 Issue），以及一个进入「看板 → 用量 / 时间线」的入口。
 * 活动明细不在这里重复渲染（那是插件「用量 / 时间线」的职责）；
 * 插件未启用时才回退到宿主自带的最近活动预览。
 */

import { useState, useEffect, useCallback } from "react";
import { CheckCircle2, Loader2, XCircle, Timer, FileClock, type LucideIcon } from "lucide-react";
import { getDelegationOrchestrator } from "../../core/session";
import { getAutomationConfig } from "../../core/automation/automation-manager";
import { getIssueManager } from "../../core/issue/issue";
import { getInboxManager } from "../../core/inbox/inbox";
import { useLang } from "../../core/i18n/lang";
import { SlotBridge } from "../../core/slots/SlotBridge";
import { TASK_CENTER_OVERVIEW_SLOT, type TaskCenterTab } from "../TaskCenter";
import { getCurrentProjectId } from "./use-current-project";
// 第 191 波：「今天」的边界走唯一实现（本地日 00:00），不再自己 `setHours(0,0,0,0)`
import { localDayStartMs } from "../../core/time/local-time";
import { scopeDelegations } from "./delegation-scope";

interface OverviewTabProps {
  onNavigate: (tab: TaskCenterTab) => void;
}

interface ActivityEntry {
  icon: LucideIcon;
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

    /**
     * Delegation stats —— **与「委派」页签同一处实现**（`scopeDelegations`）。
     *
     * ⚠️ 第 72 轮审计（真机实测）：这里原来自己写了一遍 `projectId ? filter(...) : []`，
     * 于是无项目时概览卡显示 `0 运行中 / 0 已完成`，而委派页签同时列出
     * `5 总计 / 3 已完成 / 2 失败` —— 同一个事实，同一屏，两个答案。
     * 修法不是"把这处也改对"，而是**把口径收成唯一实现**，让两处不可能再分叉。
     */
    const orch = getDelegationOrchestrator();
    const allTasks = scopeDelegations(orch.getAllDelegations(), projectId);
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
    /*
     * 第 191 波（全仓搜同类的残留）：这里原来是 `new Date(); setHours(0,0,0,0)` ——
     * 本仓**第二处**「本地日 00:00」的实现（`TIME-SINGLE-SOURCE` 的同族）。
     * 它落到同一个瞬时，但"同一事实两处实现"正是本轮反复吃亏的形态，
     * 所以改走唯一实现 `localDayStartMs`（判据 `TIME-WINDOW-4` 钉住全仓只有一处）。
     */
    const today = localDayStartMs(Date.now());
    const todayTriggered = (config.history || []).filter((h) => h.timestamp >= today).length;
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
    /*
     * ⚠️ 第 72 轮：原来是 `projectId ? getUnreadCount(projectId) : 0` —— 无项目时这张卡读 0，
     * 而侧栏徽标读的是"不带边界"的全局未读（用户现场：徽标 4、概览卡 0、收件箱空，
     * 三个地方三个答案）。现在统一口径：无项目 = 全局未读（`null`），有项目 = 本项目 + 全局。
     */
    setInboxUnread(getInboxManager().getUnreadCount(projectId ?? null));

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

  /**
   * 四个最重要的计数。单项 = 数字 + 小标签，点一下跳到对应页签；
   * 不再给每项套大卡 / 边框 / 箭头（四张等宽 KPI 卡的模板感就来自那层壳）。
   *
   * `title` 里保留同族的次级计数（已完成 / 失败 / 待审查…）：数据还在，只是不占主视线；
   * 回归判据也用它在「概览」与「委派」页签之间核对同一口径。
   */
  const metrics: Array<{
    key: string;
    tab: TaskCenterTab;
    label: string;
    value: number;
    title: string;
  }> = [
    {
      key: "inbox",
      tab: "inbox",
      label: zh ? "未读" : "Unread",
      value: inboxUnread,
      title: zh ? "收件箱未读通知" : "Unread inbox notifications",
    },
    {
      key: "delegation",
      tab: "delegation",
      label: zh ? "运行中委派" : "Running delegations",
      value: delegationStats.running,
      title: zh
        ? `已完成 ${delegationStats.completed} · 失败 ${delegationStats.failed} · 等待 ${delegationStats.pending}`
        : `${delegationStats.completed} completed · ${delegationStats.failed} failed · ${delegationStats.pending} pending`,
    },
    {
      key: "automation",
      tab: "automation",
      label: zh ? "今日自动化触发" : "Automation today",
      value: automationCount.todayTriggered,
      title: zh
        ? `活跃触发器 ${automationCount.active} · 总计 ${automationCount.total}`
        : `${automationCount.active} active · ${automationCount.total} total triggers`,
    },
    {
      key: "issues",
      tab: "issues",
      label: zh ? "进行中 Issue" : "Issues in progress",
      value: issueStats.inProgress,
      title: zh
        ? `待审查 ${issueStats.inReview} · 已完成 ${issueStats.done}`
        : `${issueStats.inReview} in review · ${issueStats.done} done`,
    },
  ];

  return (
    <div style={{ padding: "20px" }}>
      {/* 紧凑指标条：桌面一行、窄屏按项换行；每项只有数字 + 小标签 */}
      <div
        className="task-overview-metrics"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          gap: "10px 28px",
          marginBottom: "24px",
        }}
      >
        {metrics.map((metric) => (
          <button
            key={metric.key}
            type="button"
            className="task-overview-metric"
            data-metric={metric.key}
            data-value={metric.value}
            title={metric.title}
            onClick={() => onNavigate(metric.tab)}
            style={{
              display: "inline-flex",
              alignItems: "baseline",
              gap: "6px",
              padding: "2px 4px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              font: "inherit",
              textAlign: "left",
            }}
          >
            <span
              className="task-overview-metric__value"
              style={{
                fontSize: "var(--fs-2xl)",
                fontWeight: 500,
                lineHeight: 1.1,
                color: "var(--text-primary)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {metric.value}
            </span>
            <span
              className="task-overview-metric__label"
              style={{ fontSize: "var(--fs-2xs)", color: "var(--text-muted)" }}
            >
              {metric.label}
            </span>
          </button>
        ))}
      </div>

      {/* 「用量」（KPI / 健康度 / 活动分布 / token 与成本）由插件贡献到本页签
          （slot: task-center.overview）；插件禁用时回退宿主自带的最近活动预览。
          `onViewTimeline` 透传给 fallback：插件不在场时，空活动仍要能进时间线。 */}
      <SlotBridge
        name={TASK_CENTER_OVERVIEW_SLOT}
        fallback={RecentActivity}
        activities={activities}
        zh={zh}
        onViewTimeline={() => openBoardView("timeline")}
      />
    </div>
  );
}

/**
 * 宿主自带的「最近活动」预览（仅在插件未接管概览时显示）。
 *
 * 空态不是一张「数据卡」：一行说明 + 时间线入口，走共享的 `.empty-hint.is-compact`
 * （小内边距、左对齐），不再用一整块 20px 内边距的居中占位。
 */
function RecentActivity({
  activities,
  zh,
  onViewTimeline,
}: {
  activities: ActivityEntry[];
  zh: boolean;
  onViewTimeline?: () => void;
}) {
  return (
    <div>
      <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, color: "var(--text-primary)", marginBottom: "12px" }}>
        {zh ? "最近活动" : "Recent Activity"}
      </div>
      {activities.length === 0 ? (
        <div
          className="task-overview-activity-empty empty-hint is-compact sp-row"
          data-empty="activity"
        >
          <span>{zh ? "暂无活动记录" : "No activity yet"}</span>
          {onViewTimeline && (
            <button type="button" className="sp-btn sp-btn--ghost sp-btn--xs" onClick={onViewTimeline}>
              {zh ? "查看时间线" : "View timeline"}
            </button>
          )}
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
                borderRadius: "var(--radius-sm)",
                background: "var(--bg-tertiary)",
                fontSize: "var(--fs-sm)",
              }}
            >
              <act.icon size={16} style={{ color: act.iconColor, flexShrink: 0 }} />
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

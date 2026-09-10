/**
 * TaskCenter — 统一任务管理中心
 *
 * 将委派监控、子智能体监控、自动化任务、Issue/Board/Squad/Inbox
 * 全部归入一个面板，通过 Tab 切换。
 *
 * 扩展点：`task-center.board`（「看板」页签）。
 * `@codem/ui-library-ops` 启用时接管该页签，在「看板」里追加
 * 场景 / 用量 / 工具 / 错误 / 时间线 / 设置 视图（原独立「图书馆」页签已并入）；
 * 插件关闭时回退到宿主自带 Issues 看板，页签数量与行为完全不变。
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutDashboard, Link2, Bot, Clock, ClipboardList, Columns, Users, Inbox as InboxIcon } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { SlotBridge } from "../core/slots/SlotBridge";
import { getDelegationOrchestrator } from "../core/session";
import { useLang } from "../core/i18n/lang";
import { OverviewTab } from "./task-center/OverviewTab";
import { DelegationTab } from "./task-center/DelegationTab";
import { SubagentsTab } from "./task-center/SubagentsTab";
import { AutomationTab } from "./task-center/AutomationTab";
import { TeamTab } from "./task-center/TeamTab";
import { IssuesTab } from "./task-center/IssuesTab";
import { BoardTab } from "./task-center/BoardTab";
import { InboxTab } from "./task-center/InboxTab";

export type TaskCenterTab =
  | "overview"
  | "issues"
  | "board"
  | "teams"
  | "delegation"
  | "subagents"
  | "automation"
  | "inbox";

/** 「看板」页签的扩展 slot（@codem/ui-library-ops 在此接管：看板/工具/错误/时间线） */
export const TASK_CENTER_BOARD_SLOT = "task-center.board";

/** 「概览」页签的扩展 slot（插件在此贡献「用量」：KPI/健康度/活动分布/token 与成本） */
export const TASK_CENTER_OVERVIEW_SLOT = "task-center.overview";

/**
 * 「子智能体」页签的扩展 slot（@codem/ui-library-ops 在此接管：场景 / 设置）。
 * 场景里站着的就是队长 / 团队成员 / 子智能体，是「子智能体在做什么」的可视化表达；
 * 插件禁用时该页签回退到宿主自带列表（SubagentsTab）。
 */
export const TASK_CENTER_SUBAGENTS_SLOT = "task-center.subagents";

interface TaskCenterProps {
  onClose: () => void;
  initialTab?: TaskCenterTab;
  /** Subagent tasks from App state (for SubagentsTab) */
  subagentTasks?: any[];
  onSelectSubagent?: (taskId: string) => void;
}

/** 旧 tab id 兼容归一（squads → teams；library → board；外部旧调用仍可用） */
function normalizeTab(t: string): TaskCenterTab {
  if (t === "squads") return "teams";
  if (t === "library") return "board";
  return t as TaskCenterTab;
}

export function TaskCenter({ onClose, initialTab = "overview", subagentTasks = [], onSelectSubagent }: TaskCenterProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [activeTab, setActiveTab] = useState<TaskCenterTab>(() => normalizeTab(initialTab));
  // 收件箱点击穿透 / 外部事件请求聚焦的 Issue（消费后清空）
  const [focusIssueId, setFocusIssueId] = useState<string | null>(null);

  // P1-13：面板已打开时外部再次派发 `codem:open-task-center`（例如收件箱点击穿透、
  // 图书馆视图跳转），必须跟随切换页签，而不是只认挂载时的 initialTab。
  useEffect(() => {
    setActiveTab(normalizeTab(initialTab));
  }, [initialTab]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (typeof detail.tab === "string" && detail.tab) {
        setActiveTab(normalizeTab(detail.tab));
      }
      if (typeof detail.issueId === "string" && detail.issueId) {
        setFocusIssueId(detail.issueId);
      }
    };
    window.addEventListener("codem:open-task-center", handler as EventListener);
    return () => window.removeEventListener("codem:open-task-center", handler as EventListener);
  }, []);

  const clearFocusIssue = useCallback(() => setFocusIssueId(null), []);

  const tabs: { id: TaskCenterTab; label: string; icon: typeof LayoutDashboard; available: boolean }[] = [
    { id: "overview", label: zh ? "概览" : "Overview", icon: LayoutDashboard, available: true },
    { id: "delegation", label: zh ? "委派" : "Delegation", icon: Link2, available: true },
    { id: "subagents", label: zh ? "子智能体" : "Sub-agents", icon: Bot, available: true },
    { id: "automation", label: zh ? "自动化" : "Automation", icon: Clock, available: true },
    { id: "issues", label: zh ? "Issues" : "Issues", icon: ClipboardList, available: true },
    { id: "board", label: zh ? "看板" : "Board", icon: Columns, available: true },
    { id: "teams", label: zh ? "团队" : "Teams", icon: Users, available: true },
    { id: "inbox", label: zh ? "收件箱" : "Inbox", icon: InboxIcon, available: true },
  ];

  // 看板（Issues 7 列）、子智能体（场景画布）、概览（含插件贡献的用量面板）都需要更宽的面板
  const wide = activeTab === "board" || activeTab === "subagents" || activeTab === "overview";
  /**
   * 内容区是否**自己铺满一屏**（自己管滚动）。
   *
   * ⚠️ 不要和 `wide` 混用：概览也要宽面板，但它是普通文档流页面，
   * 必须由内容区滚动（`overflow: auto`）—— 曾经把两者绑在一起，
   * 结果概览被 `overflow: hidden` 裁掉，下面的用量面板完全看不到（无滚动条）。
   * 看板 / 子智能体由插件外壳自己管滚动（`.lo-task__content`），所以这里必须是 hidden。
   */
  const fillsViewport = activeTab === "board" || activeTab === "subagents";

  // 底栏显示真实委派限制（原先写死「深度 2 · 并发 5」，与运行时配置可能不一致）
  const limits = (() => {
    try {
      return getDelegationOrchestrator().getLimits();
    } catch {
      return { maxDepth: 0, maxConcurrent: 0 };
    }
  })();

  const panel = (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="task-center-panel"
        data-wide={wide ? "1" : "0"}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: wide ? "min(1180px, 96vw)" : "min(960px, 92vw)",
          maxWidth: "96vw",
          height: "min(720px, 88vh)",
          maxHeight: "90vh",
          background: "var(--bg-secondary, #1e1e2e)",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-primary)",
          boxShadow: "0 8px 32px var(--shadow-color)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontFamily: "inherit",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-primary)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <ClipboardList size={20} style={{ color: "var(--accent, #7c3aed)" }} />
            <span style={{ fontSize: "var(--fs-lg)", fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
              {zh ? "任务管理" : "Task Center"}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary, #888)",
              cursor: "pointer",
              padding: "4px 8px",
              borderRadius: "var(--radius-xs)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-tertiary, #2a2a3a)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          >
            <ActionIcons.close size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            gap: "2px",
            padding: "0 12px",
            borderBottom: "1px solid var(--border-primary)",
            flexShrink: 0,
            overflowX: "auto",
          }}
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => tab.available && setActiveTab(tab.id)}
                disabled={!tab.available}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "10px 14px",
                  fontSize: "var(--fs-base)",
                  fontWeight: isActive ? 600 : 400,
                  color: isActive
                    ? "var(--accent, #7c3aed)"
                    : tab.available
                      ? "var(--text-secondary, #888)"
                      : "var(--text-muted, #555)",
                  background: "none",
                  border: "none",
                  borderBottom: isActive ? "2px solid var(--accent, #7c3aed)" : "2px solid transparent",
                  cursor: tab.available ? "pointer" : "not-allowed",
                  whiteSpace: "nowrap",
                  opacity: tab.available ? 1 : 0.4,
                }}
              >
                <Icon size={14} />
                {tab.label}
                {!tab.available && (
                  <span style={{ fontSize: "var(--fs-xs)", opacity: 0.5, marginLeft: 2 }}>soon</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div data-task-center-content={activeTab} style={{ flex: 1, overflow: fillsViewport ? "hidden" : "auto" }}>
          {activeTab === "overview" && <OverviewTab onNavigate={setActiveTab} />}
          {activeTab === "delegation" && <DelegationTab />}
          {activeTab === "subagents" && (
            <SlotBridge
              name={TASK_CENTER_SUBAGENTS_SLOT}
              // 插件启用时「子智能体」页签由 LibraryOpsSceneView 接管（场景 + 设置）；
              // 插件禁用时回退到宿主自带的子智能体列表
              fallback={SubagentsTab}
              agents={subagentTasks}
              onSelectAgent={onSelectSubagent || (() => {})}
            />
          )}
          {activeTab === "automation" && <AutomationTab />}
          {activeTab === "teams" && <TeamTab />}
          {activeTab === "issues" && <IssuesTab focusIssueId={focusIssueId} onFocusConsumed={clearFocusIssue} />}
          {activeTab === "board" && <BoardTab />}
          {activeTab === "inbox" && <InboxTab />}
        </div>

        {/* Footer status bar */}
        <div
          style={{
            padding: "6px 20px",
            borderTop: "1px solid var(--border-primary)",
            fontSize: "var(--fs-xs)",
            color: "var(--text-secondary, #666)",
            display: "flex",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <span>
            {zh ? "任务管理面板" : "Task Center"} · {tabs.find((t) => t.id === activeTab)?.label}
          </span>
          {/* 委派限制读真实配置（原先写死「深度 2 · 并发 5」，与运行时配置可能不一致） */}
          <span>
            {zh
              ? `委派深度限制: ${limits.maxDepth} · 最大并发: ${limits.maxConcurrent}`
              : `Max depth: ${limits.maxDepth} · Max concurrent: ${limits.maxConcurrent}`}
          </span>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}

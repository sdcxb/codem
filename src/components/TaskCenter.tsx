/**
 * TaskCenter — 统一任务管理中心
 *
 * 将委派监控、子智能体监控、自动化任务、Issue/Board/Squad/Inbox
 * 全部归入一个面板，通过 Tab 切换。
 *
 * Phase 1: 骨架 + 现有功能归入（概览/委派/子智能体/自动化）
 * Phase 2+: 后续增加 Issues/Board/Squads/Inbox
 *
 * 扩展页签：`task-center.library`（由 @codem/ui-library-ops 贡献「图书馆」页签，
 * 把团队角色/子智能体在图书馆各岗位工作的动画场景 + 用量/工具/成本/错误/时间线
 * 融进本面板）。插件被禁用时该 slot 无贡献者 → 页签不出现，宿主 UI 回到原样。
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  LayoutDashboard,
  Link2,
  Bot,
  Clock,
  ClipboardList,
  Columns,
  Users,
  Inbox as InboxIcon,
  BookOpen,
} from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { useLang } from "../core/i18n/lang";
import { SlotBridge, useSlotHasEntries } from "../core/slots/SlotBridge";
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
  | "inbox"
  | "library";

/** 扩展页签的 slot 名（与 @codem/ui-library-ops 约定） */
export const TASK_CENTER_LIBRARY_SLOT = "task-center.library";

interface TaskCenterProps {
  onClose: () => void;
  initialTab?: TaskCenterTab;
  /** Subagent tasks from App state (for SubagentsTab) */
  subagentTasks?: any[];
  onSelectSubagent?: (taskId: string) => void;
}

/** 旧 tab id 兼容归一（squads → teams；外部旧调用仍可用） */
function normalizeTab(t: string): TaskCenterTab {
  return (t === "squads" ? "teams" : t) as TaskCenterTab;
}

export function TaskCenter({ onClose, initialTab = "overview", subagentTasks = [], onSelectSubagent }: TaskCenterProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [activeTab, setActiveTab] = useState<TaskCenterTab>(() => normalizeTab(initialTab));
  /** 图书馆扩展页签是否可用（插件启用时才为 true） */
  const hasLibrary = useSlotHasEntries(TASK_CENTER_LIBRARY_SLOT);

  const tabs: { id: TaskCenterTab; label: string; icon: typeof LayoutDashboard; available: boolean }[] = [
    { id: "overview", label: zh ? "概览" : "Overview", icon: LayoutDashboard, available: true },
    { id: "delegation", label: zh ? "委派" : "Delegation", icon: Link2, available: true },
    { id: "subagents", label: zh ? "子智能体" : "Sub-agents", icon: Bot, available: true },
    { id: "automation", label: zh ? "自动化" : "Automation", icon: Clock, available: true },
    { id: "issues", label: zh ? "Issues" : "Issues", icon: ClipboardList, available: true },
    { id: "board", label: zh ? "看板" : "Board", icon: Columns, available: true },
    { id: "teams", label: zh ? "团队" : "Teams", icon: Users, available: true },
    { id: "inbox", label: zh ? "收件箱" : "Inbox", icon: InboxIcon, available: true },
    ...(hasLibrary
      ? [{ id: "library" as TaskCenterTab, label: zh ? "图书馆" : "Library", icon: BookOpen, available: true }]
      : []),
  ];

  // 插件在面板打开期间被禁用 → 页签消失，回落到概览
  useEffect(() => {
    if (!tabs.some((t) => t.id === activeTab)) setActiveTab("overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLibrary]);

  const wide = activeTab === "library";

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
          borderRadius: "12px",
          border: "1px solid var(--border-color, #333344)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
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
            borderBottom: "1px solid var(--border-color, #333344)",
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
              borderRadius: "4px",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-tertiary, #2a2a3a)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          >
            <ActionIcons.close size={18} />
          </button>
        </div>

        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            gap: "2px",
            padding: "0 12px",
            borderBottom: "1px solid var(--border-color, #333344)",
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
                  <span style={{ fontSize: "9px", opacity: 0.5, marginLeft: 2 }}>soon</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflow: activeTab === "library" ? "hidden" : "auto" }}>
          {activeTab === "overview" && <OverviewTab onNavigate={setActiveTab} />}
          {activeTab === "delegation" && <DelegationTab />}
          {activeTab === "subagents" && (
            <SubagentsTab agents={subagentTasks} onSelectAgent={onSelectSubagent || (() => {})} />
          )}
          {activeTab === "automation" && <AutomationTab />}
          {activeTab === "teams" && <TeamTab />}
          {activeTab === "issues" && <IssuesTab />}
          {activeTab === "board" && <BoardTab />}
          {activeTab === "inbox" && <InboxTab />}
          {activeTab === "library" && <SlotBridge name={TASK_CENTER_LIBRARY_SLOT} fallback={null} />}
        </div>

        {/* Footer status bar */}
        <div
          style={{
            padding: "6px 20px",
            borderTop: "1px solid var(--border-color, #333344)",
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
          <span>{zh ? "委派深度限制: 2 · 最大并发: 5" : "Max depth: 2 · Max concurrent: 5"}</span>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}

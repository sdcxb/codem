/**
 * TaskCenter — 统一任务管理中心
 *
 * 将委派监控、子智能体监控、自动化任务、Issue/Board/Squad/Inbox
 * 全部归入一个面板，通过 Tab 切换。
 *
 * Phase 1: 骨架 + 现有功能归入（概览/委派/子智能体/自动化）
 * Phase 2+: 后续增加 Issues/Board/Squads/Inbox
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { LayoutDashboard, Link2, Bot, Clock, ClipboardList, Columns, Users, Inbox as InboxIcon } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { useLang } from "../core/i18n/lang";
import { OverviewTab } from "./task-center/OverviewTab";
import { DelegationTab } from "./task-center/DelegationTab";
import { SubagentsTab } from "./task-center/SubagentsTab";
import { AutomationTab } from "./task-center/AutomationTab";
import { SquadsTab } from "./task-center/SquadsTab";
import { IssuesTab } from "./task-center/IssuesTab";
import { BoardTab } from "./task-center/BoardTab";
import { InboxTab } from "./task-center/InboxTab";

export type TaskCenterTab = "overview" | "issues" | "board" | "squads" | "delegation" | "subagents" | "automation" | "inbox";

interface TaskCenterProps {
  onClose: () => void;
  initialTab?: TaskCenterTab;
  /** Subagent tasks from App state (for SubagentsTab) */
  subagentTasks?: any[];
  onSelectSubagent?: (taskId: string) => void;
}

export function TaskCenter({ onClose, initialTab = "overview", subagentTasks = [], onSelectSubagent }: TaskCenterProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [activeTab, setActiveTab] = useState<TaskCenterTab>(initialTab);

  const tabs: { id: TaskCenterTab; label: string; icon: typeof LayoutDashboard; available: boolean }[] = [
    { id: "overview", label: zh ? "概览" : "Overview", icon: LayoutDashboard, available: true },
    { id: "delegation", label: zh ? "委派" : "Delegation", icon: Link2, available: true },
    { id: "subagents", label: zh ? "子智能体" : "Sub-agents", icon: Bot, available: true },
    { id: "automation", label: zh ? "自动化" : "Automation", icon: Clock, available: true },
    { id: "issues", label: zh ? "Issues" : "Issues", icon: ClipboardList, available: true },
    { id: "board", label: zh ? "看板" : "Board", icon: Columns, available: true },
    { id: "squads", label: zh ? "Squads" : "Squads", icon: Users, available: true },
    { id: "inbox", label: zh ? "收件箱" : "Inbox", icon: InboxIcon, available: true },
  ];

  const panel = (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="task-center-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(960px, 92vw)",
          maxWidth: "95vw",
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
            <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
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
                  fontSize: "13px",
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
        <div style={{ flex: 1, overflow: "auto" }}>
          {activeTab === "overview" && <OverviewTab onNavigate={setActiveTab} />}
          {activeTab === "delegation" && <DelegationTab />}
          {activeTab === "subagents" && (
            <SubagentsTab agents={subagentTasks} onSelectAgent={onSelectSubagent || (() => {})} />
          )}
          {activeTab === "automation" && <AutomationTab />}
          {activeTab === "squads" && <SquadsTab />}
          {activeTab === "issues" && <IssuesTab />}
          {activeTab === "board" && <BoardTab />}
          {activeTab === "inbox" && <InboxTab />}
        </div>

        {/* Footer status bar */}
        <div
          style={{
            padding: "6px 20px",
            borderTop: "1px solid var(--border-color, #333344)",
            fontSize: "11px",
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

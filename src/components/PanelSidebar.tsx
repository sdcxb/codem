import { useState } from "react";
import { Bot, GitBranch, FolderOpen, ListChecks, Wrench, X } from "lucide-react";
import { useLang } from "../core/i18n/lang";
import { GitInfoPanel } from "./GitInfoPanel";
import { Workbench } from "./Workbench";
import { FileChangesList } from "./FileChangesList";
import { FileExplorer } from "./FileExplorer";
import { AgentRoster } from "./AgentRoster";
import { useProjectStore } from "../core/store";
import { useAppStore } from "../store";

type SidebarTab = "git" | "workbench" | "files" | "changes" | "agents";

interface RightSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function PanelSidebar({ open, onClose }: RightSidebarProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [activeTab, setActiveTab] = useState<SidebarTab>("git");
  const { currentProject, currentSession } = useProjectStore();
  const { isStreaming, currentModel } = useAppStore();
  const currentSessionId = currentSession?.id || "";

  if (!open) return null;

  return (
    <div
      className="floating-overlay-panel"
      style={{
        position: "fixed",
        top: "var(--chat-body-top, 48px)",
        right: 0,
        bottom: "var(--chat-body-bottom, 140px)",
        width: 360,
        zIndex: 150,
        display: "flex",
        flexDirection: "column",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.15)",
      }}>
      {/* Tab header */}
      <div className="panel-sidebar-tabs">
        {([
          { id: "git" as const, icon: GitBranch, label: "Git" },
          { id: "files" as const, icon: FolderOpen, label: zh ? "文件" : "Files" },
          { id: "changes" as const, icon: ListChecks, label: zh ? "变更" : "Changes" },
          { id: "workbench" as const, icon: Wrench, label: zh ? "工作台" : "Workbench" },
          { id: "agents" as const, icon: Bot, label: zh ? "智能体" : "Agents" },
        ]).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`panel-sidebar-tab ${active ? "active" : ""}`}
            >
              <Icon size={13} />
              <span className="panel-sidebar-tab-label">{tab.label}</span>
            </button>
          );
        })}
        <button onClick={onClose} className="panel-sidebar-close" aria-label={zh ? "关闭" : "Close"}>
          <X size={15} />
        </button>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
        {activeTab === "git" && <GitInfoPanel />}
        {activeTab === "workbench" && (
          <Workbench
            collapsed={false}
            onToggle={() => {}}
            activeTools={[]}
            modifiedFiles={[]}
          />
        )}
        {activeTab === "files" && currentProject && (
          <FileExplorer cwd={currentProject.path} onFileClick={(p) => {
            const { invoke } = (window as any).__TAURI__.core;
            // Trigger FileEditor via global event
            window.dispatchEvent(new CustomEvent("codem:open-file", { detail: p }));
          }} />
        )}
        {activeTab === "changes" && currentProject && (
          <FileChangesList sessionId={currentSessionId || ""} workspace={currentProject.path} />
        )}
        {activeTab === "agents" && (
          <AgentRoster
            sessionId={currentSessionId}
            mainModel={currentModel}
            isRunning={isStreaming}
          />
        )}
      </div>
    </div>
  );
}

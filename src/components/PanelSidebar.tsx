import { useState } from "react";
import { useLang } from "../core/i18n/lang";
import { GitInfoPanel } from "./GitInfoPanel";
import { Workbench } from "./Workbench";
import { FileChangesList } from "./FileChangesList";
import { FileExplorer } from "./FileExplorer";
import { useProjectStore } from "../core/store";

type SidebarTab = "git" | "workbench" | "files" | "changes";

interface RightSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function PanelSidebar({ open, onClose }: RightSidebarProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [activeTab, setActiveTab] = useState<SidebarTab>("git");
  const { currentProject, currentSession } = useProjectStore();
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
        background: "var(--dream-panel-bg, var(--bg-secondary))",
        backdropFilter: "blur(20px) saturate(1.5)",
        WebkitBackdropFilter: "blur(20px) saturate(1.5)",
      }}>
      {/* Tab header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid var(--border-color)",
        padding: "0 8px",
        height: 40,
        flexShrink: 0,
      }}>
        <button
          onClick={() => setActiveTab("git")}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: activeTab === "git" ? 600 : 400,
            color: activeTab === "git" ? "var(--accent)" : "var(--text-muted)",
            background: activeTab === "git" ? "var(--bg-tertiary)" : "transparent",
            border: "none",
            borderRadius: "6px 6px 0 0",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          🌿 {zh ? "Git" : "Git"}
        </button>
        <button
          onClick={() => setActiveTab("files")}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: activeTab === "files" ? 600 : 400,
            color: activeTab === "files" ? "var(--accent)" : "var(--text-muted)",
            background: activeTab === "files" ? "var(--bg-tertiary)" : "transparent",
            border: "none",
            borderRadius: "6px 6px 0 0",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          📁 {zh ? "文件" : "Files"}
        </button>
        <button
          onClick={() => setActiveTab("changes")}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: activeTab === "changes" ? 600 : 400,
            color: activeTab === "changes" ? "var(--accent)" : "var(--text-muted)",
            background: activeTab === "changes" ? "var(--bg-tertiary)" : "transparent",
            border: "none",
            borderRadius: "6px 6px 0 0",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          📋 {zh ? "变更" : "Changes"}
        </button>
        <button
          onClick={() => setActiveTab("workbench")}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: activeTab === "workbench" ? 600 : 400,
            color: activeTab === "workbench" ? "var(--accent)" : "var(--text-muted)",
            background: activeTab === "workbench" ? "var(--bg-tertiary)" : "transparent",
            border: "none",
            borderRadius: "6px 6px 0 0",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          🛠 {zh ? "工作台" : "Workbench"}
        </button>
        <button
          onClick={onClose}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          ✕
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
      </div>
    </div>
  );
}

import { useState } from "react";
import { useLang } from "../core/i18n/lang";
import { GitInfoPanel } from "./GitInfoPanel";
import { Workbench } from "./Workbench";

type SidebarTab = "git" | "workbench";

interface RightSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function PanelSidebar({ open, onClose }: RightSidebarProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [activeTab, setActiveTab] = useState<SidebarTab>("git");

  if (!open) return null;

  return (
    <div style={{
      position: "fixed",
      top: 40,
      right: 0,
      bottom: 0,
      width: 360,
      zIndex: 150,
      background: "var(--bg-secondary)",
      borderLeft: "1px solid var(--border-color)",
      display: "flex",
      flexDirection: "column",
      boxShadow: "-4px 0 16px rgba(0,0,0,0.15)",
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
      </div>
    </div>
  );
}

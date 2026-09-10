import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { GitBranch, FolderOpen, ListChecks, Wrench, Activity } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { useLang } from "../core/i18n/lang";
import { GitInfoPanel } from "./GitInfoPanel";
import { Workbench } from "./Workbench";
import { FileChangesList } from "./FileChangesList";
import { FileExplorer } from "./FileExplorer";
import { CicdPanel } from "./CicdPanel";
import { useProjectStore } from "../core/store";

type SidebarTab = "git" | "workbench" | "files" | "changes" | "cicd";

/** 读取被禁用的插件列表 */
function useDisabledPlugins(): string[] {
  const [list, setList] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('codem:disabled-plugins');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  useEffect(() => {
    const onUpdate = () => {
      try {
        const raw = localStorage.getItem('codem:disabled-plugins');
        setList(raw ? JSON.parse(raw) : []);
      } catch {}
    };
    window.addEventListener('codem:plugin-state-changed', onUpdate);
    window.addEventListener('storage', onUpdate);
    return () => {
      window.removeEventListener('codem:plugin-state-changed', onUpdate);
      window.removeEventListener('storage', onUpdate);
    };
  }, []);
  return list;
}

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
  const disabledPlugins = useDisabledPlugins();
  const cicdEnabled = !disabledPlugins.includes('@codem/ui-misc');

  // 构建 tab 列表 — CI/CD tab 根据插件状态条件渲染
  // 注：智能体活动已收敛至对话顶部「智能体与团队」按钮（AgentPanel，个体 + 团队双维度），此处不再单列
  const tabs: Array<{ id: SidebarTab; icon: typeof GitBranch; label: string }> = [
    { id: "git", icon: GitBranch, label: "Git" },
    { id: "files", icon: FolderOpen, label: zh ? "文件" : "Files" },
    { id: "changes", icon: ListChecks, label: zh ? "变更" : "Changes" },
    { id: "workbench", icon: Wrench, label: zh ? "工作台" : "Workbench" },
  ];
  if (cicdEnabled) {
    tabs.push({ id: "cicd", icon: GitBranch, label: "CI/CD" });
  }

  // 如果当前 activeTab 被隐藏了，回退到 git
  const effectiveTab = tabs.some(t => t.id === activeTab) ? activeTab : "git";

  if (!open) return null;

  // Bug1: 用 Portal 渲染到 body，避免祖先 backdrop-filter/overflow:hidden 导致 fixed 定位失效
  const panelContent = (
    <div
      className="floating-overlay-panel panel-sidebar-shell"
      style={{
        position: "fixed",
        top: "var(--chat-body-top, 48px)",
        right: 8,
        bottom: "var(--chat-body-bottom, 140px)",
        width: 420,
        maxWidth: "calc(100vw - 16px)",
        // 高于消息导航轨 ScrollbarMarkers（z 900/901），磨砂背景不透出紫色节点
        zIndex: 920,
        display: "flex",
        flexDirection: "column",
        boxShadow: "-4px 0 16px var(--shadow-color-soft)",
        borderRadius: "var(--radius, 12px)",
        overflow: "hidden",
      }}
    >
      {/* Tab header */}
      <div className="panel-sidebar-tabs">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = effectiveTab === tab.id;
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
          <ActionIcons.close size={15} />
        </button>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
        {effectiveTab === "git" && <GitInfoPanel />}
        {effectiveTab === "workbench" && (
          <Workbench
            collapsed={false}
            onToggle={() => {}}
            activeTools={[]}
            modifiedFiles={[]}
          />
        )}
        {effectiveTab === "files" && currentProject && (
          <FileExplorer cwd={currentProject.path} onFileClick={(p) => {
            const { invoke } = (window as any).__TAURI__.core;
            // Trigger FileEditor via global event
            window.dispatchEvent(new CustomEvent("codem:open-file", { detail: p }));
          }} />
        )}
        {effectiveTab === "changes" && currentProject && (
          <FileChangesList sessionId={currentSessionId || ""} workspace={currentProject.path} />
        )}
        {effectiveTab === "cicd" && cicdEnabled && (
          <CicdPanel />
        )}
      </div>
    </div>
  );

  return createPortal(panelContent, document.body);
}

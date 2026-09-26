import { useState, useEffect } from "react";
import { createPortal } from "./ui/portal";
import { GitBranch, FolderOpen, ListChecks, Wrench, Activity } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { useLang } from "../core/i18n/lang";
import { GitInfoPanel } from "./GitInfoPanel";
import { Workbench } from "./Workbench";
import { FileChangesList } from "./FileChangesList";
import { FileExplorer } from "./FileExplorer";
import { CicdPanel } from "./CicdPanel";
import { useProjectStore } from "../core/store";
// 第 47 轮补：工作台面板的文件改动区块要读**真实数据**（原来是硬编码空数组）
import { FileChangeStorage } from "../core/storage/file-change-storage";
import { onFileChangesTracked } from "../core/environment/file-change-tracker";

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
  /**
   * 第 47 轮补：工作台面板的真实状态与数据（原来三个值全是硬编码，
   * 见下面渲染处的长注释）。`modifiedFiles` 读的是**本会话的逐轮文件改动**，
   * 与 `FileChangesList` 同一份来源。
   */
  const [workbenchCollapsed, setWorkbenchCollapsed] = useState(false);
  const [modifiedFiles, setModifiedFiles] = useState<
    Array<{ path: string; additions: number; deletions: number }>
  >([]);
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

  /**
   * 第 47 轮补：把本会话的逐轮文件改动取出来喂给工作台。
   *
   * 只在**切到工作台 tab 时**读（那是低频动作），并订阅 `onFileChangesTracked`
   * 以便新回合改动后自动刷新 —— 与 `FileChangesList` 同一种做法。
   */
  useEffect(() => {
    if (effectiveTab !== "workbench" || !currentSessionId) {
      setModifiedFiles([]);
      return;
    }
    const load = () => {
      try {
        const records = FileChangeStorage.listBySession(currentSessionId);
        const byPath = new Map<string, { path: string; additions: number; deletions: number }>();
        for (const rec of records) {
          let files: Array<{ path: string; status: string }> = [];
          try {
            const parsed = rec.changed_files ? JSON.parse(rec.changed_files) : [];
            if (Array.isArray(parsed)) files = parsed;
          } catch {
            /* 坏行跳过：一个坏记录不该让整块面板空掉 */
          }
          for (const f of files) {
            // 同一文件在多轮里被改 → 合并（路径去重），不做数值上的真假推断
            if (!byPath.has(f.path)) byPath.set(f.path, { path: f.path, additions: 0, deletions: 0 });
          }
        }
        setModifiedFiles([...byPath.values()]);
      } catch (e) {
        console.warn("[PanelSidebar] 读取本会话文件改动失败（工作台文件区块留空）:", e);
        setModifiedFiles([]);
      }
    };
    load();
    const unsub = onFileChangesTracked(load);
    return unsub;
  }, [effectiveTab, currentSessionId]);

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
        width: "var(--panel-sidebar-width, 520px)",
        maxWidth: "calc(100vw - 16px)",
        // 高于消息导航轨 ScrollbarMarkers（z 900/901），磨砂背景不透出紫色节点
        zIndex: "var(--z-floating)",
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
              <Icon size={14} />
              <span className="panel-sidebar-tab-label">{tab.label}</span>
            </button>
          );
        })}
        <button onClick={onClose} className="panel-sidebar-close" aria-label={zh ? "关闭" : "Close"}>
          <ActionIcons.close size={14} />
        </button>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
        {effectiveTab === "git" && <GitInfoPanel />}
        {effectiveTab === "workbench" && (
          /*
            第 47 轮补（UI/UX 审计 P1 的"死控件"那一类）：
            这里原来传的是 `collapsed={false}` + `onToggle={() => {}}` +
            `modifiedFiles={[]}` —— 三个硬编码值让工作台变成**一块永远折叠不了、
            也永远没有内容的空面板**（`Workbench` 的内容完全来自这两个数组）。

            修法：
            - `collapsed` / `onToggle` 接**真实状态**（折叠按钮真的有反应）；
            - `modifiedFiles` 接 `FileChangeStorage.listBySession(currentSessionId)`
              的**真实数据**（那是本会话的逐轮文件改动，`FileChangesList` 读的同一份）。
            - `activeTools` 暂时仍为空数组 —— 如实说明：本仓库目前**没有**"正在执行的工具"
              的响应式数据源（`agentActivities` 的形态是 {step,total}，与此处的
              `{name,status}` 不同，硬映射会造出一个看着像真的、其实是猜的列表）。
              与其编一个，不如让它空着 —— 面板会因此不渲染该区块（不是显示假数据）。
          */
          <Workbench
            collapsed={workbenchCollapsed}
            onToggle={() => setWorkbenchCollapsed((v) => !v)}
            activeTools={[]}
            modifiedFiles={modifiedFiles}
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

  return createPortal(panelContent);
}

/**
 * RightSidebar — 上下文工具面板
 *
 * 设计参考 frakio-work 的 right-rail：
 * - 纯上下文工具面板，只放需要和对话并排操作的工具
 * - Files: 项目文件浏览
 * - Browser: 内嵌网页浏览
 * - 运行监控类内容（活动时间线、概览等）不在右侧栏，在主对话流中
 *
 * 变更说明：
 * - 移除了 Activity / Overview / Git / Agents tab（与主对话或左侧栏重复）
 * - 移除了底部 Agent 状态卡片、新手引导、最近对话、推荐下一步等区域
 * - 只保留上下文工具：Files + Browser
 */

import { useState } from "react";
import { useLang } from "../core/i18n/lang";
import { Folder, Globe, ChevronRight, ChevronLeft, ArrowLeft, FileDiff, Bot } from "lucide-react";
import type { SubagentTask } from "../core/subagent/subagent";
import { ActionIcons } from "../core/icons/icon-map";
import { useProjectStore } from "../core/store";
import { useAppStore } from "../store";
import { FileExplorer } from "./FileExplorer";
import { FileEditor } from "./FileEditor";
import { FileChangesList } from "./FileChangesList";
import { useStableContextWaterLevel } from "../core/context/water-level";
import { usePaneResize } from "../hooks/usePaneResize";
import { RightSidebarResizeHandle } from "./RightSidebarResizeHandle";

interface RightSidebarProps {
  /** 外部控制收起状态（由顶部 TitleBar 的 rightRailOpen 驱动） */
  collapsed?: boolean;
  /** 切换收起/展开（由顶部 TitleBar 按钮 驱动） */
  onToggleCollapse?: () => void;
  /** 未使用，保留兼容 */
  onNewChat?: () => void;
  onNewProject?: () => void;
  onImportProject?: () => void;
  onGitHubClone?: () => void;
  onOpenSession?: (sessionId: string, projectId: string) => void;
  /** 当前正在编辑/预览的文件路径（由 App 级别管理，支持 codem:open-file 事件） */
  editingFile?: string | null;
  onEditingFileChange?: (path: string | null) => void;
  /** 文件刷新 key */
  refreshKey?: number;
  /** 当前会话与工作区由 App 直接传入，避免右栏自己从 store 猜空 */
  sessionId?: string | null;
  workspace?: string | null;
  /** 真实子代理任务列表（由 App 的 SubagentRuntime 订阅提供） */
  agents?: SubagentTask[];
}

export function RightSidebar(props: RightSidebarProps = {}) {
  const lang = useLang();
  const zh = lang === "zh";
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<"changes" | "files" | "subagents" | "browser">("files");
  const { currentProject, currentSession, sessions, projects } = useProjectStore();
  const loadedSessionId = useAppStore((s) => s.loadedSessionId);
  const contextWater = useStableContextWaterLevel(
    props.sessionId || currentSession?.id || loadedSessionId || "",
  );
  const editingFile = props.editingFile ?? null;
  const setEditingFile = props.onEditingFileChange ?? (() => {});

  // Support both external controlled mode (from TitleBar) and internal mode
  const collapsed = props.collapsed ?? internalCollapsed;
  const toggleCollapse = () => {
    if (props.onToggleCollapse) {
      props.onToggleCollapse();
    } else {
      setInternalCollapsed(!internalCollapsed);
    }
  };

  // Browser state
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserInput, setBrowserInput] = useState("");

const RIGHT_SIDEBAR_DEFAULT_WIDE = 400;
const RIGHT_SIDEBAR_DEFAULT_NARROW = 360;

/**
 * 本档默认宽度（第 233 轮 · 二次升级 Phase B）。
 *
 * 抽成函数而不是直接写进 `initial`：双击复位也要用**同一个**口径，
 * 否则"默认值"会出现第二套真相（这正是本仓库反复吃过的亏）。
 */
function rightSidebarDefaultWidth(): number {
  if (typeof window === "undefined") return RIGHT_SIDEBAR_DEFAULT_WIDE;
  return window.innerWidth <= 1440 ? RIGHT_SIDEBAR_DEFAULT_NARROW : RIGHT_SIDEBAR_DEFAULT_WIDE;
}

const { width: sidebarWidth, isResizing, onResizeStart, resizeBy, resizeTo } = usePaneResize({
min: 300,
max: 800,
/* P2-2：1440 宽给 360，宽屏给 400；持久化值仍优先。 */
initial: rightSidebarDefaultWidth(),
storageKey: "right-sidebar-width",
});

// 不再膨胀侧栏宽度——文件预览替换文件树，占满侧栏全部宽度
const effectiveWidth = sidebarWidth;

  // Collapsed mode — thin rail with expand button
  if (collapsed) {
    return (
      <aside className="right-sidebar right-sidebar-collapsed" style={{ width: 24, flexShrink: 0 }}>
        <button
          className="right-sidebar-toggle-collapsed"
          onClick={toggleCollapse}
          title={zh ? "展开右侧栏" : "Expand"}
          aria-label={zh ? "展开右侧栏" : "Expand"}
        >
          <ChevronLeft size={16} />
        </button>
      </aside>
    );
  }

  const tabs = [
    { id: "changes" as const, icon: FileDiff, label: zh ? "改动" : "Changes" },
    { id: "files" as const, icon: Folder, label: zh ? "文件" : "Files" },
    { id: "subagents" as const, icon: Bot, label: zh ? "子代理" : "Agents" },
    { id: "browser" as const, icon: Globe, label: zh ? "浏览器" : "Browser" },
  ];

  return (
    <aside className="right-sidebar" style={{ width: effectiveWidth, flexShrink: 0 }}>
      {/* Resize handle：8px 命中区 + 2px 视觉线；可聚焦，方向键同样能调宽 */}
      <RightSidebarResizeHandle
        width={sidebarWidth}
        min={300}
        max={800}
        active={isResizing}
        label={zh ? "拖动调整右侧栏宽度" : "Resize right sidebar"}
        onPointerDown={onResizeStart}
        onResizeBy={resizeBy}
        onResizeTo={resizeTo}
        onReset={() => resizeTo(rightSidebarDefaultWidth())}
      />

      {/* Collapse button */}
      <button
        className="right-sidebar-toggle"
        onClick={toggleCollapse}
        title={zh ? "收起右侧栏" : "Collapse"}
        aria-label={zh ? "收起右侧栏" : "Collapse"}
      >
        <ChevronRight size={14} />
      </button>

      {/* Tab header */}
      <div className="right-sidebar-tabs">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              className={`right-sidebar-tab ${active ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={14} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="right-sidebar-content">
        {activeTab === "changes" && (() => {
          const sessionId = props.sessionId || currentSession?.id || loadedSessionId || "";
          const session = sessions.find((s) => s.id === sessionId);
          const sessionProject = projects.find((p) => p.id === session?.projectId);
          const workspace = props.workspace || currentProject?.path || sessionProject?.path || "";
          return sessionId && workspace ? (
            <>
              <FileChangesList sessionId={sessionId} workspace={workspace} />
              <div className="inspector-context">
                <span>{zh ? "上下文" : "Context"}</span>
                <span className="inspector-context-value">
                  {contextWater.level.authoritative
                    ? `${Math.round(contextWater.level.percent)}%`
                    : "—"}
                </span>
              </div>
              <div className="inspector-foot">
                {workspace.split(/[/\\]/).filter(Boolean).pop() || workspace}
              </div>
            </>
          ) : (
            <div className="empty-hint is-fill">
              {zh ? "选择会话和项目后查看改动" : "Select a session and project to view changes"}
            </div>
          );
        })()}
        {activeTab === "files" && (
          currentProject ? (
            editingFile ? (
              /* 文件预览模式：占满侧栏宽度，不膨胀侧栏，不挤压主对话区 */
              <div className="right-sidebar-file-preview">
                <button
                  className="right-sidebar-back-btn"
                  onClick={() => setEditingFile(null)}
                  title={zh ? "返回文件树" : "Back to file tree"}
                >
                  <ArrowLeft size={14} />
                  <span>{zh ? "文件树" : "Files"}</span>
                </button>
                <div className="right-sidebar-preview-body">
                  {/*
                    key={editingFile}：切换文件时**必须换新实例**。
                    没有 key 时 React 复用同一个 FileEditor，内部 state（content / modified）
                    会跨文件残留 —— 读不到新文件内容时点"保存"就是把上一个文件的正文写进新路径
                    （真落盘、不可撤销）。见 P0-3 回归用例 RA-1 / RA-2
                    （renderer-robustness-a.test.tsx）。
                  */}
                  <FileEditor
                    key={editingFile}
                    filePath={editingFile}
                    onClose={() => setEditingFile(null)}
                  />
                </div>
              </div>
            ) : (
              <FileExplorer
                cwd={currentProject.path}
                onFileClick={(p) => setEditingFile(p)}
                refreshKey={props.refreshKey}
              />
            )
          ) : (
            <div className="empty-hint is-fill">
              {zh ? "选择项目后可浏览文件" : "Select a project to browse files"}
            </div>
          )
        )}

        {activeTab === "subagents" && (
          (props.agents?.length ?? 0) > 0 ? (
            <div className="inspector-agent-list">
              {props.agents!.map((a) => (
                <div key={a.id} className="inspector-agent-row">
                  <span className={`inspector-agent-dot ${a.status}`} />
                  <span className="inspector-agent-title">{a.name || a.id}</span>
                  <span className="inspector-agent-status">{a.status}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-hint is-fill">
              {zh ? "当前没有子代理任务" : "No subagent tasks"}
            </div>
          )
        )}
        {activeTab === "browser" && (
          <div className="right-sidebar-browser">
            <div className="browser-url-bar">
              <input
                type="url"
                placeholder="https://..."
                value={browserInput}
                onChange={(e) => setBrowserInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && browserInput.trim()) {
                    const url = browserInput.trim().startsWith("http")
                      ? browserInput.trim()
                      : `https://${browserInput.trim()}`;
                    setBrowserUrl(url);
                  }
                }}
              />
              <button
                className="browser-go-btn"
                onClick={() => {
                  if (!browserInput.trim()) return;
                  const url = browserInput.trim().startsWith("http")
                    ? browserInput.trim()
                    : `https://${browserInput.trim()}`;
                  setBrowserUrl(url);
                }}
              >
                Go
              </button>
            </div>
            {browserUrl ? (
              <iframe
                src={browserUrl}
                title="browser"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            ) : (
              <div className="empty-hint is-fill">
                {zh ? "输入网址开始浏览" : "Enter a URL to browse"}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}


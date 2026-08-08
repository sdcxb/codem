﻿﻿﻿/**
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
import { Folder, Globe, X, ChevronRight, ChevronLeft } from "lucide-react";
import { useProjectStore } from "../core/store";
import { FileExplorer } from "./FileExplorer";
import { usePaneResize } from "../hooks/usePaneResize";

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
}

export function RightSidebar(props: RightSidebarProps = {}) {
  const lang = useLang();
  const zh = lang === "zh";
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<"files" | "browser">("files");
  const { currentProject } = useProjectStore();

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

  const { width: sidebarWidth, isResizing, onResizeStart } = usePaneResize({
    min: 280,
    max: 500,
    initial: 344,
    storageKey: "right-sidebar-width",
  });

  // Collapsed mode — thin rail with expand button
  if (collapsed) {
    return (
      <aside className="right-sidebar right-sidebar-collapsed" style={{ width: 36 }}>
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
    { id: "files" as const, icon: Folder, label: zh ? "文件" : "Files" },
    { id: "browser" as const, icon: Globe, label: zh ? "浏览器" : "Browser" },
  ];

  return (
    <aside className="right-sidebar" style={{ width: sidebarWidth, flexShrink: 0 }}>
      {/* Resize handle */}
      <div
        className={`right-sidebar-resize-handle ${isResizing ? "active" : ""}`}
        onPointerDown={onResizeStart}
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
              <Icon size={13} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="right-sidebar-content">
        {activeTab === "files" && (
          currentProject ? (
            <FileExplorer
              cwd={currentProject.path}
              onFileClick={(p) => {
                window.dispatchEvent(new CustomEvent("codem:open-file", { detail: p }));
              }}
            />
          ) : (
            <div className="right-sidebar-empty">
              {zh ? "选择项目后可浏览文件" : "Select a project to browse files"}
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
              <div className="right-sidebar-empty">
                {zh ? "输入网址开始浏览" : "Enter a URL to browse"}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * 自定义标题栏
 * - decorations: false 后用此组件替代系统标题栏
 * - data-tauri-drag-region 支持拖拽窗口
 * - 最小化 / 最大化 / 关闭按钮
 * - 透明背景，让 Mica 毛玻璃透出
 * - 集成 GitBranchSelector、侧边栏切换、新对话按钮
 */

import { useState, useEffect, useCallback } from "react";
import { PanelLeftClose, PanelLeftOpen, PencilLine, Search, Settings, Sun, Moon, PanelRight, PanelRightOpen } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { GitBranchSelector } from "./GitBranchSelector";
import { getSetting, setSetting } from "../core/storage/settings";
import { ThemeManager } from "../core/theme";
import { useProjectStore } from "../core/store";

export interface WorkspaceTab {
  id: string;
  title: string;
  active: boolean;
}

interface TitleBarProps {
  /** 侧边栏是否打开 */
  sidebarOpen?: boolean;
  /** 切换侧边栏 */
  onToggleSidebar?: () => void;
  /** 新对话回调 */
  onNewChat?: () => void;
  /** P1: 搜索回调 */
  onSearch?: () => void;
  /** P1: 设置回调 */
  onSettings?: () => void;
  /** 右侧栏是否可见 */
  rightRailOpen?: boolean;
  /** 切换右侧栏 */
  onToggleRightRail?: () => void;
  /** 工作区标签（可选） */
  workspaceTabs?: WorkspaceTab[];
  /** 切换工作区标签 */
  onSwitchTab?: (id: string) => void;
  /** 关闭工作区标签 */
  onCloseTab?: (id: string) => void;
}

export function TitleBar({
  sidebarOpen = true,
  onToggleSidebar,
  onNewChat,
  onSearch,
  onSettings,
  rightRailOpen = false,
  onToggleRightRail,
  workspaceTabs = [],
  onSwitchTab,
  onCloseTab,
}: TitleBarProps = {}) {
  const [maximized, setMaximized] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() => (getSetting("codem-theme") as "dark" | "light") || "dark");
  // P3: Detect platform for Mac-style window controls
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  // Bug fix: DB 初始化完成后重新读取保存的主题，避免状态与 DOM 不一致
  const dbReady = useProjectStore((s) => s.dbReady);
  useEffect(() => {
    if (!dbReady) return;
    try {
      const saved = getSetting("codem-theme") as "dark" | "light" | null;
      if (saved && saved !== theme) {
        setTheme(saved);
        // 只有默认皮肤才由 TitleBar 管理 data-theme
        const skin = ThemeManager.getSkin();
        if (skin !== 'dream' && skin !== 'hub') {
          document.documentElement.setAttribute("data-theme", saved);
        }
      }
    } catch {}
  }, [dbReady]);

  const getWin = useCallback(() => {
    try {
      const tauri = (window as any).__TAURI__;
      if (tauri?.window?.getCurrentWindow) {
        return tauri.window.getCurrentWindow();
      }
    } catch {}
    return null;
  }, []);

  useEffect(() => {
    const win = getWin();
    if (!win) return;
    win.isMaximized().then((m: boolean) => setMaximized(m)).catch(() => {});

    const interval = setInterval(() => {
      win.isMaximized().then((m: boolean) => setMaximized(m)).catch(() => {});
    }, 500);

    return () => clearInterval(interval);
  }, [getWin]);

  const handleMinimize = useCallback(() => {
    getWin()?.minimize().catch(() => {});
  }, [getWin]);

  const handleToggleMaximize = useCallback(() => {
    getWin()?.toggleMaximize().catch(() => {});
  }, [getWin]);

  const handleClose = useCallback(() => {
    getWin()?.close().catch(() => {});
  }, [getWin]);

  // P1: Apply theme on mount + handle theme toggle
  useEffect(() => {
    // 梦幻皮肤由 ThemeManager 管理 data-theme（根据背景图自适应），这里不覆盖
    // Hub 皮肤是暗色皮肤，由 ThemeManager 强制 data-theme=dark，不覆盖
    const skin = ThemeManager.getSkin();
    if (skin === 'dream' || skin === 'hub') return;
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setSetting("codem-theme", next);
    // 梦幻皮肤和 Hub 皮肤由 ThemeManager 管理 data-theme，不覆盖
    const skin = ThemeManager.getSkin();
    if (skin === 'dream' || skin === 'hub') return;
    document.documentElement.setAttribute("data-theme", next);
  }, [theme]);

  // P1: Cmd+K shortcut for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && onSearch) {
        e.preventDefault();
        onSearch();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSearch]);

  return (
    <div className="titlebar" data-tauri-drag-region>
      {/* P3: Mac-style window controls (left side) */}
      {isMac && (
        <div className="titlebar-buttons-mac" style={{ marginRight: 8 }}>
          <button className="mac-btn mac-btn-close" onClick={handleClose} title="关闭" />
          <button className="mac-btn mac-btn-minimize" onClick={handleMinimize} title="最小化" />
          <button className="mac-btn mac-btn-maximize" onClick={handleToggleMaximize} title={maximized ? "还原" : "最大化"} />
        </div>
      )}

      <div className="titlebar-left" data-tauri-drag-region>
        {onToggleSidebar && (
          <button
            className="titlebar-action-btn"
            onClick={onToggleSidebar}
            title={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
            aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
          >
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
        )}
        {onNewChat && (
          <button
            className="titlebar-action-btn"
            onClick={onNewChat}
            title="新对话"
            aria-label="新对话"
          >
            <PencilLine size={16} />
          </button>
        )}
        <span className="titlebar-icon" data-tauri-drag-region>◆</span>
        <span className="titlebar-title" data-tauri-drag-region>Codem</span>
      </div>

      {/* 工作区标签栏（可选） */}
      {workspaceTabs.length > 0 && (
        <div className="titlebar-tabs" role="tablist" data-tauri-drag-region>
          {workspaceTabs.map((tab) => (
            <div
              key={tab.id}
              className={`titlebar-tab ${tab.active ? "active" : ""}`}
            >
              <button
                role="tab"
                aria-selected={tab.active}
                onClick={() => onSwitchTab?.(tab.id)}
              >
                <span>{tab.title}</span>
              </button>
              {onCloseTab && (
                <button
                  className="titlebar-tab-close"
                  onClick={() => onCloseTab(tab.id)}
                  aria-label={`关闭 ${tab.title}`}
                >
                  <ActionIcons.close size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="titlebar-center" data-tauri-drag-region>
        <GitBranchSelector compact={false} refreshInterval={5000} />
      </div>

      {/* 右侧栏切换 + P1: Top navigation actions — search, settings, theme */}
      <div className="titlebar-nav-actions">
        {onToggleRightRail && (
          <button
            className={`titlebar-action-btn ${rightRailOpen ? "active" : ""}`}
            onClick={onToggleRightRail}
            title={rightRailOpen ? "收起右侧栏" : "展开右侧栏"}
            aria-label={rightRailOpen ? "收起右侧栏" : "展开右侧栏"}
          >
            {rightRailOpen ? <PanelRightOpen size={15} /> : <PanelRight size={15} />}
          </button>
        )}
        {onSearch && (
          <button
            className="titlebar-action-btn"
            onClick={onSearch}
            title="搜索 (Ctrl+K)"
            aria-label="搜索"
          >
            <Search size={15} />
          </button>
        )}
        {onSettings && (
          <button
            className="titlebar-action-btn"
            onClick={onSettings}
            title="设置"
            aria-label="设置"
          >
            <Settings size={15} />
          </button>
        )}
        <button
          className="titlebar-action-btn theme-toggle"
          onClick={toggleTheme}
          title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
          aria-label="切换主题"
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>

      {/* P3: Windows-style window controls (right side) — hidden on Mac */}
      {!isMac && (
        <div className="titlebar-buttons">
          <button
            className="titlebar-btn titlebar-btn-minimize"
            onClick={handleMinimize}
            title="最小化"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            className="titlebar-btn titlebar-btn-maximize"
            onClick={handleToggleMaximize}
            title={maximized ? "还原" : "最大化"}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M3 3 V1 H9 V7 H7" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </button>
          <button
            className="titlebar-btn titlebar-btn-close"
            onClick={handleClose}
            title="关闭"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
              <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

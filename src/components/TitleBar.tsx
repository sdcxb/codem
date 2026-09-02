/**
 * 自定义标题栏
 * - decorations: false 后用此组件替代系统标题栏
 * - data-tauri-drag-region 支持拖拽窗口
 * - 最小化 / 最大化 / 关闭按钮
 * - 透明背景，让 Mica 毛玻璃透出
 * - 集成 GitBranchSelector、侧边栏切换、新对话按钮
 */

import { useState, useEffect, useCallback } from "react";
import { PanelLeftClose, PanelLeftOpen, PencilLine, Search, Settings, Sun, Moon, PanelRight, PanelRightOpen, Home, GitBranch, Terminal } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import { GitBranchSelector } from "./GitBranchSelector";
import { getSetting, setSetting } from "../core/storage/settings";
import { ThemeManager } from "../core/theme";
import { useProjectStore } from "../core/store";
import { useAppStore } from "../store";
import { getLang } from "../core/i18n/lang";
import { getProjectExecutionMode, setProjectExecutionMode, hasUncommittedChanges, isGitRepo } from "../core/environment";
import type { ExecutionMode } from "../core/environment";

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
  /** 终端区域是否打开（顶部状态栏终端按钮，对标 dsh-desktop） */
  terminalOpen?: boolean;
  /** 切换终端区域 */
  onToggleTerminal?: () => void;
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
  terminalOpen = false,
  onToggleTerminal,
  workspaceTabs = [],
  onSwitchTab,
  onCloseTab,
}: TitleBarProps = {}) {
  const [maximized, setMaximized] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() => (getSetting("codem-theme") as "dark" | "light") || "dark");
  // 执行模式切换（本地处理 / 新工作树）—— 由 InputArea 底部 bar 移至顶部状态栏
  const currentProject = useProjectStore((s) => s.currentProject);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("current_workspace");
  const [isGitProject, setIsGitProject] = useState(false);
  const isStreaming = useAppStore((s) => s.isStreaming);
  const lang = getLang();
  const zh = lang === "zh";
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

  // 项目变化时加载执行模式 + 是否 Git 仓库
  const projectPath = currentProject?.path || "";
  useEffect(() => {
    if (!projectPath) {
      setExecutionMode("current_workspace");
      setIsGitProject(false);
      return;
    }
    setExecutionMode(getProjectExecutionMode(projectPath));
    isGitRepo(projectPath).then(setIsGitProject).catch(() => setIsGitProject(false));
  }, [projectPath]);

  // 监听执行模式外部变更（如设置面板/其他入口），保持按钮状态同步
  useEffect(() => {
    const handler = () => {
      if (projectPath) setExecutionMode(getProjectExecutionMode(projectPath));
    };
    window.addEventListener("codem-execution-mode-changed", handler);
    return () => window.removeEventListener("codem-execution-mode-changed", handler);
  }, [projectPath]);

  // 切换执行模式：非 Git 项目禁用；有未提交修改需确认
  const handleToggleExecutionMode = useCallback(async () => {
    if (!projectPath || isStreaming) return;
    const next: ExecutionMode = executionMode === "git_worktree" ? "current_workspace" : "git_worktree";
    if (next === "git_worktree" && !isGitProject) {
      alert(zh ? "需要 Git 仓库项目才能使用工作树模式" : "Git repository required for worktree mode");
      return;
    }
    try {
      const dirty = await hasUncommittedChanges(projectPath);
      if (dirty) {
        if (!confirm(zh
          ? "当前工作区有未提交的修改。切换模式可能导致修改丢失。确认切换？"
          : "The current workspace has uncommitted changes. Switching modes may cause loss. Continue?")) {
          return;
        }
      }
    } catch { /* 检查失败则继续 */ }
    setProjectExecutionMode(projectPath, next);
    setExecutionMode(next);
    // 通知 InputArea 等其他组件同步（如需要）
    window.dispatchEvent(new CustomEvent("codem-execution-mode-changed"));
  }, [projectPath, isStreaming, executionMode, isGitProject, zh]);

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
        {/* Bug9: 新建对话按钮已移至侧边栏全局对话栏右侧，此处删除 */}
        <span className="titlebar-icon" data-tauri-drag-region>◆</span>
        <span className="titlebar-title" data-tauri-drag-region>Codem</span>
        {/* 执行模式切换（本地处理 / 新工作树）—— 侧边栏按钮与项目 LOGO 右侧 */}
        <button
          className={`titlebar-action-btn execution-mode-toggle ${executionMode === "git_worktree" ? "active" : ""}`}
          onClick={handleToggleExecutionMode}
          disabled={!projectPath || isStreaming}
          title={!projectPath
            ? (zh ? "请先选择项目" : "Select a project first")
            : isStreaming
              ? (zh ? "流式生成中不可切换" : "Locked while streaming")
              : executionMode === "git_worktree"
                ? (zh ? "执行模式：新工作树（点击切换为本地处理）" : "Execution: worktree (click for local)")
                : (zh ? "执行模式：本地处理（点击切换为新工作树）" : "Execution: local (click for worktree)")}
          aria-label={zh ? "切换执行模式" : "Toggle execution mode"}
          style={{ marginLeft: 4, opacity: (!projectPath || isStreaming) ? 0.5 : 1 }}
        >
          {executionMode === "git_worktree" ? <GitBranch size={15} /> : <Home size={15} />}
          <span className="execution-mode-label">{executionMode === "git_worktree" ? (zh ? "新工作树" : "Worktree") : (zh ? "本地处理" : "Local")}</span>
        </button>
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
        {/* 终端按钮：点击后主对话区域下方出现终端区域（对标 dsh-desktop 顶部状态栏） */}
        {onToggleTerminal && (
          <button
            className={`titlebar-action-btn ${terminalOpen ? "active" : ""}`}
            onClick={onToggleTerminal}
            title={terminalOpen
              ? (zh ? "关闭终端" : "Close terminal")
              : (zh ? "打开终端" : "Open terminal")}
            aria-label={zh ? "切换终端" : "Toggle terminal"}
          >
            <Terminal size={15} />
          </button>
        )}
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

/**
 * 自定义标题栏
 * - decorations: false 后用此组件替代系统标题栏
 * - data-tauri-drag-region 支持拖拽窗口
 * - 最小化 / 最大化 / 关闭按钮
 * - 透明背景，让 Mica 毛玻璃透出
 * - 侧边栏切换、新对话按钮
 *   （Git 分支选择器已合并至右侧栏 Git 面板 GitInfoPanel，不再驻留标题栏）
 */

import { useState, useEffect, useCallback } from "react";
import { PencilLine, Search, Settings, Sun, Moon, Home, GitBranch, Terminal } from "lucide-react";
import { ActionIcons } from "../core/icons/icon-map";
import codemLogoUrl from "../assets/codem-logo.png";
import { getSetting, setSetting } from "../core/storage/settings";
import { ThemeManager } from "../core/theme";
import { DEFAULT_THEME, applyThemeAttribute, cacheTheme, isThemeMode, resolveEffectiveTheme } from "../core/theme/theme-default";
import { AppMenuBar } from "./AppMenuBar";
import type { AppMenuSection } from "./AppMenuBar";
import { buildAppShortcuts, isMacPlatform, matchesShortcut, shortcutAria, shortcutLabel } from "../core/shortcuts/app-shortcuts";
import { useProjectStore } from "../core/store";
import { useAppStore } from "../store";
import { getLang } from "../core/i18n/lang";
import { getProjectExecutionMode, setProjectExecutionMode, hasUncommittedChanges, isGitRepo } from "../core/environment";
import type { ExecutionMode } from "../core/environment";
import { alertDialog, confirmDialog } from "../core/ui/native-dialog";

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
  onNewChat,
  onSearch,
  onSettings,
  sidebarOpen = false,
  onToggleSidebar,
  terminalOpen = false,
  onToggleTerminal,
  workspaceTabs = [],
  onSwitchTab,
  onCloseTab,
}: TitleBarProps = {}) {
  const [maximized, setMaximized] = useState(false);
  // 第 60 波：主题初值必须与「已经是 DOM 现状 + 首屏镜像」一致，否则挂载时会把
  // 预渲染好的档位覆盖成默认档（用户报的"先白后暗 / 先黑后亮 / 黑→亮→黑"）。
  // resolveEffectiveTheme = DB（就绪后）→ 镜像 → 默认档；DB 未就绪时它给的就是镜像值。
  const [theme, setTheme] = useState<"dark" | "light">(() => resolveEffectiveTheme(getSetting));
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
      const saved = getSetting("codem-theme");
      if (isThemeMode(saved) && saved !== theme) {
        setTheme(saved);
        // 只有默认皮肤才由 TitleBar 管理 data-theme
        const skin = ThemeManager.getSkin();
        if (skin !== 'dream' && skin !== 'hub') {
          applyThemeAttribute(saved);
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
    applyThemeAttribute(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setSetting("codem-theme", next);
    // 第 45 轮 D-17：镜像必须在这里也写一次 —— 旧写法在 dream/hub 皮肤下**直接 return**，
    // 于是这两个皮肤的用户切过主题后，镜像永远停在旧档位，下次启动先按旧档位渲染一帧。
    // 镜像只是首屏预测（真相源仍是 DB 的 codem-theme），与当前皮肤无关，所以写在返回之前。
    cacheTheme(next);
    // 梦幻皮肤和 Hub 皮肤由 ThemeManager 管理 data-theme，不覆盖
    const skin = ThemeManager.getSkin();
    if (skin === 'dream' || skin === 'hub') return;
    applyThemeAttribute(next);
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
      void alertDialog(zh ? "需要 Git 仓库项目才能使用工作树模式" : "Git repository required for worktree mode");
      return;
    }
    try {
      const dirty = await hasUncommittedChanges(projectPath);
      if (dirty) {
        // ⚠️ 必须 `await`：dialog 插件把 `window.confirm` 换成了异步调用（返回 Promise，恒为真）。
        // 真机实测：旧写法下"有未提交修改"的询问根本没弹、模式却已经切过去了。
        if (!(await confirmDialog(zh
          ? "当前工作区有未提交的修改。切换模式可能导致修改丢失。确认切换？"
          : "The current workspace has uncommitted changes. Switching modes may cause loss. Continue?"))) {
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

  /**
   * 应用级快捷键（第 45 轮 D-14）。
   *
   * 菜单里印着的每个快捷键都必须**真的有人处理** —— 所以这里从
   * `core/shortcuts/app-shortcuts.ts` 的同一张表里取匹配规则，菜单标签也从那里取：
   * 标签与按键处理不可能再漂移（旧写法只有 Ctrl+K 有 handler，其余 4 条纯装饰，
   * 还会经 `aria-keyshortcuts` 播报给辅助技术）。
   *
   * 平台差异：macOS 上 `⌘Q` 由系统菜单处理（这里不显示、不接管）；
   * 可编辑控件里不抢 `Ctrl+B`（那是光标左移）/`Ctrl+`` `（会打断输入）。
   */
  useEffect(() => {
    const mac = isMacPlatform();
    const specs = buildAppShortcuts(mac);
    const actions: Record<string, (() => void) | undefined> = {
      "new-chat": onNewChat,
      search: onSearch,
      settings: onSettings,
      sidebar: onToggleSidebar,
      terminal: onToggleTerminal,
    };
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      for (const spec of specs) {
        const action = actions[spec.id];
        if (typeof action !== "function") continue;
        if (!matchesShortcut(e, spec, mac)) continue;
        e.preventDefault();
        action();
        return; // 一次按键只触发一条
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onNewChat, onSearch, onSettings, onToggleSidebar, onToggleTerminal]);

  // 第 41 波：应用级菜单栏（文件 / 视图 / 帮助）。
  // 只放**真实可用**的命令 —— 菜单项全部映射到已有回调或已有快捷键上，
  // 不放灰掉的假项（那只会让人以为功能存在）。
  // 第 45 轮 D-14：`shortcut` / `aria-keyshortcuts` 都从 `APP_SHORTCUTS` 取，
  // 与上面那段 handler 同源；该平台不支持的项（如 mac 的 ⌘Q）返回 undefined，不显示。
  const appMenus: AppMenuSection[] = [
    {
      id: "file",
      label: zh ? "文件" : "File",
      items: [
        { id: "new-chat", label: zh ? "新建对话" : "New chat", shortcut: shortcutLabel("new-chat", isMac), ariaShortcut: shortcutAria("new-chat", isMac), onSelect: onNewChat },
        { id: "search", label: zh ? "搜索" : "Search", shortcut: shortcutLabel("search", isMac), ariaShortcut: shortcutAria("search", isMac), onSelect: onSearch },
        { id: "settings", label: zh ? "设置" : "Settings", shortcut: shortcutLabel("settings", isMac), ariaShortcut: shortcutAria("settings", isMac), separatorBefore: true, onSelect: onSettings },
        { id: "close", label: zh ? "关闭窗口" : "Close window", shortcut: shortcutLabel("close", isMac), ariaShortcut: shortcutAria("close", isMac), separatorBefore: true, onSelect: handleClose },
      ],
    },
    {
      id: "view",
      label: zh ? "视图" : "View",
      items: [
        { id: "sidebar", label: zh ? "显示/隐藏侧边栏" : "Toggle sidebar", shortcut: shortcutLabel("sidebar", isMac), ariaShortcut: shortcutAria("sidebar", isMac), onSelect: onToggleSidebar },
        { id: "terminal", label: zh ? "显示/隐藏终端" : "Toggle terminal", shortcut: shortcutLabel("terminal", isMac), ariaShortcut: shortcutAria("terminal", isMac), onSelect: onToggleTerminal },
        {
          id: "theme",
          label: theme === "dark" ? (zh ? "切换到浅色主题" : "Switch to light theme") : (zh ? "切换到深色主题" : "Switch to dark theme"),
          onSelect: toggleTheme,
        },
      ],
    },
    {
      id: "help",
      label: zh ? "帮助" : "Help",
      items: [
        { id: "commands", label: zh ? "命令与搜索" : "Commands & search", shortcut: shortcutLabel("search", isMac), ariaShortcut: shortcutAria("search", isMac), onSelect: onSearch },
        { id: "help-settings", label: zh ? "设置与帮助" : "Settings & help", onSelect: onSettings },
      ],
    },
  ];

  return (
    <div className={`titlebar ${isMac ? "titlebar--mac" : ""}`}>
      {/* 第 44 波：专用拖拽区（对齐参考实现的结构）——
          容器不再整条可拖，只在这条"中间空档"上可拖：左右各留安全区
          （mac 左侧红黄绿灯、Windows 右侧三个窗口按钮），交互元素不必再逐个 no-drag。
          此前是"整条可拖 + 每个按钮单独 no-drag"，漏一个就按钮点不动。 */}
      <div className="titlebar-drag-region" data-tauri-drag-region />

      {/* P3: Mac-style window controls (left side) */}
      {isMac && (
        <div className="titlebar-buttons-mac" style={{ marginRight: 8 }}>
          <button className="mac-btn mac-btn-close" onClick={handleClose} title="关闭" />
          <button className="mac-btn mac-btn-minimize" onClick={handleMinimize} title="最小化" />
          <button className="mac-btn mac-btn-maximize" onClick={handleToggleMaximize} title={maximized ? "还原" : "最大化"} />
        </div>
      )}

      <div className="titlebar-left">
        {/* Bug9: 新建对话按钮已移至侧边栏全局对话栏右侧，此处删除 */}
        <span className="titlebar-icon">
          <img src={codemLogoUrl} alt="Codem" className="titlebar-logo-img" />
        </span>
        <span className="titlebar-title">Codem</span>
        {/* 第 41 波：应用级菜单栏 —— 在应用名右侧，和原生桌面应用一致 */}
        <AppMenuBar zh={zh} menus={appMenus} />
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
          {executionMode === "git_worktree" ? <GitBranch size={14} /> : <Home size={14} />}
          <span className="execution-mode-label">{executionMode === "git_worktree" ? (zh ? "新工作树" : "Worktree") : (zh ? "本地处理" : "Local")}</span>
        </button>
      </div>

      {/* 工作区标签栏（可选） */}
      {workspaceTabs.length > 0 && (
        <div className="titlebar-tabs" role="tablist">
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
          {/* 第 44 波：标签条末尾的"新建"按钮（参考实现的 .mac-window-add-tab 同构）——
              标签条是唯一能一眼看出"这里可以再开一个"的位置，比只在菜单里放"新建对话"更好找 */}
          {onNewChat && (
            <button
              className="titlebar-add-tab"
              onClick={onNewChat}
              title={zh ? "新建对话" : "New chat"}
              aria-label={zh ? "新建对话" : "New chat"}
            >
              <ActionIcons.add size={12} />
            </button>
          )}
        </div>
      )}

      {/* 右侧栏切换 + P1: Top navigation actions — search, settings, theme。
          容器空白为可拖拽区（按钮自身 no-drag 仍可点击），保证标题栏中段可拖 */}
      <div className="titlebar-nav-actions" data-tauri-drag-region>
        {onSearch && (
          <button
            className="titlebar-action-btn"
            onClick={onSearch}
            title={`${zh ? "搜索" : "Search"} (${shortcutLabel("search", isMac) ?? ""})`}
            aria-label="搜索"
          >
            <Search size={14} />
          </button>
        )}
        {onSettings && (
          <button
            className="titlebar-action-btn"
            onClick={onSettings}
            title="设置"
            aria-label="设置"
          >
            <Settings size={14} />
          </button>
        )}
        <button
          className="titlebar-action-btn theme-toggle"
          onClick={toggleTheme}
          title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
          aria-label="切换主题"
        >
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
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
            <Terminal size={14} />
          </button>
        )}
      </div>

      {/* P3: Windows-style window controls (right side) — hidden on Mac */}
      {!isMac && (
        <div className="titlebar-buttons">
          <button
            className="titlebar-btn"
            onClick={handleMinimize}
            title="最小化"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            className="titlebar-btn"
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

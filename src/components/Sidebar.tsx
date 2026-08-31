import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { PanelLeftClose, Search, Settings, Sun, Moon, PencilLine, BookOpen, Clock, Plug, BookMarked, Brain, Link2, GitBranch, Pin, Folder, FolderOpen, Pencil, Clipboard, Trash2, ChevronDown, ChevronRight, MoreHorizontal, User, Circle, ClipboardList, Bot, Activity, Puzzle } from "lucide-react";
import { SlotListBridge } from "../core/slots/SlotBridge";
import { useAppStore } from "../store";
import { useProjectStore } from "../core/store";
import { AppIdentity } from "../core/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { SearchDialog } from "./SearchDialog";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { getSetting, setSetting } from "../core/storage/settings";
import * as SessionStorage from "../core/storage/session";
import { useLang, S } from "../core/i18n/lang";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { getDelegationOrchestrator } from "../core/session";
import { getInboxManager } from "../core/inbox/inbox";

interface SidebarProps {
  identity: AppIdentity | null;
  onSettings?: () => void;
  onProjects?: () => void;
  onConfig?: () => void;
  onMcp?: () => void;
  onPlugins?: () => void;
  onSkills?: () => void;
  onMemory?: () => void;
  onNotebooks?: () => void;
  onTaskCenter?: () => void;
  onAgents?: () => void;
  onCicd?: () => void;
  onPerf?: () => void;
  onRemoveProject?: (projectId: string, projectName: string, projectPath: string) => void;
  fileExplorerProjectId?: string | null;
  onToggleFileExplorer?: (projectId: string) => void;
  onToggleSidebar?: () => void;
  collapsed?: boolean;
}

export function Sidebar({ identity, onSettings, onProjects, onConfig, onMcp, onPlugins, onSkills, onMemory, onNotebooks, onTaskCenter, onAgents, onCicd, onPerf, onRemoveProject, fileExplorerProjectId, onToggleFileExplorer, onToggleSidebar, collapsed = false }: SidebarProps) {
  const [inboxUnread, setInboxUnread] = useState(0);

  // Track inbox unread count
  useEffect(() => {
    const updateCount = () => {
      try { setInboxUnread(getInboxManager().getUnreadCount()); } catch {}
    };
    updateCount();
    const interval = setInterval(updateCount, 5000);
    return () => clearInterval(interval);
  }, []);
  const lang = useLang();
  const { clearMessages, loadMessages } = useAppStore();
  const {
    projects, currentProject, currentSession,
    createSession, switchSession, deleteSession,
    openProject, getProjectSessions, updateProject,
    renameSession,
  } = useProjectStore();
  // Theme is now managed solely by TitleBar to avoid state conflicts.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [allSessions, setAllSessions] = useState<Record<string, Array<typeof currentSession & { lastMessageAt: number; messageCount: number }>>>({});
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<{ sessionId: string; title: string } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  // #4: Right-click context menu state
  const [sessionContextMenu, setSessionContextMenu] = useState<{ session: any; x: number; y: number } | null>(null);
const [hoverMenuProjectId, setHoverMenuProjectId] = useState<string | null>(null);
const [clickedMenuProjectId, setClickedMenuProjectId] = useState<string | null>(null);
const [menuDirection, setMenuDirection] = useState<'down' | 'up'>('down');
const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
const menuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
// P2 #29: DnD session sorting
const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
const handleDragStart = useCallback((e: React.DragEvent, sessionId: string) => { setDraggedSessionId(sessionId); e.dataTransfer.effectAllowed = "move"; }, []);
const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }, []);
const handleDrop = useCallback((e: React.DragEvent, targetSessionId: string, projectId: string) => {
  e.preventDefault();
  if (!draggedSessionId || draggedSessionId === targetSessionId) return;
  // Reorder sessions in storage
  const key = projectId === "__global__" ? "" : projectId;
  const sessions = SessionStorage.listSessions(key);
  const fromIdx = sessions.findIndex((s: any) => s.id === draggedSessionId);
  const toIdx = sessions.findIndex((s: any) => s.id === targetSessionId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = sessions.splice(fromIdx, 1);
  sessions.splice(toIdx, 0, moved);
  SessionStorage.reorderSessions(key, sessions.map((s: any) => s.id));
  setDraggedSessionId(null);
  loadAllSessions();
}, [draggedSessionId]);

  // Close click-pinned menu when clicking outside the menu
  useEffect(() => {
    if (!clickedMenuProjectId) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // If click is not on the more menu or its children, close the pinned menu
      if (!target.closest('.sidebar-project-more-menu') && !target.closest('.sidebar-project-btn.more')) {
        setClickedMenuProjectId(null);
        setHoverMenuProjectId(null);
      }
    };
    document.addEventListener('click', handleClickOutside, true);
    return () => document.removeEventListener('click', handleClickOutside, true);
  }, [clickedMenuProjectId]);
  // #9: Resizable sidebar width
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const w = getSetting("codem-sidebar-width");
    const num = typeof w === "string" ? parseInt(w, 10) : (typeof w === "number" ? w : 0);
    return num > 0 ? num : 260;
  });
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const loadAllSessions = () => {
    const sessionsMap: Record<string, any[]> = {};
    // Load global sessions (projectId = "")
    sessionsMap["__global__"] = SessionStorage.listSessions("");
    for (const p of projects) {
      sessionsMap[p.id] = getProjectSessions(p.id);
    }
    setAllSessions(sessionsMap);
  };

  useEffect(() => {
    loadAllSessions();
  }, [projects.length, currentSession?.id, currentProject?.id]);

  // Apply saved font family/weight on mount (theme is handled by TitleBar)
  useEffect(() => {
    const savedFont = getSetting("codem-font-family");
    if (savedFont) {
      document.documentElement.style.setProperty("--font-family", savedFont);
    }
    const savedWeight = getSetting("codem-font-weight");
    if (savedWeight) {
      document.documentElement.style.setProperty("--font-weight", String(savedWeight));
    }
  }, []);

  useEffect(() => {
    if (currentProject) {
      setExpandedProjects((prev) => new Set(prev).add(currentProject.id));
    }
  }, [currentProject?.id]);

  // Persist sidebar width
  useEffect(() => {
    setSetting("codem-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  // Resize handlers
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStartX.current;
      const newWidth = Math.max(200, Math.min(500, resizeStartWidth.current + delta));
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      setIsResizing(false);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);


  const toggleExpand = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else {
        next.add(projectId);
        const sessions = getProjectSessions(projectId);
        setAllSessions((prev) => ({ ...prev, [projectId]: sessions }));
      }
      return next;
    });
  };

  const handleNewSession = (projectId: string) => {
    // 全局对话场景：__global__ 不是真实项目，openProject 会提前返回
    // 需要手动加载全局 sessions 列表，确保 createSession 的编号正确
    if (projectId === "__global__") {
      const globalSessions = SessionStorage.listSessions("");
      useProjectStore.setState({ currentProject: null, currentSession: null, sessions: globalSessions });
      createSession();
      loadAllSessions();
      return;
    }
    openProject(projectId);
    createSession();
    loadAllSessions();
  };

  const handleSessionClick = (projectId: string, sessionId: string) => {
    // Handle global sessions (projectId === "__global__" maps to empty projectId "")
    if (projectId === "__global__") {
      useProjectStore.setState({ currentProject: null, currentSession: null, sessions: SessionStorage.listSessions("") });
      const sessions = SessionStorage.listSessions("");
      const session = sessions.find((s: any) => s.id === sessionId);
      if (session) switchSession(sessionId);
      return;
    }
    if (currentProject?.id === projectId) {
      const sessions = getProjectSessions(projectId);
      const session = sessions.find((s: any) => s.id === sessionId);
      if (session) switchSession(sessionId);
      return;
    }
    openProject(projectId);
    const tryLoad = (attempt: number) => {
      const state = useProjectStore.getState();
      if (state.currentProject?.id === projectId || attempt > 20) {
        const sessions = getProjectSessions(projectId);
        const session = sessions.find((s: any) => s.id === sessionId);
        if (session) switchSession(sessionId);
      } else {
        setTimeout(() => tryLoad(attempt + 1), 30);
      }
    };
    setTimeout(() => tryLoad(0), 30);
  };

  // #4: Session context menu — right-click opens a custom positioned menu
  const handleSessionContextMenu = (e: React.MouseEvent, session: any) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 140);
    setSessionContextMenu({ session, x, y });
  };

  // Close context menu on Escape
  useEffect(() => {
    if (!sessionContextMenu) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSessionContextMenu(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sessionContextMenu]);

  const handleRenameSession = (sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId);
    setEditTitle(currentTitle);
  };

  const handleSaveRename = () => {
    if (editingSessionId && editTitle.trim()) {
      renameSession(editingSessionId, editTitle.trim());
      loadAllSessions();
    }
    setEditingSessionId(null);
    setEditTitle("");
  };

  const handleCopySessionId = (sessionId: string) => {
    navigator.clipboard.writeText(sessionId);
  };

  // #9: Group sessions by time
  const groupSessionsByTime = (sessions: any[]) => {
    const now = Date.now();
    const today: any[] = [];
    const earlier: any[] = [];
    for (const s of sessions) {
      const sessionTime = s.lastMessageAt || s.createdAt || 0;
      if (sessionTime && (now - sessionTime) < 24 * 60 * 60 * 1000) {
        today.push(s);
      } else {
        earlier.push(s);
      }
    }
    return { today, earlier };
  };

  // Collapsed sidebar mode — enhanced Rail with Lucide icons
  if (collapsed) {
    return (
      <div className="sidebar-rail">
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="sidebar-rail-btn" onClick={onToggleSidebar}>
              <PanelLeftClose size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{S.sidebar.expandSidebar[lang]}</TooltipContent>
        </Tooltip>
        <div className="sidebar-rail-divider" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="sidebar-rail-btn" onClick={() => { clearMessages(); if (currentProject) createSession(); }}>
              <PencilLine size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{S.sidebar.newChat[lang]}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="sidebar-rail-btn" onClick={() => setShowSearch(true)}>
              <Search size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{S.sidebar.search[lang]}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="sidebar-rail-btn" onClick={onNotebooks}>
              <BookOpen size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{lang === 'zh' ? '知识笔记本' : 'Notebooks'}</TooltipContent>
        </Tooltip>
        {onTaskCenter && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="sidebar-rail-btn" onClick={onTaskCenter} style={{ position: "relative" }}>
                <ClipboardList size={18} />
                {inboxUnread > 0 && (
                  <span style={{
                    position: "absolute", top: -2, right: -2,
                    fontSize: 9, fontWeight: 700, color: "#fff",
                    background: "#ef4444", borderRadius: 8,
                    minWidth: 16, height: 16, display: "flex",
                    alignItems: "center", justifyContent: "center", padding: "0 4px",
                  }}>{inboxUnread}</span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{lang === 'zh' ? '任务管理' : 'Task Center'}</TooltipContent>
          </Tooltip>
        )}
        <div className="sidebar-rail-divider" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="sidebar-rail-btn" onClick={onMcp}>
              <Plug size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{S.sidebar.mcp[lang]}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="sidebar-rail-btn" onClick={onSkills}>
              <BookMarked size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{S.sidebar.skills[lang]}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="sidebar-rail-btn" onClick={onMemory}>
              <Brain size={18} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{S.sidebar.memory[lang]}</TooltipContent>
        </Tooltip>
        {onPlugins && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="sidebar-rail-btn" onClick={onPlugins}>
                <Puzzle size={18} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{S.sidebar.pluginManager[lang]}</TooltipContent>
          </Tooltip>
        )}
        <div className="sidebar-rail-spacer" />
        {showSearch && (
          <SearchDialog
            onClose={() => setShowSearch(false)}
            onSwitchProject={(projectId) => { openProject(projectId); setShowSearch(false); }}
            onNewSession={() => { if (currentProject) handleNewSession(currentProject.id); }}
            onOpenSkills={() => { onSkills?.(); setShowSearch(false); }}
            onOpenSettings={() => { onSettings?.(); setShowSearch(false); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="sidebar" ref={sidebarRef} style={{ width: `${sidebarWidth}px`, flexShrink: 0 }}>
      {/* #9: Resize handle */}
      <div
        className={`sidebar-resize-handle ${isResizing ? "active" : ""}`}
        onMouseDown={startResize}
      />

      {/* Bug8: 删除左上角项目选择区域 SpaceSwitcher */}
      {/* Bug4: 删除 sidebar-header 空白区域，sidebar-nav 直接作为第一个元素 */}

      <div className="sidebar-nav">
        {/* Bug7: 新建对话按钮 — 在知识笔计本上方 */}
        <button className="sidebar-nav-item" onClick={() => {
          clearMessages();
          useProjectStore.setState({ currentProject: null, currentSession: null, sessions: [] });
          createSession();
        }}>
          <span className="sidebar-nav-icon"><PencilLine size={16} /></span>
          <span>{S.sidebar.newChat[lang]}</span>
        </button>

        <button className="sidebar-nav-item" onClick={onNotebooks}>
          <span className="sidebar-nav-icon"><BookOpen size={16} /></span>
          <span>{lang === 'zh' ? '知识笔记本' : 'Notebooks'}</span>
        </button>
        {onTaskCenter && (
          <button className="sidebar-nav-item" onClick={onTaskCenter}>
            <span className="sidebar-nav-icon" style={{ position: "relative" }}>
              <ClipboardList size={16} />
              {inboxUnread > 0 && (
                <span style={{
                  position: "absolute", top: -4, right: -6,
                  fontSize: 9, fontWeight: 700, color: "#fff",
                  background: "#ef4444", borderRadius: 8,
                  minWidth: 14, height: 14, display: "flex",
                  alignItems: "center", justifyContent: "center", padding: "0 3px",
                }}>{inboxUnread}</span>
              )}
            </span>
            <span>{lang === 'zh' ? '任务管理' : 'Task Center'}</span>
            {inboxUnread > 0 && (
              <span style={{ marginLeft: "auto", fontSize: 'var(--fs-xs)', fontWeight: 700, color: "#ef4444" }}>
                {inboxUnread}
              </span>
            )}
          </button>
        )}

        {/* Compact tool bar — 插件/CI/CD/性能 已移至其他位置 */}
        <div className="sidebar-tool-row">
          <button className="sidebar-tool-item" onClick={onMcp} title={S.sidebar.mcp[lang]}>
            <span className="sidebar-tool-item-icon"><Plug size={16} /></span>
            <span className="sidebar-tool-item-label">{S.sidebar.mcp[lang]}</span>
          </button>
          <button className="sidebar-tool-item" onClick={onSkills} title={S.sidebar.skills[lang]}>
            <span className="sidebar-tool-item-icon"><BookMarked size={16} /></span>
            <span className="sidebar-tool-item-label">{S.sidebar.skills[lang]}</span>
          </button>
          <button className="sidebar-tool-item" onClick={onMemory} title={S.sidebar.memory[lang]}>
            <span className="sidebar-tool-item-icon"><Brain size={16} /></span>
            <span className="sidebar-tool-item-label">{S.sidebar.memory[lang]}</span>
          </button>
          {onAgents && (
            <button className="sidebar-tool-item" onClick={onAgents} title={lang === 'zh' ? '智能体' : 'Agents'}>
              <span className="sidebar-tool-item-icon"><Bot size={16} /></span>
              <span className="sidebar-tool-item-label">{lang === 'zh' ? '智能体' : 'Agents'}</span>
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-section sidebar-global-section">
        <div className="sidebar-section-header">
          <span>{S.sidebar.globalChats[lang]}</span>
          <button
            className="sidebar-project-btn sidebar-add-btn"
            onClick={() => {
              clearMessages();
              useProjectStore.setState({ currentProject: null, currentSession: null, sessions: [] });
              createSession();
            }}
            title={S.sidebar.newChat[lang]}
          >+</button>
        </div>
        <div className="sidebar-sessions" style={(() => {
          const globalCount = (allSessions["__global__"] || []).length;
          return globalCount > 3 ? { maxHeight: 144, overflowY: "auto" } : undefined;
        })()}>
          {(() => {
            const globalSessions = (allSessions["__global__"] || []).slice().sort((a: any, b: any) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
            const { today, earlier } = groupSessionsByTime(globalSessions);
            if (globalSessions.length === 0) {
              return <div className="sidebar-session-empty">{S.sidebar.noSessions[lang]}</div>;
            }
            return (
              <>
            {today.length > 0 && (
              <>
                <div className="sidebar-session-group-label">{S.sidebar.sessionToday[lang]}</div>
                {today.map((s: any) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isActive={currentSession?.id === s.id && !currentProject}
                    lang={lang}
                    onClick={() => handleSessionClick("__global__", s.id)}
                    onContextMenu={(e) => handleSessionContextMenu(e, s)}
                    isEditing={editingSessionId === s.id}
                    editValue={editTitle}
                    onEditChange={setEditTitle}
                    onEditCommit={handleSaveRename}
                    onEditCancel={() => { setEditingSessionId(null); setEditTitle(""); }}
                    onRename={() => handleRenameSession(s.id, s.title)}
                    onCopyId={() => handleCopySessionId(s.id)}
                    onDelete={() => setDeleteConfirm({ sessionId: s.id, title: s.title })}
                    onPin={() => { SessionStorage.togglePinned(s.id); loadAllSessions(); }}
                  />
                ))}
              </>
            )}
            {earlier.length > 0 && (
              <>
                <div className="sidebar-session-group-label">{S.sidebar.sessionEarlier[lang]}</div>
                {earlier.map((s: any) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    isActive={currentSession?.id === s.id && !currentProject}
                    lang={lang}
                    onClick={() => handleSessionClick("__global__", s.id)}
                    onContextMenu={(e) => handleSessionContextMenu(e, s)}
                    isEditing={editingSessionId === s.id}
                    editValue={editTitle}
                    onEditChange={setEditTitle}
                    onEditCommit={handleSaveRename}
                    onEditCancel={() => { setEditingSessionId(null); setEditTitle(""); }}
                    onRename={() => handleRenameSession(s.id, s.title)}
                    onCopyId={() => handleCopySessionId(s.id)}
                    onDelete={() => setDeleteConfirm({ sessionId: s.id, title: s.title })}
                    onPin={() => { SessionStorage.togglePinned(s.id); loadAllSessions(); }}
                  />
                ))}
              </>
            )}
              </>
            );
          })()}
        </div>
      </div>

      <div className="sidebar-section sidebar-projects-section">
        <div className="sidebar-section-header">
          <span>{S.sidebar.projects[lang]}</span>
          <button className="sidebar-section-btn" onClick={onProjects} title={S.sidebar.addProject[lang]}>+</button>
        </div>
        <div className="sidebar-projects" style={{ flex: 1, overflowY: "auto" }}>
          {projects.length === 0 ? (
            <div className="sidebar-empty">{S.sidebar.noProjects[lang]}</div>
          ) : (
            projects.map((project) => {
              const isExpanded = expandedProjects.has(project.id);
              const projectSessions = allSessions[project.id] || [];
              const { today, earlier } = groupSessionsByTime(projectSessions);
              return (
                <div key={project.id} className={`sidebar-project ${currentProject?.id === project.id ? "active" : ""}`}>
                  <div
                    className="sidebar-project-header"
                    onClick={() => toggleExpand(project.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // Reuse the same menu logic as the ... button
                      const rect = e.currentTarget.getBoundingClientRect();
                      const goUp = rect.bottom + 140 > window.innerHeight;
                      setMenuDirection(goUp ? 'up' : 'down');
                      setMenuPos(goUp ? { bottom: window.innerHeight - rect.top + 2, left: rect.right - 150 } : { top: rect.bottom + 2, left: rect.right - 150 });
                      setClickedMenuProjectId(project.id);
                      setHoverMenuProjectId(project.id);
                    }}
                  >
                    <span className="sidebar-project-arrow">{isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                    <span className="sidebar-project-icon">{project.pinned ? <Pin size={14} style={{ color: "var(--accent)" }} /> : <Folder size={14} />}</span>
                    <span className="sidebar-project-name" title={project.name}>{project.name}</span>
                    <button
                      className="sidebar-project-btn"
                      onClick={(e) => { e.stopPropagation(); handleNewSession(project.id); }}
                      title={S.sidebar.newChat[lang]}
                    >+</button>
                    <div
                      className="sidebar-project-more-wrapper"
                      onMouseEnter={(e) => {
                        if (menuCloseTimer.current) {
                          clearTimeout(menuCloseTimer.current);
                          menuCloseTimer.current = null;
                        }
                        if (clickedMenuProjectId) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const goUp = rect.bottom + 140 > window.innerHeight;
                        setMenuDirection(goUp ? 'up' : 'down');
                        setMenuPos(goUp ? { bottom: window.innerHeight - rect.top + 2, left: rect.right - 150 } : { top: rect.bottom + 2, left: rect.right - 150 });
                        setHoverMenuProjectId(project.id);
                      }}
                      onMouseLeave={() => {
                        if (!clickedMenuProjectId) {
                          menuCloseTimer.current = setTimeout(() => {
                            setHoverMenuProjectId(null);
                          }, 400);
                        }
                      }}
                    >
                      <button
                        className="sidebar-project-btn more"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (clickedMenuProjectId === project.id) {
                            setClickedMenuProjectId(null);
                            setHoverMenuProjectId(null);
                          } else {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const goUp = rect.bottom + 140 > window.innerHeight;
                            setMenuDirection(goUp ? 'up' : 'down');
                            setMenuPos(goUp ? { bottom: window.innerHeight - rect.top + 2, left: rect.right - 150 } : { top: rect.bottom + 2, left: rect.right - 150 });
                            setClickedMenuProjectId(project.id);
                            setHoverMenuProjectId(project.id);
                          }
                        }}
                        title={S.sidebar.moreActions[lang]}
                        ><MoreHorizontal size={14} /></button>
                      {(hoverMenuProjectId === project.id || clickedMenuProjectId === project.id) && menuPos && createPortal(
                        <div
                          className="sidebar-project-more-menu"
                          style={{
                            position: 'fixed',
                            display: 'block',
                            top: menuPos.top,
                            bottom: menuPos.bottom,
                            left: menuPos.left,
                            zIndex: 10000,
                            background: 'var(--dream-panel-bg, var(--bg-secondary))',
                            backdropFilter: 'blur(20px) saturate(1.5)',
                            WebkitBackdropFilter: 'blur(20px) saturate(1.5)',
                            border: '1px solid var(--border-primary)',
                            borderRadius: '8px',
                            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
                          }}
                          onMouseEnter={() => {
                            if (menuCloseTimer.current) {
                              clearTimeout(menuCloseTimer.current);
                              menuCloseTimer.current = null;
                            }
                          }}
                          onMouseLeave={() => {
                            if (!clickedMenuProjectId) {
                              menuCloseTimer.current = setTimeout(() => {
                                setHoverMenuProjectId(null);
                              }, 400);
                            }
                          }}
                        >
                          <button onClick={(e) => { e.stopPropagation(); updateProject(project.id, { pinned: !project.pinned }); setHoverMenuProjectId(null); setClickedMenuProjectId(null); }}>
                            {project.pinned ? S.sidebar.unpinProject[lang] : S.sidebar.pinProject[lang]}
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); onToggleFileExplorer?.(project.id); setHoverMenuProjectId(null); setClickedMenuProjectId(null); }}>
                            {S.sidebar.fileBrowser[lang]}
                          </button>
                          <button onClick={async (e) => {
                            e.stopPropagation();
                            setHoverMenuProjectId(null);
                            setClickedMenuProjectId(null);
                            const { invoke } = (window as any).__TAURI__?.core || {};
                            if (!invoke) return;
                            // For directories, open_file_external opens the folder in explorer.
                            // If that fails (e.g. path issues), fall back to reveal_item_in_dir.
                            try {
                              await invoke("open_file_external", { path: project.path });
                            } catch {
                              try {
                                await invoke("reveal_item_in_dir", { path: project.path });
                              } catch (err) {
                                console.error("[Sidebar] Failed to open file manager:", err);
                              }
                            }
                          }}>
                            {S.sidebar.openInFileManager[lang]}
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); onRemoveProject?.(project.id, project.name, project.path); setHoverMenuProjectId(null); setClickedMenuProjectId(null); }}>
                            {S.sidebar.removeProject[lang]}
                          </button>
                        </div>,
                        document.body
                      )}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="sidebar-sessions">
                      {projectSessions.length === 0 ? (
                        <div className="sidebar-session-empty">{S.sidebar.noSessions[lang]}</div>
                      ) : (
                        <>
                          {/* #9: Time-grouped sessions */}
                          {today.length > 0 && (
                            <>
                              <div className="sidebar-session-group-label">{S.sidebar.sessionToday[lang]}</div>
                              {today.map((s: any) => (
                                <SessionItem
                                  key={s.id}
                                  session={s}
                                  isActive={currentSession?.id === s.id}
                                  lang={lang}
                                  onClick={() => handleSessionClick(project.id, s.id)}
                                  onContextMenu={(e) => handleSessionContextMenu(e, s)}
                                  isEditing={editingSessionId === s.id}
                                  editValue={editTitle}
                                  onEditChange={setEditTitle}
                                  onEditCommit={handleSaveRename}
                                  onEditCancel={() => { setEditingSessionId(null); setEditTitle(""); }}
                                  onRename={() => handleRenameSession(s.id, s.title)}
                                  onCopyId={() => handleCopySessionId(s.id)}
                                  onDelete={() => setDeleteConfirm({ sessionId: s.id, title: s.title })}
                                  onPin={() => { SessionStorage.togglePinned(s.id); loadAllSessions(); }}
                                />
                              ))}
                            </>
                          )}
                          {earlier.length > 0 && (
                            <>
                              <div className="sidebar-session-group-label">{S.sidebar.sessionEarlier[lang]}</div>
                              {earlier.map((s: any) => (
                                <SessionItem
                                  key={s.id}
                                  session={s}
                                  isActive={currentSession?.id === s.id}
                                  lang={lang}
                                  onClick={() => handleSessionClick(project.id, s.id)}
                                  onContextMenu={(e) => handleSessionContextMenu(e, s)}
                                  isEditing={editingSessionId === s.id}
                                  editValue={editTitle}
                                  onEditChange={setEditTitle}
                                  onEditCommit={handleSaveRename}
                                  onEditCancel={() => { setEditingSessionId(null); setEditTitle(""); }}
                                  onRename={() => handleRenameSession(s.id, s.title)}
                                  onCopyId={() => handleCopySessionId(s.id)}
                                  onDelete={() => setDeleteConfirm({ sessionId: s.id, title: s.title })}
                                  onPin={() => { SessionStorage.togglePinned(s.id); loadAllSessions(); }}
                                />
                              ))}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {deleteConfirm && (
        <ConfirmDialog
          title={S.sidebar.deleteSession[lang]}
          message={`${S.sidebar.deleteSessionMsg[lang]}${deleteConfirm.title}${S.sidebar.deleteSessionMsgEnd[lang]}`}
          confirmLabel={S.sidebar.confirmDelete[lang]}
          cancelLabel={S.sidebar.cancel[lang]}
          onConfirm={() => { deleteSession(deleteConfirm.sessionId); setDeleteConfirm(null); loadAllSessions(); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {showSearch && (
        <SearchDialog
          onClose={() => setShowSearch(false)}
          onSwitchProject={(projectId) => {
            openProject(projectId);
            setShowSearch(false);
          }}
          onNewSession={() => {
            if (currentProject) {
              handleNewSession(currentProject.id);
            }
          }}
          onOpenSkills={() => {
            onSkills?.();
            setShowSearch(false);
          }}
          onOpenSettings={() => { onSettings?.(); setShowSearch(false); }}
        />
      )}

      {/* #4: Right-click context menu for sessions */}
      {sessionContextMenu && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => setSessionContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setSessionContextMenu(null); }}
          />
          <div
            className="sidebar-session-context-menu"
            style={{ top: sessionContextMenu.y, left: sessionContextMenu.x }}
          >
            <button onClick={() => { handleRenameSession(sessionContextMenu.session.id, sessionContextMenu.session.title); setSessionContextMenu(null); }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Pencil size={14} /> {S.sidebar.renameSession[lang]}</span>
            </button>
            <button onClick={() => { handleCopySessionId(sessionContextMenu.session.id); setSessionContextMenu(null); }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Clipboard size={14} /> {S.sidebar.copySessionId[lang]}</span>
            </button>
            <button onClick={() => { SessionStorage.togglePinned(sessionContextMenu.session.id); loadAllSessions(); setSessionContextMenu(null); }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Pin size={14} /> {sessionContextMenu.session.pinned ? (lang === 'zh' ? '取消置顶' : 'Unpin') : (lang === 'zh' ? '置顶' : 'Pin')}</span>
            </button>
            <div className="sidebar-context-menu-separator" />
            <button className="destructive" onClick={() => { setDeleteConfirm({ sessionId: sessionContextMenu.session.id, title: sessionContextMenu.session.title }); setSessionContextMenu(null); }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Trash2 size={14} /> {S.sidebar.deleteSession[lang]}</span>
            </button>
          </div>
        </>
      )}
      {/* SlotListBridge 消费 sidebar.tabs — list 类型，允许插件注入侧边栏 tab */}
      <SlotListBridge name="sidebar.tabs" />
      {/* P1 #8: Bottom user info area + 插件管理按钮 */}
      <div className="sidebar-user-area">
        <div className="sidebar-user-avatar">
          {identity?.name
            ? identity.name.charAt(0).toUpperCase()
            : <User size={18} />}
        </div>
        <div className="sidebar-user-info">
          <div className="sidebar-user-name">{identity?.name || (lang === 'zh' ? '未登录' : 'Guest')}</div>
          <div className="sidebar-user-status">{lang === 'zh' ? '本地用户' : 'Local user'}</div>
        </div>
        {onPlugins && (
          <button className="sidebar-user-plugin-btn" onClick={onPlugins} title={S.sidebar.pluginManager[lang]}
            style={{
              marginLeft: 'auto',
              background: 'var(--bg-hover)',
              border: '1px solid var(--border-primary)',
              borderRadius: 6,
              cursor: 'pointer',
              padding: '6px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-secondary)',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-active)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <Puzzle size={14} />
            <span>{S.sidebar.pluginManager[lang]}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** #4: Session item with right-click context menu + inline rename */
function SessionItem({
  session, isActive, lang, onClick, onContextMenu,
  isEditing, editValue, onEditChange, onEditCommit, onEditCancel,
  onRename, onCopyId, onDelete, onPin,
  onDragStart, onDragOver, onDrop,
}: {
  session: any;
  isActive: boolean;
  lang: "zh" | "en";
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isEditing: boolean;
  editValue: string;
  onEditChange: (value: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
  onRename: () => void;
  onCopyId: () => void;
  onDelete: () => void;
  onPin: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  // Check if this session is currently running an agentic loop
  const isActiveSession = useAppStore(s => s.activeSessions.has(session.id));
  // Inline rename mode
  if (isEditing) {
    return (
      <div className={`sidebar-session ${isActive ? "active" : ""}`}>
        <input
          className="sidebar-session-edit-input"
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onEditCommit(); }
            if (e.key === "Escape") { e.preventDefault(); onEditCancel(); }
          }}
          onBlur={onEditCommit}
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }
  return (
    <div
      className={`sidebar-session ${isActive ? "active" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {isActiveSession && <span className="session-running-dot" title={lang === "zh" ? "运行中" : "Running"} />}
      {/* P1 #6: Unread message badge */}
      {(() => {
        const unread = (session.unreadCount as number) || 0;
        if (unread <= 0) return null;
        return <span className="session-unread-badge" title={lang === 'zh' ? `${unread} 条未读` : `${unread} unread`}>{unread > 99 ? '99+' : unread}</span>;
      })()}
      {session.executionMode === "git_worktree" && (
        <span style={{ fontSize: 'var(--fs-sm)', flexShrink: 0, display: "flex", alignItems: "center" }} title={session.worktreePath || (lang === "zh" ? "工作树模式" : "Worktree mode")}><GitBranch size={12} /></span>
      )}
      {/* Delegation badge: show 🔗 if session has active delegations */}
      {(() => {
        try {
          const orch = getDelegationOrchestrator();
          const hasActive = orch.getDelegationsByTarget(session.id).some(d => d.status === 'pending' || d.status === 'running')
            || orch.getDelegationsBySource(session.id).some(d => d.status === 'pending' || d.status === 'running');
          return hasActive ? <span style={{ fontSize: 'var(--fs-sm)', flexShrink: 0, display: "flex", alignItems: "center" }} title={lang === "zh" ? "委派任务进行中" : "Delegation active"}><Link2 size={12} /></span> : null;
        } catch { return null; }
      })()}
      <span className="sidebar-session-title" title={session.title}>{session.title}</span>
      <div className="sidebar-session-actions">
        <button
          className={`sidebar-session-pin ${session.pinned ? "pinned" : ""}`}
          onClick={(e) => { e.stopPropagation(); onPin(); }}
          title={session.pinned ? S.sidebar.unpinProject[lang] : S.sidebar.pinProject[lang]}
        >{session.pinned ? <Pin size={12} style={{ color: "var(--accent)" }} /> : <Pin size={12} />}</button>
        <button
          className="sidebar-session-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >✕</button>
      </div>
    </div>
  );
}

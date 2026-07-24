import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../store";
import { useProjectStore } from "../core/store";
import { AppIdentity } from "../core/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { SearchDialog } from "./SearchDialog";
import { getSetting, setSetting } from "../core/storage/settings";
import * as SessionStorage from "../core/storage/session";
import { useLang, S } from "../core/i18n/lang";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

interface SidebarProps {
  identity: AppIdentity | null;
  onSettings?: () => void;
  onProjects?: () => void;
  onConfig?: () => void;
  onMcp?: () => void;
  onSkills?: () => void;
  onMemory?: () => void;
  onNotebooks?: () => void;
  onAutomations?: () => void;
  onRemoveProject?: (projectId: string, projectName: string, projectPath: string) => void;
  fileExplorerProjectId?: string | null;
  onToggleFileExplorer?: (projectId: string) => void;
  onToggleSidebar?: () => void;
  collapsed?: boolean;
}

export function Sidebar({ identity, onSettings, onProjects, onConfig, onMcp, onSkills, onMemory, onNotebooks, onAutomations, onRemoveProject, fileExplorerProjectId, onToggleFileExplorer, onToggleSidebar, collapsed = false }: SidebarProps) {
  const lang = useLang();
  const { clearMessages, loadMessages } = useAppStore();
  const {
    projects, currentProject, currentSession,
    createSession, switchSession, deleteSession,
    openProject, getProjectSessions, updateProject,
    renameSession,
  } = useProjectStore();
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (getSetting("codem-theme") as "dark" | "light") || "dark";
  });
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

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    setSetting("codem-theme", theme);
    // Apply saved font family
    const savedFont = getSetting("codem-font-family");
    if (savedFont) {
      document.documentElement.style.setProperty("--font-family", savedFont);
    }
    // Apply saved font weight
    const savedWeight = getSetting("codem-font-weight");
    if (savedWeight) {
      document.documentElement.style.setProperty("--font-weight", String(savedWeight));
    }
  }, [theme]);

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

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

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

  // Collapsed sidebar mode
  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="sidebar-collapse-toggle" onClick={onToggleSidebar}>
              ☰
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{S.sidebar.expandSidebar[lang]}</TooltipContent>
        </Tooltip>
        <div className="sidebar-collapsed-icons">
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="sidebar-nav-icon-btn" onClick={() => { clearMessages(); if (currentProject) createSession(); }}>
                ✏️
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{S.sidebar.newChat[lang]}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="sidebar-nav-icon-btn" onClick={() => setShowSearch(true)}>
                🔍
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{S.sidebar.search[lang]}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="sidebar-nav-icon-btn" onClick={onSettings}>
                ⚙️
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{S.sidebar.settings[lang]}</TooltipContent>
          </Tooltip>
        </div>
        {showSearch && (
          <SearchDialog
            onClose={() => setShowSearch(false)}
            onSwitchProject={(projectId) => { openProject(projectId); setShowSearch(false); }}
            onNewSession={() => { if (currentProject) handleNewSession(currentProject.id); }}
            onOpenSkills={() => { onSkills?.(); setShowSearch(false); }}
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

      <div className="sidebar-header">
        <h3>{identity?.emoji || "⚡"} {identity?.name || "Codem"}</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button onClick={() => setShowSearch(true)} title={S.sidebar.search[lang]} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, padding: "2px 4px", borderRadius: 4 }}>🔍</button>
          <button onClick={onSettings} title={S.sidebar.settings[lang]} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, padding: "2px 4px", borderRadius: 4 }}>⚙️</button>
          <button className="theme-toggle" onClick={toggleTheme} title={S.sidebar.toggleTheme[lang]} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, padding: "2px 4px", borderRadius: 4 }}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          {onToggleSidebar && (
            <button className="sidebar-collapse-btn" onClick={onToggleSidebar} title={S.sidebar.collapseSidebar[lang]} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, padding: "2px 4px", borderRadius: 4 }}>
              ◀
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-nav">
        <button className="sidebar-nav-item" onClick={() => {
          clearMessages();
          useProjectStore.setState({ currentProject: null, currentSession: null, sessions: [] });
          createSession();
        }}>
          <span className="sidebar-nav-icon">✏️</span>
          <span>{S.sidebar.newChat[lang]}</span>
        </button>

        <button className="sidebar-nav-item" onClick={onNotebooks}>
          <span className="sidebar-nav-icon">📓</span>
          <span>{lang === 'zh' ? '知识笔记本' : 'Notebooks'}</span>
        </button>
        {onAutomations && (
          <button className="sidebar-nav-item" onClick={onAutomations}>
            <span className="sidebar-nav-icon">⏰</span>
            <span>{lang === 'zh' ? '自动化' : 'Automations'}</span>
          </button>
        )}

        {/* Compact 3-in-a-row tool bar */}
        <div className="sidebar-tool-row">
          <button className="sidebar-tool-item" onClick={onMcp} title={S.sidebar.mcp[lang]}>
            <span className="sidebar-tool-item-icon">🔌</span>
            <span className="sidebar-tool-item-label">{S.sidebar.mcp[lang]}</span>
          </button>
          <button className="sidebar-tool-item" onClick={onSkills} title={S.sidebar.skills[lang]}>
            <span className="sidebar-tool-item-icon">📚</span>
            <span className="sidebar-tool-item-label">{S.sidebar.skills[lang]}</span>
          </button>
          <button className="sidebar-tool-item" onClick={onMemory} title={S.sidebar.memory[lang]}>
            <span className="sidebar-tool-item-icon">🧠</span>
            <span className="sidebar-tool-item-label">{S.sidebar.memory[lang]}</span>
          </button>
        </div>
      </div>

      <div className="sidebar-section sidebar-global-section">
        <div className="sidebar-section-header">
          <span>{S.sidebar.globalChats[lang]}</span>
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
                  >
                    <span className="sidebar-project-arrow">{isExpanded ? "▾" : "▸"}</span>
                    <span className="sidebar-project-icon">{project.pinned ? "📌" : "📁"}</span>
                    <span className="sidebar-project-name">{project.name}</span>
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
                        >⋯</button>
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
              ✏️ {S.sidebar.renameSession[lang]}
            </button>
            <button onClick={() => { handleCopySessionId(sessionContextMenu.session.id); setSessionContextMenu(null); }}>
              📋 {S.sidebar.copySessionId[lang]}
            </button>
            <div className="sidebar-context-menu-separator" />
            <button className="destructive" onClick={() => { setDeleteConfirm({ sessionId: sessionContextMenu.session.id, title: sessionContextMenu.session.title }); setSessionContextMenu(null); }}>
              🗑️ {S.sidebar.deleteSession[lang]}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** #4: Session item with right-click context menu + inline rename */
function SessionItem({
  session, isActive, lang, onClick, onContextMenu,
  isEditing, editValue, onEditChange, onEditCommit, onEditCancel,
  onRename, onCopyId, onDelete, onPin,
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
    >
      {isActiveSession && <span className="session-running-dot" title={lang === "zh" ? "运行中" : "Running"} />}
      {session.executionMode === "git_worktree" && (
        <span style={{ fontSize: 11, flexShrink: 0 }} title={session.worktreePath || (lang === "zh" ? "工作树模式" : "Worktree mode")}>🌲</span>
      )}
      <span className="sidebar-session-title">{session.title}</span>
      <div className="sidebar-session-actions">
        <button
          className={`sidebar-session-pin ${session.pinned ? "pinned" : ""}`}
          onClick={(e) => { e.stopPropagation(); onPin(); }}
          title={session.pinned ? S.sidebar.unpinProject[lang] : S.sidebar.pinProject[lang]}
        >{session.pinned ? "📍" : "📌"}</button>
        <button
          className="sidebar-session-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >✕</button>
      </div>
    </div>
  );
}

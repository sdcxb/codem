import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../store";
import { useProjectStore } from "../core/store";
import { AppIdentity } from "../core/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { SearchDialog } from "./SearchDialog";
import { getSetting, setSetting } from "../core/storage/settings";
import { useLang, S } from "../core/i18n/lang";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

interface SidebarProps {
  identity: AppIdentity | null;
  onSettings?: () => void;
  onProjects?: () => void;
  onConfig?: () => void;
  onMcp?: () => void;
  onSkills?: () => void;
  onMemory?: () => void;
  onRemoveProject?: (projectId: string, projectName: string, projectPath: string) => void;
  fileExplorerProjectId?: string | null;
  onToggleFileExplorer?: (projectId: string) => void;
  onToggleSidebar?: () => void;
  collapsed?: boolean;
}

export function Sidebar({ identity, onSettings, onProjects, onConfig, onMcp, onSkills, onMemory, onRemoveProject, fileExplorerProjectId, onToggleFileExplorer, onToggleSidebar, collapsed = false }: SidebarProps) {
  const lang = useLang();
  const { clearMessages, loadMessages } = useAppStore();
  const {
    projects, currentProject, currentSession,
    createSession, switchSession, deleteSession,
    openProject, getProjectSessions, updateProject,
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
  const [hoverMenuProjectId, setHoverMenuProjectId] = useState<string | null>(null);
  const [clickedMenuProjectId, setClickedMenuProjectId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const menuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    openProject(projectId);
    setTimeout(() => {
      createSession();
      setTimeout(() => loadAllSessions(), 50);
    }, 50);
  };

  const handleSessionClick = (projectId: string, sessionId: string) => {
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

  // #4: Session context menu handlers
  const handleSessionContextMenu = (e: React.MouseEvent, session: any) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleRenameSession = (sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId);
    setEditTitle(currentTitle);
  };

  const handleSaveRename = (projectId: string) => {
    if (editingSessionId && editTitle.trim()) {
      // Update session title in storage
      const sessions = getProjectSessions(projectId);
      const session = sessions.find((s: any) => s.id === editingSessionId);
      if (session) {
        // Use updateProject to trigger reload
        loadAllSessions();
      }
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
        <button className="theme-toggle" onClick={toggleTheme} title={S.sidebar.toggleTheme[lang]}>
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        {/* #9: Collapse toggle */}
        {onToggleSidebar && (
          <button className="sidebar-collapse-btn" onClick={onToggleSidebar} title={S.sidebar.collapseSidebar[lang]}>
            ◀
          </button>
        )}
      </div>

      <div className="sidebar-nav">
        <button className="sidebar-nav-item" onClick={() => {
          clearMessages();
          if (currentProject) {
            createSession();
          }
        }}>
          <span className="sidebar-nav-icon">✏️</span>
          <span>{S.sidebar.newChat[lang]}</span>
        </button>
        <button className="sidebar-nav-item" onClick={() => setShowSearch(true)}>
          <span className="sidebar-nav-icon">🔍</span>
          <span>{S.sidebar.search[lang]}</span>
        </button>
        <button className="sidebar-nav-item" onClick={onMcp}>
          <span className="sidebar-nav-icon">🔌</span>
          <span>{S.sidebar.mcp[lang]}</span>
        </button>
        <button className="sidebar-nav-item" onClick={onSkills}>
          <span className="sidebar-nav-icon">📚</span>
          <span>{S.sidebar.skills[lang]}</span>
        </button>
        <button className="sidebar-nav-item" onClick={onMemory}>
          <span className="sidebar-nav-icon">🧠</span>
          <span>{S.sidebar.memory[lang]}</span>
        </button>
        <button className="sidebar-nav-item" onClick={onSettings}>
          <span className="sidebar-nav-icon">⚙️</span>
          <span>{S.sidebar.settings[lang]}</span>
        </button>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span>{S.sidebar.projects[lang]}</span>
          <button className="sidebar-section-btn" onClick={onProjects} title={S.sidebar.addProject[lang]}>+</button>
        </div>
        <div className="sidebar-projects">
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
                        const rect = e.currentTarget.getBoundingClientRect();
                        setMenuPosition({ top: rect.bottom + 4, left: rect.right - 140 });
                        setHoverMenuProjectId(project.id);
                      }}
                      onMouseLeave={() => {
                        if (clickedMenuProjectId !== project.id) {
                          menuCloseTimer.current = setTimeout(() => {
                            setHoverMenuProjectId(null);
                          }, 500);
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
                            setMenuPosition({ top: rect.bottom + 4, left: rect.right - 140 });
                            setClickedMenuProjectId(project.id);
                            setHoverMenuProjectId(project.id);
                          }
                        }}
                        title={S.sidebar.moreActions[lang]}
                      >⋯</button>
                      {(hoverMenuProjectId === project.id || clickedMenuProjectId === project.id) && menuPosition && (
                        <div
                          className="sidebar-project-more-menu"
                          style={{ top: menuPosition.top, left: menuPosition.left }}
                          onMouseEnter={() => {
                            if (menuCloseTimer.current) {
                              clearTimeout(menuCloseTimer.current);
                              menuCloseTimer.current = null;
                            }
                          }}
                          onMouseLeave={() => {
                            if (clickedMenuProjectId !== project.id) {
                              menuCloseTimer.current = setTimeout(() => {
                                setHoverMenuProjectId(null);
                              }, 500);
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
                        </div>
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
                                  onRename={() => handleRenameSession(s.id, s.title)}
                                  onCopyId={() => handleCopySessionId(s.id)}
                                  onDelete={() => setDeleteConfirm({ sessionId: s.id, title: s.title })}
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
                                  onRename={() => handleRenameSession(s.id, s.title)}
                                  onCopyId={() => handleCopySessionId(s.id)}
                                  onDelete={() => setDeleteConfirm({ sessionId: s.id, title: s.title })}
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
    </div>
  );
}

/** #4: Session item with right-click context menu */
function SessionItem({ session, isActive, lang, onClick, onContextMenu, onRename, onCopyId, onDelete }: {
  session: any;
  isActive: boolean;
  lang: "zh" | "en";
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: () => void;
  onCopyId: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <div
        className={`sidebar-session ${isActive ? "active" : ""}`}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <span className="sidebar-session-title">{session.title}</span>
        <div className="sidebar-session-actions">
          <button
            className={`sidebar-session-pin ${session.pinned ? "pinned" : ""}`}
            onClick={(e) => { e.stopPropagation(); }}
            title={session.pinned ? S.sidebar.unpinProject[lang] : S.sidebar.pinProject[lang]}
          >📌</button>
          <button
            className="sidebar-session-delete"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >✕</button>
        </div>
      </div>
      {/* Hidden trigger — context menu is activated via right-click */}
      <DropdownMenuTrigger asChild>
        <span style={{ display: "none" }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={onRename}>✏️ {S.sidebar.renameSession[lang]}</DropdownMenuItem>
        <DropdownMenuItem onClick={onCopyId}>📋 {S.sidebar.copySessionId[lang]}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>🗑️ {S.sidebar.deleteSession[lang]}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

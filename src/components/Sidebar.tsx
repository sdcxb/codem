import { useState, useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { useProjectStore } from "../core/store";
import { AppIdentity } from "../core/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { SearchDialog } from "./SearchDialog";
import { getSetting, setSetting } from "../core/storage/settings";
import { useLang, S } from "../core/i18n/lang";

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
}

export function Sidebar({ identity, onSettings, onProjects, onConfig, onMcp, onSkills, onMemory, onRemoveProject, fileExplorerProjectId, onToggleFileExplorer }: SidebarProps) {
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

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const toggleExpand = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else {
        next.add(projectId);
        // Load sessions for this project when expanding
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

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h3>{identity?.emoji || "⚡"} {identity?.name || "Codem"}</h3>
        <button className="theme-toggle" onClick={toggleTheme} title={S.sidebar.toggleTheme[lang]}>
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
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
                        projectSessions.map((s: any) => (
                          <div
                            key={s.id}
                            className={`sidebar-session ${currentSession?.id === s.id ? "active" : ""}`}
                            onClick={() => handleSessionClick(project.id, s.id)}
                          >
                            <span className="sidebar-session-title">{s.title}</span>
                            <div className="sidebar-session-actions">
                              <button
                                className={`sidebar-session-pin ${s.pinned ? "pinned" : ""}`}
                                onClick={(e) => { e.stopPropagation(); /* TODO: session pin */ }}
                                title={s.pinned ? S.sidebar.unpinProject[lang] : S.sidebar.pinProject[lang]}
                              >📌</button>
                              <button
                                className="sidebar-session-delete"
                                onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ sessionId: s.id, title: s.title }); }}
                              >✕</button>
                            </div>
                          </div>
                        ))
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

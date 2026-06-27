import { useState, useEffect } from "react";
import { useAppStore } from "../store";
import { useProjectStore } from "../core/store";
import { AppIdentity } from "../core/types";
import { ConfirmDialog } from "./ConfirmDialog";

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
  const { clearMessages, loadMessages } = useAppStore();
  const {
    projects, currentProject, currentSession,
    createSession, switchSession, deleteSession,
    openProject, getProjectSessions,
  } = useProjectStore();
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("mimo-theme") as "dark" | "light") || "dark";
  });
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [allSessions, setAllSessions] = useState<Record<string, Array<typeof currentSession & { lastMessageAt: number; messageCount: number }>>>({});
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<{ sessionId: string; title: string } | null>(null);

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
    localStorage.setItem("mimo-theme", theme);
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
        <button className="theme-toggle" onClick={toggleTheme} title="切换主题">
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </div>

      <div className="sidebar-nav">
        <button className="sidebar-nav-item" onClick={clearMessages}>
          <span className="sidebar-nav-icon">✏️</span>
          <span>新对话</span>
        </button>
        <button className="sidebar-nav-item" onClick={onConfig}>
          <span className="sidebar-nav-icon">🔍</span>
          <span>搜索</span>
        </button>
        <button className="sidebar-nav-item" onClick={onMcp}>
          <span className="sidebar-nav-icon">🔌</span>
          <span>MCP</span>
        </button>
        <button className="sidebar-nav-item" onClick={onSkills}>
          <span className="sidebar-nav-icon">📚</span>
          <span>技能</span>
        </button>
        <button className="sidebar-nav-item" onClick={onMemory}>
          <span className="sidebar-nav-icon">🧠</span>
          <span>记忆</span>
        </button>
        <button className="sidebar-nav-item" onClick={onSettings}>
          <span className="sidebar-nav-icon">⚙️</span>
          <span>设置</span>
        </button>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span>项目</span>
          <button className="sidebar-section-btn" onClick={onProjects} title="新增项目">+</button>
        </div>
        <div className="sidebar-projects">
          {projects.length === 0 ? (
            <div className="sidebar-empty">暂无项目</div>
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
                    <span className="sidebar-project-icon">📁</span>
                    <span className="sidebar-project-name">{project.name}</span>
                    <button
                      className={`sidebar-project-btn ${fileExplorerProjectId === project.id ? "active" : ""}`}
                      onClick={(e) => { e.stopPropagation(); onToggleFileExplorer?.(project.id); }}
                      title="文件浏览器"
                    >📂</button>
                    <button
                      className="sidebar-project-btn"
                      onClick={(e) => { e.stopPropagation(); handleNewSession(project.id); }}
                      title="新对话"
                    >+</button>
                    <button
                      className="sidebar-project-btn delete"
                      onClick={(e) => { e.stopPropagation(); onRemoveProject?.(project.id, project.name, project.path); }}
                      title="移除项目"
                    >🗑️</button>
                  </div>
                  {isExpanded && (
                    <div className="sidebar-sessions">
                      {projectSessions.length === 0 ? (
                        <div className="sidebar-session-empty">暂无对话</div>
                      ) : (
                        projectSessions.map((s: any) => (
                          <div
                            key={s.id}
                            className={`sidebar-session ${currentSession?.id === s.id ? "active" : ""}`}
                            onClick={() => handleSessionClick(project.id, s.id)}
                          >
                            <span className="sidebar-session-title">{s.title}</span>
                            <button
                              className="sidebar-session-delete"
                              onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ sessionId: s.id, title: s.title }); }}
                            >✕</button>
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
          title="删除对话"
          message={`确定删除「${deleteConfirm.title}」？`}
          confirmLabel="删除"
          cancelLabel="取消"
          onConfirm={() => { deleteSession(deleteConfirm.sessionId); setDeleteConfirm(null); loadAllSessions(); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}

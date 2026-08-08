import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useProjectStore } from "../core/store";
import { useLang, S } from "../core/i18n/lang";
import { Search, Pin, Folder, PencilLine, BookMarked, Settings, MessageSquare, GitBranch } from "lucide-react";
import * as SessionStorage from "../core/storage/session";

interface SearchDialogProps {
  onClose: () => void;
  onSwitchProject: (projectId: string) => void;
  onNewSession: () => void;
  onOpenSkills: () => void;
  onOpenSettings?: () => void;
}

export function SearchDialog({ onClose, onSwitchProject, onNewSession, onOpenSkills, onOpenSettings }: SearchDialogProps) {
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { projects, currentProject, openProject, getProjectSessions, switchSession } = useProjectStore();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()) ||
    p.path.toLowerCase().includes(query.toLowerCase())
  );

  // P1: Search sessions across all projects
  const filteredSessions = (() => {
    if (!query.trim()) return [];
    const results: Array<{ sessionId: string; title: string; projectId: string; projectName: string }> = [];
    // Global sessions
    const globalSessions = SessionStorage.listSessions("");
    for (const s of globalSessions) {
      if (s.title?.toLowerCase().includes(query.toLowerCase())) {
        results.push({ sessionId: s.id, title: s.title, projectId: "", projectName: lang === "zh" ? "全局" : "Global" });
      }
    }
    // Project sessions
    for (const p of projects) {
      const sessions = getProjectSessions(p.id);
      for (const s of sessions) {
        if (s.title?.toLowerCase().includes(query.toLowerCase())) {
          results.push({ sessionId: s.id, title: s.title, projectId: p.id, projectName: p.name });
        }
      }
    }
    return results.slice(0, 10);
  })();

  // P1: All searchable items for keyboard navigation
  const allItems = [
    ...filteredProjects.map(p => ({ type: "project" as const, id: p.id, label: p.name, data: p })),
    ...filteredSessions.map(s => ({ type: "session" as const, id: s.sessionId, label: s.title, data: s })),
    { type: "action" as const, id: "new-chat", label: lang === "zh" ? "新建对话" : "New Chat" },
    { type: "action" as const, id: "skills", label: lang === "zh" ? "前往技能" : "Go to Skills" },
    ...(onOpenSettings ? [{ type: "action" as const, id: "settings", label: lang === "zh" ? "设置" : "Settings" }] : []),
  ];

  // P1: Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, allItems.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = allItems[selectedIndex];
        if (!item) return;
        if (item.type === "project") { openProject(item.id); onClose(); }
        else if (item.type === "session") {
          const s = item.data;
          if (s.projectId) openProject(s.projectId);
          switchSession(s.sessionId);
          onClose();
        }
        else if (item.id === "new-chat") { onNewSession(); onClose(); }
        else if (item.id === "skills") { onOpenSkills(); onClose(); }
        else if (item.id === "settings") { onOpenSettings?.(); onClose(); }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [allItems, selectedIndex, onClose]);

  return createPortal(
    <div className="search-overlay" onClick={onClose}>
      <div className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-wrapper">
          <span className="search-icon"><Search size={16} /></span>
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={lang === "zh" ? "搜索聊天或运行命令" : "Search chats or run commands"}
          />
        </div>

        <div className="search-content">
          {/* P1: Session search results */}
          {filteredSessions.length > 0 && (
            <div className="search-section">
              <div className="search-section-title">{lang === "zh" ? "对话" : "Sessions"}</div>
              {filteredSessions.map((s, i) => {
                const idx = filteredProjects.length + i;
                return (
                  <div
                    key={s.sessionId}
                    className={`search-item ${selectedIndex === idx ? "active" : ""}`}
                    onClick={() => {
                      if (s.projectId) openProject(s.projectId);
                      switchSession(s.sessionId);
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <span className="search-item-icon"><MessageSquare size={16} /></span>
                    <span className="search-item-label">{s.title}</span>
                    <span className="search-item-shortcut" style={{ fontSize: 10, opacity: 0.5 }}>{s.projectName}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Section 1: Projects */}
          <div className="search-section">
            <div className="search-section-title">{S.sidebar.projects[lang]}</div>
            {filteredProjects.map((project, index) => (
              <div
                key={project.id}
                className={`search-item ${project.id === currentProject?.id ? "active" : ""} ${selectedIndex === index ? "active" : ""}`}
                onClick={() => { openProject(project.id); onClose(); }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="search-item-icon">{project.pinned ? <Pin size={16} style={{ color: "var(--accent)" }} /> : <Folder size={16} />}</span>
                <span className="search-item-label">{project.name}</span>
                <span className="search-item-shortcut">Ctrl+{index + 1}</span>
              </div>
            ))}
          </div>

          {/* Section 2: Actions */}
          <div className="search-section">
            <div className="search-section-title">{lang === "zh" ? "操作" : "Actions"}</div>
            <div className={`search-item ${selectedIndex === filteredProjects.length + filteredSessions.length ? "active" : ""}`} onClick={() => { onNewSession(); onClose(); }} onMouseEnter={() => setSelectedIndex(filteredProjects.length + filteredSessions.length)}>
              <span className="search-item-icon"><PencilLine size={16} /></span>
              <span className="search-item-label">{lang === "zh" ? "新建快速对话" : "New quick chat"}</span>
              <span className="search-item-shortcut">Ctrl+N</span>
            </div>
            <div className={`search-item ${selectedIndex === filteredProjects.length + filteredSessions.length + 1 ? "active" : ""}`} onClick={() => { onOpenSkills(); onClose(); }} onMouseEnter={() => setSelectedIndex(filteredProjects.length + filteredSessions.length + 1)}>
              <span className="search-item-icon"><BookMarked size={16} /></span>
              <span className="search-item-label">{lang === "zh" ? "前往技能" : "Go to Skills"}</span>
              <span className="search-item-shortcut">Ctrl+S</span>
            </div>
            {onOpenSettings && (
              <div className={`search-item ${selectedIndex === filteredProjects.length + filteredSessions.length + 2 ? "active" : ""}`} onClick={() => { onOpenSettings(); onClose(); }} onMouseEnter={() => setSelectedIndex(filteredProjects.length + filteredSessions.length + 2)}>
                <span className="search-item-icon"><Settings size={16} /></span>
                <span className="search-item-label">{lang === "zh" ? "设置" : "Settings"}</span>
                <span className="search-item-shortcut">Ctrl+,</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

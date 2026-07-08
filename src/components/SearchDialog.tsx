import { useState, useEffect, useRef } from "react";
import { useProjectStore } from "../core/store";
import { useLang, S } from "../core/i18n/lang";

interface SearchDialogProps {
  onClose: () => void;
  onSwitchProject: (projectId: string) => void;
  onNewSession: () => void;
  onOpenSkills: () => void;
}

export function SearchDialog({ onClose, onSwitchProject, onNewSession, onOpenSkills }: SearchDialogProps) {
  const lang = useLang();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { projects, currentProject, openProject } = useProjectStore();

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

  const handleProjectClick = (projectId: string) => {
    openProject(projectId);
    onClose();
  };

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-wrapper">
          <span className="search-icon">🔍</span>
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={lang === "zh" ? "搜索聊天或运行命令" : "Search chats or run commands"}
          />
        </div>

        <div className="search-content">
          {/* Section 1: Projects */}
          <div className="search-section">
            <div className="search-section-title">{S.sidebar.projects[lang]}</div>
            {filteredProjects.map((project, index) => (
              <div
                key={project.id}
                className={`search-item ${project.id === currentProject?.id ? "active" : ""}`}
                onClick={() => handleProjectClick(project.id)}
              >
                <span className="search-item-icon">{project.pinned ? "📌" : "📁"}</span>
                <span className="search-item-label">{project.name}</span>
                <span className="search-item-shortcut">Ctrl+{index + 1}</span>
              </div>
            ))}
          </div>

          {/* Section 2: Conversations */}
          <div className="search-section">
            <div className="search-section-title">{lang === "zh" ? "对话" : "Chats"}</div>
            <div className="search-item" onClick={() => { onNewSession(); onClose(); }}>
              <span className="search-item-icon">✏️</span>
              <span className="search-item-label">{lang === "zh" ? "新建快速对话" : "New quick chat"}</span>
              <span className="search-item-shortcut">Ctrl+N</span>
            </div>
          </div>

          {/* Section 3: Skills */}
          <div className="search-section">
            <div className="search-section-title">{S.sidebar.skills[lang]}</div>
            <div className="search-item" onClick={() => { onOpenSkills(); onClose(); }}>
              <span className="search-item-icon">📚</span>
              <span className="search-item-label">{lang === "zh" ? "前往技能" : "Go to Skills"}</span>
              <span className="search-item-shortcut">Ctrl+S</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

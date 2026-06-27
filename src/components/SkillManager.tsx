import { useState, useEffect } from "react";
import { getSkillRegistry, type SkillDefinition } from "../core/skill/skill";

interface SkillManagerProps {
  onClose: () => void;
}

export function SkillManager({ onClose }: SkillManagerProps) {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillDefinition | null>(null);
  const [filter, setFilter] = useState<"all" | "builtin" | "project" | "user">("all");

  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = () => {
    const registry = getSkillRegistry();
    setSkills(registry.getAll());
  };

  const filteredSkills = skills.filter(
    (s) => filter === "all" || s.source === filter
  );

  function getSourceLabel(source: string): string {
    switch (source) {
      case "builtin": return "内置";
      case "project": return "项目";
      case "user": return "用户";
      case "external": return "外部";
      default: return source;
    }
  }

  function getSourceColor(source: string): string {
    switch (source) {
      case "builtin": return "var(--accent)";
      case "project": return "var(--success)";
      case "user": return "var(--warning)";
      case "external": return "var(--text-muted)";
      default: return "var(--text-muted)";
    }
  }

  return (
    <div className="skill-manager">
      <div className="skill-manager-header">
        <div className="skill-manager-title">
          <span className="skill-manager-icon">📚</span>
          <span>技能管理</span>
        </div>
        <button className="skill-manager-close" onClick={onClose}>✕</button>
      </div>

      <div className="skill-manager-filters">
        {(["all", "builtin", "project", "user"] as const).map((f) => (
          <button
            key={f}
            className={`skill-filter-btn ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "全部" : getSourceLabel(f)}
            {f !== "all" && (
              <span className="skill-filter-count">
                {skills.filter((s) => s.source === f).length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="skill-content">
        <div className="skill-list">
          {filteredSkills.length === 0 && (
            <div className="skill-empty">暂无技能</div>
          )}
          {filteredSkills.map((skill) => (
            <div
              key={skill.name}
              className={`skill-item ${selectedSkill?.name === skill.name ? "selected" : ""}`}
              onClick={() => setSelectedSkill(selectedSkill?.name === skill.name ? null : skill)}
            >
              <div className="skill-item-header">
                <span className="skill-item-name">{skill.name}</span>
                <span
                  className="skill-item-source"
                  style={{ color: getSourceColor(skill.source) }}
                >
                  {getSourceLabel(skill.source)}
                </span>
              </div>
              <div className="skill-item-desc">{skill.description}</div>
              {skill.aliases && skill.aliases.length > 0 && (
                <div className="skill-item-aliases">
                  别名: {skill.aliases.join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>

        {selectedSkill && (
          <div className="skill-detail">
            <div className="skill-detail-header">
              <h3>{selectedSkill.name}</h3>
              <span
                className="skill-detail-source"
                style={{ color: getSourceColor(selectedSkill.source) }}
              >
                {getSourceLabel(selectedSkill.source)}
              </span>
            </div>

            <div className="skill-detail-section">
              <label>描述</label>
              <p>{selectedSkill.description}</p>
            </div>

            {selectedSkill.aliases && selectedSkill.aliases.length > 0 && (
              <div className="skill-detail-section">
                <label>别名</label>
                <div className="skill-detail-tags">
                  {selectedSkill.aliases.map((alias) => (
                    <span key={alias} className="skill-detail-tag">{alias}</span>
                  ))}
                </div>
              </div>
            )}

            {selectedSkill.allowedTools && selectedSkill.allowedTools.length > 0 && (
              <div className="skill-detail-section">
                <label>允许的工具</label>
                <div className="skill-detail-tags">
                  {selectedSkill.allowedTools.map((tool) => (
                    <span key={tool} className="skill-detail-tag tool">{tool}</span>
                  ))}
                </div>
              </div>
            )}

            {selectedSkill.model && (
              <div className="skill-detail-section">
                <label>模型</label>
                <span className="skill-detail-value">{selectedSkill.model}</span>
              </div>
            )}

            {selectedSkill.whenToUse && (
              <div className="skill-detail-section">
                <label>触发条件</label>
                <p className="skill-detail-mono">{selectedSkill.whenToUse}</p>
              </div>
            )}

            <div className="skill-detail-section">
              <label>提示词</label>
              <pre className="skill-detail-prompt">{selectedSkill.prompt}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

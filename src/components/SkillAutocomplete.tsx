/**
 * SkillAutocomplete — 技能自动补全
 *
 * 用户输入 / 时显示可用技能列表
 */

import { memo, useState } from "react";
import { useLang, S } from "../core/i18n/lang";

interface SkillItem {
  id: string;
  name: string;
  description: string;
}

interface SkillAutocompleteProps {
  /** Available skills */
  skills: SkillItem[];
  /** When user selects a skill */
  onSelect: (skill: SkillItem) => void;
}

export const SkillAutocomplete = memo(function SkillAutocomplete({
  skills,
  onSelect,
}: SkillAutocompleteProps) {
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(false);

  const filtered = skills.filter((skill) =>
    skill.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <>
      {visible && (
        <div className="skill-autocomplete">
          <div className="skill-header">
            <span>{S.skills.title[lang]}</span>
            <button
              className="skill-close"
              onClick={() => setVisible(false)}
            >
              ✕
            </button>
          </div>
          {filtered.length === 0 ? (
            <div className="skill-empty">{S.skills.noResults[lang]}</div>
          ) : (
            <ul className="skill-list">
              {filtered.slice(0, 5).map((skill) => (
                <li
                  key={skill.id}
                  className="skill-item"
                  onClick={() => {
                    onSelect(skill);
                    setVisible(false);
                  }}
                >
                  <div className="skill-name">{skill.name}</div>
                  <div className="skill-desc">{skill.description}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
});
import { useState, useEffect, useRef, useMemo } from "react";
import { getSkillRegistry } from "../core/skill/skill";
import { getSettingJSON } from "../core/storage/settings";
import { useLang } from "../core/i18n/lang";

export interface SlashCommandItem {
  id: string;
  title: string;
  description?: string;
  icon: string;
  onSelect: () => void;
}

interface SlashCommandMenuProps {
  filter: string;
  onSelect: (item: SlashCommandItem) => void;
  onClose: () => void;
}

export function SlashCommandMenu({ filter, onSelect, onClose }: SlashCommandMenuProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<SlashCommandItem[]>(() => {
    const items: SlashCommandItem[] = [];
    let disabled: string[] = [];
    try { disabled = getSettingJSON<string[]>("codem-disabled-skills", []); } catch {}
    const skills = getSkillRegistry().getAll().filter(s => !disabled.includes(s.name));

    for (const s of skills) {
      const name = s.displayName || s.name;
      const lowerFilter = filter.toLowerCase();
      const matches =
        !filter ||
        s.name.toLowerCase().includes(lowerFilter) ||
        name.toLowerCase().includes(lowerFilter) ||
        (s.description || "").toLowerCase().includes(lowerFilter);

      if (matches) {
        items.push({
          id: s.name,
          title: name,
          description: s.description,
          icon: "🎯",
          onSelect: () => onSelect({
            id: s.name,
            title: name,
            description: s.description,
            icon: "🎯",
            onSelect: () => {},
          }),
        });
      }
    }
    return items;
  }, [filter, onSelect]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, commands.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && commands[selectedIndex]) {
        e.preventDefault();
        commands[selectedIndex].onSelect();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [commands, selectedIndex, onClose]);

  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.children[selectedIndex] as HTMLElement;
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (commands.length === 0) {
    return (
      <div className="slash-command-menu" ref={listRef}>
        <div className="slash-command-empty">
          {zh ? "无匹配技能" : "No matching skills"}
        </div>
      </div>
    );
  }

  return (
    <div className="slash-command-menu" ref={listRef}>
      <div className="slash-command-header">
        {zh ? "技能列表" : "Skills"}
      </div>
      {commands.map((cmd, i) => (
        <button
          key={cmd.id}
          className={`slash-command-item ${i === selectedIndex ? "selected" : ""}`}
          onMouseEnter={() => setSelectedIndex(i)}
          onClick={() => cmd.onSelect()}
        >
          <span className="slash-command-icon">{cmd.icon}</span>
          <span className="slash-command-info">
            <span className="slash-command-title">{cmd.title}</span>
            {cmd.description && (
              <span className="slash-command-desc">{cmd.description}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

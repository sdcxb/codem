/**
 * Hub 皮肤 - 顶部导航栏
 * 顶部菜单映射到 codem 各功能
 */

import { useLang } from "../core/i18n/lang";

interface TopNavbarProps {
  onHome?: () => void;
  onTasks?: () => void;
  onSkills?: () => void;
  onNotebooks?: () => void;
  onAutomations?: () => void;
  onSearch?: () => void;
  onSettings?: () => void;
}

export function TopNavbar({ onHome, onTasks, onSkills, onNotebooks, onAutomations, onSearch, onSettings }: TopNavbarProps) {
  const lang = useLang();

  // 菜单映射到 codem 功能
  const links = [
    { id: "home", label: lang === "zh" ? "首页" : "Home", active: true, onClick: onHome },
    // Tasks → 项目管理器（管理对话和项目）
    { id: "tasks", label: lang === "zh" ? "任务" : "Tasks", onClick: onTasks },
    // Skills → 技能管理器
    { id: "skills", label: "Skills", onClick: onSkills },
    // Notebooks → 笔记本管理器
    { id: "notebooks", label: lang === "zh" ? "笔记本" : "Notebooks", onClick: onNotebooks },
    // Automations → MCP 管理器（自动化工具链）
    { id: "automations", label: lang === "zh" ? "自动化" : "Automations", onClick: onAutomations },
  ];

  return (
    <nav className="hub-navbar">
      <div className="hub-navbar-logo">
        codem <span className="hub-badge">hub</span>
      </div>
      <div className="hub-navbar-links">
        {links.map((link) => (
          <a
            key={link.id}
            className={link.active ? "active" : ""}
            onClick={(e) => {
              e.preventDefault();
              link.onClick?.();
            }}
          >
            {link.label}
          </a>
        ))}
      </div>
      <div className="hub-navbar-actions">
        <i className="fas fa-search" title={lang === "zh" ? "搜索" : "Search"} onClick={onSearch} style={{ cursor: "pointer" }} />
        <i className="fas fa-cog" title={lang === "zh" ? "设置" : "Settings"} onClick={onSettings} style={{ cursor: "pointer" }} />
      </div>
    </nav>
  );
}

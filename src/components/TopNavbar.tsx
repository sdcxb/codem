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
  onTaskCenter?: () => void;
}

export function TopNavbar({ onHome, onTasks, onSkills, onNotebooks, onTaskCenter }: TopNavbarProps) {
  const lang = useLang();

  // 菜单映射到 codem 功能
  const links = [
    { id: "home", label: lang === "zh" ? "首页" : "Home", active: true, onClick: onHome },
    // Tasks → 项目管理器（管理对话和项目）
    { id: "tasks", label: lang === "zh" ? "项目" : "Projects", onClick: onTasks },
    // Skills → 技能管理器
    { id: "skills", label: "Skills", onClick: onSkills },
    // Notebooks → 笔记本管理器
    { id: "notebooks", label: lang === "zh" ? "笔记本" : "Notebooks", onClick: onNotebooks },
    // Task Center → 统一任务管理面板
    { id: "taskcenter", label: lang === "zh" ? "任务管理" : "Tasks", onClick: onTaskCenter },
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
    </nav>
  );
}

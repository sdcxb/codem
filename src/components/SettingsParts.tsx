/**
 * SettingsParts — 可复用的设置面板组件
 *
 * 包含：
 * - SettingsNav: 设置导航栏（替代原有 settings-sidebar-item）
 * - ConfigEntry: 配置条目（标签 + 描述 + 控件）
 * - ToggleEntry: 开关切换条目
 *
 * 使用 CSS 变量驱动，自动适配三套皮肤。
 */

import { memo, type ReactNode } from "react";
import { type LucideIcon } from "lucide-react";

// ========== SettingsNav ==========

export interface SettingsNavItem {
  id: string;
  label: string;
  icon?: LucideIcon;
}

export interface SettingsNavSection {
  label?: string;
  items: SettingsNavItem[];
}

interface SettingsNavProps {
  sections: SettingsNavSection[];
  activeId: string;
  onSelect: (id: string) => void;
}

export const SettingsNav = memo(function SettingsNav({
  sections,
  activeId,
  onSelect,
}: SettingsNavProps) {
  return (
    <nav className="settings-nav">
      {sections.map((section, i) => (
        <div key={i}>
          {section.label && (
            <div className="settings-nav-section-label">{section.label}</div>
          )}
          {section.items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`settings-nav-item ${activeId === item.id ? "active" : ""}`}
                onClick={() => onSelect(item.id)}
              >
                {Icon && <Icon size={14} />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
});

// ========== ConfigEntry ==========

interface ConfigEntryProps {
  label: string;
  description?: string;
  children: ReactNode;
}

export const ConfigEntry = memo(function ConfigEntry({
  label,
  description,
  children,
}: ConfigEntryProps) {
  return (
    <div className="config-entry">
      <div className="config-entry-info">
        <span className="config-entry-label">{label}</span>
        {description && (
          <span className="config-entry-desc">{description}</span>
        )}
      </div>
      <div className="config-entry-control">{children}</div>
    </div>
  );
});

// ========== ToggleEntry ==========

interface ToggleEntryProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}

export const ToggleEntry = memo(function ToggleEntry({
  label,
  description,
  value,
  onChange,
}: ToggleEntryProps) {
  return (
    <ConfigEntry label={label} description={description}>
      <button
        className={`toggle-entry ${value ? "on" : ""}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
      />
    </ConfigEntry>
  );
});

/**
 * SpaceSwitcher — 工作空间切换器
 *
 * 在侧边栏顶部显示当前工作空间名称，
 * 点击后展开下拉列表切换不同的工作空间（项目）。
 * 支持：
 * - 显示当前项目名称 + 图标
 * - 下拉切换项目
 * - 快速新建项目
 * - 全局对话入口
 *
 * 使用 CSS 变量驱动，自动适配三套皮肤。
 */

import { useState, useRef, useEffect, memo } from "react";
import { ChevronDown, FolderKanban, Plus, Globe, Check } from "lucide-react";
import { useProjectStore } from "../core/store";

interface SpaceSwitcherProps {
  /** 是否显示 */
  visible?: boolean;
  /** 新建项目回调 */
  onNewProject?: () => void;
}

interface SpaceItem {
  id: string;
  name: string;
  path: string;
  isGlobal: boolean;
}

export const SpaceSwitcher = memo(function SpaceSwitcher({
  visible = true,
  onNewProject,
}: SpaceSwitcherProps) {
  const { projects, currentProject, openProject } = useProjectStore();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!showDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showDropdown]);

  if (!visible) return null;

  const currentName = currentProject?.name || "全局对话";
  const spaces: SpaceItem[] = [
    { id: "__global__", name: "全局对话", path: "", isGlobal: true },
    ...projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      isGlobal: false,
    })),
  ];

  const handleSelect = (space: SpaceItem) => {
    if (space.isGlobal) {
      useProjectStore.setState({ currentProject: null, currentSession: null });
    } else {
      openProject(space.id);
    }
    setShowDropdown(false);
  };

  return (
    <div className="space-switcher" ref={dropdownRef}>
      <button
        className="space-switcher-btn"
        onClick={() => setShowDropdown((s) => !s)}
        title={currentName}
      >
        {currentProject ? (
          <FolderKanban size={14} className="space-switcher-icon" />
        ) : (
          <Globe size={14} className="space-switcher-icon" />
        )}
        <span className="space-switcher-name">{currentName}</span>
        <ChevronDown size={12} className="space-switcher-arrow" />
      </button>

      {showDropdown && (
        <div className="space-switcher-dropdown">
          <div className="space-switcher-list">
            {spaces.map((space) => {
              const isActive = space.isGlobal
                ? !currentProject
                : currentProject?.id === space.id;
              return (
                <button
                  key={space.id}
                  className={`space-switcher-item ${isActive ? "active" : ""}`}
                  onClick={() => handleSelect(space)}
                >
                  {space.isGlobal ? (
                    <Globe size={12} />
                  ) : (
                    <FolderKanban size={12} />
                  )}
                  <span className="space-switcher-item-name">{space.name}</span>
                  {isActive && <Check size={12} className="space-switcher-check" />}
                </button>
              );
            })}
          </div>
          {onNewProject && (
            <button
              className="space-switcher-new-btn"
              onClick={() => {
                onNewProject();
                setShowDropdown(false);
              }}
            >
              <Plus size={12} />
              <span>新建项目</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
});

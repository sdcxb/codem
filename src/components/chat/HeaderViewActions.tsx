/**
 * 聊天头部的**直接视图/面板按钮**（第 18 轮）。
 *
 * 背景：Batch 1B 曾把 7 个视图开关收进「更多操作 → 视图与面板」菜单。
 * 实际使用里这些是高频开关（完整历史/思考过程/智能体/快照/上下文/轨迹/侧边面板），
 * 收进菜单后每次都要「点开菜单 → 再点一项」，用户明确要求恢复成常显图标、快捷点击。
 *
 * 保留原菜单的行为契约：
 * - 每项都有可访问名（aria-label/title），不再只有 title；
 * - 开关型用 `aria-pressed` 表达当前状态；
 * - disabled 的项不可点；
 * - 图标沿用调用方给的 lucide 图标，不另造一套。
 */
import type { ReactNode } from "react";

export interface HeaderViewAction {
  id: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface HeaderViewActionsProps {
  items: HeaderViewAction[];
  /** 工具条的可访问名（中文/英文由调用方给） */
  label: string;
}

export function HeaderViewActions({ items, label }: HeaderViewActionsProps) {
  return (
    <div className="chat-header-view-actions" role="toolbar" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`agent-toggle chat-header-action ${item.active ? "active" : ""}`}
          aria-label={item.label}
          aria-pressed={!!item.active}
          title={item.label}
          disabled={item.disabled}
          onClick={item.onSelect}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}

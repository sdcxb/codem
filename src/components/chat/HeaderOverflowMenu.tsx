/**
 * 聊天头部的"更多"溢出菜单（Batch 1B）。
 *
 * ## 为什么要有它
 *
 * 迁移前聊天头上有 **10 个可交互控件、7 个纯图标按钮**，其中 6 个只有 `title`、没有 `aria-label`。
 * 方向稿要求"头部收敛到 3 个 + overflow"：保留身份/上下文级的三项（侧栏开关、会话标题、模型），
 * 其余（完整历史、思考、智能体、快照、上下文、轨迹、侧边面板）收进一个菜单。
 * 收进菜单的另一个收益是：每一项**天然有了文字名**，顺带修掉"只有 title 的可访问名"。
 *
 * ## 关闭语义走共享层
 *
 * Escape / 焦点归还一律交给 `useDismissableLayer`（全仓浮层关闭的唯一实现）：
 * 它保证"只有最上层响应"、关闭后焦点回到触发按钮、以及（可选）背景 `inert`。
 * 手写按键监听会同时踩两条门禁：OVERLAY-1c 的棘轮（按 Esc 字样的行数只许降），以及焦点丢失。
 *
 * ## 行为契约
 *
 * - 触发按钮：`aria-haspopup="menu"` + `aria-expanded`；
 * - 打开后焦点落在第一项；
 * - 每一项是 `menuitemcheckbox`（菜单里全是开关式视图），`aria-checked` 反映当前是否激活；
 * - 选中后关闭菜单（面板本身保留打开态，由调用方决定）；
 * - 点遮罩关闭（与仓里其它下拉一致，用 `.popover-shield`）。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";

export interface HeaderMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** 当前是否处于"开"的状态（决定 aria-checked 与选中样式） */
  active?: boolean;
  /** 不可用（例如没有会话时的「完整历史」） */
  disabled?: boolean;
  onSelect: () => void;
}

export interface HeaderOverflowMenuProps {
  items: HeaderMenuItem[];
  /** 触发按钮的可访问名（中文/英文由调用方给） */
  label: string;
  /** 菜单标题（可选，屏幕上不显示，只给 screen reader） */
  menuLabel?: string;
}

export function HeaderOverflowMenu({ items, label, menuLabel }: HeaderOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useDismissableLayer({ open, onDismiss: () => setOpen(false) });

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>("[role='menuitemcheckbox']");
    first?.focus();
  }, [open]);

  return (
    <div className="chat-header-overflow chat-relative-anchor">
      <button
        ref={triggerRef}
        type="button"
        className={`agent-toggle ${open ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="popover-shield" style={{ zIndex: 99 }} onClick={() => setOpen(false)} />
          <div ref={menuRef} className="popover-shell chat-header-overflow-menu" role="menu" aria-label={menuLabel ?? label}>
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={!!item.active}
                aria-disabled={item.disabled ? true : undefined}
                disabled={item.disabled}
                className={`chat-header-overflow-item ${item.active ? "is-active" : ""}`}
                onClick={() => {
                  item.onSelect();
                  setOpen(false);
                }}
              >
                <span className="chat-header-overflow-icon" aria-hidden="true">{item.icon}</span>
                <span className="chat-header-overflow-label">{item.label}</span>
                <span className="chat-header-overflow-check" aria-hidden="true">{item.active ? "✓" : ""}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

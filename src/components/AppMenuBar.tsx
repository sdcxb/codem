/**
 * AppMenuBar —— 应用级菜单栏（第 41 波）。
 *
 * 为什么要有它：参考实现有完整的应用外壳（mac 风格窗口 + 一体化工具条 + 应用菜单），
 * 而我们此前只有一排图标按钮 —— 图标按钮"能用"，但**没有可读的命令名**：
 * 用户不知道有哪些功能、也看不到快捷键。原生桌面应用的"产品感"有很大一部分来自
 * 这一条菜单栏（文件 / 视图 / 帮助）。
 *
 * 设计取舍：
 * - 只放**真实可用**的命令（没有实现的菜单项一律不放，不放灰掉的假项）；
 * - 键盘完整可用：Alt/↓ 打开、↑↓ 选项、←→ 换菜单、Esc 关闭并回到触发器、Home/End 跳首尾；
 * - ARIA 与样式同源：`role="menubar"/"menu"/"menuitem"` + `aria-haspopup` + `aria-expanded`，
 *   样式挂在 `[aria-expanded="true"]` 与 `:focus-visible` 上（不额外造 `.active` 类）。
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface AppMenuAction {
  id: string;
  label: string;
  /** 快捷键提示（仅展示；真实绑定在各自组件里） */
  shortcut?: string;
  onSelect?: () => void;
  /** 分组分隔线：在这项**之前**画一条 */
  separatorBefore?: boolean;
  disabled?: boolean;
}

export interface AppMenuSection {
  id: string;
  label: string;
  items: AppMenuAction[];
}

interface AppMenuBarProps {
  zh: boolean;
  menus: AppMenuSection[];
}

export function AppMenuBar({ zh, menus }: AppMenuBarProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRefs = useRef(new Map<string, HTMLDivElement | null>());
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const baseId = useId();

  const close = useCallback((focusTrigger = true) => {
    setOpenId((current) => {
      if (current && focusTrigger) triggerRefs.current.get(current)?.focus();
      return null;
    });
  }, []);

  // 点击别处 / 按 Esc 关闭
  useEffect(() => {
    if (!openId) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenId(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [openId, close]);

  const focusItem = (menuId: string, index: number) => {
    const container = menuRefs.current.get(menuId);
    if (!container) return;
    const items = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])")];
    if (!items.length) return;
    const next = (index + items.length) % items.length;
    items[next]?.focus();
  };

  /** 待聚焦项：菜单是条件渲染的，展开后 DOM 才存在 —— 用 effect 在渲染完成后聚焦
   *  （不用 requestAnimationFrame：那样在测试与慢机器上时序不可控） */
  const pendingFocus = useRef<{ menuId: string; index: number } | null>(null);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || !openId) return;
    pendingFocus.current = null;
    const container = menuRefs.current.get(pending.menuId);
    if (!container) return;
    const items = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])")];
    if (!items.length) return;
    items[(pending.index + items.length) % items.length]?.focus();
  }, [openId]);

  /** 在菜单之间左右移动（打开态下用 ←→ 切换） */
  const moveMenu = (dir: 1 | -1) => {
    if (!openId) return;
    const idx = menus.findIndex((m) => m.id === openId);
    const next = menus[(idx + dir + menus.length) % menus.length];
    pendingFocus.current = { menuId: next.id, index: dir === 1 ? 0 : -1 };
    setOpenId(next.id);
  };

  const openMenu = (menuId: string, focusFirst: boolean) => {
    if (focusFirst) pendingFocus.current = { menuId, index: 0 };
    setOpenId(menuId);
  };

  return (
    // data-tauri-drag-region 之外：这一条是交互区，不能拖窗口
    <div className="app-menubar" role="menubar" aria-label={zh ? "应用菜单" : "Application menu"} ref={rootRef}>
      {menus.map((menu) => {
        const open = openId === menu.id;
        const menuDomId = `${baseId}-${menu.id}`;
        return (
          <div className="app-menu" key={menu.id}>
            <button
              type="button"
              className="app-menu-trigger"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? menuDomId : undefined}
              ref={(el) => {
                triggerRefs.current.set(menu.id, el);
              }}
              onClick={() => (open ? close(false) : openMenu(menu.id, false))}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openMenu(menu.id, true);
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  const idx = menus.findIndex((m) => m.id === menu.id);
                  const next = menus[(idx + 1) % menus.length];
                  triggerRefs.current.get(next.id)?.focus();
                  if (openId) setOpenId(next.id);
                } else if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  const idx = menus.findIndex((m) => m.id === menu.id);
                  const prev = menus[(idx - 1 + menus.length) % menus.length];
                  triggerRefs.current.get(prev.id)?.focus();
                  if (openId) setOpenId(prev.id);
                }
              }}
            >
              {menu.label}
            </button>

            {open && (
              <div
                className="app-menu-surface"
                role="menu"
                id={menuDomId}
                aria-label={menu.label}
                ref={(el) => {
                  menuRefs.current.set(menu.id, el);
                }}
                onKeyDown={(e) => {
                  const container = menuRefs.current.get(menu.id);
                  const items = container
                    ? [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])")]
                    : [];
                  const current = items.indexOf(document.activeElement as HTMLButtonElement);
                  switch (e.key) {
                    case "ArrowDown":
                      e.preventDefault();
                      focusItem(menu.id, current + 1);
                      break;
                    case "ArrowUp":
                      e.preventDefault();
                      focusItem(menu.id, current - 1);
                      break;
                    case "Home":
                      e.preventDefault();
                      focusItem(menu.id, 0);
                      break;
                    case "End":
                      e.preventDefault();
                      focusItem(menu.id, -1);
                      break;
                    case "ArrowRight":
                      e.preventDefault();
                      moveMenu(1);
                      break;
                    case "ArrowLeft":
                      e.preventDefault();
                      moveMenu(-1);
                      break;
                    case "Tab":
                      setOpenId(null);
                      break;
                    default:
                      break;
                  }
                }}
              >
                {menu.items.map((item) => (
                  <div key={item.id}>
                    {item.separatorBefore && <div className="app-menu-separator" role="separator" />}
                    <button
                      type="button"
                      className="app-menu-item"
                      role="menuitem"
                      disabled={item.disabled}
                      aria-keyshortcuts={item.shortcut}
                      onClick={() => {
                        setOpenId(null);
                        item.onSelect?.();
                      }}
                    >
                      <span className="app-menu-item-label">{item.label}</span>
                      {item.shortcut && <kbd className="app-menu-shortcut">{item.shortcut}</kbd>}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

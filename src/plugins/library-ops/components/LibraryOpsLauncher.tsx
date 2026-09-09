/**
 * LibraryOpsLauncher —— 插件入口（挂载到 `app.overlay` 全局叠加层）。
 *
 * 设计取舍：
 * - 宿主 App.tsx 无需为插件新增任何 UI 代码：插件通过已存在的 `app.overlay`
 *   list 型 slot 自挂载（`<SlotListBridge name="app.overlay" />` 已由 App.tsx 消费）。
 * - 关闭插件（插件管理里禁用 `@codem/ui-library-ops`）→ provider 不装配 →
 *   这个入口和面板都不存在，宿主 UI 完全不变。
 * - 入口是一个**可拖拽的悬浮圆钮**（默认右下角、位于输入区上方，不占布局）：
 *   位置持久化到 localStorage，用户可拖到任何不挡控件的地方；
 *   另外支持 Ctrl/Cmd+Shift+L 与 `codem:open-library-ops` 自定义事件。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLibraryOps } from "../store";
import { LibraryOpsPanel } from "./LibraryOpsPanel";
import "../styles/library-ops.css";

/** 其它界面打开监控面板的全局事件名 */
export const OPEN_EVENT = "codem:open-library-ops";

/** 入口位置持久化键（与插件设置键区分） */
const POS_KEY = "codem-library-ops-launcher-pos";

interface Pos {
  x: number;
  y: number;
}

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pos;
    if (typeof p?.x !== "number" || typeof p?.y !== "number") return null;
    return p;
  } catch {
    return null;
  }
}

function savePos(p: Pos | null): void {
  try {
    if (p) localStorage.setItem(POS_KEY, JSON.stringify(p));
    else localStorage.removeItem(POS_KEY);
  } catch (e) {
    console.warn("[library-ops] launcher position persist failed:", e);
  }
}

export function LibraryOpsLauncher() {
  const open = useLibraryOps((s) => s.open);
  const openPanel = useLibraryOps((s) => s.openPanel);
  const togglePanel = useLibraryOps((s) => s.togglePanel);
  const autoOpen = useLibraryOps((s) => s.settings.autoOpen);
  const snapshot = useLibraryOps((s) => s.snapshot);
  const refresh = useLibraryOps((s) => s.refresh);

  const [pos, setPos] = useState<Pos | null>(() => (typeof localStorage === "undefined" ? null : loadPos()));
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // 启动时自动打开（设置项，默认关闭）+ 采样一次用于入口徽标
  // （只采一次，不做后台轮询：面板关闭后宿主零开销）
  useEffect(() => {
    if (autoOpen) openPanel();
    else void refresh();
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 全局事件 + 快捷键
  useEffect(() => {
    const onOpen = () => openPanel();
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, [openPanel, togglePanel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const el = btnRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      drag.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: rect.left,
        originY: rect.top,
        moved: false,
      };
      el.setPointerCapture?.(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const size = 44;
    setPos({
      x: Math.max(4, Math.min(w - size - 4, d.originX + dx)),
      y: Math.max(4, Math.min(h - size - 4, d.originY + dy)),
    });
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      drag.current = null;
      btnRef.current?.releasePointerCapture?.(e.pointerId);
      if (!d) return;
      if (d.moved) {
        savePos(pos);
        // 拖动结束后的 click 不应触发展开
        suppressClick.current = true;
      }
    },
    [pos],
  );

  /** 点击展开（键盘 Enter / 触摸 / 鼠标单击均走这里） */
  const onClick = useCallback(() => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    openPanel();
  }, [openPanel]);

  const onDoubleClick = useCallback(() => {
    // 双击复位到默认位置
    setPos(null);
    savePos(null);
  }, []);

  const style = pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined;
  const working = snapshot?.metrics.actorsWorking ?? 0;
  const errors = snapshot?.metrics.actorsError ?? 0;

  return (
    <>
      {!open && (
        <button
          ref={btnRef}
          className="lo-launcher"
          style={style}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          title={
            errors > 0
              ? `图书馆运营监控：${errors} 个角色异常（点击打开 / 拖动移动 / 双击复位）`
              : working > 0
                ? `图书馆运营监控：${working} 个角色工作中（点击打开 / 拖动移动 / 双击复位）`
                : "图书馆运营监控（点击打开 / 拖动移动 / 双击复位 / Ctrl+Shift+L）"
          }
          aria-label="图书馆运营监控"
          data-working={working}
          data-errors={errors}
        >
          <span className="lo-launcher__icon" aria-hidden="true">
            📚
          </span>
          <span className="lo-launcher__text">图书馆</span>
          {working > 0 && (
            <span className={`lo-launcher__badge${errors > 0 ? " is-error" : ""}`} aria-hidden="true">
              {errors > 0 ? "!" : working}
            </span>
          )}
        </button>
      )}
      <LibraryOpsPanel />
    </>
  );
}

export default LibraryOpsLauncher;

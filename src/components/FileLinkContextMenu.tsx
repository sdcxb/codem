/**
 * FileLinkContextMenu — 自定义右键菜单，用于文件路径链接。
 *
 * 提供"在文件管理器中显示"、"打开文件"、"复制路径"三个操作。
 * 通过 subscribeFileLinkMenu 订阅菜单状态变化。
 * 样式完全由 CSS 变量驱动，自动适配所有主题皮肤。
 */

import { useState, useEffect, useRef } from "react";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import {
  subscribeFileLinkMenu,
  getFileLinkMenuState,
  closeFileLinkMenu,
  openFileLink,
  openFileDirectly,
  copyFilePath,
} from "../utils/file-link";
import { FolderOpen, FileText, Copy } from "lucide-react";

export function FileLinkContextMenu() {
  const [, forceUpdate] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = subscribeFileLinkMenu(() => forceUpdate((n) => n + 1));
    return unsub;
  }, []);

  const state = getFileLinkMenuState();

  /* 第 173 轮 P2-6：Esc 关闭交给共享 hook；"点外面关"仍由上面的 mousedown 处理
     （两者是不同的关闭触发，hook 只管键盘那一半）。 */
  useDismissableLayer({ open: state.visible, onDismiss: closeFileLinkMenu });

  // Close on click outside（键盘那一半已交给 useDismissableLayer）
  useEffect(() => {
    if (!state.visible) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeFileLinkMenu();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, [state.visible]);

  if (!state.visible) return null;

  const handleAction = (action: "reveal" | "open" | "copy") => {
    closeFileLinkMenu();
    if (action === "reveal") void openFileLink(state.href);
    else if (action === "open") void openFileDirectly(state.href);
    else if (action === "copy") void copyFilePath(state.href);
  };

  return (
    <div
      ref={menuRef}
      className="file-link-context-menu popover-shell"
      style={{
        position: "fixed",
        left: state.x,
        top: state.y,
        zIndex: "var(--z-top)",
      }}
    >
      <button className="file-link-menu-item" onClick={() => handleAction("reveal")}>
        <FolderOpen size={14} />
        <span>在文件管理器中显示</span>
      </button>
      <button className="file-link-menu-item" onClick={() => handleAction("open")}>
        <FileText size={14} />
        <span>打开文件</span>
      </button>
      <button className="file-link-menu-item" onClick={() => handleAction("copy")}>
        <Copy size={14} />
        <span>复制路径</span>
      </button>
    </div>
  );
}

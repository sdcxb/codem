/**
 * FileLinkContextMenu — 自定义右键菜单，用于文件路径链接。
 *
 * 提供"在文件管理器中显示"、"打开文件"、"复制路径"三个操作。
 * 通过 subscribeFileLinkMenu 订阅菜单状态变化。
 * 样式完全由 CSS 变量驱动，自动适配所有主题皮肤。
 */

import { useState, useEffect, useRef } from "react";
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

  // Close on click outside or Escape
  useEffect(() => {
    if (!state.visible) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeFileLinkMenu();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFileLinkMenu();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
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
      className="file-link-context-menu"
      style={{
        position: "fixed",
        left: state.x,
        top: state.y,
        zIndex: 100000,
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

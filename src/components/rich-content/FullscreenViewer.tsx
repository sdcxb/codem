/**
 * FullscreenViewer — 全屏查看器
 *
 * 提供通用的全屏覆盖层，用于任何富内容组件的全屏展示。
 */

import { type ReactNode, useEffect } from "react";
import { X } from "lucide-react";

interface FullscreenViewerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function FullscreenViewer({ open, onClose, title, children }: FullscreenViewerProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="content-fullscreen-backdrop" onClick={onClose}>
      <div className="content-fullscreen" onClick={(e) => e.stopPropagation()}>
        <div className="content-fullscreen-header">
          <span className="content-fullscreen-title">{title}</span>
          <button className="content-fullscreen-close" onClick={onClose} aria-label="关闭全屏">
            <X size={16} />
          </button>
        </div>
        <div className="content-fullscreen-body">
          {children}
        </div>
      </div>
    </div>
  );
}

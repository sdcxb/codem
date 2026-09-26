import { useEffect, useRef } from "react";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = "确定", cancelLabel = "取消", onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  /* 第 173 轮 P2-6：Esc 关闭收敛到 useDismissableLayer（只关最上层 + 关闭后焦点归还） */
  useDismissableLayer({ onDismiss: onCancel });

  // Use Portal to render at document.body level — avoids backdrop-filter
  // containing block issues in Dream skin where sidebar has backdrop-filter
  // which would break position:fixed for children.
  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">{title}</div>
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button className="confirm-btn cancel" onClick={onCancel}>{cancelLabel}</button>
          <button className="confirm-btn danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

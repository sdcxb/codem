/**
 * ToastNotification — 轻量级 Toast 通知组件
 *
 * 替代 pet-bubble 的临时通知，提供标准化的 toast UI。
 * 支持四种类型：success、error、warning、info。
 * 自动消失 + 手动关闭。
 */

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { CheckCircle, XCircle, AlertTriangle, Info, X } from "lucide-react";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

// Simple global toast manager
let toastIdCounter = 0;
const toastListeners = new Set<(toasts: ToastItem[]) => void>();
let currentToasts: ToastItem[] = [];

function notify() {
  toastListeners.forEach(fn => fn([...currentToasts]));
}

export function showToast(type: ToastType, message: string, duration = 4000) {
  const id = `toast-${++toastIdCounter}`;
  currentToasts = [...currentToasts, { id, type, message, duration }];
  notify();
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

export function dismissToast(id: string) {
  currentToasts = currentToasts.filter(t => t.id !== id);
  notify();
}

const iconMap = {
  success: <CheckCircle size={18} />,
  error: <XCircle size={18} />,
  warning: <AlertTriangle size={18} />,
  info: <Info size={18} />,
};

const colorMap = {
  success: "var(--security-full, #4ade80)",
  error: "#ef4444",
  warning: "var(--warning, #f59e0b)",
  info: "var(--accent, #7c6cf0)",
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener = (newToasts: ToastItem[]) => setToasts(newToasts);
    toastListeners.add(listener);
    return () => { toastListeners.delete(listener); };
  }, []);

  const handleDismiss = useCallback((id: string) => dismissToast(id), []);

  if (toasts.length === 0) return null;

  return createPortal(
    <div className="toast-container">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast-item toast-${toast.type}`} style={{
          borderLeftColor: colorMap[toast.type],
        }}>
          <span className="toast-icon" style={{ color: colorMap[toast.type] }}>
            {iconMap[toast.type]}
          </span>
          <span className="toast-message">{toast.message}</span>
          <button className="toast-close" onClick={() => handleDismiss(toast.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}

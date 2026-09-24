/**
 * ToastNotification — 轻量级 Toast 通知组件
 *
 * 替代 pet-bubble 的临时通知，提供标准化的 toast UI。
 * 支持四种类型：success、error、warning、info。
 * 自动消失 + 手动关闭。
 */

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { ActionIcons, StatusIcons, CommonIcons } from "../core/icons/icon-map";

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

function dismissToast(id: string) {
  currentToasts = currentToasts.filter(t => t.id !== id);
  notify();
}

const iconMap = {
  success: <StatusIcons.success size={16} />,
  error: <StatusIcons.error size={16} />,
  warning: <StatusIcons.danger size={16} />,
  info: <CommonIcons.info size={16} />,
};

/**
 * 通知图标色：**一律走语义令牌**（第 65 轮）。
 *
 * 改动前 `error` 写死 Tailwind 的 `#ef4444`（白底对比度 3.76、浅灰底 3.36），
 * `info` 兜底写死 `#7c6cf0` —— 而项目里 `--error` / `--info` 早就按浅底调过
 * （`#cf222e` 白底 5.36 / `#6b5ce7` 白底 4.87）。写死的结果就是
 * "同一个错误提示，在暗色下用令牌色、在亮色下用饱和色"。
 */
const colorMap = {
  success: "var(--success)",
  error: "var(--error)",
  warning: "var(--warning)",
  info: "var(--info)",
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
          <button aria-label="关闭" title="关闭" className="toast-close" onClick={() => handleDismiss(toast.id)}>
            <ActionIcons.close size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}

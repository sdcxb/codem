/**
 * 自定义标题栏
 * - decorations: false 后用此组件替代系统标题栏
 * - data-tauri-drag-region 支持拖拽窗口
 * - 最小化 / 最大化 / 关闭按钮
 * - 透明背景，让 Mica 毛玻璃透出
 */

import { useState, useEffect, useCallback } from "react";

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  // 获取 Tauri window 实例
  const getWin = useCallback(() => {
    try {
      const tauri = (window as any).__TAURI__;
      // Tauri v2 withGlobalTauri: window.__TAURI__.window.getCurrentWindow()
      if (tauri?.window?.getCurrentWindow) {
        return tauri.window.getCurrentWindow();
      }
    } catch {}
    return null;
  }, []);

  // 初始化：读取当前最大化状态
  useEffect(() => {
    const win = getWin();
    if (!win) return;
    win.isMaximized().then((m: boolean) => setMaximized(m)).catch(() => {});

    // 监听窗口大小变化来更新最大化状态
    const interval = setInterval(() => {
      win.isMaximized().then((m: boolean) => setMaximized(m)).catch(() => {});
    }, 500);

    return () => clearInterval(interval);
  }, [getWin]);

  const handleMinimize = useCallback(() => {
    const win = getWin();
    win?.minimize().catch(() => {});
  }, [getWin]);

  const handleToggleMaximize = useCallback(() => {
    const win = getWin();
    win?.toggleMaximize().catch(() => {});
  }, [getWin]);

  const handleClose = useCallback(() => {
    const win = getWin();
    // 调用 close() 会触发 Rust 端的 CloseRequested 事件，
    // 由 Rust 端 prevent_close + emit "close-requested" 交给前端处理
    win?.close().catch(() => {});
  }, [getWin]);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <span className="titlebar-icon" data-tauri-drag-region>◆</span>
        <span className="titlebar-title" data-tauri-drag-region>Codem</span>
      </div>
      <div className="titlebar-buttons">
        <button
          className="titlebar-btn titlebar-btn-minimize"
          onClick={handleMinimize}
          title="最小化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className="titlebar-btn titlebar-btn-maximize"
          onClick={handleToggleMaximize}
          title={maximized ? "还原" : "最大化"}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M3 3 V1 H9 V7 H7" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          onClick={handleClose}
          title="关闭"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

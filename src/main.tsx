// Buffer polyfill — must be first import so globalThis.Buffer is set before any code uses it
import { Buffer } from "./stubs/buffer-polyfill";
(globalThis as any).Buffer = Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import "@fortawesome/fontawesome-free/css/all.min.css";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import "./styles.css";
import "./styles/skin-hub.css";
import "./styles/skin-dream.css";
import "./styles/notebook-workspace.css";
import "./styles/codem-ui.css";

// 全局错误捕获 — 静默记录到 console（App.tsx 另有 console 级监听）。
// 之前用 alert() 弹原生对话框：任何未捕获错误都会阻塞打断用户操作，
// 且 Tauri 窗口内多次弹窗体验极差。对标 dsh-desktop 的 crash-evidence /
// renderer-health：错误应被记录并可通过诊断导出，而不是弹出打断。
// 过滤掉已知的浏览器良性警告（ResizeObserver loop 等）。
const IGNORED_ERRORS = [
  'ResizeObserver loop completed with undelivered notifications',
  'ResizeObserver loop limit exceeded',
];
window.addEventListener('error', (e) => {
  const msg = e.message || '';
  if (IGNORED_ERRORS.some(p => msg.includes(p))) return;
  console.error('[Global Error]', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason) || '';
  if (IGNORED_ERRORS.some(p => msg.includes(p))) return;
  console.error('[Global Rejection]', e.reason);
});

// Main window: render the full application
// Pet window now uses a separate entry point (pet.html → pet-main.tsx)
// for a lightweight bundle that doesn't load the full app.
// AppErrorBoundary：顶层渲染崩溃恢复边界（对标 dsh renderer-health 恢复理念）。
// 渲染阶段崩溃不再白屏 —— 展示恢复卡片（重试/重载/重置界面设置），
// 崩溃证据写入 localStorage 供下次启动提示。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);

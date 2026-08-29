// Buffer polyfill — must be first import so globalThis.Buffer is set before any code uses it
import { Buffer } from "./stubs/buffer-polyfill";
(globalThis as any).Buffer = Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import "@fortawesome/fontawesome-free/css/all.min.css";
import App from "./App";
import "./styles.css";
import "./styles/skin-hub.css";
import "./styles/skin-dream.css";
import "./styles/notebook-workspace.css";
import "./styles/codem-ui.css";

// 全局错误捕获 — 用 alert 弹出，不依赖 DOM 渲染
// 但过滤掉已知的浏览器良性警告（ResizeObserver loop 等）
const IGNORED_ERRORS = [
  'ResizeObserver loop completed with undelivered notifications',
  'ResizeObserver loop limit exceeded',
];
window.addEventListener('error', (e) => {
  const msg = e.message || '';
  if (IGNORED_ERRORS.some(p => msg.includes(p))) return;
  alert('[ERROR] ' + (e.error?.stack || e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason) || '';
  if (IGNORED_ERRORS.some(p => msg.includes(p))) return;
  alert('[REJECTION] ' + (e.reason?.stack || e.reason?.message || String(e.reason)));
});

// Main window: render the full application
// Pet window now uses a separate entry point (pet.html → pet-main.tsx)
// for a lightweight bundle that doesn't load the full app.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

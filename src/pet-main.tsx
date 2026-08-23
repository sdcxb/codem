/**
 * pet-main.tsx — 宠物窗口的独立轻量入口。
 *
 * 不导入 App.tsx、styles.css、FontAwesome 等重型依赖。
 * 仅加载 React + PetWindowApp + 最小透明背景 CSS。
 *
 * 预期将宠物窗口的 JS Bundle 从 3.4MB 降至 ~50KB，
 * WebView2 进程内存从 ~150MB 降至 ~30-50MB。
 */

// Buffer polyfill — must be first import so globalThis.Buffer is set before any code uses it
import { Buffer } from "./stubs/buffer-polyfill";
(globalThis as any).Buffer = Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import { PetWindowApp } from "./components/PetWindowApp";
import "./styles/pet-window.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PetWindowApp />
  </React.StrictMode>
);

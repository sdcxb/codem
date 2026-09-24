/**
 * pet-main.tsx — 宠物窗口的独立轻量入口。
 *
 * 不导入 App.tsx、styles.css、FontAwesome 等重型依赖。
 * 仅加载 React + PetWindowApp + 最小透明背景 CSS。
 *
 * 预期将宠物窗口的 JS Bundle 从 3.4MB 降至 ~50KB，
 * WebView2 进程内存从 ~150MB 降至 ~30-50MB。
 */

// process shim — 必须最先导入（dev server 不像生产构建那样替换 process.*）
import "./stubs/process-polyfill";
// Buffer polyfill — must be first import so globalThis.Buffer is set before any code uses it
import { Buffer } from "./stubs/buffer-polyfill";
(globalThis as any).Buffer = Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import { PetWindowApp } from "./components/PetWindowApp";
import { PetErrorBoundary } from "./components/PetErrorBoundary";
import "./styles/pet-window.css";

/*
 * 第 108 轮：**把宠物窗自己的错误边界接上**。
 *
 * 现场：`PetErrorBoundary` 是第 44 轮（P2-14）专门为这个独立入口写的（自包含、不 import
 * 任何主窗模块，连样式都走内联），文件头把"为什么不能复用主窗的 AppErrorBoundary"讲得很清楚 ——
 * 但**它从来没有被接线**：本文件一直直接渲染 `<PetWindowApp />`。
 * 后果正是它要防的那个：宠物窗渲染期一抛异常，整个窗口就是一块**透明的死窗口**
 * （没有文字、没有按钮，用户连"重新加载"都点不到）。
 *
 * 这一处由第 106/107 轮的可达性普查查出来（`PetErrorBoundary.tsx` 只被测试 import、
 * 生产代码 0 引用），属于"已实现但没接线"里最该马上接的一类：修复成本一行，收益是
 * 崩溃时能看到诊断文本 + 「重新加载宠物界面」按钮。
 *
 * 边界在 App 内层：StrictMode 保持在外，这样边界的 class 组件行为仍受严格模式检查。
 */
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PetErrorBoundary>
      <PetWindowApp />
    </PetErrorBoundary>
  </React.StrictMode>
);

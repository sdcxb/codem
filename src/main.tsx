// process shim — 必须最先导入：dev server 不像生产构建那样替换 process.*，
// 未保护的模块（如 core/zvec-grep/types.ts）会在浏览器里 ReferenceError 白屏
import "./stubs/process-polyfill";
// Buffer polyfill — must be first import so globalThis.Buffer is set before any code uses it
import { Buffer } from "./stubs/buffer-polyfill";
(globalThis as any).Buffer = Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import "@fortawesome/fontawesome-free/css/all.min.css";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import { applyAppearanceAttributes } from "./core/theme/appearance-modes";
import "./styles.css";
import "./styles/skin-hub.css";
import "./styles/skin-dream.css";
import "./styles/notebook-workspace.css";
import "./styles/codem-ui.css";
import "./styles/task-center.css";

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
/**
 * 第 158 轮：把「系统窗口材质可用吗」问清楚，并在**首次渲染前**打上 `data-native-material`。
 *
 * 为什么要在这里做（对标 OpenBitFun 的启动注入脚本）：系统材质（Windows Mica/Acrylic、macOS vibrancy）
 * 早就 apply 了，但网页在它上面画了不透明底色 ⇒ 材质一直看不见。CSS 只有知道「材质真的生效了」
 * 才敢把外壳底色让出来；而在**首帧之前**打属性，才不会出现「先画一帧实色、再变成玻璃」的闪动。
 * 失败 / 非 Tauri 环境（浏览器调试）一律不打属性 ⇒ 保持不透明底 + 我们自己的场景层（1.16.157 那套）。
 */
async function applyNativeMaterialHint(): Promise<void> {
  try {
    const { invoke, isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    const material = await invoke<string>("native_material");
    if (material) {
      document.documentElement.setAttribute("data-native-material", "sidebar");
      document.documentElement.setAttribute("data-native-material-kind", material);
    }
  } catch (e) {
    // 拿不到就当作「没有材质」：宁可保持不透明，也不要得到一块没有材质的透明窗口
    console.warn("[native-material] 探测失败，保持不透明底", e);
  }
}

/** 渲染入口（单独抽出来，好让 bootstrap 在探测之后再调它） */
function renderApp(): void {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>
  );
}

/**
 * 启动顺序：**先探测材质、再渲染**。
 * ⚠️ 不能用顶层 `await` —— 构建目标（esbuild 的 safari 档）不支持，实测直接编译失败
 * （`Top-level await is not available in the configured target environment`）。
 * 另加一个超时兜底：万一 IPC 卡住，也不能让界面一直空着。
 */
const MATERIAL_HINT_TIMEOUT_MS = 400;
async function bootstrap(): Promise<void> {
  /* 外观档位（高对比/密度）先按**镜像**应用一次：用户上次选的档要立刻生效，
     不然会先按默认档渲染一帧再跳（DB 的真值由 TitleBar 在 dbReady 后再校正一次）。 */
  applyAppearanceAttributes();
  await Promise.race([
    applyNativeMaterialHint(),
    new Promise((resolve) => setTimeout(resolve, MATERIAL_HINT_TIMEOUT_MS)),
  ]);
  renderApp();
}

void bootstrap();

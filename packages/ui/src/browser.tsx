/**
 * 浏览器入口（阶段 2）：挂载共享 React 应用。
 *
 * 产物 `packages/host/web/ui.js` + `packages/host/web/ui.css` 由 `npm run host:build:ui` 生成；
 * 页面只剩一个 `#app` 容器，DOM 结构全部由共享组件渲染。
 *
 * `ui.css` 的 import 就在这里（而不是手抄一份到 `web/`）：esbuild 会把同一次构建里的
 * CSS 抽成与 `outfile` 同名的 `.css`，于是手机壳加载的样式与桌面 import 的是**同一个源文件**。
 * 手机壳 `index.html` 用 `<link rel="stylesheet" href="ui.css">` 引它。
 *
 * ## 本机凭据的引导顺序（先抹地址栏，再挂 React）
 *
 * 1. **同步**读 `#token=<64hex>` → 立刻 `history.replaceState` 抹掉 fragment → 存 sessionStorage；
 * 2. **异步**用它换一次 HttpOnly cookie（只为 SSE）；RPC 直接带 Bearer；
 * 3. 引导完成后才 `createRoot(...).render(...)`：这样 React 首次 `connect()` 时
 *    cookie 已经在浏览器里，`/events` 不会先撞一次 401（EventSource 对非 200 不重试）。
 *
 * 没有凭据时探测一次 `/local-auth`：401 ⇒ 这台 Host 要本机凭据（显示"凭据缺失"），
 * 其它 ⇒ 远程/旧形态，照旧走配对门。这不会新增协议方法，也不改 `host.hello`。
 */
import * as React from "react";
import { createRoot } from "react-dom/client";

import { HostRpcError, createHostClient } from "./host-client";
import { MobileApp, type LocalAuthState } from "./mobile-app";
import {
  bootstrapLocalAuth,
  clearLocalAuth,
  probeLocalAuthMode,
  readStoredLocalAuth,
  saveLocalAuth,
  stripLegacyTokenFromUrl,
  takeLocalAuthFromFragment,
} from "./transport";

import "./ui.css";

async function resolveLocalAuth(): Promise<LocalAuthState | undefined> {
  // 1) fragment（只存在一次：外壳每次加载都新拼一份）
  const fromFragment = takeLocalAuthFromFragment();
  if (fromFragment) saveLocalAuth(fromFragment);
  const token = fromFragment || readStoredLocalAuth();
  if (token) {
    // 2) 换 cookie。即使换失败（旧 Host = unsupported），RPC 的 Bearer 仍然可用
    const result = await bootstrapLocalAuth(token);
    if (result === "rejected") {
      // 凭据被拒：清掉会话副本，交给错误页提示"重新打开应用"
      clearLocalAuth();
      return { problem: "rejected" };
    }
    return { token };
  }
  // 3) 没有凭据：只有 `local-auth` 的 Host 才该显示"凭据缺失"，其余走配对门
  const probe = await probeLocalAuthMode();
  if (probe === "local-auth") return { problem: "missing" };
  return undefined;
}

function mount(): void {
  const el = document.getElementById("app");
  if (!el) return;
  // 迁移残留：旧链接/旧设备 token 的 `?token=` 只删不读（设备凭据现在只走 HttpOnly cookie）
  stripLegacyTokenFromUrl();
  const root = createRoot(el);
  void resolveLocalAuth().then((localAuth) => {
    /*
     * 写模式由 `host.hello.capabilities` 决定（见 `mobile-app.tsx` 的
     * `capabilitiesFromMethods`）。M1 时代在 index.html 注入的
     * `window.__CODEM_GATEWAY_READ_ONLY__` 已删除：同一份 ui.js 服务 Host 与
     * 桌面网关时，能力只能有一个来源。
     */
    root.render(<MobileApp {...(localAuth ? { localAuth } : {})} />);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}

// 仍然暴露客户端：其它页面/调试台可以直接复用（不必再打一份）
(globalThis as unknown as { CodemUI?: unknown }).CodemUI = { createHostClient, HostRpcError };

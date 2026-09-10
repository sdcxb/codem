/**
 * 「系统减少动效」偏好（第 40 波）。
 *
 * 为什么需要这个 hook：CSS 的 `@media (prefers-reduced-motion: reduce)` 只能管 CSS 动画，
 * 管不了 **JS 逐帧动画**（`requestAnimationFrame` 驱动的精灵图切换、画布相机缓动）。
 * 第 40 波审计发现：全仓库 **0 处** `matchMedia('(prefers-reduced-motion…)')` ——
 * 也就是说开了系统「减少动效」之后，宠物精灵仍在逐帧切换、图书馆场景相机仍在缓动。
 *
 * 用法：
 * - 组件里 `const reduced = useReducedMotion();`
 * - 非组件代码（事件回调、工具函数）用 `prefersReducedMotion()`。
 */

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** 非 hook 版本：给事件回调 / 非 React 代码用 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** React hook：返回当前偏好，并在系统设置变化时更新 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => prefersReducedMotion());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(QUERY);
    const onChange = () => setReduced(mql.matches);
    onChange();
    // Safari < 14 只有 addListener
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return reduced;
}

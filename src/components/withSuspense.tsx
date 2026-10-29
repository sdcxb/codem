/**
 * 给 `lazy()` 组件加一个**自己的** Suspense 边界（第 233 轮审计 · 冷启动分包）。
 *
 * ## 为什么要这么个小工具
 *
 * `React.lazy` 必须被 `<Suspense>` 包住，否则它一"挂起"就会把**最近的**边界以上的
 * 整棵子树一起换成 fallback —— 在 App 根上表现为**整个界面白屏**。
 * 而这些按需面板散落在 App 的 JSX 各处（底部页签 / 模态框），
 * 手工给每处套 `<Suspense>` 既啰嗦又容易漏（漏一处就是白屏）。
 *
 * 用 `withSuspense(Component)` 把边界**焊在组件自己身上**：
 * 调用方只需要把 `X` 换成 `XLazy`，边界永远存在，且加载中只影响这一块。
 */
import { Suspense, type ComponentType, type ReactNode } from "react";

export function withSuspense<P extends object>(
  Component: ComponentType<P>,
  fallback: ReactNode = null,
): ComponentType<P> {
  function Suspended(props: P) {
    return (
      <Suspense fallback={fallback}>
        <Component {...props} />
      </Suspense>
    );
  }
  /* 开发工具里能看出原组件名（排错时不用猜） */
  Suspended.displayName = `withSuspense(${Component.displayName ?? Component.name ?? "Component"})`;
  return Suspended;
}

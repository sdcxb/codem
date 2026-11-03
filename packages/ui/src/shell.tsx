/**
 * 外壳布局骨架 `SplitLayout`：会话列表 / 对话 / 第三列。
 *
 * 归属线：`.layout/.sidebar/.chat-pane/.detail-pane` 的**样式**仍由各端外壳给
 * （桌面有桌面自己的壳；手机是 `packages/host/web/index.html`），这里只负责结构 +
 * 两个开关类名（`in-session` / `sidebar-collapsed`）。
 *
 * 抽出来的唯一理由是**可测**：`MobileApp` 在单测里跑不起来（挂载就要 `createHostClient` +
 * `hello()`），骨架留在里面的话，「折叠只翻转类名、不改 DOM」「没会话时列表永远在」
 * 这两条就只能靠真机证明，没有会变红的 vitest。
 */
import * as React from "react";

export interface SplitLayoutProps {
  /** 是否已选中会话（窄屏：未选中看列表、选中看对话） */
  inSession: boolean;
  /** 平板/宽屏侧栏收起；**只在 `in-session` 时生效**（CSS 侧带前置选择器） */
  sidebarCollapsed?: boolean;
  sidebar: React.ReactNode;
  chat: React.ReactNode;
  detail: React.ReactNode;
}

export function SplitLayout(props: SplitLayoutProps): React.ReactElement {
  /**
   * 折叠**不改 DOM 结构**：侧栏继续渲染（只是 `display: none`），
   * 这样列表的滚动位置与搜索词都不会因为收起/展开而丢。
   */
  const className =
    "layout" + (props.inSession ? " in-session" : "") + (props.sidebarCollapsed ? " sidebar-collapsed" : "");
  return (
    <div className={className}>
      <aside className="sidebar" id="session-sidebar" aria-label="会话列表">
        {props.sidebar}
      </aside>
      <section className="chat-pane">{props.chat}</section>
      <aside className="detail-pane">{props.detail}</aside>
    </div>
  );
}

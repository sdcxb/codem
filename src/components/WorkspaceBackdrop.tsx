/**
 * WorkspaceBackdrop — macOS 风格材质背景
 *
 * 提供透光毛玻璃效果的动态渐变背景层：
 * - 多层径向渐变模拟 macOS Big Sur+ 的桌面材质
 * - 缓慢动画的渐变光斑
 * - 适配三套皮肤（Default, Hub, Dream）通过 CSS 变量
 * - 适配亮/暗主题
 *
 * 替代原有的静态 ambient-backdrop div。
 */

import { memo } from "react";

interface WorkspaceBackdropProps {
  /** 是否激活动画（性能考虑可在设置中关闭） */
  animated?: boolean;
}

export const WorkspaceBackdrop = memo(function WorkspaceBackdrop({
  animated = true,
}: WorkspaceBackdropProps = {}) {
  return (
    <div
      className={`workspace-backdrop ${animated ? "animated" : ""}`}
      aria-hidden="true"
    >
      <div className="workspace-backdrop-layer workspace-backdrop-blob blob-1" />
      <div className="workspace-backdrop-layer workspace-backdrop-blob blob-2" />
      <div className="workspace-backdrop-layer workspace-backdrop-blob blob-3" />
      <div className="workspace-backdrop-layer workspace-backdrop-noise" />
      <div className="workspace-backdrop-layer workspace-backdrop-vignette" />
    </div>
  );
});

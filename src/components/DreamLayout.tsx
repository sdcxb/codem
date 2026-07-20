/**
 * 梦幻皮肤布局
 *
 * 设计原则：独立 CSS，不依赖默认皮肤的 CSS 变量
 * - 背景图层 + 装饰元素 + 拍立得
 * - 透明毛玻璃面板，透出背景图
 * - 浅色梦幻氛围，粉色强调色
 */

import type { ReactNode } from "react";
import { useSkin } from "../core/theme";
import { useLang } from "../core/i18n/lang";

interface DreamLayoutProps {
  children: ReactNode;
}

export function DreamLayout({ children }: DreamLayoutProps) {
  const { dreamConfig } = useSkin();
  const lang = useLang();

  const hasBgImage = !!dreamConfig?.backgroundImage;

  return (
    <>
      {/* 背景图层 */}
      <div className={`dream-bg-layer${hasBgImage ? "" : " no-image"}`} />

      {/* 背景叠加层（增强可读性） */}
      <div className="dream-bg-overlay" />

      {/* 装饰元素 */}
      {dreamConfig?.decorations && (
        <div className="dream-decorations">
          <div className="dream-decoration rose-left">❀</div>
          <div className="dream-decoration rose-right">❀</div>
        </div>
      )}

      {/* 核心内容（Sidebar + MainArea）由 App.tsx 渲染 */}
      {children}
    </>
  );
}

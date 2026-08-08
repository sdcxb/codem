/**
 * ContentFrame — 富内容容器框架
 *
 * 统一管理富内容块的头部（标题/语言标签）、操作按钮（复制/全屏/折叠）、
 * 以及内容区域。所有富内容组件都应包裹在此框架内。
 *
 * 使用 CSS 变量驱动，自动适配三套皮肤。
 */

import { useState, useCallback, type ReactNode } from "react";
import { Copy, Check, Maximize2, ChevronDown, ChevronRight } from "lucide-react";

export interface ContentFrameProps {
  /** 头部标题（如文件名、代码语言） */
  title?: string;
  /** 头部右侧标签（如语言名、行数） */
  badge?: string;
  /** 头部左侧图标 */
  icon?: ReactNode;
  /** 子内容 */
  children: ReactNode;
  /** 是否可折叠 */
  collapsible?: boolean;
  /** 是否默认折叠 */
  defaultCollapsed?: boolean;
  /** 是否可全屏 */
  fullscreenable?: boolean;
  /** 全屏内容渲染器 */
  onFullscreen?: () => void;
  /** 复制回调 */
  onCopy?: () => void;
  /** 额外类名 */
  className?: string;
  /** 额外头部内容 */
  headerExtra?: ReactNode;
}

export function ContentFrame({
  title,
  badge,
  icon,
  children,
  collapsible = false,
  defaultCollapsed = false,
  fullscreenable = false,
  onFullscreen,
  onCopy,
  className = "",
  headerExtra,
}: ContentFrameProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (onCopy) {
      onCopy();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [onCopy]);

  return (
    <div className={`content-frame ${className}`}>
      <div className="content-frame-header">
        <div className="content-frame-title-area">
          {collapsible && (
            <button
              className="content-frame-collapse-btn"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? "展开" : "折叠"}
            >
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
          {icon}
          {title && <span className="content-frame-title">{title}</span>}
          {badge && <span className="content-frame-badge">{badge}</span>}
        </div>
        <div className="content-frame-actions">
          {headerExtra}
          {onCopy && (
            <button
              className="content-frame-action-btn"
              onClick={handleCopy}
              aria-label="复制"
              title="复制"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
          {fullscreenable && onFullscreen && (
            <button
              className="content-frame-action-btn"
              onClick={onFullscreen}
              aria-label="全屏"
              title="全屏"
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="content-frame-body">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Drawer — 侧边抽屉组件
 *
 * 从屏幕边缘滑入的抽屉面板，用于移动端和窄屏场景。
 * 支持 left/right/top/bottom 四个方向。
 * 使用 framer-motion 实现进出动画。
 */

import { memo, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ActionIcons } from "../core/icons/icon-map";

interface DrawerProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 抽屉方向 */
  side?: "left" | "right" | "top" | "bottom";
  /** 抽屉宽度 (left/right) 或高度 (top/bottom) */
  size?: number | string;
  /** 标题 */
  title?: string;
  /** 内容 */
  children: ReactNode;
  /** 是否显示遮罩 */
  overlay?: boolean;
  /** 是否点击遮罩关闭 */
  closeOnOverlayClick?: boolean;
}

const directionConfig = {
  left: {
    initial: { x: "-100%" },
    animate: { x: 0 },
    exit: { x: "-100%" },
    style: { top: 0, bottom: 0, left: 0 },
  },
  right: {
    initial: { x: "100%" },
    animate: { x: 0 },
    exit: { x: "100%" },
    style: { top: 0, bottom: 0, right: 0 },
  },
  top: {
    initial: { y: "-100%" },
    animate: { y: 0 },
    exit: { y: "-100%" },
    style: { left: 0, right: 0, top: 0 },
  },
  bottom: {
    initial: { y: "100%" },
    animate: { y: 0 },
    exit: { y: "100%" },
    style: { left: 0, right: 0, bottom: 0 },
  },
};

export const Drawer = memo(function Drawer({
  open,
  onClose,
  side = "right",
  size = 360,
  title,
  children,
  overlay = true,
  closeOnOverlayClick = true,
}: DrawerProps) {
  const config = directionConfig[side];
  const sizeStyle =
    side === "left" || side === "right"
      ? { width: typeof size === "number" ? `${size}px` : size }
      : { height: typeof size === "number" ? `${size}px` : size };

  return (
    <AnimatePresence>
      {open && (
        <>
          {overlay && (
            <motion.div
              className="drawer-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeOnOverlayClick ? onClose : undefined}
              style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.4)" }}
            />
          )}
          <motion.div
            className={`drawer drawer-${side}`}
            initial={config.initial}
            animate={config.animate}
            exit={config.exit}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            style={{
              position: "fixed",
              zIndex: 9999,
              background: "var(--bg-secondary, #1e1e2e)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              display: "flex",
              flexDirection: "column",
              ...config.style,
              ...sizeStyle,
            }}
          >
            {title && (
              <div className="drawer-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border-primary, #333)" }}>
                <span style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>{title}</span>
                <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted, #888)", padding: 4, borderRadius: 4 }}>
                  <ActionIcons.close size={16} />
                </button>
              </div>
            )}
            <div className="drawer-body" style={{ flex: 1, overflow: "auto", padding: 16 }}>
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
});

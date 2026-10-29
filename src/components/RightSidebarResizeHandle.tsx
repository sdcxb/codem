/**
 * RightSidebarResizeHandle —— 右栏左缘的宽度拖拽条（8px 命中区 + 2px 视觉线）。
 *
 * ## 为什么单独成型
 *
 * 第 233 轮审计：这个元素原本是 `RightSidebar.tsx` 里的一个裸 `div`，
 * 只有 `onPointerDown`，**不可聚焦**、没有 `aria-value*`、`:focus-visible { outline: none }`
 * 也没有替代环 ⇒ 右栏宽度**只能鼠标拖**，键盘用户拿不到这个能力。
 * 抽成独立组件后，「可聚焦 + 方向键可调 + 焦点环可见」可以被直接渲染出来测
 * （见 `src/test/right-sidebar-resize-keyboard.test.tsx` 的 RSH-2/3/4），
 * 而不是靠 grep 源码确认「某处大概写了 onKeyDown」。
 *
 * ## 键位约定
 *
 * 拖拽条在右栏**左缘**：向左拖 = 变宽。键盘沿用同一心理模型：
 * - `ArrowLeft` 变宽、`ArrowRight` 变窄，每次 16px；按住 Shift 一次 64px；
 * - `Home` 到底（min）、`End` 到顶（max）；
 * - 其它键不拦截（不抢 Tab / Esc / 输入法）。
 *
 * 方向键必须 `preventDefault()`：否则浏览器会把方向键当成页面滚动，
 * 调宽的同时消息流也跟着跑。
 */
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

export interface RightSidebarResizeHandleProps {
  /** 当前宽度（用于 aria-valuenow 与夹紧） */
  width: number;
  /** 最小宽度 */
  min: number;
  /** 最大宽度 */
  max: number;
  /** 是否正在拖动（视觉线常亮） */
  active?: boolean;
  /** 无障碍名称（跟随界面语言） */
  label: string;
  /** 与 hook 的 onResizeStart 直连 */
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  /** 键盘微调：正值变宽、负值变窄（由调用方夹紧并落盘） */
  onResizeBy: (delta: number) => void;
  /** 键盘直达：夹紧到指定宽度 */
  onResizeTo: (width: number) => void;
  /**
   * 双击复位到**本档默认宽度**（第 233 轮 · 二次升级 Phase B 的「重置宽度」入口）。
   *
   * 为什么需要它：宽度是持久化的，而 defaults 随版本变过（旧版本存过 586）。
   * 没有复位入口时，用户只能一格一格拖回去 —— 双击是这类分隔条的通用约定。
   */
  onReset?: () => void;
}

/** 单次方向键步进（Shift 加速 4 倍） */
const STEP = 16;
const STEP_FAST = 64;

export function RightSidebarResizeHandle(props: RightSidebarResizeHandleProps) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP_FAST : STEP;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        props.onResizeBy(step);
        return;
      case "ArrowRight":
        e.preventDefault();
        props.onResizeBy(-step);
        return;
      case "Home":
        e.preventDefault();
        props.onResizeTo(props.min);
        return;
      case "End":
        e.preventDefault();
        props.onResizeTo(props.max);
        return;
      default:
        return;
    }
  };

  return (
    <div
      className={`right-sidebar-resize-handle ${props.active ? "active" : ""}`}
      onPointerDown={props.onPointerDown}
      onDoubleClick={props.onReset}
      onKeyDown={onKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={Math.round(props.width)}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      title={props.onReset ? `${props.label}（双击复位到默认宽度）` : props.label}
    />
  );
}

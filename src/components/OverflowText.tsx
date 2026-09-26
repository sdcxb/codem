/**
 * OverflowText —— **只在真的被截断时**才挂 `title` 的长文本（第 171 轮 P2-5）。
 *
 * ## 为什么需要它
 *
 * 仓库里长文本的既有做法是「CSS 里截断 + TSX 里无条件写 `title`」（全仓 258 处 `title={…}`）。
 * 无条件挂 `title` 有两个毛病：
 * ① **没被截断也会弹提示** —— 鼠标停在一个完整可见的名字上冒出同样的文字，是纯噪声；
 * ② 截断是**布局结果**，字号/窗口宽度一变，同一个元素"截没截断"就变了，而写死的 `title` 不会跟着变。
 *
 * 这里沿用 `StatsLine.tsx` 已经验证过的做法（`scrollWidth > clientWidth` + `ResizeObserver`），
 * 但收成一个共用组件：**文本变化与尺寸变化都会重新量**，只有真的放不下才挂 `title`。
 *
 * ## 与工具类的关系
 *
 * 截断本身走 `.truncate` / `.truncate-2` / `.truncate-3`（`src/styles.css` 里唯一一处定义，
 * 标准 `line-clamp` 与 `-webkit-` 前缀双写）。组件只负责"探测 + 提示"，不自己写 CSS ——
 * 否则又会出现"第三套截断写法"。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface OverflowTextProps {
  children: ReactNode;
  /** 截断行数：1（默认，单行省略号）/ 2 / 3 —— 对应 .truncate / .truncate-2 / .truncate-3 */
  lines?: 1 | 2 | 3;
  /** 追加的类名（原样式表里的类照旧传进来，截断工具类由组件自己加） */
  className?: string;
  /** 显式指定提示文案（不给就用 children 的纯文本，且**只在真被截断时**挂上） */
  title?: string;
}

export function OverflowText({ children, lines = 1, className, title }: OverflowTextProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      /* 单行看宽度，多行看高度（多行截断时 scrollWidth 不一定溢出，高度才是判据） */
      const over = lines === 1
        ? el.scrollWidth > el.clientWidth + 1
        : el.scrollHeight > el.clientHeight + 1;
      setTruncated(over);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, lines]);

  const cls = [lines === 1 ? "truncate" : `truncate-${lines}`, className].filter(Boolean).join(" ");
  const tip = title ?? (truncated && typeof children === "string" ? children : undefined);

  return (
    <span ref={ref} className={cls} title={tip}>
      {children}
    </span>
  );
}

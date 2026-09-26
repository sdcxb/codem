/**
 * useDismissableLayer —— 浮层关闭的唯一实现（第 173 轮 P2-6）。
 *
 * ## 为什么要有
 *
 * 实测：全仓有 **22 处**手写 `e.key === "Escape"`（方案里写的是 14 处，实际更多），
 * 其中 **12 处是 document/window 级的关闭逻辑**，形状几乎逐字相同：
 * ```tsx
 * useEffect(() => {
 *   const handleKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
 *   window.addEventListener("keydown", handleKeyDown);
 *   return () => window.removeEventListener("keydown", handleKeyDown);
 * }, [onClose]);
 * ```
 * 复制粘贴的代价不是"多几行"：① 每一份都要自己处理"只有最上层那个该响应"；
 * ② 关掉之后**焦点丢在 body 上**（键盘用户回到文档开头）；③ 背景没有 `inert`，
 * Tab 会跑到浮层后面去。这些没有一处是"写错了"，而是**没有任何一份写了**。
 *
 * ## 口径（与方案原文的差异，写清楚）
 *
 * 方案说"把 14 处 Escape 收敛过去"。实测这 22 处里有**两族不同的东西**：
 * - **浮层关闭**（本 hook 管）：点外面关不掉的那些浮层按 Esc 关闭；
 * - **编辑取消**（本 hook 也管）：行内改名/编辑里按 Esc 放弃这次编辑 ——
 *   它的语义同样是"撤销一个临时状态"，用同一个 hook 是合适的（焦点归还同样受益）。
 * 真正**不该收**的只有三类，门禁里按名字列出：元素的 `onKeyDown`（输入框自己的按键语义）、
 * 非关闭语义的 Esc（如画布"取消选择"）、以及注释/模板字符串里出现的字样。
 *
 * ## 行为
 *
 * - Escape → `onDismiss()`，**只有栈顶那一层**会响应（后打开的先关，符合直觉）；
 * - `open: false` 时不响应（还没打开 / 已经关掉）；
 * - 关闭（或卸载）时把焦点**还给打开它的那个元素** —— 只在它还在文档里、且还能聚焦时；
 * - `inertBackground: true` 时给 `#root` 加 `inert`（Tab 不再跑进背景），关闭时移除；
 * - 回调用 ref 保存 ⇒ 父组件每次渲染换函数引用不会导致反复订阅。
 */
import { useEffect, useRef } from "react";

interface DismissableLayerOptions {
  /** 浮层是否处于"打开"状态。传 false 时不监听（例如浮层还没渲染） */
  open?: boolean;
  /** Esc（或外部触发）时执行：通常就是 setOpen(false) / onClose() */
  onDismiss: () => void;
  /** 关闭后把焦点还给打开前的元素（默认 true —— 这正是手写版普遍缺的那一条） */
  restoreFocus?: boolean;
  /** 打开期间给 `#root` 加 `inert`，别让 Tab 跑到浮层后面（默认 false，按需开） */
  inertBackground?: boolean;
  /** 用捕获阶段监听（AppMenuBar 的菜单栏要跑在别人的 keydown 之前，就得用捕获） */
  capture?: boolean;
}

/**
 * 全局浮层栈：只有栈顶那一层响应 Escape。
 *
 * 为什么用模块级数组而不是 context：浮层之间常常没有共同祖先（都挂在 body 上），
 * 而"谁在最上面"就是"谁最后打开" —— 注册顺序天然表达了这件事。
 */
const layerStack: symbol[] = [];

export function useDismissableLayer({
  open = true,
  onDismiss,
  restoreFocus = true,
  inertBackground = false,
  capture = false,
}: DismissableLayerOptions): void {
  const idRef = useRef<symbol>(Symbol("dismissable-layer"));
  /** 每次都指向最新的回调，避免因为父组件换函数引用而反复重订阅 */
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  /** 打开前拿着焦点的那个元素 */
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const id = idRef.current;
    layerStack.push(id);
    if (typeof document !== "undefined") {
      const active = document.activeElement;
      previousFocusRef.current = active instanceof HTMLElement ? active : null;
    }
    const root = inertBackground && typeof document !== "undefined" ? document.getElementById("root") : null;
    if (root) root.setAttribute("inert", "");
    /* inert 在旧内核上不生效也不报错，作为"锦上添花"而不是唯一防线 */

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /* 只关最上面那一层：栈是后进先出，所以比对自己是不是最后一个 */
      if (layerStack[layerStack.length - 1] !== id) return;
      dismissRef.current();
    };
    /* 监听放在 `window` 上（不是 document）：真实键盘事件从焦点元素冒泡经过 document 到 window，
       两种写法都收得到；但**测试里**常写成 `fireEvent.keyDown(window, …)`，那种事件**不会**传播到
       document（第 173 轮迁移 PixelLibraryScene 时就被这个绊了一下）。放 window 上两种都收得到。 */
    window.addEventListener("keydown", handleKeyDown, capture);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, capture);
      const at = layerStack.indexOf(id);
      if (at >= 0) layerStack.splice(at, 1);
      if (root) root.removeAttribute("inert");
      if (!restoreFocus) return;
      const previous = previousFocusRef.current;
      /*
       * ⚠️ 只在「**没人接管焦点**」时才归还。
       * 调用方常常自己就会把焦点还给触发器（例如 AppMenuBar 的 close() 里 triggerRefs…focus()）——
       * 那时此刻的 activeElement 是一个真实元素而不是 body ⇒ 我们**不能再抢**，否则会把别人刚设好的
       * 焦点顶掉（第 173 轮 app-menu-bar 的用例就是这么红的：断言"焦点回到触发器"，结果被 hook 抢回 body）。
       * 只有焦点落在 body/null（没人管）时，才由我们兜底还原。
       */
      const active = typeof document !== "undefined" ? document.activeElement : null;
      if (active && active !== document.body) return;
      /* 只在"还在文档里 + 还能聚焦"时还原：元素被卸载后 focus() 是空操作，
         但对已 disabled 的元素调用会让焦点留在 body（那正是我们要避免的） */
      if (previous && previous.isConnected && !(previous as HTMLButtonElement).disabled) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open, restoreFocus, inertBackground, capture]);
}

/**
 * 浮层共享入口（第 180 轮 P2-6 收口）。
 *
 * ## 为什么要有这个文件
 *
 * 方案实测：`createPortal` 手写 **48 处 / 21 个生产文件**，每个文件自己
 * `import { createPortal } from "react-dom"` 再自己决定"往哪儿挂"（几乎全是 `document.body`）。
 * 这种"每处都自己决定"的形态有三个具体代价：
 * ① **容器选择散落各处** —— 改一次层级策略（例如改成挂到应用根、或按皮肤换宿主）要动 21 个文件；
 * ② **没有单一的判据** —— 门禁无法回答"新浮层有没有走共享层"，因为"共享层"根本不存在；
 * ③ **SSR / 无 DOM 环境**要每个调用点各自判断（今天没人判断，只是碰巧都在浏览器里跑）。
 *
 * ## 口径
 *
 * - 这里是**唯一**允许从 `react-dom` 取 `createPortal` 的生产文件（门禁 **PORTAL-1** 守这一条）；
 * - 容器默认 `document.body`；需要别的宿主时**显式传** `container`（今天只有 `SelectionTooltip`
 *   一处：它优先挂在容器内部，拿不到才回退 `document.body`）；
 * - 没有 DOM（`document` 不存在）时返回 `null` —— 与 React 自己的 `createPortal` 会抛错不同，
 *   这里选择"安全地什么都不渲染"，因为在非浏览器环境里"渲染不出来"比"整页崩掉"更可接受。
 *
 * ## 如实标注：这一轮**没有**做的部分
 *
 * 方案里还提到"浮层契约"（`Portal.module.css` 不得出现 z-index/transform/filter/backdrop-filter）。
 * 层级今天由各浮层自己的 class 管（`--z-*` 令牌 + 局部层叠），**本轮不动**——
 * 把 21 个浮层的层级统一重排是观感级改动，需要单独的读数与截图对照，不该混在"收口入口"里做。
 */
import { createPortal as reactCreatePortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * 往**共享宿主**挂一个浮层。
 *
 * @param children 浮层内容
 * @param container 宿主元素；不传就是 `document.body`（绝大多数浮层）
 */
export function createPortal(children: ReactNode, container?: Element | null): ReactNode {
  /* 非浏览器环境：安全地什么都不渲染（见文件头 ③） */
  if (typeof document === "undefined") return null;
  const target = container ?? document.body;
  if (!target) return null;
  return reactCreatePortal(children, target);
}

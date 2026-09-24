/**
 * useDomainReady —— 「镜像就绪后把这些数据重读一次」（第 72 轮审计新增）
 *
 * ## 为什么需要它（读侧缺的那一半）
 *
 * 写侧早就有"就绪后重放"（`domain-store.ts::deferWrite`，A-1"首触必丢"的修法）。
 * 读侧一直没有：域镜像没就绪时 `domainReadMany/One` 返回 `undefined`，存储层按契约吞成 `[]`，
 * 于是"**没读到**"与"**确实是空**"在界面层长得一模一样，而且**没有任何人会再试一次**。
 *
 * 真机事故（两起，都由这个缺口造成）：
 * - 委派页签：编排器在构造时读一次 ⇒ 重启后历史永远空着（已在 1.16.122 修）；
 * - 历史消息的赞/踩：每条消息只读一次镜像 ⇒ 打开会话时显示"未评价"（已在 1.16.123 修）。
 *
 * 这个 hook 把"再试一次"变成一行：**先自己读一次**（已就绪时这次就拿全了），
 * 再把"就绪后重读"挂上；卸载时自动退订（否则闭包会攒在存储层里）。
 *
 * ## 用法
 *
 * ```tsx
 * const load = useCallback(() => setComments(listComments(issueId)), [issueId]);
 * useEffect(() => { load(); }, [load]);
 * useDomainReady("issue_comments", load);   // ← 就绪后自动再读一次
 * ```
 *
 * ## 三条纪律（都由用例守住）
 *
 * 1. **不要在已经就绪的表上反复挂**：`onceDomainReady` 对已就绪的表**直接返回空退订**，
 *    所以这里重复调用是安全的（不会成环）；
 * 2. **`reload` 用 ref 存**：调用方通常写成 `useCallback`，但也常见写成内联箭头函数 ——
 *    若把 reload 放进依赖数组，每次渲染都会重挂一次；用 ref 就与身份无关；
 * 3. **卸载必须退订**：`onceDomainReady` 返回的退订函数在这里统一调用。
 */

import { useEffect, useRef } from "react";
import { onceDomainReady } from "../core/storage/domain-store";

export function useDomainReady(tables: string | readonly string[], reload: () => void): void {
  // reload 放 ref：与它的函数身份无关，避免每次渲染重挂
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const key = Array.isArray(tables) ? tables.join(",") : (tables as string);
  useEffect(() => {
    const list = key.split(",").filter(Boolean);
    const unsubs = list.map((t) => onceDomainReady(t, () => reloadRef.current()));
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [key]);
}

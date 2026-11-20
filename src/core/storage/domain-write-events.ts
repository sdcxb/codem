/**
 * 域写订阅（第 6 轮）：让"数据变了"从**轮询**变成**通知**。
 *
 * ## 为什么需要
 *
 * 侧栏每 5s 重读一次会话表、水位每 3s 整会话读一次 —— 两者的目的都只是"数据可能变了，
 * 重新读一遍"。而写路径其实**知道**自己刚写了哪张表（`persistWriteThrough` 是唯一的落点），
 * 于是可以让它顺手通知一声：有变化才读，没变化一次都不读。
 *
 * ## 边界（写清楚，免得下一个人以为它是数据库变更流）
 *
 * - 只覆盖**本进程内经 `domain-store` 的写**：镜像 `applyWriteMany` / `applyDelete` 之后通知；
 * - **不覆盖**：镜像整表重载（`replaceTable`，发生在启动/hydrate）与引擎侧主动推来的变化；
 * - 因此订阅方**必须**保留一条低频兜底（侧栏 30s、水位 30s）—— 这条路只是把常态成本降到 0，
 *   不是"保证一定收到"。
 * - 监听方抛错**不影响写**（写是事实，通知是尽力而为）。
 */

export type DomainWriteListener = (table: string) => void;

const domainWriteListeners = new Set<DomainWriteListener>();

/** 订阅域写（返回取消函数） */
export function subscribeDomainWrites(listener: DomainWriteListener): () => void {
  domainWriteListeners.add(listener);
  return () => {
    domainWriteListeners.delete(listener);
  };
}

/** 通知一次域写（内部用；对同一张表的多次写会多次通知，节流由订阅方负责） */
export function notifyDomainWrite(table: string): void {
  if (domainWriteListeners.size === 0) return;
  for (const listener of [...domainWriteListeners]) {
    try {
      listener(table);
    } catch {
      /* 通知失败不得影响写路径 */
    }
  }
}

/** 仅测试用：清空订阅者，避免用例之间互相影响 */
export function __resetDomainWriteListeners(): void {
  domainWriteListeners.clear();
}

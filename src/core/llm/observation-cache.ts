/**
 * 只读搜索观察缓存（第 186 波）。
 *
 * 只做**精确键 + TTL**，不猜语义：键由调用方用 `exactSignature` 生成。
 * 作用域由 AgenticLoop 的实例持有（一个会话/一轮），因此不会跨会话串结果。
 * TTL 是外部进程可能改盘后的逃生口；工作区内的写操作仍由调用方立即 `clear()`。
 */
export interface ObservationCacheEntry {
  output: string;
  at: number;
}

export class ObservationCache {
  private readonly map = new Map<string, ObservationCacheEntry>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, now = Date.now()): ObservationCacheEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (now - entry.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, output: string, now = Date.now()): void {
    this.map.set(key, { output, at: now });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * debug — 运行期诊断日志开关 + 「只报一次」的告警（第 58 波）
 *
 * 背景（用户报了控制台噪声）：AgenticLoop 的容错分支每调用一次就 `console.warn` 一次，
 * 而它处在"每次工具调用"的热路径上 —— 实测一次 `write` 调用会打出两遍
 * `Service "snapshot" not available, falling back to singleton`，还带调用栈；
 * 同一条链路上另有十余条「每轮迭代 / 每条消息」的 `console.log`（其中一条会把工具参数，
 * 包含生成的文件内容，打进控制台）。
 *
 * 于是定两条规矩：
 *   ① **容错回退只报一次**：回退本身是设计好的容错（功能不受影响），但"服务没接上"值得知道一次；
 *      用 `warnOnce(key, ...)`，同一个 key 在整个进程里只输出一次。
 *   ② **热路径诊断日志默认静默**：用 `debugLog(ns, ...)` 包起来，默认不输出；
 *      需要排查时在控制台执行 `localStorage.setItem('codem-debug', 'agent-loop,provider')`
 *      后重载（或设 `window.__CODEM_DEBUG__ = 'agent-loop'` / `true` 立即生效）。
 *
 * 注意：错误（console.error）与用户可见的一次性告警不受影响，仍照常输出。
 */

const FLAG_KEY = "codem-debug";

/** 已开启的命名空间（null = 未开启；"all" = 全开） */
let cached: Set<string> | "all" | null | undefined;

function readFlag(): Set<string> | "all" | null {
  try {
    const globalFlag = (globalThis as any).__CODEM_DEBUG__;
    if (globalFlag === true) return "all";
    if (typeof globalFlag === "string" && globalFlag.trim()) {
      return new Set(globalFlag.split(",").map((s) => s.trim()).filter(Boolean));
    }
    const raw = (globalThis as any).localStorage?.getItem?.(FLAG_KEY);
    if (typeof raw === "string" && raw.trim()) {
      if (raw.trim() === "1" || raw.trim() === "true" || raw.trim() === "*") return "all";
      return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
    }
  } catch {
    /* 非浏览器环境 / 隐私模式 —— 视为未开启 */
  }
  return null;
}

/** 该命名空间是否开启诊断日志 */
export function isDebugEnabled(namespace: string): boolean {
  if (cached === undefined) cached = readFlag();
  if (cached === null) return false;
  if (cached === "all") return true;
  return cached.has(namespace);
}

/** 测试用：清掉缓存（改过开关后再判断） */
export function resetDebugCache(): void {
  cached = undefined;
}

/** 诊断日志：默认静默，开启后按 `[ns]` 前缀输出 */
export function debugLog(namespace: string, ...args: unknown[]): void {
  if (!isDebugEnabled(namespace)) return;
  // eslint-disable-next-line no-console
  console.log(`[${namespace}]`, ...args);
}

/** 已告警过的 key（进程级） */
const warnedKeys = new Set<string>();

/**
 * 只输出一次的告警。用于"有兜底、但说明接线不完整"的场景（例如 ctx 里取不到服务）。
 * @returns 本次是否真的输出了
 */
export function warnOnce(key: string, ...args: unknown[]): boolean {
  if (warnedKeys.has(key)) return false;
  warnedKeys.add(key);
  // eslint-disable-next-line no-console
  console.warn(...args);
  return true;
}

/** 测试用：重置「只报一次」的记录 */
export function resetWarnOnce(): void {
  warnedKeys.clear();
}

/** 已告警过的 key 数量（诊断/测试用） */
export function warnedKeyCount(): number {
  return warnedKeys.size;
}

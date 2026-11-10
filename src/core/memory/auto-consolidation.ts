/**
 * 自动记忆整合（consolidation）的**空闲批次服务**（25 号文 P2；默认关）。
 *
 * ## 与「提取批次」的关系：同一套思路，两套独立的东西
 *
 * 24 §P0-3 的提取批次（`extraction-batcher.ts`）证明了两件事：
 * ① 回合结束不是立刻跑，而是排一个 30–120 秒的空闲批次；
 * ② 计时器与单飞必须由调用方显式拥有，否则「取消」与「并发」都会失控。
 *
 * 自动整合复用这个**思路**，但刻意做成**独立服务**：
 * - 独立计时器：提取与整合的延迟/开关互不影响（关掉自动整合不该动提取）；
 * - 独立单飞：一个会话的整合在途时，新到点的批次**直接跳过**（整合幂等，
 *   下一次空闲会再来，不需要排队等 Promise）；
 * - 开关从 `codem-context-config.autoConsolidate` 现读（**默认 false**）：
 *   排期时与到点时各查一次 —— 用户中途关掉，已排的批次到点什么都不做。
 *
 * ## 语义（判据钉住）
 *
 * 1. **默认关**：开关为假时 `scheduleAutoConsolidation()` 返回 false（连计时器都不建）；
 * 2. **只处理 auto**：真正干活的是 `MemoryService.consolidate({ removeStale: false })` ——
 *    manual / pending / 已归档的保护口径在 memory 里是**同一个实现**，这里不另写一套；
 *    自动路径显式 `removeStale: false`（`consolidate` 的契约：自动路径必须传它，
 *    否则自动整合会按时间归档用户没点过整理的旧条目）；
 * 3. **可撤销**：有变更时 `consolidate` 写**单份** undo 记录（`codem-memory-consolidation-undo`），
 *    `undoConsolidate()` 可逐条恢复 —— 与手动整合共用同一份；
 * 4. **失败/无变更不打扰**：没有用户动作可做，失败只写渲染侧 console，
 *    **不**走 `reportAdvisory`/横幅（那是用户点的「整合」按钮才有的反馈）；
 * 5. **可取消**：关闭/删除会话时 `cancelAutoConsolidation()` 撤掉排期（与提取批次同一收口）。
 *
 * ## 为什么没有「立刻跑一次」的测试钩子
 *
 * 判据用假计时器把 30 秒压平（`vi.advanceTimersByTime(30_000)`），而不是给生产代码加
 * 「delay=0」的旁路：旁路一旦存在，就永远可能有人从产品路径调它（本仓踩过这种后门）。
 * 计时器本身可注入（`now`/`setTimer`/`clearTimer`），但默认走全局 `setTimeout`，
 * 于是假计时器对它是透明的。
 */
import { EXTRACTION_IDLE_DELAY_MIN_MS } from "./extraction-delay";
import { getMemoryService } from "./memory";
import { getContextManager } from "../context/context";

/** 自动整合的归属：只依赖 `consolidate` 这一件事（便于将来换实现而不动调度）。 */
interface AutoConsolidationMemory {
  consolidate: (options: {
    removeStale: boolean;
    sessionId?: string;
  }) => { changed?: number };
}

interface PendingBatch {
  handle: unknown;
}

/**
 * 生产档位：30 秒（与提取批次同一下限；25 §P2 的口径是「空闲 30–120 秒」，
 * 取窗口下沿 —— 比这更短就退化成「每回合立即整合」，那正是要治的形态）。
 *
 * 判据用假计时器把 30 秒压平（`vi.advanceTimersByTime(30_000)`），
 * **不给生产代码留 delay=0 的旁路**（旁路一旦存在就可能被产品路径调到）。
 */
const AUTO_CONSOLIDATION_IDLE_DELAY_MS = EXTRACTION_IDLE_DELAY_MIN_MS;

/**
 * 空闲批次调度器（**模块私有**：外部只通过下面的服务函数使用它）。
 *
 * 为什么不让外部 new 一个：调度状态必须与「开关 / 在途」同源；多个实例会让
 * 「取消」只取消到其中一个（本仓在别处见过这种两套状态）。判据通过服务函数驱动。
 */
class AutoConsolidationBatcher {
  private readonly pending = new Map<string, PendingBatch>();
  /** 在途整合的会话（单飞；只由 run 的同步返回 / Promise 收尾删除） */
  private readonly running = new Set<string>();

  private setTimer(fn: () => void, ms: number): unknown {
    const handle = setTimeout(fn, ms);
    /**
     * Node（判据环境）里 `unref()` 让「还没到点的后台批次」**不阻塞进程退出**：
     * 否则会给进程留一个 30–120s 的活计时器。浏览器 / Electron 渲染侧的
     * `setTimeout` 返回 number（没有 unref）⇒ 这一步自然跳过。
     */
    try {
      (handle as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* 拿不到 unref 不影响调度（只是进程退出晚一点） */
    }
    return handle;
  }

  private warn(message: string): void {
    console.warn(`[memory-auto-consolidate] ${message}`);
  }

  /**
   * 排一个批次。
   *
   * - **开关关着 ⇒ 不排**（默认路径连计时器都不建）；
   * - 已有排期 ⇒ 不重置计时器（首次排期优先；连续说话不该让整合永远排不上）。
   *
   * @returns 是否新建了排期
   */
  schedule(sessionId: string, isEnabled: () => boolean): boolean {
    if (!sessionId) return false;
    try {
      if (!isEnabled()) return false;
    } catch {
      /* 开关读不到 ⇒ 按关处理（fail-closed），下一回合会再试 */
      return false;
    }
    if (this.pending.has(sessionId)) return false;
    const entry: PendingBatch = { handle: undefined };
    entry.handle = this.setTimer(() => this.fire(sessionId, isEnabled), AUTO_CONSOLIDATION_IDLE_DELAY_MS);
    this.pending.set(sessionId, entry);
    return true;
  }

  /** 取消某会话的排期（关闭/删除会话时调；返回是否真的取消了一个排期） */
  cancel(sessionId: string): boolean {
    if (!sessionId) return false;
    const entry = this.pending.get(sessionId);
    if (!entry) return false;
    this.pending.delete(sessionId);
    clearTimeout(entry.handle as ReturnType<typeof setTimeout>);
    return true;
  }

  /** 计时器到点：确认没被取消、开关仍开、且该会话没有在途整合，再跑 */
  private fire(sessionId: string, isEnabled: () => boolean): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return; // 已被 cancel（或已经跑过一次）
    this.pending.delete(sessionId);
    try {
      if (!isEnabled()) return; // 到点时开关已关 ⇒ 什么都不做
    } catch {
      /* 开关读不到 ⇒ 按关处理（fail-closed）：不排、不跑、不动用户记忆 */
      return;
    }
    if (this.running.has(sessionId)) {
      /* 单飞：整合幂等，下一次空闲会再来 —— 不排队等 Promise */
      this.warn(`会话 ${sessionId} 已有在途整合 ⇒ 本批合并跳过`);
      return;
    }
    this.running.add(sessionId);
    try {
      /**
       * `consolidate` 是**同步**的（内存聚类 + 一次落盘），所以这里没有"等 Promise"的窗口；
       * `running` 仍然保留 —— 它是「同一会话不并发整合」这条契约的显式表达，
       * 将来若 consolidate 变成异步，这个集合就是现成的单飞闸。
       */
      runAutoConsolidation(sessionId);
    } catch (e) {
      /* 自动任务的失败没有用户动作可做 ⇒ 只留痕，不弹横幅 */
      this.warn(`会话 ${sessionId} 的自动整合启动失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running.delete(sessionId);
    }
  }
}

/** 唯一的调度器实例（模块级：开关/排期/在途同源） */
const batcher = new AutoConsolidationBatcher();

/** 自动整合开关：`codem-context-config.autoConsolidate`，**缺键 / 显式 false ⇒ 关**。 */
function isAutoConsolidationEnabled(): boolean {
  try {
    return getContextManager().getConfig().autoConsolidate === true;
  } catch {
    /* 配置读不到 ⇒ 按关处理（绝不在读不到配置时替用户动记忆） */
    return false;
  }
}

/**
 * 真正跑一次自动整合。
 *
 * - `removeStale: false`：自动路径**不按时间归档**（`consolidate` 的契约要求）；
 * - 只合并 `source=auto`、非 pending、未归档的重复条目（保护口径在 `MemoryService` 里）；
 * - 有变更时 `consolidate` 自己写单份 undo + advisory（用户可见的审计），
 *   这里**不重复上报**；无变更时它什么也不做。
 */
function runAutoConsolidation(sessionId: string): void {
  const memory = getMemoryService() as unknown as AutoConsolidationMemory | null;
  if (!memory || typeof memory.consolidate !== "function") {
    /* 记忆服务不可用（例如极早期启动）⇒ 本批跳过；不当作错误上报 */
    return;
  }
  const result = memory.consolidate({ removeStale: false, sessionId });
  const changed = Math.max(0, Number(result?.changed) || 0);
  if (changed > 0) {
    console.log(`[memory-auto-consolidate] session=${sessionId} 自动整合完成：${changed} 条变更（可撤销）`);
  }
}

/**
 * 回合结束钩子调用：排一个空闲整合批次。
 *
 * 内部**先查开关**（默认 false ⇒ 返回 false，连计时器都不建）—— 所以引擎侧不需要
 * 再判一次开关，也就不会出现「两处各判一次」的口径分叉。
 *
 * @returns 是否真的新建了排期（false = 关着 / 已有排期 / 空 sessionId）
 */
export function scheduleAutoConsolidation(sessionId: string): boolean {
  return batcher.schedule(sessionId, isAutoConsolidationEnabled);
}

/** 关闭/删除会话时撤掉排期（返回是否真的取消了一个排期）。 */
export function cancelAutoConsolidation(sessionId: string): boolean {
  return batcher.cancel(sessionId);
}

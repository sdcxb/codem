/**
 * 启动维护（第 18 轮，从 `database.ts` 抽出来）。
 *
 * ## 为什么它必须独立存在
 *
 * 这个函数原来住在旧引擎模块 `database.ts` 里，于是它**继承了旧引擎的生死**：
 * 第一行 `if (!db || dbFatal) return` 让它在 rust 模式（`db` 恒为 `null`）下
 * **整段不执行**，而 `App.tsx` 每次启动都在 `await` 它 —— 追加日志（权威副本）的回填与压缩、
 * 索引裁剪、外置附件预热与孤儿清理、崩溃后"索引重建标记"驱动的自愈 **全部从未跑过**。
 *
 * 抽出来之后，它依赖的东西**一目了然**，且没有一件与旧引擎有关：
 *   · 会话追加日志（JSONL，权威副本）—— 文件 I/O；
 *   · 外置附件正文 —— 文件 I/O + 域端口；
 *   · 索引裁剪与重建 —— 域端口 + JSONL；
 *   · 遥测裁剪 —— 引擎命令 `telemetry.prune`。
 *
 * ## 顺带修掉的一件事：日志必须能区分"没跑"和"跑了没事做"
 *
 * 缺陷能长期存在的另一半原因是那两种情况在日志里长得一样（rust 模式下连"维护完成"都不打印）。
 * 现在**每次维护结束都打一行带数字的日志**，任何一步真的做了事都能看见。
 */

import { reportPersistFailure } from "./persist-failure";

export interface MaintenanceResult {
  /** 旧引擎时代的库体积统计；现在恒为 0（库文件由 Rust 引擎持有，渲染侧不读它） */
  sizeBefore: number;
  sizeAfter: number;
  reclaimed: number;
  prunedEvents: number;
  prunedTelemetry: number;
  vacuumed: boolean;
  /** 本次被快照式压缩的会话数（第 77 波；端口模式下由引擎侧负责，这里恒为 0） */
  compactedSessions: number;
  /** 本次回填进追加日志的消息数（第 78 波） */
  backfilledMessages: number;
  /** 本次**从权威日志重建进索引**的消息数（第 91 波：崩溃自愈） */
  rebuiltIndexMessages: number;
  /** 本次从查询索引裁剪掉的消息数（第 78 波） */
  trimmedIndexMessages: number;
  /** 本次预热的外置附件正文数 */
  warmedAttachments: number;
  /** 本次清理的孤儿附件文件数 */
  prunedAttachmentOrphans: number;
  /** 本次压缩的追加日志会话数（权威副本的膨胀控制） */
  compactedLogSessions: number;
}

/** 索引重建标记文件（写文件走 IPC，与数据库无关） */
export const INDEX_REBUILD_MARKER = "codem-index-rebuild-needed.json";

/**
 * 是否存在"需要重建索引"的标记（启动维护用）。
 *
 * 标记的产生者曾是旧引擎的致命闩锁（sql.js OOM/WASM 陷阱 → `noteFatalDbError`），
 * 那个产生者随引擎消失；消费侧保留 —— 它守的能力是"索引可以随时从权威日志重建"，
 * 而这条能力在新架构下仍然有意义（引擎侧完整性检查失败、未来的自愈入口都可以写这个标记）。
 */
export async function indexRebuildNeeded(): Promise<{ needed: boolean; reason?: string }> {
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return { needed: false };
    const dir = await invoke("get_app_data_dir");
    const path = `${dir}${INDEX_REBUILD_MARKER}`;
    const exists = await invoke("path_exists", { path });
    if (!exists) return { needed: false };
    let reason: string | undefined;
    try {
      const raw = await invoke("read_file", { path });
      reason = JSON.parse(raw)?.reason;
    } catch {
      /* 内容读不出来也照样重建 */
    }
    return { needed: true, reason };
  } catch {
    return { needed: false };
  }
}

/** 清除重建标记（重建成功后调用） */
export async function clearIndexRebuildMarker(): Promise<void> {
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return;
    const dir = await invoke("get_app_data_dir");
    await invoke("delete_file", { path: `${dir}${INDEX_REBUILD_MARKER}` });
  } catch {
    /* 删不掉也无害：重建是幂等的 */
  }
}

/**
 * **写下"索引需要重建"标记**（第 19 轮新增）。
 *
 * 消费侧一直是 `runDatabaseMaintenance`（它看到标记就**从权威日志重建索引**再清标记），
 * 但**生产者**在删 sql.js 时随旧引擎的致命闩锁一起消失了 —— 也就是说
 * "索引坏了能自愈"这条能力当时**只剩一半**（能消费、没人生产）。
 *
 * 现在生产者有两个：
 * 1. **损坏库自动恢复**（`Engine::open_with_recovery` → 渲染侧端口 health 里报 `recovered`，
 *    见 `rust-port.ts` 的 `health()`）：坏文件备份走人、空库重建，索引必须从日志重建回来；
 * 2. 将来任何"检测到索引与日志不一致"的自愈入口。
 *
 * 失败不抛：写标记本身失败不该阻塞启动（下次维护仍会做常规回填/裁剪）。
 */
export async function markIndexRebuildNeeded(reason: string): Promise<boolean> {
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return false;
    const dir = await invoke("get_app_data_dir");
    await invoke("write_file", {
      path: `${dir}${INDEX_REBUILD_MARKER}`,
      content: JSON.stringify({ reason, at: new Date().toISOString() }),
    });
    console.log("[Maintenance] 已留索引重建标记（下次启动将从权威日志重建索引）");
    return true;
  } catch (e) {
    console.warn("[Maintenance] 写索引重建标记失败（不影响主流程）:", e);
    return false;
  }
}

/**
 * 遥测裁剪的**端口版**。
 *
 * 引擎侧 `telemetry.prune` 刻意要求显式水位线 `before`（没有它直接报错），
 * 因为"以为传了条件其实全表清空"这类事故的代价太高。失败不抛：维护永远不能让应用不可用；
 * 但要**如实留痕**（否则又变成"看起来做了"）。
 */
export async function pruneTelemetryViaPort(before: number): Promise<number> {
  try {
    const { hasStoragePort, getStoragePort } = await import("./port");
    if (!hasStoragePort()) return 0;
    const port = getStoragePort();
    if (port.kind !== "rust") return 0;
    const res = await port.data.execute("telemetry.prune", { before });
    return Number((res as { written?: number } | undefined)?.written ?? 0);
  } catch (e) {
    console.warn("[Maintenance] 遥测裁剪（端口）失败（跳过）:", e);
    return 0;
  }
}

export async function runDatabaseMaintenance(
  opts: {
    /** 事件裁剪开关（保留参数：端口模式下由引擎侧的快照压缩负责） */
    keepEventsPerSession?: number;
    keepTelemetryDays?: number;
    /** 兼容旧签名（旧引擎的 VACUUM 阈值）；端口模式下无对应动作 */
    vacuumMaxBytes?: number;
    /** 兼容旧签名（旧引擎的事件快照压缩阈值）；端口模式下由引擎侧负责 */
    compactEventsOver?: number;
    /** 每个会话在查询索引里至少保留多少条消息（0 = 不裁剪索引） */
    keepIndexedMessages?: number;
  } = {},
): Promise<MaintenanceResult> {
  const keepTelemetryDays = opts.keepTelemetryDays ?? 7;
  const keepIndexedMessages = opts.keepIndexedMessages ?? 500;

  const result: MaintenanceResult = {
    sizeBefore: 0,
    sizeAfter: 0,
    reclaimed: 0,
    prunedEvents: 0,
    prunedTelemetry: 0,
    vacuumed: false,
    compactedSessions: 0,
    backfilledMessages: 0,
    rebuiltIndexMessages: 0,
    trimmedIndexMessages: 0,
    warmedAttachments: 0,
    prunedAttachmentOrphans: 0,
    compactedLogSessions: 0,
  };

  try {
    /**
     * 顺序是有语义的（第 78 波）：先把历史回填进**追加日志**（权威存储），再裁剪查询索引。
     * 反过来的话，裁剪的耐久性检查会读不到刚写的日志 —— 它宁可跳过也不会冒险删。
     *
     * 另外注意（第 80 波审计修正）：回填、附件预热、日志压缩**不能被"是否裁剪索引"这个开关挡住** ——
     * 曾经把它们一起塞进 `if (keepIndexedMessages > 0)`，于是关掉裁剪时附件不预热
     * （同步读取拿不到外置内容）、日志也不压缩。只有"裁剪索引"这一步该受开关控制。
     */
    try {
      const bridge = await import("./session-log-bridge");

      // 自愈：上次留下的标记 → 先**从权威日志重建索引**，再回填/裁剪。
      try {
        const marker = await indexRebuildNeeded();
        if (marker.needed) {
          console.log(`[Maintenance] 检测到索引重建标记（原因：${marker.reason || "未知"}）—— 从权威日志重建索引`);
          const rebuilt = await bridge.rebuildIndexFromSessionLogs();
          result.rebuiltIndexMessages = rebuilt.messages;
          await clearIndexRebuildMarker();
        }
      } catch (e) {
        console.warn("[Maintenance] 索引重建失败（保留标记，下次再试）:", e);
      }

      result.backfilledMessages = await bridge.backfillAllSessions();

      if (keepIndexedMessages > 0) {
        const trimmed = await bridge.trimIndexedMessages({ keepPerSession: keepIndexedMessages });
        result.trimmedIndexMessages = trimmed.deletedMessages;
        if (trimmed.deletedMessages > 0 || trimmed.skippedSessions > 0) {
          console.log(
            `[Maintenance] 追加日志：索引裁剪 ${trimmed.deletedMessages} 条` +
              `（跳过 ${trimmed.skippedSessions} 个会话：日志尚未覆盖）`,
          );
        }
      }
      if (result.backfilledMessages > 0) {
        console.log(`[Maintenance] 追加日志：回填 ${result.backfilledMessages} 条历史`);
      }

      const attachments = await bridge.hydrateAllAttachments();
      result.warmedAttachments = attachments.warmed;
      result.prunedAttachmentOrphans = attachments.orphansRemoved;
      if (attachments.warmed > 0 || attachments.orphansRemoved > 0) {
        console.log(
          `[Maintenance] 外置附件：预热 ${attachments.warmed} 个，清理孤儿文件 ${attachments.orphansRemoved} 个`,
        );
      }

      const compactedLog = await bridge.compactOversizedSessionLogs();
      result.compactedLogSessions = compactedLog.compactedSessions;
      if (compactedLog.compactedSessions > 0) {
        console.log(
          `[Maintenance] 追加日志压缩：${compactedLog.compactedSessions} 个会话，省下 ${compactedLog.linesSaved} 行`,
        );
      }
    } catch (e) {
      console.warn("[Maintenance] 追加日志/附件维护失败（跳过）:", e);
    }

    // 遥测按天裁剪（引擎命令，显式水位线）
    const cutoff = Date.now() - keepTelemetryDays * 24 * 60 * 60 * 1000;
    result.prunedTelemetry = await pruneTelemetryViaPort(cutoff);
  } catch (e) {
    console.warn("[Maintenance] 维护失败（不影响使用）:", e);
  }

  /**
   * 每次维护结束都留一行带数字的日志。
   *
   * ⚠️ 这不是"日志洁癖"：这个功能曾经在真机上**整段没跑**却没人发现，
   * 因为"没跑"与"跑了但没事做"在日志里完全一样（当时 rust 模式连这行都不打印）。
   * 可观测性的最低要求就是——**做了什么都得看得见**。
   */
  console.log(
    `[Maintenance] 维护完成：索引重建 ${result.rebuiltIndexMessages} 条、日志回填 ${result.backfilledMessages} 条、` +
      `索引裁剪 ${result.trimmedIndexMessages} 条、附件预热 ${result.warmedAttachments} 个、孤儿清理 ${result.prunedAttachmentOrphans} 个、` +
      `日志压缩 ${result.compactedLogSessions} 个会话、遥测裁剪 ${result.prunedTelemetry} 条`,
  );
  return result;
}

/** 兼容旧调用点：维护失败时也走统一上报通道（保留导出，供未来需要时使用） */
export { reportPersistFailure as __reportMaintenanceFailure };

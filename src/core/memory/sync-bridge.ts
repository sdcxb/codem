/**
 * 记忆的**跨设备同步桥**（25 号文 P2 · 多设备 Host 同步）。
 *
 * ## 它为什么单独一层（而不是让 `sync-engine` / 网关直接 import `memory.ts`）
 *
 * - `memory.ts` 是 450 KB 的**运行时单例**（构造就要读库、拿端口、建索引）。同步是
 *   "按需发生的后台动作"，不该在模块加载期就把记忆服务拉起来 —— 所以这里用**动态 import**：
 *   没开同步的用户不会因为同步把记忆服务提前实例化；
 * - 合并判定必须只有一份：本模块**不实现任何合并规则**，只是 `MemoryService` 的窄门面
 *   （导出 / 合并落库 / 冲突审计）。`merge.ts` 的判定表仍是唯一真相。
 *
 * ## 边界
 *
 * 记忆的 `deviceId` 是**记忆域自己的**（`memory-device-id`），与会话同步的设备 id
 * （`codem-device-id`）**不是同一个键**。这里不合并两者：记忆合并的"本地设备"由
 * `MemoryService` 自己决定（它才是墓碑/审计里那个 `deviceId` 的来源），
 * 会话同步只负责把"对方是谁"传进来（`remoteDeviceId`）。
 */

import type { MemoryConflictRecord } from "./merge";
import type { MemorySyncMergeResult } from "./memory";

/** 动态拿记忆服务单例（只在真正同步时才构造它） */
async function memoryService(): Promise<
  | {
      exportPayloadForSync(): { payload: string; deviceId: string; entries: number };
      mergeRemoteForSync(payload: string, remoteDeviceId: string): Promise<MemorySyncMergeResult>;
      recordConflictsForSync(records: readonly MemoryConflictRecord[]): number;
    }
  | null
> {
  try {
    const mod = await import("./memory");
    return mod.getMemoryService() as unknown as {
      exportPayloadForSync(): { payload: string; deviceId: string; entries: number };
      mergeRemoteForSync(payload: string, remoteDeviceId: string): Promise<MemorySyncMergeResult>;
      recordConflictsForSync(records: readonly MemoryConflictRecord[]): number;
    };
  } catch {
    // 记忆域没起来（端口未注册/早期启动）⇒ 如实返回 null，由调用方给出可见原因
    return null;
  }
}

export type LocalMemoryExport =
  | { ok: true; payload: string; deviceId: string; entries: number }
  | { ok: false; reason: string };

/** 读本机记忆的**落库形态**（供 `sync.memory` 推送）。 */
export async function readLocalMemoryPayload(): Promise<LocalMemoryExport> {
  const service = await memoryService();
  if (!service) return { ok: false, reason: "记忆服务不可用（记忆域未就绪）" };
  try {
    const exported = service.exportPayloadForSync();
    if (typeof exported?.payload !== "string") {
      return { ok: false, reason: "记忆服务没有返回 payload" };
    }
    return {
      ok: true,
      payload: exported.payload,
      deviceId: String(exported.deviceId ?? ""),
      entries: Number(exported.entries ?? 0),
    };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message ?? e) };
  }
}

/** 把对端合并结果并入本机记忆（冲突双方都留，审计进 `memory-conflicts`）。 */
export async function mergeLocalMemoryFromRemote(
  payload: string,
  remoteDeviceId: string,
): Promise<MemorySyncMergeResult> {
  const service = await memoryService();
  if (!service) {
    return {
      ok: false,
      payload: "",
      entries: 0,
      conflicts: [],
      changed: false,
      reason: "记忆服务不可用（记忆域未就绪）",
    };
  }
  try {
    return await service.mergeRemoteForSync(payload, remoteDeviceId);
  } catch (e) {
    return {
      ok: false,
      payload: "",
      entries: 0,
      conflicts: [],
      changed: false,
      reason: String((e as Error)?.message ?? e),
    };
  }
}

/** 把对端报来的冲突审计并进本机（去重；返回新记入的条数）。 */
export async function recordRemoteMemoryConflicts(records: readonly unknown[]): Promise<number> {
  const list = Array.isArray(records) ? (records as MemoryConflictRecord[]) : [];
  if (list.length === 0) return 0;
  const service = await memoryService();
  if (!service) return 0;
  try {
    return service.recordConflictsForSync(list);
  } catch {
    // 审计写不进去不是同步失败（冲突副本本身已经在记忆里）
    return 0;
  }
}

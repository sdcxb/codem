/**
 * 记忆的**并发写合并**（24 号文 P2 · 多客户端写冲突）。
 *
 * ## 为什么需要这一层（缺陷形状）
 *
 * `memory` 字段是**整份 JSON 字符串**：两个客户端（两个窗口 / 两个进程 / 手机桥 + 桌面）
 * 各自读一份、改一条、再把**整份**写回去 —— 后写的那个把先写的改动**整条覆盖掉**，
 * 而双方都返回"保存成功"。这不是"偶发竞态"，是整份读写的**结构性后果**：
 * 谁的写晚，谁的内存态就是唯一真相。
 *
 * 本轮把写入改成**读-改-写 + 版本合并**：
 *
 * 1. 每条记忆带 `rev`（本地每次改动 +1）与 `updatedAt`；
 * 2. 写之前重新读一次库里的**当前** payload，按 id 逐条比 `rev`；
 * 3. 结论只有三种：本地胜 / 远端胜 / **冲突（双方都保留）**；
 * 4. 删除走**墓碑**（`id` + `rev` + `deletedAt`），否则"别人还留着的旧副本"会在下一次合并里
 *    把已删条目**复活**；墓碑有界（{@link MEMORY_TOMBSTONE_MAX}）。
 *
 * ## 三条硬纪律
 *
 * - **不许静默丢内容**：rev 相同而内容不同 ⇒ 双方都留（一条保留原 id，另一条变成
 *   `conflictOf` 副本），并写一条审计记录（`memory-conflicts` 键，有界
 *   {@link MEMORY_CONFLICT_AUDIT_MAX}）；
 * - **删除是权威的**：除"本地在删除之后又改过"（严格更新的 rev）以外，墓碑一律生效；
 *   远端旧写**不许**让条目复活；
 * - **有界**：墓碑 200 条、审计 100 条、冲突副本 50 条（超出按"保留胜者 + 记一条审计"降级，
 *   不静默丢弃）。边界都在本文件顶部，判据直接断言这些数字。
 *
 * ## 本模块的边界（它**不**做的事）
 *
 * - 不碰 IO、不碰 settings、不认 payload 形状：输入是已经解析好的条目/墓碑映射，
 *   输出是"合并后的内存态"。解析与落库都在 `memory.ts`（那里才是唯一的权威入口）；
 * - 不做"时间戳更新者胜"这类推断：`updatedAt` 只用于审计展示，判定只看 `rev`。
 *   理由是跨设备时钟不可信（同一毫秒内两边各写一条是常态），而 `rev` 是**因果链**上的计数。
 */

/** 一条删除墓碑（删除的**持久凭据**，防止旧写把条目复活） */
export interface MemoryTombstone {
  id: string;
  /** 删除时的版本号（只增；合并时与条目的 `rev` 直接比大小） */
  rev: number;
  /** 删除时刻（毫秒） */
  deletedAt: number;
  /** 执行删除的客户端（审计用；缺省 = 旧数据/未知） */
  deviceId?: string;
}

/** 一条**合并冲突**的审计记录（写进 `memory-conflicts` 键；只记摘要，不记全文） */
export interface MemoryConflictRecord {
  /** 冲突涉及的条目 id（原 id，不是副本 id） */
  id: string;
  /** 发现冲突的时刻（毫秒） */
  at: number;
  /**
   * 冲突种类：
   * - `edit-edit`：双方都改过同一条（rev 相同内容不同，或远端 rev 更高而本地也改过）；
   * - `edit-delete`：本地改过，远端删了（或相反）——删除仍生效，但内容摘要留档；
   */
  kind: "edit-edit" | "edit-delete";
  localRev: number;
  remoteRev: number;
  /** 本地一侧的摘要（`key — 正文前 N 字`；被删除的一侧也留摘要） */
  localSummary: string;
  remoteSummary: string;
  /** 本地客户端 id */
  deviceId: string;
  /** 远端条目自称的客户端 id（旧数据缺省） */
  remoteDeviceId?: string;
}

/** 一方的快照（合并的输入） */
export interface MemoryMergeSide<E> {
  entries: ReadonlyMap<string, E>;
  tombstones: ReadonlyMap<string, MemoryTombstone>;
}

/** 参与合并的条目最小形状（与 `MemoryEntry` 结构性兼容） */
export interface MergeableMemory {
  id: string;
  scope?: string;
  projectId?: string;
  sessionId?: string;
  /**
   * 25:668：`team` 作用域的归属键（AgentTeam id）。
   *
   * 它必须进冲突签名：团队 A 的"发布约定"与团队 B 的同名条目是**两条不同的团队事实**，
   * 不算"同一件事的两种说法"；漏掉它会让跨设备合并把它们判成冲突并互相造副本
   * （判据 TM-1/TM-3 的合并侧）。
   */
  teamId?: string;
  key?: string;
  content?: string;
  status?: string;
  archived?: boolean;
  rev?: number;
  updatedAt?: number;
  deviceId?: string;
  timestamp?: number;
  order?: number;
  usageCount?: number;
  lastUsedAt?: number;
  conflictOf?: string;
  conflictGroup?: string;
}

/** 墓碑上限：超出按 `deletedAt` 丢最旧的 */
export const MEMORY_TOMBSTONE_MAX = 200;

/** 冲突审计上限：`memory-conflicts` 键里最多留多少条 */
export const MEMORY_CONFLICT_AUDIT_MAX = 100;

/** 冲突副本上限（一次合并里最多造几条；超出只保留胜者并记审计） */
const MEMORY_CONFLICT_COPY_MAX = 50;

/** 审计摘要里正文的长度上限（只用于"人能不能认出是哪条"，不用于判定） */
const CONFLICT_SUMMARY_CONTENT_MAX = 60;

/** 冲突组标签前缀（面板/工具可据此把成对的条目归到一组） */
const MEMORY_CONFLICT_GROUP_PREFIX = "merge-conflict:";

/** 条目的有效版本号（非有限数/负数 ⇒ 0 = 旧数据语义） */
export function revOf(entry: { rev?: unknown } | null | undefined): number {
  const raw = entry?.rev;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * 条目的**内容签名**（冲突判定只看它，不看排版/使用计数）。
 *
 * 为什么把 scope/归属也算进"内容"：把一条记忆从项目级改成平台级，与另一台设备改它的正文
 * 是**同一类并发编辑**（两个意图都合理，都不能被静默覆盖）。而 `usageCount` / `lastUsedAt`
 * 是**本机观测**（读一次就变），把它们算进签名会让"两台设备各读了一遍"变成一条冲突。
 */
function memoryContentSignature(entry: MergeableMemory): string {
  const parts = [
    String(entry.scope ?? ""),
    String(entry.projectId ?? ""),
    String(entry.sessionId ?? ""),
    String(entry.teamId ?? ""),
    String(entry.key ?? ""),
    String(entry.content ?? ""),
    String(entry.status ?? ""),
    entry.archived === true ? "1" : "0",
  ];
  return parts.join("\u0000");
}

/** 审计用的单行摘要（`key — 正文前 60 字`；不带换行，Bounded） */
function memoryConflictSummary(entry: MergeableMemory | null | undefined): string {
  if (!entry) return "";
  const key = String(entry.key ?? "").replace(/\s+/g, " ").slice(0, 60);
  const content = String(entry.content ?? "")
    .replace(/\s+/g, " ")
    .slice(0, CONFLICT_SUMMARY_CONTENT_MAX);
  return `${key} — ${content}`;
}

/** FNV-1a 32 位（局部小工具：只用来给冲突副本派生**确定性** id） */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 冲突副本的 id（**确定性**：同一对内容在任何客户端上派生出同一个 id）。
 *
 * 确定性是"双方都留"能收敛的前提：A 造出副本、B 下一次合并会在远端看到同一个 id 的副本，
 * 于是它按普通条目走合并，不会每同步一次就多出一条。
 */
function conflictCopyId(originalId: string, signature: string): string {
  return `${originalId}~c~${fnv1a(signature)}`;
}

export interface MemoryMergeOptions<E extends MergeableMemory> {
  /** 本次合并的时刻（毫秒；注入是为了判据可重复） */
  now: number;
  /** 本地客户端 id（写进冲突审计与墓碑） */
  deviceId: string;
  /**
   * 上一次与远端对齐时观察到的 rev（缺省 = 从未同步过这一条）。
   *
   * 它只用来回答一个问题：「远端的 rev 更高时，本地到底改没改过」
   * （没改过 ⇒ 静默接受远端；改过 ⇒ 记冲突且双方都留）。
   */
  syncedRev: ReadonlyMap<string, number>;
  /** 给新造的冲突副本分配创建序（调用方的 `nextCreationOrder`，保证与现有序不撞） */
  nextOrder: () => number;
  /** 构造一条冲突副本（`MemoryEntry` 的其余默认值由调用方决定） */
  makeConflictCopy: (
    source: E,
    meta: {
      id: string;
      conflictOf: string;
      conflictGroup: string;
      order: number;
      rev: number;
      now: number;
      deviceId: string;
    },
  ) => E;
}

interface MergeCounters {
  /** 本地 rev 更高（或本地新增）⇒ 本地胜的条数 */
  localWins: number;
  /** 远端 rev 更高且本地未改 ⇒ 静默接受的条数 */
  remoteAccepted: number;
  /** 冲突条数（= `conflicts.length` 的上界前计数；副本可能因上限被降级） */
  conflicts: number;
  /** 因墓碑/远端删除而本地消失的条数 */
  deleted: number;
  /** 实际造出的冲突副本条数 */
  copies: number;
  /** 因副本上限被降级的冲突条数（**只保留胜者 + 记审计**） */
  copiesDropped: number;
}

export interface MemoryMergeOutcome<E> {
  entries: Map<string, E>;
  tombstones: MemoryTombstone[];
  conflicts: MemoryConflictRecord[];
  stats: MergeCounters;
  /** 合并结果与本地输入**是否不同**（不同 ⇒ 调用方需要重新序列化/落库） */
  changed: boolean;
}

/**
 * 合并两方的记忆态（**纯函数**：不读 IO、不看时间，`now` 由调用方注入）。
 *
 * 判定表（按 id 逐条，顺序固定 ⇒ 结果可重复）：
 *
 * | 本地 | 远端 | 结论 |
 * |---|---|---|
 * | 有墓碑且 rev ≥ 本地 rev | — | 删除生效（本地改过 ⇒ 记 `edit-delete` 冲突） |
 * | 有墓碑但 rev < 本地 rev | — | 本地在删除后又改过 ⇒ 本地胜、丢墓碑 |
 * | 无墓碑 | 有墓碑 | 远端删除 vs 本地条目：墓碑 rev ≥ 本地 ⇒ 删；否则本地胜 |
 * | 有 | 有（rev 相同、签名相同） | 保留本地（元数据取并：usage 取 max） |
 * | 有 | 有（rev 相同、签名不同） | **冲突**：双方都留 |
 * | 有 | 有（本地 rev 高） | 本地胜 |
 * | 有 | 有（远端 rev 高、本地未改） | 静默接受远端 |
 * | 有 | 有（远端 rev 高、本地改过） | **冲突**：双方都留 |
 * | 有 | 无（曾同步过、本地未改） | 远端删掉了（无墓碑的批量删除）⇒ 接受删除 |
 * | 有 | 无（曾同步过、本地改过） | 本地胜 + 记 `edit-delete` |
 * | 有 | 无（从没同步过） | 本地新增 ⇒ 保留 |
 * | 无 | 有（曾同步过） | 本地删掉了 ⇒ 丢远端（若远端 rev 更高 ⇒ 记 `edit-delete`） |
 * | 无 | 有（从没同步过） | 远端新增 ⇒ 接受 |
 */
export function mergeMemoryState<E extends MergeableMemory>(
  local: MemoryMergeSide<E>,
  remote: MemoryMergeSide<E>,
  options: MemoryMergeOptions<E>,
): MemoryMergeOutcome<E> {
  const entries = new Map<string, E>();
  const conflicts: MemoryConflictRecord[] = [];
  const stats: MergeCounters = {
    localWins: 0,
    remoteAccepted: 0,
    conflicts: 0,
    deleted: 0,
    copies: 0,
    copiesDropped: 0,
  };
  /** 合并后的墓碑（先合双方，最后统一修剪） */
  const tombstones = new Map<string, MemoryTombstone>();
  for (const [id, t] of local.tombstones) tombstones.set(id, t);
  for (const [id, t] of remote.tombstones) {
    const prev = tombstones.get(id);
    if (!prev || t.rev > prev.rev) tombstones.set(id, t);
  }

  const recordConflict = (record: MemoryConflictRecord) => {
    conflicts.push(record);
    stats.conflicts += 1;
  };

  /**
   * 造一条冲突副本（内容 = `loser`）。
   *
   * 三种"不造副本"的分支都必须**留审计**：
   * ① 已达副本上限（有界，不静默丢）；② 同 id 同签名副本已经存在（幂等，不重复造）。
   */
  const keepLoserCopy = (winnerId: string, winner: E, loser: E, kind: MemoryConflictRecord["kind"], localRev: number, remoteRev: number) => {
    const sig = memoryContentSignature(loser);
    const copyId = conflictCopyId(winnerId, sig);
    const existing = entries.get(copyId) ?? local.entries.get(copyId) ?? remote.entries.get(copyId);
    if (existing) {
      // 副本已在（另一台设备造过同一个确定性 id）：只补齐标记，不重复造；
      // 已经补齐过的**保留原对象引用** —— 否则「无变化不写」会在这里被打破（每次都判定 changed）
      const group = `${MEMORY_CONFLICT_GROUP_PREFIX}${winnerId}`;
      entries.set(
        copyId,
        existing.conflictOf === winnerId && existing.conflictGroup === group
          ? existing
          : { ...existing, conflictOf: winnerId, conflictGroup: group },
      );
      return;
    }
    if (stats.copies >= MEMORY_CONFLICT_COPY_MAX) {
      stats.copiesDropped += 1;
      recordConflict({
        id: winnerId,
        at: options.now,
        kind,
        localRev,
        remoteRev,
        localSummary: memoryConflictSummary(winner),
        remoteSummary: memoryConflictSummary(loser),
        deviceId: options.deviceId,
        remoteDeviceId: typeof loser.deviceId === "string" ? loser.deviceId : undefined,
      });
      return;
    }
    const copy = options.makeConflictCopy(loser, {
      id: copyId,
      conflictOf: winnerId,
      conflictGroup: `${MEMORY_CONFLICT_GROUP_PREFIX}${winnerId}`,
      order: options.nextOrder(),
      rev: 1,
      now: options.now,
      deviceId: options.deviceId,
    });
    entries.set(copyId, copy);
    stats.copies += 1;
  };

  /** 冲突：本地胜但双方都留 */
  const conflictKeepBoth = (id: string, L: E, R: E, kind: MemoryConflictRecord["kind"] = "edit-edit") => {
    const winnerRev = Math.max(revOf(L), revOf(R)) + 1;
    const winner: E = {
      ...L,
      rev: winnerRev,
      updatedAt: options.now,
      deviceId: options.deviceId,
      conflictGroup: `${MEMORY_CONFLICT_GROUP_PREFIX}${id}`,
    };
    entries.set(id, winner);
    keepLoserCopy(id, winner, R, kind, revOf(L), revOf(R));
    recordConflict({
      id,
      at: options.now,
      kind,
      localRev: revOf(L),
      remoteRev: revOf(R),
      localSummary: memoryConflictSummary(L),
      remoteSummary: memoryConflictSummary(R),
      deviceId: options.deviceId,
      remoteDeviceId: typeof R.deviceId === "string" ? R.deviceId : undefined,
    });
  };

  const ids = new Set<string>([...local.entries.keys(), ...remote.entries.keys()]);
  const orderedIds = [...ids].sort();

  for (const id of orderedIds) {
    const L = local.entries.get(id);
    const R = remote.entries.get(id);
    const localRev = revOf(L);
    const remoteRev = revOf(R);
    const base = options.syncedRev.get(id);
    const localChanged = L ? base === undefined || localRev > base : false;

    /* ===== ① 墓碑优先（删除是权威的） ===== */
    const tomb = tombstones.get(id);
    if (tomb) {
      if (L) {
        if (localRev > tomb.rev) {
          // 本地在删除之后又改过（严格更新的 rev）⇒ 编辑生效，墓碑作废
          tombstones.delete(id);
          entries.set(id, L);
          stats.localWins += 1;
          continue;
        }
        // 删除生效
        if (localChanged) {
          recordConflict({
            id,
            at: options.now,
            kind: "edit-delete",
            localRev,
            remoteRev: tomb.rev,
            localSummary: memoryConflictSummary(L),
            remoteSummary: "（已删除）",
            deviceId: options.deviceId,
            remoteDeviceId: tomb.deviceId,
          });
        }
        stats.deleted += 1;
        continue;
      }
      if (R) {
        // 本地墓碑 + 远端条目：墓碑 ≥ 远端 rev ⇒ 远端旧写不许复活；
        // 远端 rev 更高 ⇒ 仍是删除生效（用户删了它），但把 rev 抬到远端之上并留审计。
        if (remoteRev > tomb.rev) {
          tombstones.set(id, { ...tomb, rev: remoteRev + 1 });
          recordConflict({
            id,
            at: options.now,
            kind: "edit-delete",
            localRev: tomb.rev,
            remoteRev,
            localSummary: "（已删除）",
            remoteSummary: memoryConflictSummary(R),
            deviceId: options.deviceId,
            remoteDeviceId: typeof R.deviceId === "string" ? R.deviceId : undefined,
          });
        }
        stats.deleted += 1;
        continue;
      }
      continue; // 两边都没有条目：墓碑原样保留
    }

    /* ===== ② 只有本地有 ===== */
    if (L && !R) {
      if (base !== undefined && localRev <= base) {
        // 曾同步过、本地未改，而远端整条没了（无墓碑的批量删除/清理）⇒ 接受删除
        stats.deleted += 1;
        continue;
      }
      if (base !== undefined && localRev > base) {
        // 本地改过而远端把它删了（无墓碑）⇒ 编辑胜，但明确记一条审计
        recordConflict({
          id,
          at: options.now,
          kind: "edit-delete",
          localRev,
          remoteRev: 0,
          localSummary: memoryConflictSummary(L),
          remoteSummary: "（远端已删除）",
          deviceId: options.deviceId,
        });
      }
      entries.set(id, L);
      stats.localWins += 1;
      continue;
    }

    /* ===== ③ 只有远端有 ===== */
    if (!L && R) {
      if (base === undefined) {
        // 本地从未有过 ⇒ 远端新增，直接接受（usage 是本机观测，不从远端继承）
        entries.set(id, R);
        stats.remoteAccepted += 1;
        continue;
      }
      if (remoteRev <= base) {
        // 本地删掉了它（批量路径没留墓碑），远端还是旧值 ⇒ 删除生效
        stats.deleted += 1;
        continue;
      }
      // 本地删除 vs 远端更新：删除仍是权威（否则用户删过的东西会复活），但留审计
      recordConflict({
        id,
        at: options.now,
        kind: "edit-delete",
        localRev: base,
        remoteRev,
        localSummary: "（本地已删除）",
        remoteSummary: memoryConflictSummary(R),
        deviceId: options.deviceId,
        remoteDeviceId: typeof R.deviceId === "string" ? R.deviceId : undefined,
      });
      stats.deleted += 1;
      continue;
    }

    /* ===== ④ 两边都有 ===== */
    if (!L || !R) continue;
    const sigL = memoryContentSignature(L);
    const sigR = memoryContentSignature(R);
    if (localRev === remoteRev) {
      if (sigL === sigR) {
        entries.set(id, mergeMetadata(L, R));
      } else {
        conflictKeepBoth(id, L, R, "edit-edit");
      }
      continue;
    }
    if (localRev > remoteRev) {
      // 本地版本更高：本地胜（远端那份是旧值）
      entries.set(id, mergeMetadata(L, R));
      stats.localWins += 1;
      continue;
    }
    // 远端 rev 更高
    if (!localChanged || sigL === sigR) {
      // 本地没改过（或改完与远端一致）⇒ 静默接受远端（保留本机 usage 观测）
      entries.set(id, mergeMetadata(R, L));
      stats.remoteAccepted += 1;
      continue;
    }
    conflictKeepBoth(id, L, R, "edit-edit");
  }

  /* ===== ⑤ 修剪墓碑与冲突副本 ===== */
  const keptTombstones = pruneTombstones([...tombstones.values()], options.now);
  const keptIds = new Set(keptTombstones.map((t) => t.id));
  for (const id of tombstones.keys()) if (!keptIds.has(id)) tombstones.delete(id);

  // 墓碑与存活条目**不许共存**：存活且 rev 更高的条目会让墓碑失效（上面已处理，这里兜一道）
  for (const t of keptTombstones) {
    const alive = entries.get(t.id);
    if (alive && revOf(alive) > t.rev) tombstones.delete(t.id);
  }

  const tombstoneList = pruneTombstones([...tombstones.values()], options.now);
  const changed = !sameEntries(local.entries, entries) || !sameTombstones(local.tombstones, tombstoneList);

  return { entries, tombstones: tombstoneList, conflicts, stats, changed };
}

/**
 * 两个"同一签名"的条目合并**元数据**（内容以 `primary` 为准）。
 *
 * `usageCount` / `lastUsedAt` 取两者较大值：它们是本机观测信号，丢哪一边都会让
 * "一直有人读的那条"看起来像没人读（排序会跟着变）。内容字段不做任何合并。
 */
function mergeMetadata<E extends MergeableMemory>(primary: E, secondary: E | undefined): E {
  if (!secondary) return primary;
  const primaryUsage = Math.max(0, Math.floor(Number(primary.usageCount) || 0));
  const secondaryUsage = Math.max(0, Math.floor(Number(secondary.usageCount) || 0));
  const usage = Math.max(primaryUsage, secondaryUsage);
  const primaryUsed = Number.isFinite(primary.lastUsedAt) ? Number(primary.lastUsedAt) : 0;
  const secondaryUsed = Number.isFinite(secondary.lastUsedAt) ? Number(secondary.lastUsedAt) : 0;
  const lastUsed = Math.max(primaryUsed, secondaryUsed);
  // 引用保持：元数据没变就**原样返回 primary**，否则「无变化不写」会被这里打破（每次合并都判定 changed）
  if (usage === primaryUsage && lastUsed === primaryUsed) return primary;
  return {
    ...primary,
    usageCount: usage > 0 ? usage : undefined,
    lastUsedAt: lastUsed > 0 ? lastUsed : undefined,
  };
}

/**
 * 墓碑修剪：按 `deletedAt` 从新到旧保留 {@link MEMORY_TOMBSTONE_MAX} 条。
 *
 * 为什么按时间而不是按 rev：rev 是**每台设备各自**的计数，跨设备不可比；
 * `deletedAt` 是墙钟，虽然也可能偏，但"最近删的最值得记住"这个方向是对的。
 *
 * 边界（如实交代）：被修剪掉的墓碑对应的删除，在**很久以后**才重新出现的旧副本面前
 * 会失去保护 —— 界面上不会假装不是这样：修剪条数会进 `getMergeStats()` 的读数。
 */
function pruneTombstones(list: readonly MemoryTombstone[], _now: number): MemoryTombstone[] {
  const sorted = [...list].sort((a, b) => b.deletedAt - a.deletedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.slice(0, MEMORY_TOMBSTONE_MAX);
}

/** 冲突审计修剪：按 `at` 从新到旧保留 {@link MEMORY_CONFLICT_AUDIT_MAX} 条 */
export function pruneMemoryConflicts(
  list: readonly MemoryConflictRecord[],
  max: number = MEMORY_CONFLICT_AUDIT_MAX,
): MemoryConflictRecord[] {
  return [...list].sort((a, b) => b.at - a.at).slice(0, Math.max(0, max));
}

/** 条目映射是否逐条相同（引用相等即可：调用方从不原地改条目，改动一律换新对象） */
function sameEntries<E>(a: ReadonlyMap<string, E>, b: ReadonlyMap<string, E>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, entry] of a) {
    if (b.get(id) !== entry) return false;
  }
  return true;
}

function sameTombstones(a: readonly MemoryTombstone[] | ReadonlyMap<string, MemoryTombstone>, b: readonly MemoryTombstone[]): boolean {
  const left = a instanceof Map ? [...a.values()] : [...a];
  if (left.length !== b.length) return false;
  const byId = new Map(left.map((t) => [t.id, t]));
  for (const t of b) {
    const prev = byId.get(t.id);
    if (!prev || prev.rev !== t.rev || prev.deletedAt !== t.deletedAt) return false;
  }
  return true;
}




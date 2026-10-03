/**
 * `fs-observation-policy`：**读后写**与**版本比对（CAS）**（第 95 波）。
 *
 * ## 为什么需要它（对标 DSH）
 *
 * DSH 的 `packages/fs/fs-observation-policy` 在文件服务层记下"每个会话**观察过**哪些目标、
 * 版本是什么"，并在写入前做三道判定：
 *
 * | 意图 | DSH 的判据 | 后果 |
 * | --- | --- | --- |
 * | `editIntent` | 没见过该目标 ⇒ 抛 `FS_NOT_OBSERVED`；观察为"不存在" ⇒ `FS_NOT_FOUND`；否则用观察到的**版本**做 CAS | **没读过就改**会被拒，改的是"你确实见过的那一版" |
 * | `writeIntent` | 观察为存在 ⇒ `replaceIfVersion(version)`；没见过/不存在 ⇒ `createIfAbsent` | 覆盖一个**从没看过**的文件会被拒（`createIfAbsent` 失败）；"没人动过"才允许覆盖 |
 *
 * 我们这边以前**一点都没有**：`src/core/provider/fs-observation-policy-provider.ts` 全文 16 行，
 * 只有文件监听的防抖配置 —— **名字与能力不符**（很容易让人以为已经有保护了）。
 * 结果是两类真实事故没有任何拦截：
 *   1. 模型**没读过**就 `edit`/覆盖 `write`（内容来自压缩后的记忆或猜测）⇒ 悄悄改错/覆盖掉没见过的东西；
 *   2. 模型**读过**，但文件在这期间被改过（用户手动改 / git 切换 / 子智能体改）⇒ 仍然照着旧内容下手。
 *
 * ## 观察是什么（本实现的口径）
 *
 * 一个观察 = `{ kind: "present" | "absent", version }`：
 * - `kind` 区分"确认存在"与"**确认不存在**"（后者也要记 —— `createIfAbsent` 靠它区分
 *   "不存在"与"没观察过"，这两件事的处置完全不同）；
 * - `version` 是文件**版本令牌**（`size:mtime`，见 `src-tauri/src/lib.rs::file_version_impl`）；
 * - 观察按**会话**归属（`sessionId`）：本会话读过才算"见过"。
 *
 * ⚠️ **没有会话归属时不启用**（`sessionId` 为空 ⇒ 一律放行）。这一点与 DSH 不同（DSH 没有 owner
 * 时 `editIntent` 直接抛 `FS_NOT_OBSERVED`）。取舍理由：我们的工具也能在没有会话的上下文里被调用，
 * 一律拒绝会把那些调用整体打断；而"有会话"是主链路（agentic-loop 始终传 `sessionId`）。
 *
 * ⚠️ **已知边界**（写清，别当成等于 DSH 的内容版本 CAS）：
 * - 版本令牌是元数据（size + mtime），不是内容哈希 —— 刻意把内容换成另一份再把 mtime 改回去能骗过它；
 * - 校验在**工具层**（写之前一次 `stat` + 比较），不在 Rust 的"临时文件 → rename"那一步里，
 *   所以两次调用之间仍有一个极小的 TOCTOU 窗口。要彻底关掉，得把 `replaceIfVersion` 下沉到
 *   `write_file`（带 `expectedVersion` 参数，在 rename 前校验）。见交接单 §3.5 的后续项。
 * - `bash` 等能任意改盘的工具不走这条策略（它们不该被文件工具的策略管住，但也因此不受保护）。
 */

/** 观察结果：确认存在 / 确认不存在（**"没观察过"是 `undefined`，不是 `absent`**） */
export interface FsObservation {
  kind: "present" | "absent";
  /** 版本令牌（`<size>:<mtime_nanos>`）；`absent` 或拿不到令牌时为 `null` */
  version: string | null;
  /** 记录下来时刻（诊断用） */
  at: number;
}

/** 拒绝码：与 DSH 的 `FsError` code 对齐，便于模型/日志认出这是哪一类 */
export type FsPolicyDenialCode = "FS_NOT_OBSERVED" | "FS_NOT_FOUND" | "FS_STALE_OBSERVATION";

export interface FsPolicyDenial {
  ok: false;
  code: FsPolicyDenialCode;
  /** 给模型看的**可行动**说明（含文件路径与下一步怎么做） */
  message: string;
}

/** 写入意图（与 DSH 的 `FsWriteIntent` 同形） */
export type FsWriteIntent =
  | { kind: "createIfAbsent" }
  | { kind: "replaceIfVersion"; version: string };

export type FsWriteDecision = { ok: true; intent: FsWriteIntent } | FsPolicyDenial;
export type FsEditDecision = { ok: true; version: string | null } | FsPolicyDenial;

/**
 * 决策：**能不能覆盖/写入这个路径**（`write` 工具的判据）。
 *
 * @param observed    本会话对该路径的观察（`undefined` = 没观察过）
 * @param currentVersion 当前版本令牌：`string` = 拿到了；`null` = **确认不存在**；
 *                       `undefined` = **不知道**（拿不到令牌）
 */
export function decideWriteIntent(
  path: string,
  observed: FsObservation | undefined,
  currentVersion: string | null | undefined,
): FsWriteDecision {
  /**
   * 当前不存在 ⇒ 创建：不会破坏任何东西，不需要先观察（`createIfAbsent` 的语义）。
   *
   * ⚠️ `undefined`（不知道）**不能**当成"不存在"：那会在"其实有文件"时放行一次覆盖。
   * 但也不能一律拒绝（取不到令牌时整个写路径会瘫掉）。取舍：**降级为创建并如实记一条 warn**，
   * 让"这次没做 CAS"是可观测的事实，而不是静默假设。
   */
  if (currentVersion === undefined) {
    console.warn(
      `[fs-observation] "${path}" 的当前版本取不到 ⇒ 这次写入**没有做版本比对**（按"新文件/无法判定"放行）`,
    );
    return { ok: true, intent: { kind: "createIfAbsent" } };
  }
  if (currentVersion === null) return { ok: true, intent: { kind: "createIfAbsent" } };

  if (!observed) {
    return {
      ok: false,
      code: "FS_NOT_OBSERVED",
      message:
        `FS_NOT_OBSERVED: "${path}" already exists but has not been read in this session — refusing to overwrite a file you have never seen ` +
        `(that is how content gets silently destroyed). Call \`read\` on it first, or use \`edit\` for a targeted change. Nothing was written.`,
    };
  }
  if (observed.kind === "absent") {
    return {
      ok: false,
      code: "FS_STALE_OBSERVATION",
      message:
        `FS_STALE_OBSERVATION: "${path}" did not exist when you last looked, but it exists now (something created it in the meantime) — ` +
        `read it before overwriting. Nothing was written.`,
    };
  }
  if (observed.version !== null && observed.version !== currentVersion) {
    return {
      ok: false,
      code: "FS_STALE_OBSERVATION",
      message:
        `FS_STALE_OBSERVATION: "${path}" changed on disk after you read it (you saw version ${observed.version}, it is now ${currentVersion}) — ` +
        `read it again and re-apply your change against the current content. Nothing was written.`,
    };
  }
  // 观察为存在且版本一致（或当时拿不到令牌 ⇒ 无法比对，退化放行但如实说明）
  return {
    ok: true,
    intent: observed.version === null ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", version: observed.version },
  };
}

/**
 * 决策：**能不能 edit 这个路径**（`edit` / `multi_edit` 的判据）。
 *
 * 与写入的区别：`edit` **必须**先读过 —— 它的正确性完全依赖"oldString 来自你亲眼看到的字节"。
 *
 * @param observed 本会话对该路径的观察
 * @param currentVersion 当前版本令牌：`string` = 拿到了；`null` = **确认不存在**；
 *                       `undefined` = **不知道**（拿不到令牌 —— 不许当成"文件没了"）
 */
export function decideEditIntent(
  path: string,
  observed: FsObservation | undefined,
  currentVersion: string | null | undefined,
): FsEditDecision {
  if (!observed) {
    return {
      ok: false,
      code: "FS_NOT_OBSERVED",
      message:
        `FS_NOT_OBSERVED: edit requires reading "${path}" first — \`oldString\` must come from content you actually saw in this session, ` +
        `not from memory or a summary. Call \`read\` on this file, then apply the edit. Nothing was written.`,
    };
  }
  if (observed.kind === "absent") {
    return {
      ok: false,
      code: "FS_NOT_FOUND",
      message: `FS_NOT_FOUND: cannot edit "${path}" — it did not exist when you last looked. Nothing was written.`,
    };
  }
  /**
   * 拿不到当前令牌 ⇒ **不比版本，但"读过"这条照旧成立**。
   * 不谎报 FS_NOT_FOUND（"读不到 ≠ 文件没了"），也不假装比过了 —— 留一条 warn 说明这次没做 CAS。
   */
  if (currentVersion === undefined) {
    console.warn(
      `[fs-observation] "${path}" 的当前版本取不到 ⇒ 这次 edit **没有做版本比对**（放行，但这一条是可观测的）`,
    );
    return { ok: true, version: observed.version };
  }
  if (currentVersion === null) {
    return {
      ok: false,
      code: "FS_NOT_FOUND",
      message: `FS_NOT_FOUND: cannot edit "${path}" — the file is gone (it existed when you read it). Nothing was written.`,
    };
  }
  if (observed.version !== null && observed.version !== currentVersion) {
    return {
      ok: false,
      code: "FS_STALE_OBSERVATION",
      message:
        `FS_STALE_OBSERVATION: "${path}" changed on disk after you read it (you saw version ${observed.version}, it is now ${currentVersion}) — ` +
        `read it again and re-apply your edit against the current content. Nothing was written.`,
    };
  }
  return { ok: true, version: observed.version };
}

/** 同时记多少个会话的观察（超过就丢最早的，避免长跑进程里无限增长） */
const MAX_TRACKED_SESSIONS = 64;

/**
 * 观察状态机（一个实例 = 一份观察状态）。
 *
 * 按**会话**归属：`sessionId` 一样的调用共享观察（同一个 agent 的多次工具调用），
 * 不同会话互不可见（子智能体读了文件，父会话仍然算"没读过"）。
 */
export class FsObservationPolicy {
  /** sessionId → (path → 观察)。Map 的插入顺序即 LRU 近似顺序（用 `Map` 的删除+重插实现） */
  private bySession = new Map<string, Map<string, FsObservation>>();

  /** 记下"这个会话观察到了这个目标"。`absent` 也要记（见模块头的说明）。 */
  observe(sessionId: string | undefined, path: string, kind: FsObservation["kind"], version: string | null): void {
    if (!sessionId || !path) return;
    let byPath = this.bySession.get(sessionId);
    if (!byPath) {
      byPath = new Map();
      this.bySession.set(sessionId, byPath);
      this.evictIfNeeded();
    }
    byPath.set(path, { kind, version, at: Date.now() });
  }

  /** 取某个会话对某个路径的观察（`undefined` = 没观察过） */
  get(sessionId: string | undefined, path: string): FsObservation | undefined {
    if (!sessionId) return undefined;
    return this.bySession.get(sessionId)?.get(path);
  }

  /** 丢掉一个会话的全部观察（会话被销毁 / 测试用） */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** 当前记了多少个会话（诊断用） */
  get trackedSessions(): number {
    return this.bySession.size;
  }

  private evictIfNeeded(): void {
    while (this.bySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.bySession.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.bySession.delete(oldest);
    }
  }
}

/** 进程级共享实例：工具（`read` / `edit` / `write`）与 provider 用的是同一份观察 */
let sharedPolicy: FsObservationPolicy | null = null;

/** 取共享的观察状态机（懒建；provider 与工具都经它读写） */
export function getFsObservationPolicy(): FsObservationPolicy {
  if (!sharedPolicy) sharedPolicy = new FsObservationPolicy();
  return sharedPolicy;
}

/** 测试用：把共享实例丢掉（下一个用例从干净状态开始） */
export function __resetFsObservationPolicy(): void {
  sharedPolicy = null;
}

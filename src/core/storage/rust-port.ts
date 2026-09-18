/**
 * Rust 存储端口实现（P3）：渲染侧通过 **Tauri IPC** 调用 `codem-db` crate 的类型化仓储命令。
 *
 * ## 为什么这个文件是迁移的关键
 *
 * P0 定了端口（`port.ts`），P1 实现了引擎（Rust + CLI）。这一层把两者接起来 ——
 * 从这一刻起，渲染侧有了一个**真的能用的**非 WASM 存储实现，P3 就是逐个模块把调用点切过来。
 *
 * ## 三条硬约束（由 D 类门禁与契约测试共同守住）
 *
 * 1. **不接受 SQL**：`invoke` 的 `command` 必须是仓储命令名（Rust `COMMANDS` 白名单）。
 *    本文件里**不出现任何 SQL 字符串** —— 出现即为门禁命中。
 * 2. **不做事务**：`BEGIN/COMMIT` 归 Rust。批量写用 `write()`，其语义是
 *    "顺序执行、每步一个独立事务、失败即停并如实回报已完成步数"。
 * 3. **不缓存语料**：只有配置面（`settings`）允许内存镜像，因为它的读必须是同步的；
 *    消息/事件/附件一律走分页读，绝不整体读进渲染进程。
 *
 * ## 错误是值
 *
 * Rust 侧返回 `{code, message, retryable, hint}`，这里转成 `StorageError` 实例。
 * 调用方按 `code` 决定重试/降级/上报，而不是解析错误文本。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  StorageError,
  type Page,
  type PageRequest,
  type StorageAppendPort,
  type StorageConfigPort,
  type StorageDataPort,
  type StorageEnginePort,
  type StorageErrorCode,
  type StorageHealth,
  type StoragePort,
} from "./port";

// ========== IPC 线协议（与 src-tauri/src/storage.rs 的 StorageReply 一一对应） ==========

interface WireError {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
}

interface WireReply<T = unknown> {
  ok: boolean;
  result?: T;
  error?: WireError;
  engine?: string;
}

interface WirePage<T> {
  items: T[];
  has_more: boolean;
  next_cursor: string | null;
}

const KNOWN_CODES: readonly StorageErrorCode[] = [
  "BUSY",
  "LOCKED",
  "NOMEM",
  "CORRUPT",
  "IO",
  "CONSTRAINT",
  "NOT_FOUND",
  "UNAVAILABLE",
  "UNSUPPORTED",
  "OTHER",
];

function toStorageError(e: unknown, fallbackMessage: string): StorageError {
  const wire = e as Partial<WireError> | null;
  if (wire && typeof wire.code === "string") {
    const code = (KNOWN_CODES as readonly string[]).includes(wire.code)
      ? (wire.code as StorageErrorCode)
      : "OTHER";
    /*
     * **引擎的 `retryable` 优先**（第 45 轮线协议审计 P2-5）。
     *
     * 它就在线协议里（`storage.rs` 转发 `DbError.retryable`），此前被这里丢掉、
     * 改用 `StorageError` 构造函数里那张按 `code` 重算的本地表。两边不一致时，
     * 唯一知道"这次失败的真实原因是不是瞬时的"的是引擎 —— 丢掉它的判断等于
     * 让渲染侧一直在重试引擎已经明确说别重试的失败。
     *
     * 没带这个字段时（老的假传输 / 手搓错误对象）传 `undefined`，回落到本地表。
     */
    return new StorageError(code, wire.message ?? fallbackMessage, {
      detail: wire.hint,
      ...(typeof wire.retryable === "boolean" ? { retryable: wire.retryable } : {}),
    });
  }
  return new StorageError("OTHER", e instanceof Error ? e.message : fallbackMessage);
}

/**
 * "损坏库已恢复"只通知一次（`health()` 会被反复调用）。
 * 与 `health.ts` 里的 `notifyStorageUnavailable` 同一套思路：**一次性**，
 * 避免同一个事件在每个调用点各提示一遍。
 */
let recoveryNotified = false;

/** 测试隔离：复位"已通知损坏恢复"闩锁 */
export function __resetRecoveryNotifiedForTests(): void {
  recoveryNotified = false;
}

// ========== 传输层 ==========

/**
 * 传输层抽象：默认是 Tauri IPC，测试可注入假实现。
 *
 * 这样"契约测试"可以在**没有 Tauri 运行时**的情况下验证端口语义，
 * 而真机验证走真实 IPC —— 两者用的是同一份端口代码。
 */
export type StorageTransport = {
  invokeCommand<T>(command: string, params?: Record<string, unknown>): Promise<T>;
  invokeBatch<T>(commands: Array<{ command: string; params?: Record<string, unknown> }>): Promise<T>;
  health<T>(): Promise<T>;
  integrityCheck<T>(): Promise<T>;
  checkpoint<T>(): Promise<T>;
  capabilities<T>(): Promise<T>;
};

/**
 * 破坏性操作的**最终出口**留痕（第 36 轮，**长期保留**）。
 *
 * ## 为什么装在这里而不是别处
 *
 * 第 31–35 轮把渲染侧能查的地方都排除了：
 * `data.execute/write/command`（端口层）、`domain-store` 五个写穿点、
 * 删除类写操作的控制台记录、以及仓储命令唯一出口 `RustDataPort.execute/.command` ——
 * 在"点开会话就删掉那个会话"这个可复现场景里**全部 0 命中**。
 *
 * 而 `tauriTransport.invokeCommand` / `invokeBatch` 是**所有 IPC 的最终出口**：
 * 任何路径（`RustDataPort`、三个镜像类、任何直接持有 transport 的代码）想动数据库，
 * 都必须经过这里。所以它是唯一无法绕过的位置 —— 也是"再插一个更靠外的桩"这件事的终点。
 *
 * 只记破坏性命令（delete / replace_table / compact），附调用栈；正文一律不记。
 */
function traceDestructiveIpc(command: string, params?: Record<string, unknown>): void {
  if (!/delete|replace_table|compact/i.test(command)) return;
  try {
    const stack = (new Error().stack ?? "")
      .split("\n")
      .slice(2, 12)
      .map((l) => l.trim());
    console.warn(
      `[IpcTrace] ${command} params=${JSON.stringify(params ?? {}).slice(0, 200)}\n` + stack.join("\n"),
    );
  } catch {
    /* 留痕失败绝不影响功能 */
  }
}

const tauriTransport: StorageTransport = {
  invokeCommand: (command, params) => {
    traceDestructiveIpc(command, params);
    return invoke("storage_invoke", { command, params: params ?? {} });
  },
  invokeBatch: (commands) => {
    for (const c of commands) traceDestructiveIpc(c.command, c.params);
    return invoke("storage_batch", { commands });
  },
  health: () => invoke("storage_health"),
  integrityCheck: () => invoke("storage_integrity_check"),
  checkpoint: () => invoke("storage_checkpoint"),
  capabilities: () => invoke("storage_capabilities"),
};

function unwrap<T>(reply: WireReply<T>, label: string): T {
  if (!reply || typeof reply.ok !== "boolean") {
    throw new StorageError("OTHER", `${label}：IPC 返回了无法识别的响应`);
  }
  if (!reply.ok) throw toStorageError(reply.error, `${label} 失败`);
  return reply.result as T;
}

/**
 * 发一条仓储命令并解包结果。
 *
 * **两种失败都必须变成 `StorageError`**：
 * 1. Rust 侧返回 `{ok:false, error:{code,…}}`；
 * 2. IPC 通道本身炸了（桥断了 / 序列化失败 / 前端把命令名写错到 Tauri 直接 reject）。
 *
 * 第 2 种早先被漏掉过：调用方本想 `catch (e) => e.code`，结果拿到的是原生 `Error`，
 * `code` 是 `undefined` —— 于是"错误是值"在渲染侧断了一截。契约测试 PORT-5 钉住这一点。
 */
async function call<T>(
  transport: StorageTransport,
  command: string,
  params?: Record<string, unknown>,
): Promise<T> {
  let reply: unknown;
  try {
    reply = await transport.invokeCommand<WireReply<T>>(command, params);
  } catch (e) {
    throw toStorageError(e, `${command} 的 IPC 调用失败`);
  }
  return unwrap(reply as WireReply<T>, command);
}

// ========== 有界写重试（A-6，第 20 轮） ==========

/**
 * **允许重试的写命令**（白名单，默认拒绝）。
 *
 * ## 为什么必须是白名单而不是黑名单
 *
 * `StorageError.retryable` 早就是"值"（`port.ts` 按 code 算出来，BUSY / LOCKED /
 * IO / UNAVAILABLE），但**它一个消费者都没有** —— 写失败就是失败，
 * 一次 `SQLITE_BUSY` 就足够让一条本该成功的写变成"未落库"。
 *
 * 而"给所有写都加上重试"是更糟的做法：**非幂等写重试会制造重复数据**。
 * 所以判据是**命令语义是否幂等**，逐条列出、其余一概不重试：
 *
 * | 命令 | 幂等？ | 为什么 |
 * | --- | --- | --- |
 * | `crud.upsert` | ✅ | 按主键 upsert；重放两次与一次结果相同（replace 亦然） |
 * | `messages.upsert_index` | ✅ | 单事务复合写，按 message id 覆盖 |
 * | `tool_calls.replace` | ✅ | "整批替换该消息的工具调用"，天然幂等 |
 * | `messages.rebuild_index` | ✅ | 从权威日志重建，重放收敛到同一结果 |
 * | `attachments.update` | ✅ | COALESCE 语义的字段更新 |
 * | `settings.set` | ✅ | 按 key 覆盖同一个值 |
 * | `crud.delete` | ❌ | 不重试（**不是**因为危险：重复删同一行影响 0 行）。真正的理由见下 |
 *
 * ## `crud.delete` 为什么不重试（这条判断值得写下来）
 *
 * `domainDelete` 的调用方在 `.catch` 里**如实上报一次失败**；若这里自动重试，
 * 上报就变成"可能成功也可能没成功"，而调用方无法区分。删除类操作的语义是
 * **用户的显式破坏性动作**（删会话 / 删项目），失败必须让用户看见并重做 ——
 * 悄悄重试反而把"没删掉"变成"没删掉但你没被告知"。任务书也把它列入不可重试。
 *
 * `events.append` / `messages.create` 更是硬禁止：**重试 = 插入两条**。
 */
const RETRYABLE_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "crud.upsert",
  "messages.upsert_index",
  "tool_calls.replace",
  "messages.rebuild_index",
  "attachments.update",
  "settings.set",
]);

/** 退避表：**上限 3 次尝试**，间隔 50 / 150 / 400ms */
const RETRY_BACKOFF_MS: readonly number[] = [50, 150, 400];

/** `retryAfterMs` 的上限（避免引擎给一个荒谬的值把界面卡住） */
const RETRY_AFTER_CAP_MS = 2000;

/** 判断一个错误是否值得重试：只有 `StorageError` 且 `retryable` 为真 */
function isRetryableError(e: unknown): e is StorageError {
  return e instanceof StorageError && e.retryable;
}

/**
 * 执行一次写，**必要时有界重试**。
 *
 * - 只对白名单里的**幂等**命令重试（见上表）；
 * - 只对 `retryable` 的错误重试（BUSY / LOCKED / IO / UNAVAILABLE）；
 * - 最多 3 次尝试、退避 50 / 150 / 400ms（或尊重引擎给的 `retryAfterMs`，带上限）；
 * - **绝不吞掉最终失败**：耗尽之后照原样把最后一次的错误抛给调用方，
 *   由调用方走它原来的 `reportPersistFailure` 通道 —— 这条是硬要求，
 *   "重试过"不能变成"失败被吃掉了"。
 *
 * @param onRetry 每次重试前回调（诊断/测试用；线上用来计数，不参与控制流）
 */
async function callWithRetry<T>(
  transport: StorageTransport,
  command: string,
  params: Record<string, unknown> | undefined,
  onRetry?: (attempt: number, e: StorageError, delayMs: number) => void,
): Promise<T> {
  if (!RETRYABLE_WRITE_COMMANDS.has(command)) {
    return call<T>(transport, command, params);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await call<T>(transport, command, params);
    } catch (e) {
      /*
       * 不可重试的错误（CONSTRAINT / NOT_FOUND / UNSUPPORTED / OTHER…）**只发一次**。
       *
       * `attempt` 从 0 起：`attempt >= RETRY_BACKOFF_MS.length - 1` 时已经没有下一次
       * 退避可等了 —— 也就是**总共 3 次尝试**（1 次原始 + 2 次重试，间隔 50 / 150ms）。
       * 早先写成 `>= length` 会多跑一次（共 4 次），把"上限 3 次"变成空话。
       */
      if (!isRetryableError(e) || attempt >= RETRY_BACKOFF_MS.length - 1) throw e;
      const suggested = e.retryAfterMs;
      const delayMs =
        typeof suggested === "number" && suggested > 0
          ? Math.min(suggested, RETRY_AFTER_CAP_MS)
          : RETRY_BACKOFF_MS[attempt];
      onRetry?.(attempt + 1, e, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ========== 引擎生命周期 ==========

class RustEnginePort implements StorageEnginePort {
  constructor(private readonly t: StorageTransport) {}

  async open(): Promise<StorageHealth> {
    return this.health();
  }

  async close(): Promise<void> {
    // Rust 侧的连接归引擎自己管（进程退出即释放）；这里是有意的 no-op，
    // 而不是"假装关了"。需要真正释放时走 `checkpoint` 把 WAL 并回主库。
    return Promise.resolve();
  }

  async health(): Promise<StorageHealth> {
    let reply: unknown;
    try {
      reply = await this.t.health<WireReply<Record<string, unknown>>>();
    } catch (e) {
      throw toStorageError(e, "storage_health 的 IPC 调用失败");
    }
    const raw = unwrap(reply as WireReply<Record<string, unknown>>, "storage_health");
    /**
     * **损坏库自动重建**的通知（第 19 轮）。
     *
     * 引擎侧在库文件损坏时会"备份坏文件 + 重建空库"（`Engine::open_with_recovery`），
     * 并把备份路径附在 health 上。这里**必须把这件事传出去**：
     *  - 写"索引需要重建"标记 → 启动维护会从**权威日志（会话 JSONL）**把索引重建回来；
     *  - 如实上报一件用户可见的事（索引丢过一次、坏文件备份在哪）。
     * 悄悄恢复 = 用户永远不知道自己的索引经历过一次重建。
     *
     * ⚠️ 只做一次（health 会被反复调用），用模块级闩锁。
     */
    if (raw.recovered === true && !recoveryNotified) {
      recoveryNotified = true;
      const backup = typeof raw.recovered_from === "string" ? raw.recovered_from : "(未知备份路径)";
      console.error(`[Storage] 库文件损坏：已备份坏文件并重建空库（备份：${backup}）`);
      const salvaged = raw.recovered_projects;
      void (async () => {
        /*
         * 第 47 轮补：**先把抢救出来的项目 / 会话归属写回，再写重建标记**。
         *
         * 顺序不能反：重建标记会让维护去跑 `rebuildIndexFromSessionLogs()`，而那条路
         * 需要从 `sessions` 表读"每个会话属于哪个项目" —— 空库里它是空的，于是所有
         * 复活的会话都会落到"全局项目"。引擎在恢复时已把归属从坏文件备份里抄了出来
         * （`health.recovered_projects`），这里就是把它落回去的那一刻。
         *
         * 失败**不阻塞**恢复：归属救不回来只是"落到全局项目"（与修之前的行为一致），
         * 而消息仍会从权威日志重建。
         */
        try {
          const { restoreRecoveredProjects } = await import("./recovery-restore");
          const restored = await restoreRecoveredProjects(salvaged);
          if (restored.projects > 0 || restored.sessions > 0) {
            console.log(
              `[Storage] 损坏恢复：已还原 ${restored.projects} 个项目、${restored.sessions} 个会话的项目归属` +
                (restored.skipped > 0 ? `（${restored.skipped} 个未写回）` : ""),
            );
          }
        } catch (e) {
          console.warn("[Storage] 还原抢救出来的项目归属失败（会话会落到全局项目）:", e);
        }
        try {
          const { markIndexRebuildNeeded } = await import("./maintenance");
          await markIndexRebuildNeeded(`存储库损坏后重建（备份：${backup}）`);
        } catch (e) {
          console.warn("[Storage] 写索引重建标记失败（下次启动仍会重试）:", e);
        }
        const { reportActionFailure } = await import("./persist-failure");
        reportActionFailure(
          "storage.recovered",
          new Error(`库文件损坏，已重建空库（坏文件备份：${backup}）`),
          "查询索引已丢失，将从会话日志自动重建；历史消息本身不受影响（权威副本是会话 JSONL）",
        );
      })();
    }

    return {
      engine: "rust",
      ready: Boolean(raw.ready),
      path: typeof raw.path === "string" ? raw.path : undefined,
      sizeBytes: typeof raw.size_bytes === "number" ? raw.size_bytes : undefined,
      journalMode: typeof raw.journal_mode === "string" ? raw.journal_mode : undefined,
      walSizeBytes: typeof raw.wal_size_bytes === "number" ? raw.wal_size_bytes : undefined,
      tables: typeof raw.tables === "number" ? raw.tables : undefined,
      ftsModule: typeof raw.fts_module === "string" ? raw.fts_module : undefined,
      lastErrorCode:
        typeof raw.last_error_code === "string"
          ? ((KNOWN_CODES as readonly string[]).includes(raw.last_error_code)
              ? (raw.last_error_code as StorageErrorCode)
              : "OTHER")
          : undefined,
    };
  }

  async integrityCheck(): Promise<{ ok: boolean; detail?: string }> {
    let reply: unknown;
    try {
      reply = await this.t.integrityCheck<WireReply<{ ok?: boolean; detail?: string }>>();
    } catch (e) {
      throw toStorageError(e, "storage_integrity_check 的 IPC 调用失败");
    }
    const raw = unwrap(reply as WireReply<{ ok?: boolean; detail?: string }>, "storage_integrity_check");
    return { ok: Boolean(raw.ok), detail: raw.detail };
  }

  async checkpoint(): Promise<void> {
    let reply: unknown;
    try {
      reply = await this.t.checkpoint<WireReply>();
    } catch (e) {
      throw toStorageError(e, "storage_checkpoint 的 IPC 调用失败");
    }
    unwrap(reply as WireReply, "storage_checkpoint");
  }
}

// ========== 数据面（异步 + 分页，不接受 SQL） ==========

class RustDataPort implements StorageDataPort {
  constructor(
    private readonly t: StorageTransport,
    /**
     * 重试计数（诊断用）。
     *
     * A-6 之前 `retryable` 是"算出来但没人用"的值；现在它有了消费者，
     * 于是必须能回答"到底重试过几次" —— 一个只在代码里存在、界面上看不见的
     * 重试机制，出问题时没法证明它到底跑没跑。
     */
    private readonly onRetry: (command: string, attempt: number, e: StorageError, delayMs: number) => void = () => {},
  ) {}

  /** 已发生的写重试次数（按命令累计，诊断/测试用） */
  retryStats(): { count: number; byCommand: Record<string, number> } {
    return { count: this.retries, byCommand: { ...this.retriesByCommand } };
  }
  private retries = 0;
  private retriesByCommand: Record<string, number> = {};

  /**
   * 破坏性命令的控制台留痕（第 34 轮，**长期保留**）。
   *
   * ## 为什么在这一层
   *
   * 第 31–33 轮反复出现的困境：SQLite 侧的删除审计（触发器）能如实回答
   * **"删了什么"**，但追不到**"谁发起"**；而 `write-audit` 与 `domain-store`
   * 的 5 个写穿点都记录不到 —— 说明发起方走的是**别的入口**。
   *
   * `RustDataPort.execute` / `command` 是**所有**仓储命令的唯一出口
   * （`domain-store`、`session-log-bridge`、`bootstrap` 都得经过这里），
   * 所以把留痕放在这一层，能覆盖"任何一个调用点"而不必逐个插桩 ——
   * 这正是前两轮"插了 A、漏了 B"的教训换来的位置。
   *
   * 只记**破坏性命令**（delete / replace_table / compact），避免正常读写刷屏；
   * 记录里带调用栈，正文一律不记。
   */
  private traceDestructive(command: string, params?: Record<string, unknown>): void {
    if (!/delete|replace_table|compact/i.test(command)) return;
    try {
      const stack = (new Error().stack ?? "")
        .split("\n")
        .slice(2, 10)
        .map((l) => l.trim());
      const table = params?.table ?? params?.stream ?? "";
      const where = params?.where ?? params?.id ?? params?.ids ?? params?.session_id ?? "";
      console.warn(
        `[StorageTrace] ${command} table=${String(table)} target=${JSON.stringify(where).slice(0, 160)}\n` +
          stack.join("\n"),
      );
    } catch {
      /* 留痕失败绝不影响功能 */
    }
  }

  async query<T = unknown>(
    command: string,
    params: Record<string, unknown> = {},
    page: PageRequest = {},
  ): Promise<Page<T>> {
    const payload: Record<string, unknown> = { ...params };
    if (page.limit !== undefined) payload.limit = page.limit;
    if (page.offset !== undefined) payload.offset = page.offset;
    const raw = await call<WirePage<T> | { item: T | null } | T>(this.t, command, payload);
    // 三种合法形状：分页列表 / 单条 {item} / 其它（原样放回 items: [值]）
    if (raw && typeof raw === "object" && Array.isArray((raw as WirePage<T>).items)) {
      const p = raw as WirePage<T>;
      return {
        items: p.items,
        hasMore: Boolean(p.has_more),
        nextCursor: p.next_cursor ?? undefined,
      };
    }
    if (raw && typeof raw === "object" && "item" in (raw as Record<string, unknown>)) {
      const item = (raw as { item: T | null }).item;
      return { items: item === null ? [] : [item], hasMore: false };
    }
    return { items: [raw as T], hasMore: false };
  }

  async write(
    commands: Array<{ command: string; params?: Record<string, unknown> }>,
  ): Promise<{ written: number }> {
    if (commands.length === 0) return { written: 0 };
    // 批量走独立命令：它的失败必须带上"已完成几步"，所以这里**不能**用 `call` 的
    // 单命令解包（那会把 batch 的进度信息丢掉）。
    let reply: unknown;
    try {
      reply = await this.t.invokeBatch<
        WireReply<{ count?: number; results?: Array<{ result?: { written?: number } }> }>
      >(commands.map((c) => ({ command: c.command, params: c.params ?? {} })));
    } catch (e) {
      throw toStorageError(e, "storage_batch 的 IPC 调用失败");
    }
    const raw = unwrap(
      reply as WireReply<{ count?: number; results?: Array<{ result?: { written?: number } }> }>,
      "storage_batch",
    );
    // `written` 取各步之和；引擎没给就退回"成功步数"（至少能让调用方判断"都成功了"）
    let written = 0;
    for (const r of raw.results ?? []) {
      const w = r?.result?.written;
      written += typeof w === "number" ? w : 1;
    }
    return { written };
  }

  async execute(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<{ written: number }> {
    this.traceDestructive(command, params);
    // 幂等写（白名单）走有界重试：一次 BUSY 不该让整条写丢失（A-6）
    const raw = await callWithRetry<{ written?: number }>(this.t, command, params, (attempt, e, delayMs) =>
      this.onRetry(command, attempt, e, delayMs),
    );
    return { written: typeof raw?.written === "number" ? raw.written : 1 };
  }

  /**
   * 执行命令并返回**完整的结构化结果**（P5 第 6 段新增）。
   *
   * ## 为什么不能复用 `execute`
   *
   * `execute` 刻意把结果压成 `{ written }` —— 对"写入类"调用够用，而且能让调用方
   * 一眼看出"到底写了几行"。但有些命令的返回值**本身就是结果**，例如
   * `migration.auto` 返回 `{ migrated, tables, rows, per_table, skipped }`。
   *
   * 用 `execute` 调它踩过一次坑：拿到的对象里没有 `tables`/`rows`，
   * 于是 `?? 0` 兜底成 0，日志打出 **"已从旧库自动迁移：0 张表 / 0 行（对账通过）"** ——
   * 一次真实的迁移被记成了"0 行"的假成功。这类"字段读不到就静默取默认值"正是
   * 本项目一直在消灭的模式，所以这里不猜：读不到就抛，让调用方知道契约对不上。
   */
  async command<T = Record<string, unknown>>(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.traceDestructive(command, params);
    // 同上：`command` 与 `execute` 的差别只在返回值的整形，重试规则必须一致
    const raw = await callWithRetry<T>(this.t, command, params, (attempt, e, delayMs) =>
      this.onRetry(command, attempt, e, delayMs),
    );
    if (raw === null || raw === undefined) {
      throw new Error(`命令 ${command} 返回了空结果（期望结构化对象）`);
    }
    return raw;
  }
}

// ========== 配置面（同步读 + 写穿） ==========

/**
 * 配置面：**唯一**允许内存镜像的形态。
 *
 * 为什么必须同步读：`getSetting()` 的历史调用点遍布同步上下文（React 渲染、
 * 模块初始化、快捷键处理），改成 `Promise` 会波及几百处调用点，风险远大于收益。
 * 所以做法是启动时一次性把 `settings` 表读进内存（表很小，实测 24 行），
 * 之后读永远同步；写先更新内存再入队落库，失败**如实上报**（不静默吞掉）。
 *
 * 关键纪律：**只有配置能进这个缓存**。把消息语料也缓存进来就等于把
 * "语料住在渲染进程"这个根因请回来（见 port.ts 的硬约束 4）。
 */
class RustConfigPort implements StorageConfigPort {
  private cache = new Map<string, string | null>();
  private warmed = false;
  private failures = 0;
  /**
   * 在途写请求。
   *
   * 早先用"计数 + sleep 轮询"来判断队列是否排空，结果 `flush()` 会在 catch 微任务
   * 执行之前就返回（契约测试 PORT-16 抓到：失败计数还是 0）。现在直接持有 Promise，
   * 排空 = `await Promise.allSettled(...)`，语义准确且不靠 sleep。
   */
  private inFlight = new Set<Promise<void>>();

  constructor(
    private readonly t: StorageTransport,
    private readonly onFailure: (key: string, e: unknown, note: string) => void,
  ) {}

  async warmup(): Promise<number> {
    const raw = await call<Record<string, string | null>>(this.t, "settings.get_all");
    this.cache.clear();
    for (const [k, v] of Object.entries(raw ?? {})) this.cache.set(k, v);
    this.warmed = true;
    return this.cache.size;
  }

  get<T = unknown>(key: string, fallback: T): T {
    if (!this.warmed) {
      // 未预热就同步读：不能假装有值，也不能抛（会炸掉渲染）。如实返回兜底并留痕。
      this.onFailure(key, new StorageError("UNAVAILABLE", "配置面尚未预热"), "配置读取回退到默认值");
      return fallback;
    }
    const v = this.cache.get(key);
    if (v === undefined || v === null) return fallback;
    return v as unknown as T;
  }

  set(key: string, value: unknown): void {
    const text =
      value === null || value === undefined
        ? null
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
    // 先内存后落库：界面即时生效；落库失败会走统一上报（用户能看到"没保存成功"）
    this.cache.set(key, text);
    this.track(
      /**
       * `settings.set` 是**按 key 覆盖**（幂等），所以走有界重试：一次 BUSY
       * 不该让用户刚改的设置静默回退（A-6）。重试耗尽后仍由下面的 catch
       * 走 `onFailure` —— 也就是"重试过"绝不等于"失败被吃掉"。
       */
      callWithRetry<void>(this.t, "settings.set", { key, value: text })
        .then(() => undefined)
        .catch((e) => {
          this.failures++;
          this.onFailure(key, e, "设置未保存，重启后会丢失");
        }),
    );
  }

  remove(key: string): void {
    this.cache.delete(key);
    this.track(
      call(this.t, "settings.remove", { key })
        .then(() => undefined)
        .catch((e) => {
          // "本来就不存在"不算失败（幂等删除的语义）
          const err = toStorageError(e, "settings.remove 失败");
          if (err.code === "NOT_FOUND") return;
          this.failures++;
          this.onFailure(key, e, "设置未删除，重启后会恢复");
        }),
    );
  }

  private track(p: Promise<void>): void {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  stats(): { warmed: boolean; keys: number; pendingWrites: number; failures: number } {
    return {
      warmed: this.warmed,
      keys: this.cache.size,
      pendingWrites: this.inFlight.size,
      failures: this.failures,
    };
  }

  /** 写队列是否已排空（退出前 / 测试用） */
  async flush(): Promise<void> {
    // 新写可能在上面的 await 期间入队，循环直到真的空
    for (let guard = 0; guard < 100 && this.inFlight.size > 0; guard++) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}

// ========== 只追加面（入队 + 背压） ==========

/**
 * 追加面：事件日志与遥测**不需要读回结果**，所以入队即可，顺序由队列保证。
 *
 * 背压：队列满了就返回 `false`（调用方据此降级/丢弃），而不是无限增长内存 ——
 * 这正是第 90 波"存储压力"问题的边界所在。
 */
class RustAppendPort implements StorageAppendPort {
  private queue: Array<{ stream: string; record: Record<string, unknown> }> = [];
  private draining = false;
  private dropped = 0;
  private failures = 0;
  /**
   * 正在落库的条数。
   *
   * 背压必须把**在途**也算进去：drain 会先把一批从队列里摘走再等 IPC，
   * 只看 `queue.length` 的话上限永远达不到（摘走的那些"消失"了），
   * 结果是内存里同时在途的批次数量没有上界。契约测试 PORT-19 钉住这一点。
   */
  private inFlight = 0;
  /** 单条队列上限（超过就丢最旧的并计数，绝不无限涨） */
  private readonly maxQueue = 5000;
  /** 每批最多合并多少条（减少 IPC 往返） */
  private readonly batchSize = 200;

  constructor(
    private readonly t: StorageTransport,
    private readonly onFailure: (stream: string, e: unknown, note: string) => void,
  ) {}

  /** 当前积压 = 队列 + 在途 */
  private backlog(): number {
    return this.queue.length + this.inFlight;
  }

  append(stream: string, record: Record<string, unknown>): boolean {
    if (this.backlog() >= this.maxQueue) {
      // 满了：优先丢最旧的排队项（保住新的）；如果积压全在途，则直接拒收这一条
      if (this.queue.length > 0) this.queue.shift();
      this.dropped++;
      return false;
    }
    this.queue.push({ stream, record });
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        this.inFlight += batch.length;
        // 按 stream 分组：一个 stream 一次 IPC
        const byStream = new Map<string, Record<string, unknown>[]>();
        for (const it of batch) {
          const list = byStream.get(it.stream) ?? [];
          list.push(it.record);
          byStream.set(it.stream, list);
        }
        for (const [stream, records] of byStream) {
          try {
            if (stream === "telemetry") {
              await call(this.t, "telemetry.append", { items: records });
            } else {
              // 事件是逐条命令（每次 append 有独立 seq），顺序执行保证 seq 单调
              for (const r of records) {
                await call(this.t, "events.append", r);
              }
            }
          } catch (e) {
            this.failures += records.length;
            this.onFailure(stream, e, "追加日志未落库（权威副本在会话 JSONL 里，索引可重建）");
          } finally {
            this.inFlight -= records.length;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async flush(): Promise<void> {
    for (let guard = 0; guard < 600 && (this.queue.length > 0 || this.draining); guard++) {
      if (!this.draining && this.queue.length > 0) void this.drain();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  stats(): { pending: number; dropped: number; failures: number } {
    return { pending: this.backlog(), dropped: this.dropped, failures: this.failures };
  }
}

// ========== 配置面的扩展域（P3 第 3 段） ==========
//
// `quick_phrases` / `mcp_servers` / `memory` 与 `settings` 同属"配置面"：
// 判据是**量级**（小到可以整表放进内存），不是名字。实测生产库这几张表都是 0~1 行。
//
// 因此它们享受同一种形态：**同步读（内存镜像）+ 写穿**。
// 好处是 `loadQuickPhrases()` / `loadMcpServers()` / `loadMemory()` 这些同步函数
// **不需要改签名**就能切到 Rust —— settings 的 878 个调用点已经验证过这条路可行。
//
// ⚠️ 边界：`cost_records`（可能上万行）与 `recovery_data`（每会话一份快照）
// **不进这个缓存** —— 它们属于数据面，必须走分页读。把大表塞进内存镜像
// 就等于把"语料住在渲染进程"这个根因请回来（port.ts 硬约束 4）。

export interface ConfigSnapshot {
  quickPhrases: QuickPhraseRow[];
  mcpServers: McpServerRow[];
  memory: string;
}

export interface QuickPhraseRow {
  id: string;
  title: string;
  content: string;
  category: string;
  usage_count: number;
  created_at: number;
  updated_at: number;
}

export interface McpServerRow {
  id: string;
  name: string;
  config: string;
  enabled: boolean;
}

/**
 * 配置面扩展域的内存镜像。
 *
 * 与 `RustConfigPort`（settings）分开是刻意的：两者的**失效策略不同** ——
 * settings 是逐键覆盖（写穿即刻一致），这三个域是整表替换（改动后需要重新拉整表）。
 * 混在一起会让"什么时候该重新拉"变得含糊。
 */
class RustConfigDomainCache {
  private snapshot: ConfigSnapshot = { quickPhrases: [], mcpServers: [], memory: "" };
  private warmed = false;
  private failures = 0;

  constructor(
    private readonly t: StorageTransport,
    private readonly onFailure: (scope: string, e: unknown, note: string) => void,
  ) {}

  /** 一次 IPC 拉齐三个域（启动预热用） */
  async warmup(): Promise<ConfigSnapshot> {
    const raw = await call<{
      quick_phrases?: QuickPhraseRow[];
      mcp_servers?: McpServerRow[];
      memory?: string;
    }>(this.t, "config_warmup");
    this.snapshot = {
      quickPhrases: raw?.quick_phrases ?? [],
      mcpServers: raw?.mcp_servers ?? [],
      memory: raw?.memory ?? "",
    };
    this.warmed = true;
    return this.snapshot;
  }

  isWarmed(): boolean {
    return this.warmed;
  }

  /** 同步读：未预热时返回 fallback 并留痕（与 settings 的处置一致） */
  read<T>(pick: (s: ConfigSnapshot) => T, fallback: T, scope: string): T {
    if (!this.warmed) {
      this.onFailure(scope, new StorageError("UNAVAILABLE", "配置面尚未预热"), "读取回退到默认值");
      return fallback;
    }
    return pick(this.snapshot);
  }

  /** 本地覆盖（写穿成功后由调用方触发，或写入路径自己维护） */
  patch(patch: Partial<ConfigSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
  }

  stats(): { warmed: boolean; quickPhrases: number; mcpServers: number; memoryBytes: number; failures: number } {
    return {
      warmed: this.warmed,
      quickPhrases: this.snapshot.quickPhrases.length,
      mcpServers: this.snapshot.mcpServers.length,
      memoryBytes: this.snapshot.memory.length,
      failures: this.failures,
    };
  }

  bumpFailure(): void {
    this.failures++;
  }
}

// ========== 只追加面的内存镜像 + 发件箱（P3 第 4 段） ==========
//
// ## 这里解开的矛盾
//
// `EventLog` / `PersistenceProvider` 的接口**全是同步**的（`append(): number`、
// `readAll(): PersistedEvent[]`），而 Rust 路径是异步 IPC。硬塞是不可能的。
//
// 解法是把"读"和"写"分开处理：
//
// - **读**：事件日志整份放进内存镜像（启动时一次拉齐）。这不是"把语料塞进渲染进程"
//   的倒退 —— 事件日志本来就是**为回放而整份读取**的（投影、压缩、重建索引都读全量），
//   所以镜像没有增加任何新的内存负担，反而省掉了反复查询。
// - **写**：发件箱（outbox）。`append` 同步返回，写请求入队立刻冲刷；失败如实上报。
//   崩溃时可能丢最后几条 —— 这是**可接受的**，因为会话 JSONL 才是权威副本，
//   而事件索引本来就被设计成"可重建"（见 docs/ARCH-SQLITE-TO-RUST.md 的存储原则）。
//
// ## seq 的坑（真机实测发现）
//
// `session_events.seq` 是**全局** AUTOINCREMENT，不是每会话从 1 开始。所以本地不能
// 预分配 seq（不知道全局水位会撞主键）。做法是：追加时先给一个**本地占位 seq**
// （仅用于镜像内的相对顺序），写成功后用引擎回传的真实 seq 修正镜像。
// 回放用的 `projectFromEvents` 依赖的是**相对顺序**与 `seq` 单调性，两者都成立。

export interface MirrorEvent {
  seq: number;
  sessionId: string;
  type: string;
  payload: string;
  timestamp: number;
  /**
   * 第 47 轮补（通信链路审计 P1）：这一条是**本地追加**的事件。
   *
   * ## 为什么必须有这个标记，而不能靠"seq 很大"来判断
   *
   * 原来的合并判据是 `e.seq > placeholderBase - 1_000_000 && e.seq > maxReal`。
   * 而 `reconcile` 会把占位**就地改写成引擎回传的真实 seq** —— 一旦那一步在
   * `loadSession` 的合并**之前**完成，这条事件就不再"看起来像占位"了，
   * 于是它既不在刚读到的分页里（分页是在它 INSERT 之前发出的），也被过滤掉：
   * **一条已经落库的事件在本进程内永久从镜像里消失**（`readAll` 读的就是镜像）。
   *
   * 语义是"**这一条来自本地追加**"，与"有没有落库"是**两件独立的事**：
   * - `pending`：本地追加 → 合并时必须保留（分页一定不包含它）；
   * - `settled`：引擎已回传真实 seq → 只有这样才算"落库了"。
   *
   * ⚠️ 我第一版把两者合成一个标记，结果 `reconcile` 清掉标记之后合并立刻把事件丢了
   * —— 用例当场抓到。两个事实就应该是两个字段。
   */
  pending?: boolean;
  /** 引擎已回传真实 seq（= 确认落库）。未确认的条目不许当水位用 */
  settled?: boolean;
}

class RustEventMirror {
  private bySession = new Map<string, MirrorEvent[]>();
  /** 已**完成**从数据库加载的会话（只有这个集合里的会话才允许路由到镜像） */
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private failures = 0;
  private pendingWrites = 0;
  private inFlight = new Set<Promise<void>>();
  /**
   * 本地占位 seq 的起点：远大于任何真实 seq，只用于镜像内排序，**永不落库**。
   *
   * 为什么需要占位：`seq` 是全局 AUTOINCREMENT，本地无法预知全局水位。
   * 所以追加时先给一个占位保证镜像内的相对顺序，写成功后用引擎回传的真实 seq 修正。
   */
  private placeholderBase = Number.MAX_SAFE_INTEGER - 1_000_000;
  /** 单会话加载上限（防极端情况下无限拉取） */
  private readonly maxBatch = 5000;
  private readonly maxRounds = 40;

  constructor(
    private readonly t: StorageTransport,
    private readonly onFailure: (scope: string, e: unknown, note: string) => void,
  ) {}

  /** 该会话的事件是否已经完整加载（**路由到镜像的唯一依据**） */
  isLoaded(sessionId: string): boolean {
    return this.loaded.has(sessionId);
  }

  /** 全局是否已就绪（至少加载过一个会话 / 或明确标记过） */
  isWarmed(): boolean {
    return this.loaded.size > 0 || this.warmedFlag;
  }
  private warmedFlag = false;

  /**
   * 确保某个会话的事件已加载（**同步返回**，后台加载）。
   *
   * 设计要点（为了彻底消除"读写分裂"）：
   * - 未加载完之前，调用方**必须继续走旧路径**（`isLoaded` 返回 false）——
   *   否则新写入的事件进了镜像、而读还从旧库取，用户会看到"记录不再更新"；
   * - 加载是**按会话惰性**的：启动时不必把整个事件库拉进内存（生产库 2197 条、
   *   将来可能十万条），只有真正被用到的会话才加载；
   * - 加载完成后，本地已追加的**占位事件**要迁移到真实 seq（见 `reconcile`），
   *   否则会与库里的同一条事件重复计数。
   *
   * @param onLoaded 加载完成后的回调。用于把"加载窗口期内**写进了旧库**的事件"
   *   补进镜像与 Rust 库（见 EventLog 的 pendingDuringLoad）——
   *   否则那一小段时间写入的事件会在切换引擎后"消失"。
   */
  ensureLoaded(sessionId: string, onLoaded?: () => void): void {
    if (this.loaded.has(sessionId)) {
      onLoaded?.();
      return;
    }
    if (this.loading.has(sessionId)) {
      if (onLoaded) {
        void this.loading.get(sessionId)?.then(() => onLoaded());
      }
      return;
    }
    const job = this.loadSession(sessionId)
      .then(() => {
        this.loaded.add(sessionId);
        this.warmedFlag = true;
      })
      .catch((e) => {
        this.failures++;
        this.onFailure("events.load", e, "事件索引未能加载（该会话继续使用旧引擎读取）");
      })
      .finally(() => {
        this.loading.delete(sessionId);
      });
    this.loading.set(sessionId, job);
    if (onLoaded) {
      void job.then(() => {
        if (this.loaded.has(sessionId)) onLoaded();
      });
    }
  }

  private async loadSession(sessionId: string): Promise<void> {
    const list: MirrorEvent[] = [];
    let fromSeq: number | undefined;
    for (let round = 0; round < this.maxRounds; round++) {
      const page = await call<{ items?: unknown[]; has_more?: boolean }>(this.t, "events.list", {
        session_id: sessionId,
        limit: this.maxBatch,
        ...(fromSeq === undefined ? {} : { from_seq: fromSeq }),
      });
      const items = (page?.items ?? []).map((r) => this.normalize(r));
      list.push(...items);
      if (!page?.has_more || items.length === 0) break;
      fromSeq = items[items.length - 1].seq + 1;
    }
    /*
     * 合并：把本地**还没确认落库**的事件并进来。
     *
     * 第 47 轮补（通信链路审计 P1）：原来的判据是
     * `e.seq > placeholderBase - 1_000_000 && e.seq > maxReal` —— 而 `reconcile`
     * 会把占位改写成真实 seq，于是"已经落库、但分页是在它之前发出的"那条事件
     * **两个条件都不满足**，被静默丢掉（本进程内再也读不到它）。
     * 现在按**显式标记** `pending` 判定，并按 seq 去重防重复。
     */
    this.__mergeForTests(sessionId, list);
  }

  /**
   * 把"从库里读到的分页"与"本地未落库的事件"合并进镜像。
   *
   * 抽成独立方法有两个理由：① `loadSession` 那一步是**纯内存时序**逻辑，
   * 而它修掉的缺陷只在这里能观察到，独立出来才能用测试直接驱动；
   * ② 合并规则只有一份（`pending` 标记 + seq 去重 + 按 seq 排序）。
   */
  __mergeForTests(sessionId: string, list: MirrorEvent[]): void {
    const local = this.bySession.get(sessionId) ?? [];
    /**
     * ⚠️ 从库里读回来的条目**必须标记 `settled`**：它们的存在本身就是"已落库"的证据。
     * 不标的话它们会被算成"未落库"（`pendingPlaceholderCount` 数错），
     * 而 `latestSeq` 会拒绝把它们当水位 —— 那等于"明明有真实事件却说没有"。
     */
    const fromDb = list.map((e) => ({ ...e, settled: true as const }));
    const seen = new Set(fromDb.map((e) => e.seq));
    const merged = [...fromDb, ...local.filter((e) => e.pending && !seen.has(e.seq))];
    // 占位 seq 极大，排序会把"还没落库的"放到最后 —— 与它们的真实时序一致
    merged.sort((a, b) => a.seq - b.seq);
    this.bySession.set(sessionId, merged);
  }

  /** **仅测试用**：造一条"已落库"的事件（等价于 追加 → reconcile 的那一步） */
  __seedPersistedForTests(sessionId: string, seq: number): void {
    const e = this.appendLocal(sessionId, "seeded", "{}", 0);
    this.reconcile(sessionId, e.seq, seq);
  }

  /** 启动预热：对给定会话批量触发加载（后台进行，不阻塞启动） */
  async warmup(sessionIds: string[]): Promise<number> {
    this.warmedFlag = true;
    let total = 0;
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        this.ensureLoaded(sessionId);
        const job = this.loading.get(sessionId);
        if (job) await job;
        total += this.bySession.get(sessionId)?.length ?? 0;
      }),
    );
    return total;
  }

  private normalize(r: unknown): MirrorEvent {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      seq: Number(o.seq ?? 0),
      sessionId: String(o.session_id ?? o.sessionId ?? ""),
      type: String(o.type ?? ""),
      payload: typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload ?? {}),
      timestamp: Number(o.timestamp ?? 0),
    };
  }

  readAll(sessionId: string): MirrorEvent[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  readFrom(sessionId: string, fromSeq: number): MirrorEvent[] {
    return (this.bySession.get(sessionId) ?? []).filter((e) => e.seq >= fromSeq);
  }

  readRange(sessionId: string, fromSeq: number, toSeq: number): MirrorEvent[] {
    return (this.bySession.get(sessionId) ?? []).filter((e) => e.seq >= fromSeq && e.seq <= toSeq);
  }

  /**
   * 镜像内的最大 seq（对齐判断与诊断用）。
   *
   * ## ⚠️ 第 47 轮补（通信链路审计 P1）：**必须排除未落库的占位**
   *
   * 占位 seq 取自 `placeholderBase = MAX_SAFE_INTEGER - 1_000_000`（见 `appendLocal`），
   * 是一个**故意巨大**的数。而 `appendLocal` 是"先放进镜像、再排队落库"——
   * 一旦那次 IPC **失败**（引擎忙 / 桥出错），占位就**永远不会被 reconcile**，
   * 也没有任何代码把它从镜像里摘掉。
   *
   * 原实现直接返回"数组最后一项的 seq"，于是：
   * - `latestSeq()` 返回 9.007e15 这个假水位；
   * - 增量投影（`readFrom(lastPushedSeq + 1)`）**此后再也读不到任何真实事件**；
   * - `events.compact` 会拿这个假锚点去问引擎，引擎答"锚点事件不存在"（NOT_FOUND），
   *   而镜像那边已经改过了 → 镜像与库在这一进程内永久分叉。
   *
   * 判据用**显式标记** `settled`（引擎已回传真实 seq），而不是"seq 很大"：
   * 占位 seq 取自 `placeholderBase = MAX_SAFE_INTEGER - 1_000_000`，而 `appendLocal` 算的是
   * `Math.max(last + 1, this.placeholderBase++)` —— **第一条占位正好等于 `placeholderBase`**，
   * 用 `seq >= placeholderBase` 之类的数值判据会漏掉它（这个 off-by-one 我在写这一版时
   * 真的踩到了：用例里的第一条占位没被数出来）。标记不依赖数值，也就不会再错。
   */
  latestSeq(sessionId: string): number {
    const list = this.bySession.get(sessionId) ?? [];
    let max = 0;
    for (const e of list) {
      if (!e.settled) continue; // 还没确认落库：不是水位
      if (e.seq > max) max = e.seq;
    }
    return max;
  }

  /** 镜像里**还没确认落库**的条数（诊断用：>0 说明有追加没成功） */
  pendingPlaceholderCount(sessionId: string): number {
    return (this.bySession.get(sessionId) ?? []).filter((e) => !e.settled).length;
  }

  count(sessionId: string): number {
    return (this.bySession.get(sessionId) ?? []).length;
  }

  sessions(): string[] {
    return [...this.bySession.keys()];
  }

  /** 本地追加：立刻进镜像（相对顺序正确），并排队落库 */
  appendLocal(sessionId: string, type: string, payload: string, timestamp: number): MirrorEvent {
    const list = this.bySession.get(sessionId) ?? [];
    const last = list.length ? list[list.length - 1].seq : 0;
    const placeholder = Math.max(last + 1, this.placeholderBase++);
    /*
     * `pending: true` = "这一条来自本地追加"（合并时必须保留，见 `MirrorEvent.pending`）；
     * `settled: false` = "还没确认落库"（不许当水位，见 `latestSeq`）。
     * 两个事实、两个字段 —— 合成一个就会在 reconcile 之后丢掉事件（用例抓到的）。
     */
    const evt: MirrorEvent = {
      seq: placeholder,
      sessionId,
      type,
      payload,
      timestamp,
      pending: true,
      settled: false,
    };
    list.push(evt);
    this.bySession.set(sessionId, list);
    return evt;
  }

  /**
   * 用引擎回传的真实 seq 修正镜像里的占位，并标记**已确认落库**。
   *
   * 两件事分开做（第 47 轮补）：
   * - `seq` 改成真实值 —— 让镜像里的顺序与库一致；
   * - `settled = true` —— 只有确认落库的条目才允许当水位（`latestSeq`）。
   *
   * `pending` **保持不动**：它的语义是"这一条来自本地追加"，而分页一定不包含它
   * （分页在该 INSERT 之前发出），所以合并时必须继续保留 —— 见 `MirrorEvent.pending`。
   */
  reconcile(sessionId: string, placeholderSeq: number, realSeq: number): void {
    const list = this.bySession.get(sessionId);
    if (!list) return;
    const found = list.find((e) => e.seq === placeholderSeq && e.pending);
    if (found) {
      found.seq = realSeq;
      found.settled = true;
    }
  }

  /** 排队一次写（不阻塞调用方） */
  enqueue(job: Promise<void>, scope: string, note: string): void {
    this.pendingWrites++;
    const wrapped = job
      .catch((e) => {
        this.failures++;
        this.onFailure(scope, e, note);
      })
      .finally(() => {
        this.pendingWrites--;
        this.inFlight.delete(wrapped);
      });
    this.inFlight.add(wrapped);
  }

  async flush(): Promise<void> {
    for (let guard = 0; guard < 100 && this.inFlight.size > 0; guard++) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  stats(): { warmed: boolean; sessions: number; events: number; pendingWrites: number; failures: number } {
    let events = 0;
    for (const list of this.bySession.values()) events += list.length;
    return {
      warmed: this.isWarmed(),
      sessions: this.loaded.size,
      events,
      pendingWrites: this.pendingWrites,
      failures: this.failures,
    };
  }

  /** 删除整个会话的事件（供 compact/fork 后的镜像维护） */
  replaceSession(sessionId: string, events: MirrorEvent[]): void {
    this.bySession.set(sessionId, [...events].sort((a, b) => a.seq - b.seq));
  }
}

// ========== 消息索引的会话级镜像（P3 第 7 段） ==========
//
// ## 为什么读必须跟着写一起切（这是 P3 第 6 段留下的隐患）
//
// 第 6 段把**索引写**切到了 Rust，但**读**还在旧库。渲染侧有条明确的教训
// （见 `listMessagesMerged` 的注释）：**索引里的 hidden 状态也是权威** ——
// 软删除行只在索引里，日志里没有墓碑。于是：
//   写进了 Rust → 旧库那份 hidden 状态是旧的 → 合并时把已压缩的消息**加回来** →
//   上下文永不缩小 → 死循环（用户现场"压缩了 840 条、上下文一点没小"就是这个机制）。
//
// 所以这一段把读也切过来：**按会话**把该会话的消息索引读进镜像。
//
// ## 为什么这不违反"大表不进渲染进程"
//
// 镜像的粒度是**单个会话**，而不是整个库；而且 `listMessagesMerged` 本来就会把
// 一个会话的消息**全部读进内存**再渲染（它返回的是数组）。所以这里没有增加新的
// 内存负担 —— 只是把"每次查询都读一遍"变成"读一次、之后同步读"。
// 真正的语料级缓冲（整个库、附件正文、全文索引）仍然不进来。

export interface MirrorMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  reasoning?: string | null;
  timestamp: number;
  model?: string | null;
  status?: string | null;
  hidden?: number;
  /**
   * `generated_files` 的 JSON 文本（与原样返回的列一致）。
   *
   * 为什么必须进镜像（第 14 轮）：写路径一直在传这一列，而**读路径从来没把它带回来** ——
   * `getMessage` / `listMessages` 的端口分支只认镜像行，于是 rust 模式下"生成了哪些文件"
   * 永远读不到（用户形态：重启后标记消失、fork/复制一起丢）。列在库里，缺陷在 SELECT 与映射。
   */
  generated_files?: string | null;
  /**
   * **索引裁剪**标记（第 44 轮新增的库列）。
   *
   * `hidden = 1, trimmed = 1` = "这一行是为了限制索引体积而被隐藏的"，
   * 与"被上下文压缩隐藏"（`hidden = 1, trimmed = 0`）语义相反：前者读路径要**保留**，
   * 后者要**排除**。所以这一列必须进镜像 —— 否则读路径又只能靠猜。
   */
  trimmed?: number;
}

class RustMessageMirror {
  private bySession = new Map<string, MirrorMessageRow[]>();
  private byId = new Map<string, MirrorMessageRow>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private failures = 0;
  /**
   * 单会话加载上限（防极端会话无限拉取；超出时记录并截断，读操作会回退）。
   *
   * 这个值同时是**单会话**的内存上限：`MirrorMessageRow` 持有 `content` 字符串，
   * 5000 条大消息就是几十上百 MB。所以它必须与 `totalBudgetRows` 一起看。
   */
  private readonly maxBatch = 5000;
  private readonly maxRounds = 60;
  private truncated = false;
  /**
   * **跨会话**的总行数预算。
   *
   * 原来这里是"每个会话一旦加载就永远驻留"：用户浏览过 N 个大会话之后，
   * N 份语料全留在渲染进程里（实测形态：1000 条 × 200KB 的会话 ≈ 195MB 正文，
   * 两份引用（bySession + byId）指向同一批对象，但 N 个会话就是 N 份）。
   * 这正是"大文档批处理把渲染进程压死"在**读路径**上的形态。
   *
   * 超出预算时按 **LRU** 逐出最久未使用的会话镜像：
   * - 逐出后 `isLoaded` 为 false → 该会话的读**自动回退旧路径**，
   *   同时下次访问会重新走 `ensureLoaded`（从 Rust 分页拉回）；
   * - 因为路由规则本来就是"未加载完不路由"，逐出**不会**造成读写分裂。
   */
  private readonly totalBudgetRows: number;
  /** 访问序（Map 的迭代顺序即插入序）：命中时删除再插入 = 移到末尾 = 最新使用 */
  private lru = new Map<string, true>();
  private evictions = 0;

  constructor(
    private readonly t: StorageTransport,
    private readonly onFailure: (scope: string, e: unknown, note: string) => void,
    totalBudgetRows = 20_000,
  ) {
    this.totalBudgetRows = totalBudgetRows;
  }

  isLoaded(sessionId: string): boolean {
    return this.loaded.has(sessionId);
  }

  /**
   * 该会话的镜像**正在加载中**（第 49 轮）。
   *
   * 为什么需要它：`isLoaded === false` 有两种完全不同的含义 ——
   * ①**还没到**（加载任务在途，马上就有）；②**读不到**（端口没有该能力 / 加载失败过）。
   * 两者在界面上必须长得不一样：前者应当是"加载中"，后者才是"暂时读不到"。
   *
   * 真机实测（打包版，277 条消息的会话）：启动后的第 225ms~379ms 之间，
   * 界面渲染的是「**暂时读不到这个会话的历史消息**」——
   * 而那一刻只是启动时按会话惰性加载的正常过程（154ms 后消息就出来了）。
   * 每次启动都对着一条 277 条的会话说一次"读不到"，用户会以为存储坏了。
   */
  isLoading(sessionId: string): boolean {
    return this.loading.has(sessionId);
  }

  /** 当前镜像统计（用于诊断与契约测试：证明"驻留是有界的"） */
  stats(): {
    sessions: number;
    rows: number;
    failures: number;
    truncated: boolean;
    evictions: number;
    budgetRows: number;
  } {
    let rows = 0;
    for (const l of this.bySession.values()) rows += l.length;
    return {
      sessions: this.loaded.size,
      rows,
      failures: this.failures,
      truncated: this.truncated,
      evictions: this.evictions,
      budgetRows: this.totalBudgetRows,
    };
  }

  /** 加载是否被上限截断（截断后必须以旧库为准，避免读到不完整集合） */
  isTruncated(): boolean {
    return this.truncated;
  }

  private touch(sessionId: string): void {
    if (!this.loaded.has(sessionId)) return;
    this.lru.delete(sessionId);
    this.lru.set(sessionId, true);
  }

  /**
   * **丢弃并重新加载**某会话的镜像（第 38 轮）。
   *
   * ## 为什么需要它
   *
   * 场景：数据被外部清空 → 运行期守护从旧库恢复 → 但镜像里那份"空集合"仍然是
   * `loaded` 状态，于是 `rustMessageSource()` 认为"已加载完、可以路由"，
   * 读出来还是空 —— 数据库已经救回来了，**界面却依旧空白**（真机实测就是这个形态）。
   *
   * 关键认知：**镜像的 `loaded` 标记是关于"这份快照完整"，不是关于"库没变"**。
   * 一旦库内容被外部改动（恢复就是这种情况），旧快照必须作废重拉，
   * 否则"未加载不路由"这条防读写分裂的规则，会反过来把陈旧快照当成权威。
   */
  reload(sessionId: string, onLoaded?: () => void): void {
    this.loaded.delete(sessionId);
    this.lru.delete(sessionId);
    this.bySession.delete(sessionId);
    this.loading.delete(sessionId); // 允许立刻重新发起（旧 job 的 finally 是幂等删除）
    this.ensureLoaded(sessionId, onLoaded);
  }

  /**
   * 超出总预算时逐出最久未使用的会话镜像（**不动正在加载的会话**）。
   *
   * 只逐出到刚好低于预算：逐出动作本身不该引发抖动。
   */
  private enforceBudget(): void {
    let rows = 0;
    for (const l of this.bySession.values()) rows += l.length;
    if (rows <= this.totalBudgetRows) return;
    for (const sessionId of [...this.lru.keys()]) {
      if (rows <= this.totalBudgetRows) break;
      if (this.loading.has(sessionId)) continue;
      const dropped = this.bySession.get(sessionId);
      if (!dropped) continue;
      for (const r of dropped) {
        // byId 只在该 id 不再属于任何驻留会话时才删（同一条消息不会属于两个会话，
        // 但这里仍然按"引用是否还存在"判断，避免将来支持跨会话引用时误删）
        if (this.byId.get(r.id) === r) this.byId.delete(r.id);
      }
      this.bySession.delete(sessionId);
      this.loaded.delete(sessionId);
      this.lru.delete(sessionId);
      rows -= dropped.length;
      this.evictions++;
      this.onFailure(
        "messages.evict",
        new Error(`消息镜像超出总预算，已逐出会话 ${sessionId}（${dropped.length} 条）`),
        "已释放最久未使用的会话消息镜像（内存预算），下次读取该会话会重新加载",
      );
    }
  }

  ensureLoaded(sessionId: string, onLoaded?: () => void): void {
    if (this.loaded.has(sessionId)) {
      this.touch(sessionId);
      onLoaded?.();
      return;
    }
    if (this.loading.has(sessionId)) {
      if (onLoaded) void this.loading.get(sessionId)?.then(() => onLoaded());
      return;
    }
    const job = this.loadSession(sessionId)
      .then(() => {
        this.loaded.add(sessionId);
        this.lru.set(sessionId, true);
        this.enforceBudget();
      })
      .catch((e) => {
        this.failures++;
        this.onFailure("messages.load", e, "消息索引未能加载（该会话继续使用旧引擎读取）");
      })
      .finally(() => {
        this.loading.delete(sessionId);
      });
    this.loading.set(sessionId, job);
    if (onLoaded) void job.then(() => { if (this.loaded.has(sessionId)) onLoaded(); });
  }

  private async loadSession(sessionId: string): Promise<void> {
    const rows: MirrorMessageRow[] = [];
    let offset = 0;
    for (let round = 0; round < this.maxRounds; round++) {
      const page = await call<{ items?: unknown[]; has_more?: boolean }>(this.t, "messages.list", {
        session_id: sessionId,
        limit: this.maxBatch,
        offset,
        include_hidden: true, // 索引读必须含 hidden（它的 hidden 状态是权威）
      });

      const items = (page?.items ?? []).map((r) => this.normalize(r));
      rows.push(...items);
      if (!page?.has_more || items.length === 0) break;
      offset += items.length;
      if (round === this.maxRounds - 1) this.truncated = true;
    }
    this.bySession.set(sessionId, rows);
    for (const r of rows) this.byId.set(r.id, r);
  }

  private normalize(r: unknown): MirrorMessageRow {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      session_id: String(o.session_id ?? ""),
      role: String(o.role ?? "user"),
      content: typeof o.content === "string" ? o.content : "",
      reasoning: (o.reasoning as string | null) ?? null,
      timestamp: Number(o.timestamp ?? 0),
      model: (o.model as string | null) ?? null,
      status: (o.status as string | null) ?? null,
      hidden: Number(o.hidden ?? 0),
      generated_files: (o.generated_files as string | null) ?? null,
      /*
       * ⚠️ `trimmed` **必须**在这里搬进来（第 44 轮：漏了它就是"整批修复在真机上没生效"）。
       *
       * 这一处是 eager 转换：wire 行 → 镜像行时**只搬列在这里列出的字段**。
       * 我加了 `MirrorMessageRow.trimmed`、也让 `hiddenIds()` 去读它，却忘了在这里搬 ——
       * 于是真端口上每一行的 `trimmed` 都是 `undefined`，`hiddenIds()` 的
       * `Number(m.trimmed ?? 0) !== 1` 恒真 → **所有被隐藏的行都被当成"上下文压缩"** →
       * `listMessagesMerged` 把"被索引裁剪掉、本该仍读得到的历史"整批删掉。
       *
       * 更糟的是 CI 看不见它：假端口的 `hiddenIds()` 是**惰性读共享表**（原始 wire 行形状，
       * `trimmed` 一直在），而真端口是**eager 转换**（在这里被丢掉）—— 测试双比实现宽松的又一处。
       * 所以修完这一行必须配一条**真端口**的转换契约用例（见 `rust-port.test.ts` 的 MIRROR-TRIM）。
       */
      trimmed: Number(o.trimmed ?? 0),
    };
  }

  list(sessionId: string): MirrorMessageRow[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  byIdLookup(id: string): MirrorMessageRow | undefined {
    return this.byId.get(id);
  }

  /**
   * 只返回**上下文压缩隐藏**的 id（`hidden = 1` 且 `trimmed ≠ 1`）。
   *
   * ## 为什么要把"索引裁剪"那一类排除掉（第 44 轮：持久化标记）
   *
   * `hidden` 这一列被两条语义**相反**的路径共用：
   *
   * | 路径 | `hidden = 1` 的含义 | 读路径应当 |
   * | --- | --- | --- |
   * | 上下文压缩 | 这条消息**从上下文里移除** | 排除（否则"压缩 840 条、token 一点没降"） |
   * | 索引裁剪（启动维护，限制索引体积） | 行**留在库里**满足 `message_feedback` 外键 | **保留**（"被裁的历史仍读得到"是裁剪的前提） |
   *
   * 两者原来在库里长得一模一样，渲染侧只能靠**进程内记账**区分"这次隐藏是谁做的" ——
   * 于是重启后必然分不清：要么历史消失（用户看不到自己的消息），要么压缩失效。
   * 现在引擎把裁剪写成 `hidden = 1, trimmed = 1`，区别成了库里的事实，这里只需读它。
   */
  hiddenIds(sessionId: string): Set<string> {
    return new Set(
      (this.bySession.get(sessionId) ?? [])
        // `trimmed` 缺省按 0 处理：老库/未迁移的行没有这一列的值
        .filter((m) => m.hidden === 1 && Number(m.trimmed ?? 0) !== 1)
        .map((m) => m.id),
    );
  }

  /**
   * 把一批消息标记为"被索引裁剪"（`hidden = 1, trimmed = 1`）**在镜像上的等价更新**。
   *
   * 为什么不能复用 `removeByIds`：引擎只把行改成隐藏，**行还在库里**；
   * 镜像若把行删掉，下一次整会话加载就会与引擎不一致（镜像比引擎"更狠"是缺陷的来源）。
   * 也不能只改 `hidden`：那样这一行会被读路径当成"被压缩"，用户就看不到自己的历史了。
   */
  applyMessageTrim(sessionId: string, ids: string[]): void {
    this.touch(sessionId);
    const wanted = new Set(ids);
    for (const row of this.bySession.get(sessionId) ?? []) {
      if (wanted.has(row.id)) {
        row.hidden = 1;
        row.trimmed = 1;
      }
    }
    for (const id of ids) {
      const row = this.byId.get(id);
      if (row) {
        row.hidden = 1;
        row.trimmed = 1;
      }
    }
  }

  count(sessionId: string): number {
    return (this.bySession.get(sessionId) ?? []).length;
  }

  /** 本地应用一次写入（让镜像与刚写进 Rust 的索引保持一致） */
  applyWrite(row: Partial<MirrorMessageRow> & { id: string; session_id: string }): void {
    this.touch(row.session_id);
    const list = this.bySession.get(row.session_id);
    const prev = this.byId.get(row.id);
    const full: MirrorMessageRow = {
      id: row.id,
      session_id: row.session_id,
      role: row.role ?? "user",
      content: row.content ?? "",
      reasoning: row.reasoning ?? null,
      timestamp: row.timestamp ?? Date.now(),
      model: row.model ?? null,
      status: row.status ?? "done",
      /**
       * ⚠️ `hidden` **未提供 ≠ 置 0**（A-3，第 20 轮）。
       *
       * 原来这里是 `row.hidden ?? 0` —— 而唯一的生产调用方
       * `writeIndexViaRust`（`message.ts`）**不传 hidden**（那是刻意的：
       * 流式更新不该碰软删除状态）。于是每次 `updateMessage` 都把索引镜像里
       * 已经置 1 的 `hidden` **打回 0**：被压缩（软删除）的消息重新变回可见，
       * 上下文再也缩不小 —— 而库里那一行是对的（Rust 的 `upsert_index` 只在
       * 显式给了 hidden 时才改它）。**镜像比库更宽松**，这类偏差最难查。
       *
       * 所以：未提供时**保留镜像里已有的值**；镜像里也没有（首次写入）才用 0。
       */
      hidden:
        row.hidden === undefined
          ? Number(prev?.hidden ?? 0)
          : Number(row.hidden),
      /**
       * `generated_files` 同样按"未提供 = 不动"处理（A-3）。
       *
       * 这一列原来在 `applyWrite` 里**完全没有维护**：`upsert_index` 每次都会带上它
       * （`writeIndexViaRust` 传的是 `message.generatedFiles ?? null`），本地镜像却从不更新 ——
       * 于是"刚写的这行生成了哪些文件"要等下一次整会话重载才看得到（写后读丢字段）。
       * `row` 里没有这个键时保留旧值/置 null，与 `normalize` 的读路径形状一致。
       */
      generated_files:
        row.generated_files === undefined
          ? (prev?.generated_files ?? null)
          : (row.generated_files as string | null),
    };
    if (list) {
      const i = list.findIndex((m) => m.id === row.id);
      if (i >= 0) list[i] = { ...list[i], ...full };
      else list.push(full);
    }
    this.byId.set(row.id, full);
  }

  /** 删除（deleteMessage / trim）后的镜像维护 */
  removeByIds(sessionId: string, ids: string[]): void {
    this.touch(sessionId);
    const set = new Set(ids);
    const list = this.bySession.get(sessionId);
    if (list) this.bySession.set(sessionId, list.filter((m) => !set.has(m.id)));
    for (const id of ids) this.byId.delete(id);
  }
}

// ========== 通用域镜像（P3 第 11 段） ==========
//
// ## 为什么需要它
//
// 剩余 14 个域模块（账号 / 图谱 / 笔记本 / 卡片 / 目标 / 团队 / 问题 / 收件箱 / 笔记 /
// 委派任务 / 提议草稿 / 待办 / 轮次文件变更 / 智能体画像）都是同一个形状：
// **纯 CRUD + 同步读**（列表 / 按 id 取 / 按条件取 / 写入 / 更新 / 删除），
// 表都很小（实测 graph_nodes 33 行、notebooks 1 行、accounts 0~几条）。
//
// 与其为每个域写一遍镜像逻辑（14 次重复、14 次可能出错），不如做一个**通用域镜像**：
// 按表名加载、同步读、写穿 + 本地更新。每个域的接入就变成"声明表名 + 保留原签名"。
//
// ## 边界（与"语料不进渲染进程"的分工）
//
// 这些域的数据天然是"整表即工作集"：图谱一次要渲染全部节点、笔记本列表要全部标题。
// 而**消息/事件/附件正文**这类大量级语料绝不进来（各自有专门的分页或镜像策略）。
// 所以判据仍是**量级**：单表几十到几百行 → 可镜像；上万行 → 必须分页。
//
// 每个域的镜像都会在加载时记录行数，超过上限（`maxRows`）就**放弃镜像**并回退旧路径，
// 避免"某天图谱涨到十万行"时把渲染进程压死。

/**
 * **哪些表只镜像指定列**（第 14 轮；第 20 轮补 `turn_file_changes`）。
 *
 * 判据不是"表重不重要"，而是"整行会不会把大体积列拉进渲染进程"：
 * `attachments.content` 存的是附件正文（长文档可达几十 MB），而渲染侧只用到元数据
 * （列表展示、按 id 取正文走 `attachments.content` 命令 + 同步缓存）。
 *
 * 不投影的话，`listExternalAttachmentMarkers()` 这类调用会把**整张附件表连同正文**
 * 读进内存 —— 正是 P6 花大力气消灭的那类占用。
 *
 * ## `turn_file_changes.patch`（A-2，第 20 轮）
 *
 * 同一类问题，量级更狠：`patch` 是**单行上限 500,000 字符**的统一 diff，
 * 而这张表是**热表**（每轮一行，会话一多必然几千行）。
 * 按全列装载的实测后果有两层：
 * 1. 更容易先撞上"超过 5000 行被 `refused`" → `getById` 恒返回 null → 回滚功能整域失效
 *    （拒绝的永久性由 A-2 的 `refusedAt` 退避重试修掉）；
 * 2. 即使没被拒，5000 行 × 500KB ≈ 2.5GB 的渲染进程占用 —— 正是要消灭的那类占用。
 *
 * ⚠️ **投影之后 `getById` 返回的记录里 `patch` 就是 `undefined`** —— 这是刻意的契约：
 * 它表示"镜像里没有这一列"，而不是"这条记录没有 patch"。
 * 需要 patch 正文的调用方（`FileChangeTracker.revert`）走
 * `crud.list` + `columns: ["patch"]` + `where: { id }` **只取那一行的那一列** ——
 * 这条按需路径由 `environment/file-change-tracker.ts::fetchPatchById`（任务 C-7）提供。
 *
 * ⚠️ 写入侧的相容性（为什么投影不会把库里的 patch 写没）：
 * `crud.upsert` 的列集合是**由提供行的键求并集**（`codem-db/src/crud.rs`，其测试
 * `crud_upsert_replace_does_not_cascade_delete_children` 明确断言"未提供的列要保持原值"），
 * 而 `JSON.stringify` 会丢掉值为 `undefined` 的键 ——
 * 所以"从镜像读回来的记录少了 patch、再整体写回库"**不会**把 `patch` 清成 NULL。
 */
const DOMAIN_COLUMN_PROJECTION: Record<string, string[]> = {
  attachments: [
    "id",
    "session_id",
    "message_id",
    "name",
    "type",
    "path",
    "preview",
    "sandbox_path",
    "mime_type",
    "size",
    "added_at",
  ],
  /** 除 `patch` 正文之外的全部列（列表 / 状态更新 / 回滚要用的 changed_files 都不需要它） */
  turn_file_changes: [
    "id",
    "session_id",
    "message_id",
    "turn_index",
    "before_tree",
    "after_tree",
    "changed_files",
    "patch_sha256",
    "current_brief",
    "status",
    "created_at",
  ],
};

export class RustDomainMirror {

  private byTable = new Map<string, Array<Record<string, unknown>>>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private refused = new Set<string>();
  /**
   * 每张"被拒"表的**上次尝试时间**（A-2，第 20 轮）。
   *
   * ## 为什么必须有它
   *
   * 原来的 `refused` 是一个**只进不出**的集合：一旦某表超过镜像行数上限，
   * `loadTable` 就 `refused.add(table)` 并 `return`，而 `refused` **只在
   * `replaceTable` 里被清除** —— 那个方法零生产调用者。于是"这张表太大"
   * 一旦成立，就变成**进程内永久不再重试**：该域的读路径永远拿到空结果，
   * 直到用户重启。
   *
   * 真机形态很具体：`turn_file_changes` 是热表（`patch` 单行上限 500,000 字符），
   * 会话一多必然超过 5000 行 → 被拒 → **回滚功能整个会话期内失效**。
   * 而且"太大"这件事本身也可能只是**那一刻**太大（用户后来删了旧会话）。
   *
   * 处置：记下尝试时间，**下次访问时若已过退避窗口就再试一次**。
   * 重试仍然超限就再记一次时间，退避窗口翻倍（上限
   * `REFUSED_RETRY_MAX_MS`）—— 既不会每次访问都白拉一遍几千行，
   * 也不会让"永久空"成立。
   */
  private refusedAt = new Map<string, number>();
  /** 退避窗口起点：首次尝试失败后等这么久才重试 */
  private static readonly REFUSED_RETRY_BASE_MS = 30_000;
  /** 退避窗口上限（再大就等于不再重试了，那正是要修掉的形态） */
  private static readonly REFUSED_RETRY_MAX_MS = 10 * 60_000;
  private failures = 0;
  /** 单表镜像行数上限（超过则放弃镜像，回退旧路径） */
  private readonly maxRows: number;

  constructor(
    private readonly t: StorageTransport,
    private readonly onFailure: (scope: string, e: unknown, note: string) => void,
    maxRows = 5000,
  ) {
    this.maxRows = maxRows;
  }

  /** 该表是否已加载且允许镜像（**路由的唯一依据**） */
  isReady(table: string): boolean {
    return this.loaded.has(table) && !this.refused.has(table);
  }

  /**
   * 该表**正在加载**（异步 IPC 在途；既没就绪也没失败）。
   *
   * ## 为什么必须能问出这个状态（A-1）
   *
   * `ensureLoaded` 是**异步**的，所以每次启动后对某张表的**第一次写**都落在
   * "加载中"这个窗口里。写路径只有能区分"**还在加载**"（应当排队等就绪）
   * 与"**永远不会就绪**"（超上限被拒 / 加载失败，应当如实返回未接手），
   * 才能既修掉"首触必丢"、又不把"永远不成的写"排进一个只涨不消的队列。
   */
  isLoading(table: string): boolean {
    return this.loading.has(table);
  }

  /** 同步触发加载（后台进行） */
  ensureLoaded(table: string, onLoaded?: () => void, maxRowsOverride?: number): void {
    /*
     * A-2：被拒过的表**不是永久拒绝**。
     *
     * 先看退避窗口是否已过；过了就把这张表从 `refused` 里放出来重新加载一次，
     * 并按尝试次数把窗口翻倍。这样"超限后进程内永久空"不再成立 ——
     * 用户删掉旧会话之后，下一次访问就能把回滚记录重新镜像回来。
     */
    if (this.refused.has(table)) {
      const waited = Date.now() - (this.refusedAt.get(table) ?? 0);
      const misses = this.refusedMisses.get(table) ?? 1;
      const window = Math.min(
        RustDomainMirror.REFUSED_RETRY_BASE_MS * 2 ** (misses - 1),
        RustDomainMirror.REFUSED_RETRY_MAX_MS,
      );
      // 窗口内、或本轮已经重试过一次 → 不再白拉一遍（几千行的代价），也不回调 onLoaded
      if (waited < window || this.refusedRetryUsed) return;
      this.refusedRetryUsed = true;
      this.refused.delete(table);
    }
    if (this.loaded.has(table) || this.loading.has(table)) {
      if (this.loaded.has(table)) onLoaded?.();
      else if (onLoaded) void this.loading.get(table)?.then(() => { if (this.isReady(table)) onLoaded(); });
      return;
    }
    const job = this.loadTable(table, maxRowsOverride)
      .then(() => {
        this.loaded.add(table);
      })
      .catch((e) => {
        this.failures++;
        this.onFailure(`domain.${table}.load`, e, `表 ${table} 未能加载（该域继续使用旧引擎读取）`);
      })
      .finally(() => {
        this.loading.delete(table);
      });
    this.loading.set(table, job);
    if (onLoaded) void job.then(() => { if (this.isReady(table)) onLoaded(); });
  }

  /**
   * **显式重试全部被拒的表**（A-2）。
   *
   * 退避重试解决的是"迟早会再试一次"；这个入口解决的是"**现在**重试" ——
   * 重建时机（索引重建、库被外部恢复、维护清理之后）恰恰是"表可能已经不再超限"
   * 的时刻，等退避窗口白等一遍没有意义。
   *
   * 注意它**真的重新发起加载**（而不是只把表从 `refused` 里放出去）：
   * 只"放出去"是不够的 —— 那些表的读路径都在等 `isReady`，而没有谁会替它们
   * 再调一次 `ensureLoaded`（`domainPort` 会，但它要等到下一次访问，
   * 中间这段时间的读依旧是空）。
   *
   * @returns 已重新发起加载的表名（供日志/诊断与测试断言）
   */
  retryRefusedTables(): string[] {
    const retry = [...this.refused];
    for (const table of retry) {
      this.refused.delete(table);
      this.refusedAt.delete(table);
      this.refusedMisses.delete(table);
      this.ensureLoaded(table);
    }
    return retry;
  }

  /** 每张被拒表**连续**被拒的次数（退避窗口按它翻倍） */
  private refusedMisses = new Map<string, number>();
  /**
   * 本次"加载周期"里是否已经重试过被拒的表（A-2）。
   *
   * 为什么要这个闩锁：退避重试的自然触发点是 `ensureLoaded`（每次访问都会走到），
   * 而 `ensureLoaded` 在一次页面渲染里会被调很多次。没有闩锁的话，
   * 那张 2.5GB 量级的大表会被**反复拉取**（每次都拉到超限才放弃）——
   * 那比"永久不重试"更糟。一旦某次重试仍被拒，就等下一个加载周期
   * （`beginLoadCycle()`，由启动/预取调用）再试。
   */
  private refusedRetryUsed = false;

  /**
   * 开始一个新的**加载周期**：允许再次重试被拒的表。
   *
   * 由 `bootstrap.ts` 的域镜像预取（每次启动一次）调用。语义是
   * "上一轮判断（太大）可能已经过时了（用户删了旧会话 / 清理跑过）"。
   */
  beginLoadCycle(): void {
    this.refusedRetryUsed = false;
  }

  /** 被拒表的上次尝试时间（诊断/测试用） */
  refusedSince(): Record<string, number> {
    return Object.fromEntries(this.refusedAt);
  }

  private async loadTable(table: string, maxRowsOverride?: number): Promise<void> {
    // 每张表可以有更小的上限（例如 notebook_chunks：每行带 Base64 embedding，
    // 5000 行就是几十 MB 的渲染进程内存）。取更严格的那个。
    const cap = maxRowsOverride === undefined ? this.maxRows : Math.min(this.maxRows, maxRowsOverride);
    const rows: Array<Record<string, unknown>> = [];
    let offset = 0;
    for (let round = 0; round < 40; round++) {
      /**
       * **按表列投影**（第 14 轮）：默认取全部列，但有些表的整行**不能**进渲染进程 ——
       * 典型是 `attachments.content`（可能是几十 MB 的文档全文，而这里只要元数据）。
       * 投影清单在 `DOMAIN_COLUMN_PROJECTION` 里声明；`crud.list` 的 `columns` 参数
       * 会在引擎侧核对列名真实性（不存在会报错，不会静默少列）。
       */
      const projection = DOMAIN_COLUMN_PROJECTION[table];
      const page = await call<{ items?: Array<Record<string, unknown>>; has_more?: boolean }>(
        this.t,
        "crud.list",
        projection ? { table, columns: projection, limit: 1000, offset } : { table, limit: 1000, offset },
      );
      const items = page?.items ?? [];
      rows.push(...items);
      if (rows.length > cap) {
        // 放弃镜像：这张表比预期大得多，继续镜像会把渲染进程压死
        this.refused.add(table);
        /*
         * A-2：记下**这次尝试的时间**与连续被拒次数。
         *
         * 没有这两个字段时 `refused` 就是一个只进不出的集合 —— "太大"会变成
         * 永久结论（详见 `refusedAt` 的说明）。有了它，退避窗口一过就会自动再试，
         * 窗口按连续失败次数翻倍、有上限，所以既不会永久空、也不会每次访问都白拉。
         */
        this.refusedAt.set(table, Date.now());
        this.refusedMisses.set(table, (this.refusedMisses.get(table) ?? 0) + 1);
        this.onFailure(
          `domain.${table}.too-large`,
          new Error(`表 ${table} 超过镜像上限 ${cap} 行`),
          `表 ${table} 暂不镜像（超出内存上限）；稍后会自动重试，本次该域读给空结果`,
        );
        return;
      }
      if (!page?.has_more || items.length === 0) break;
      offset += items.length;
    }
    this.byTable.set(table, rows);
    // 加载成功：清掉这张表的退避记录（下次超限重新从最小窗口起算）
    this.refusedMisses.delete(table);
    this.refusedAt.delete(table);
  }

  all<R = Record<string, unknown>>(table: string): R[] {
    return [...((this.byTable.get(table) ?? []) as R[])];
  }

  find<R = Record<string, unknown>>(table: string, where: Record<string, unknown>): R[] {
    const keys = Object.entries(where);
    return this.all<R>(table).filter((row) =>
      keys.every(([k, v]) => (row as Record<string, unknown>)[k] === v),
    );
  }

  findOne<R = Record<string, unknown>>(table: string, where: Record<string, unknown>): R | null {
    return this.find<R>(table, where)[0] ?? null;
  }

  count(table: string): number {
    return (this.byTable.get(table) ?? []).length;
  }

  /** 本地应用一次写入（键为**线协议列名**，snake_case） */
  applyWrite(table: string, row: Record<string, unknown>, primaryKey = "id"): void {
    const list = this.byTable.get(table);
    if (!list) return;
    const key = row[primaryKey];
    const i = list.findIndex((r) => r[primaryKey] === key);
    if (i >= 0) list[i] = { ...list[i], ...row };
    else list.push({ ...row });
  }

  /** 本地应用批量写入 */
  applyWriteMany(table: string, rows: Array<Record<string, unknown>>, primaryKey = "id"): void {
    for (const r of rows) this.applyWrite(table, r, primaryKey);
  }

  /** 本地应用删除（按 where 匹配） */
  applyDelete(table: string, where: Record<string, unknown>): void {
    const list = this.byTable.get(table);
    if (!list) return;
    const keys = Object.entries(where);
    this.byTable.set(
      table,
      list.filter((row) => !keys.every(([k, v]) => row[k] === v)),
    );
  }

  /**
   * 只有镜像的整表替换（清空 + 重建）。
   *
   * ⚠️ **它不写穿**。`domain-store.ts` 的 `domainReplaceTable` 曾用它当"写穿"的
   * 实现（只改内存就返回成功），第 20 轮已把那条路改成逐行 `crud.delete` +
   * `crud.upsert`。这里保留它只作为"镜像维护"原语，并在 `refused` 上做正确的事：
   * 替换成功意味着这张表**现在**是完整的，所以清掉退避记录（A-2）。
   */
  replaceTable(table: string, rows: Array<Record<string, unknown>>): void {
    this.byTable.set(table, [...rows]);
    this.loaded.add(table);
    this.refused.delete(table);
    this.refusedAt.delete(table);
    this.refusedMisses.delete(table);
  }

  /**
   * 本地按**谓词**删除（范围条件，例如 `created_at < cutoff`）。
   *
   * 只改本地镜像，**不写穿** —— 调用方（`domainDeleteWhere`）负责按筛出的 id 写穿。
   */
  applyDeleteWhere(table: string, match: (row: Record<string, unknown>) => boolean): number {
    const list = this.byTable.get(table);
    if (!list) return 0;
    const kept = list.filter((row) => !match(row));
    const removed = list.length - kept.length;
    if (removed > 0) this.byTable.set(table, kept);
    return removed;
  }

  stats(): { tables: number; rows: number; refused: string[]; failures: number } {
    let rows = 0;
    for (const l of this.byTable.values()) rows += l.length;
    return { tables: this.loaded.size, rows, refused: [...this.refused], failures: this.failures };
  }
}

// ========== 聚合端口 ==========

export class RustStoragePort implements StoragePort {
  readonly kind = "rust" as const;
  readonly engine: RustEnginePort;
  readonly data: RustDataPort;
  readonly config: RustConfigPort;
  readonly append: RustAppendPort;
  /** 配置面扩展域（quick_phrases / mcp_servers / memory）的内存镜像 */
  readonly configDomain: RustConfigDomainCache;
  /** 事件日志的镜像 + 发件箱（只追加面） */
  readonly events: RustEventMirror;
  /** 消息索引的会话级镜像（数据面读路径） */
  readonly messages: RustMessageMirror;
  /** 通用域镜像（账号 / 图谱 / 笔记本 / 卡片 … 的表级镜像与写穿） */
  readonly domains: RustDomainMirror;
  private readonly reportFailure: (stream: string, e: unknown, note: string) => void;
  private readonly transport: StorageTransport;

  constructor(
    transport: StorageTransport = tauriTransport,
    onFailure: (stream: string, e: unknown, note: string) => void = () => {},
    opts: { messageMirrorBudgetRows?: number } = {},
  ) {
    this.reportFailure = onFailure;
    this.transport = transport;
    this.engine = new RustEnginePort(transport);
    this.data = new RustDataPort(transport, (command, attempt, e, delayMs) => {
      this.retryCount++;
      this.retryByCommand[command] = (this.retryByCommand[command] ?? 0) + 1;
      /*
       * 重试**只留痕、不上报为用户可见失败**：这一刻还没失败，只是引擎说"稍后重试"。
       * 真失败了由调用方的 `.catch` 走统一上报（那次才是用户该看见的）。
       */
      console.warn(
        `[Storage] ${command} 第 ${attempt} 次重试（${e.code}，${delayMs}ms 后）：${e.message}`,
      );
    });
    this.config = new RustConfigPort(transport, onFailure);
    this.append = new RustAppendPort(transport, onFailure);
    this.configDomain = new RustConfigDomainCache(transport, onFailure);
    this.events = new RustEventMirror(transport, onFailure);
    // 预算可注入：契约测试要用小预算来验证"驻留真的有界"（否则得造两万条消息）
    this.messages = new RustMessageMirror(transport, onFailure, opts.messageMirrorBudgetRows);
    this.domains = new RustDomainMirror(transport, onFailure);
  }

  /**
   * 已发生的写重试次数（诊断用）。
   *
   * 为什么值得留一个计数：重试是**不可见的延迟**（最坏 3 次 × 数秒），
   * 真机上"界面偶尔卡一下"很可能就是它。没有计数就只能靠猜。
   */
  retryStats(): { count: number; byCommand: Record<string, number> } {
    return { count: this.retryCount, byCommand: { ...this.retryByCommand } };
  }
  private retryCount = 0;
  private retryByCommand: Record<string, number> = {};

  /** 为某个会话预热消息索引镜像（打开会话时调用） */
  warmupMessages(sessionId: string): void {
    this.messages.ensureLoaded(sessionId);
  }

  /**
   * 事件日志预热（只追加面）。
   *
   * **不阻塞启动**：预热是后台进行的，且每个会话在加载完成前仍走旧引擎路径
   * （由 `EventLog` 通过 `isLoaded(sessionId)` 判断）。失败同样只上报。
   */
  warmupEvents(sessionIds: string[]): void {
    for (const id of sessionIds) this.events.ensureLoaded(id);
  }

  /**
   * 启动顺序：先预热配置（同步读的前提），再报告健康。
   *
   * 两个预热阶段的**失败处置刻意不同**：
   * - `settings` 预热失败 → 抛出（整个配置面不可用，界面连主题都读不到，
   *   上层应当据此决定是否启用端口）；
   * - 扩展域（quick_phrases / mcp_servers / memory）失败 → **只上报，不抛**：
   *   这三块按默认值也能正常用（没有快捷短语、没有 MCP、没有记忆），
   *   而"启动整体失败"会让用户连界面都进不去 —— 代价严重不成比例。
   *
   * （注释写"不阻塞启动"却 `throw` 是自相矛盾的；这里让代码和注释对齐。）
   */
  async start(): Promise<StorageHealth> {
    await this.config.warmup();
    try {
      await this.configDomain.warmup();
    } catch (e) {
      this.configDomain.bumpFailure();
      this.reportFailure(
        "config-domain",
        e,
        "快捷短语 / MCP 服务器 / 记忆未能加载（功能降级，其余不受影响）",
      );
    }
    return this.engine.health();
  }

  /** 退出顺序：先排空写队列，再 checkpoint（不是整库导出） */
  async stop(): Promise<void> {
    await this.append.flush();
    await this.events.flush();
    await this.config.flush();
    await this.engine.checkpoint();
  }

  /** 供消息索引写路径使用：把刚写入 Rust 的行同步进镜像（读与写保持一致） */
  applyMessageWrite(row: Partial<MirrorMessageRow> & { id: string; session_id: string }): void {
    this.messages.applyWrite(row);
  }

  /** 供删除路径使用：把已删除的 id 从镜像移除 */
  applyMessageDelete(sessionId: string, ids: string[]): void {
    this.messages.removeByIds(sessionId, ids);
  }

  /** 供索引裁剪路径使用：把一批消息标成"裁剪隐藏"（行仍在库里，只是不再从索引出） */
  applyMessageTrim(sessionId: string, ids: string[]): void {
    this.messages.applyMessageTrim(sessionId, ids);
  }

  /** 供事件日志使用：把一条追加排队落库（并回传真实 seq 修正镜像） */
  appendEventAsync(
    sessionId: string,
    type: string,
    payload: string,
    timestamp: number,
    placeholderSeq: number,
  ): void {
    const job = call<{ seq?: number; written?: number }>(this.transport, "events.append", {
      session_id: sessionId,
      event_type: type,
      payload: JSON.parse(payload || "{}") as unknown,
      timestamp,
    }).then((r) => {
      const real = Number(r?.seq ?? 0);
      // 用引擎分配的真实 seq 修正镜像里的占位 —— 顺序与数据库保持一致
      if (real > 0) this.events.reconcile(sessionId, placeholderSeq, real);
    });
    this.events.enqueue(job, "events.append", "事件未写入索引（权威副本在会话 JSONL，索引可重建）");
  }

  /** 供事件日志使用：批量追加（单事务，seq 连续） */
  appendEventBatchAsync(
    sessionId: string,
    events: Array<{ type: string; payload: string; timestamp: number; placeholderSeq: number }>,
  ): void {
    const job = call<{ seqs?: number[] }>(this.transport, "events.append_batch", {
      session_id: sessionId,
      events: events.map((e) => ({
        type: e.type,
        payload: JSON.parse(e.payload || "{}") as unknown,
        timestamp: e.timestamp,
      })),
    }).then((r) => {
      const seqs = r?.seqs ?? [];
      events.forEach((e, i) => {
        const real = Number(seqs[i] ?? 0);
        if (real > 0) this.events.reconcile(sessionId, e.placeholderSeq, real);
      });
    });
    this.events.enqueue(job, "events.append_batch", "事件批次未写入索引（权威副本在会话 JSONL，索引可重建）");
  }

  /** 供事件日志使用：压缩（快照占锚点 seq）。这是**写**操作，排队执行 */
  compactEventAsync(
    sessionId: string,
    snapshotSeq: number,
    cutoffSeq: number,
    payload: string,
  ): void {
    const job = call(this.transport, "events.compact", {
      session_id: sessionId,
      snapshot_seq: snapshotSeq,
      cutoff_seq: cutoffSeq,
      payload: JSON.parse(payload || "{}") as unknown,
    }).then(() => undefined);
    this.events.enqueue(job, "events.compact", "事件压缩未写入索引（下次启动会重新读取）");
  }

  /** 供事件日志使用：删除会话事件 */
  deleteEventsAsync(sessionId: string): void {
    const job = call(this.transport, "events.delete_session", { session_id: sessionId }).then(() => undefined);
    this.events.enqueue(job, "events.delete_session", "事件未删除（重启后会重新出现）");
  }
}

/**
 * 能力自省的**真实线协议形状**（A-5，第 20 轮）。
 *
 * ## 原来错在哪
 *
 * `rustCapabilities()` 按**扁平字段**读（`raw.commands` / `raw.max_rows_per_query`），
 * 但 Tauri 命令 `storage_capabilities` 返回的是**裸 `Value`**：
 *
 * ```rust
 * // src-tauri/src/storage.rs
 * #[tauri::command]
 * pub fn storage_capabilities() -> Value { capabilities() }
 * ```
 *
 * 没有 `{ok, result}` 包装（那个包装只属于 `storage_invoke` / `storage_batch` 这条路）。
 * 于是渲染侧读到的 `raw.commands` **恒为 undefined** → `?? []` → **能力集恒空**。
 * 影响不是"少了个诊断字段"：`no_whole_file_export` 这类架构承诺是**契约测试的
 * 判据**（`rust-port.test.ts` 的 PORT-23），它恒为 `false` 时，"引擎承诺不提供
 * 整库导出"这件事在渲染侧**从来没有被真正验证过**。
 *
 * ## 现在怎么读
 *
 * 以**真实形状为准**（裸对象），同时**容忍** `{ok, result}` 包装 —— 不是"猜两种"，
 * 而是因为包装形态在 Tauri 里确实存在（`storage_invoke` 那条路），
 * 将来若有人把这条命令也套上 `reply()`，这里不该静默变空。
 * 两种形状都认不出来时**抛错**，不返回"看起来合法但全空"的结果：
 * 静默给出空能力集正是这个缺陷本身。
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function unwrapCapabilities(raw: unknown): {
  commands?: string[];
  max_rows_per_query?: number;
  no_whole_file_export?: boolean;
} {
  if (!isRecord(raw)) {
    throw new StorageError("OTHER", "storage_capabilities 返回了无法识别的响应（既不是对象也不是包装响应）");
  }
  // 1) 包装形态：{ok:false,...} 是明确的失败，不能当成"没有能力"
  if (typeof raw.ok === "boolean") {
    const reply = raw as unknown as WireReply<Record<string, unknown>>;
    if (!reply.ok) throw toStorageError(reply.error, "storage_capabilities 失败");
    if (isRecord(reply.result)) return reply.result as Record<string, unknown>;
  }
  // 2) 真实形态：裸 Value（`storage.rs::storage_capabilities`）
  return raw as Record<string, unknown>;
}

/** 供测试与诊断：命令清单（Rust 侧白名单） */
export async function rustCapabilities(
  transport: StorageTransport = tauriTransport,
): Promise<{ commands: string[]; max_rows_per_query: number; no_whole_file_export: boolean }> {
  const raw = unwrapCapabilities(await transport.capabilities());
  return {
    commands: Array.isArray(raw.commands) ? (raw.commands as string[]) : [],
    max_rows_per_query: typeof raw.max_rows_per_query === "number" ? raw.max_rows_per_query : 0,
    no_whole_file_export: Boolean(raw.no_whole_file_export),
  };
}

/**
 * **仅测试用**：事件镜像的契约桥（第 47 轮补）。
 *
 * 为什么需要它：`RustEventMirror` 是模块私有的，而本轮修的两个缺陷
 * （"未落库的占位被当成水位"与"加载合并丢掉刚 reconcile 的事件"）**只在这个类里**
 * 能观察到 —— 走整条 `RustStoragePort` 需要真 IPC，而这些是**纯内存时序**问题。
 *
 * 这个桥**只暴露被断言的行为**，不暴露内部字段：
 * - `seedReal` 造一条已落库事件；
 * - `appendLocal` / `reconcile` 复现"追加 → 落库确认"的真实调用序列；
 * - `mergeLoaded` 复现 `loadSession` 的合并那一步；
 * - `latestSeq` / `pendingPlaceholderCount` / `seqs` 是断言出口。
 */
export function __eventMirrorForTests(): {
  seedReal(sessionId: string, seq: number): void;
  appendLocal(sessionId: string, type: string, payload: string, timestamp: number): { seq: number };
  reconcile(sessionId: string, placeholderSeq: number, realSeq: number): void;
  mergeLoaded(sessionId: string, seqs: number[]): void;
  latestSeq(sessionId: string): number;
  pendingPlaceholderCount(sessionId: string): number;
  seqs(sessionId: string): number[];
} {
  const mirror = new RustEventMirror(
    {} as StorageTransport,
    () => {},
  );
  return {
    seedReal: (sessionId, seq) => mirror.__seedPersistedForTests(sessionId, seq),
    appendLocal(sessionId, type, payload, timestamp) {
      const e = mirror.appendLocal(sessionId, type, payload, timestamp);
      return { seq: e.seq };
    },
    reconcile: (sessionId, placeholderSeq, realSeq) => mirror.reconcile(sessionId, placeholderSeq, realSeq),
    mergeLoaded(sessionId, seqs) {
      // 复现 `loadSession` 的合并那一步（分页结果 → merge）
      const loaded = seqs.map((seq) => ({ seq, sessionId, type: "fromDb", payload: "{}", timestamp: 0 }));
      mirror.__mergeForTests(sessionId, loaded);
    },
    latestSeq: (sessionId) => mirror.latestSeq(sessionId),
    pendingPlaceholderCount: (sessionId) => mirror.pendingPlaceholderCount(sessionId),
    seqs: (sessionId) => mirror.readAll(sessionId).map((e) => e.seq),
  };
}

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
    return new StorageError(code, wire.message ?? fallbackMessage, { detail: wire.hint });
  }
  return new StorageError("OTHER", e instanceof Error ? e.message : fallbackMessage);
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

const tauriTransport: StorageTransport = {
  invokeCommand: (command, params) => invoke("storage_invoke", { command, params: params ?? {} }),
  invokeBatch: (commands) => invoke("storage_batch", { commands }),
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
  constructor(private readonly t: StorageTransport) {}

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
    const raw = await call<{ written?: number }>(this.t, command, params);
    return { written: typeof raw?.written === "number" ? raw.written : 1 };
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
      call(this.t, "settings.set", { key, value: text })
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

// ========== 聚合端口 ==========

export class RustStoragePort implements StoragePort {
  readonly kind = "rust" as const;
  readonly engine: RustEnginePort;
  readonly data: RustDataPort;
  readonly config: RustConfigPort;
  readonly append: RustAppendPort;

  constructor(
    transport: StorageTransport = tauriTransport,
    onFailure: (stream: string, e: unknown, note: string) => void = () => {},
  ) {
    this.engine = new RustEnginePort(transport);
    this.data = new RustDataPort(transport);
    this.config = new RustConfigPort(transport, onFailure);
    this.append = new RustAppendPort(transport, onFailure);
  }

  /** 启动顺序：先预热配置（同步读的前提），再报告健康 */
  async start(): Promise<StorageHealth> {
    await this.config.warmup();
    return this.engine.health();
  }

  /** 退出顺序：先排空写队列，再 checkpoint（不是整库导出） */
  async stop(): Promise<void> {
    await this.append.flush();
    await this.config.flush();
    await this.engine.checkpoint();
  }
}

/** 供测试与诊断：命令清单（Rust 侧白名单） */
export async function rustCapabilities(
  transport: StorageTransport = tauriTransport,
): Promise<{ commands: string[]; max_rows_per_query: number; no_whole_file_export: boolean }> {
  const raw = (await transport.capabilities()) as unknown as {
    commands?: string[];
    max_rows_per_query?: number;
    no_whole_file_export?: boolean;
  };
  return {
    commands: raw.commands ?? [],
    max_rows_per_query: raw.max_rows_per_query ?? 0,
    no_whole_file_export: Boolean(raw.no_whole_file_export),
  };
}

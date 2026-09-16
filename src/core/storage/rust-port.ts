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
    const raw = await call<{ written?: number }>(this.t, command, params);
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
    const raw = await call<T>(this.t, command, params);
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
    // 合并：保留本地刚追加但还没被库覆盖的占位事件（否则会丢刚写的事件）
    const local = this.bySession.get(sessionId) ?? [];
    const maxReal = list.length ? list[list.length - 1].seq : 0;
    const pendingLocal = local.filter((e) => e.seq > this.placeholderBase - 1_000_000 && e.seq > maxReal);
    this.bySession.set(sessionId, [...list, ...pendingLocal]);
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

  /** 镜像内的最大 seq（对齐判断与诊断用） */
  latestSeq(sessionId: string): number {
    const list = this.bySession.get(sessionId) ?? [];
    return list.length ? list[list.length - 1].seq : 0;
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
    const evt: MirrorEvent = { seq: placeholder, sessionId, type, payload, timestamp };
    list.push(evt);
    this.bySession.set(sessionId, list);
    return evt;
  }

  /** 用引擎回传的真实 seq 修正镜像里的占位 */
  reconcile(sessionId: string, placeholderSeq: number, realSeq: number): void {
    const list = this.bySession.get(sessionId);
    if (!list) return;
    const found = list.find((e) => e.seq === placeholderSeq);
    if (found) found.seq = realSeq;
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
    };
  }

  list(sessionId: string): MirrorMessageRow[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  byIdLookup(id: string): MirrorMessageRow | undefined {
    return this.byId.get(id);
  }

  hiddenIds(sessionId: string): Set<string> {
    return new Set((this.bySession.get(sessionId) ?? []).filter((m) => m.hidden === 1).map((m) => m.id));
  }

  count(sessionId: string): number {
    return (this.bySession.get(sessionId) ?? []).length;
  }

  /** 本地应用一次写入（让镜像与刚写进 Rust 的索引保持一致） */
  applyWrite(row: Partial<MirrorMessageRow> & { id: string; session_id: string }): void {
    this.touch(row.session_id);
    const list = this.bySession.get(row.session_id);
    const full: MirrorMessageRow = {
      id: row.id,
      session_id: row.session_id,
      role: row.role ?? "user",
      content: row.content ?? "",
      reasoning: row.reasoning ?? null,
      timestamp: row.timestamp ?? Date.now(),
      model: row.model ?? null,
      status: row.status ?? "done",
      hidden: row.hidden ?? 0,
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

export class RustDomainMirror {
  private byTable = new Map<string, Array<Record<string, unknown>>>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private refused = new Set<string>();
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

  /** 同步触发加载（后台进行） */
  ensureLoaded(table: string, onLoaded?: () => void, maxRowsOverride?: number): void {
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

  private async loadTable(table: string, maxRowsOverride?: number): Promise<void> {
    // 每张表可以有更小的上限（例如 notebook_chunks：每行带 Base64 embedding，
    // 5000 行就是几十 MB 的渲染进程内存）。取更严格的那个。
    const cap = maxRowsOverride === undefined ? this.maxRows : Math.min(this.maxRows, maxRowsOverride);
    const rows: Array<Record<string, unknown>> = [];
    let offset = 0;
    for (let round = 0; round < 40; round++) {
      const page = await call<{ items?: Array<Record<string, unknown>>; has_more?: boolean }>(
        this.t,
        "crud.list",
        { table, limit: 1000, offset },
      );
      const items = page?.items ?? [];
      rows.push(...items);
      if (rows.length > cap) {
        // 放弃镜像：这张表比预期大得多，继续镜像会把渲染进程压死
        this.refused.add(table);
        this.onFailure(
          `domain.${table}.too-large`,
          new Error(`表 ${table} 超过镜像上限 ${cap} 行`),
          `表 ${table} 改用旧引擎读取（超出内存镜像上限）`,
        );
        return;
      }
      if (!page?.has_more || items.length === 0) break;
      offset += items.length;
    }
    this.byTable.set(table, rows);
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

  /** 整表替换（清空+重建类操作用，例如按 notebook 重算图谱） */
  replaceTable(table: string, rows: Array<Record<string, unknown>>): void {
    this.byTable.set(table, [...rows]);
    this.loaded.add(table);
    this.refused.delete(table);
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
    this.data = new RustDataPort(transport);
    this.config = new RustConfigPort(transport, onFailure);
    this.append = new RustAppendPort(transport, onFailure);
    this.configDomain = new RustConfigDomainCache(transport, onFailure);
    this.events = new RustEventMirror(transport, onFailure);
    // 预算可注入：契约测试要用小预算来验证"驻留真的有界"（否则得造两万条消息）
    this.messages = new RustMessageMirror(transport, onFailure, opts.messageMirrorBudgetRows);
    this.domains = new RustDomainMirror(transport, onFailure);
  }

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

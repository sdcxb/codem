/**
 * 存储端口（P0，第 92 波）—— SQLite 迁移到 Rust 的**唯一**调用面。
 *
 * ## 为什么需要这一层
 *
 * 现状：渲染进程里有 **159 处** SQL 调用点（`db.exec/run/prepare`），分布在 **30 个文件**里，
 * 全部**同步**，而且直接持有 sql.js 的 WASM 堆。要迁移到 Rust（原生 sqlite3 + WAL 增量落盘），
 * 不能靠"逐个文件改调用"—— 那会 30 次重演同一类 bug。必须先定一个**实现可替换**的端口，
 * 让"换引擎"变成"换实现"。
 *
 * ## 三类形态（按数据形态划分，见 docs/ARCH-SQLITE-TO-RUST.md §2.2）
 *
 * | 形态 | 适用 | 为什么 |
 * |---|---|---|
 * | `StorageDataPort`（异步、分页） | 消息 / 事件 / 附件 / 遥测 / 图谱等**大体量**数据 | 体量大必须分页；调用方本来就在 async 上下文（UI 加载、agentic loop、维护） |
 * | `StorageConfigPort`（**同步读** + 写穿队列） | settings / 快捷键短语等**配置** | 表很小，启动一次性预热到内存；读永远同步。**这是唯一允许的内存镜像，且只放配置、不放语料** |
 * | `StorageAppendPort`（入队） | 事件日志 / 遥测 / 追加日志 | 不需要读回结果；队列保证顺序与合并，失败走统一上报 |
 *
 * ## 硬约束（由 D 类门禁强制，见 tools/audit/scan-storage-boundary.mjs）
 *
 * 1. 渲染侧**不写 SQL**：端口上不出现 SQL 字符串参数，SQL 只存在于 Rust 侧；
 * 2. 渲染侧**不做事务**：`BEGIN/COMMIT` 归 Rust（异步化后跨 await 的事务必然交错）；
 * 3. 渲染侧**不整库导出**：不存在 export/base64 形态的方法；
 * 4. 渲染侧**不缓存语料**：只有配置面允许内存镜像（否则等于把"语料住在渲染进程"请回来）。
 *
 * ## 错误是值（不是进程中毒）
 *
 * 迁移的根本收益之一：原生 SQLite 的内存/锁/IO 问题都是**可处理的返回值**，
 * 而 WASM 陷阱是不可恢复的进程级中毒。因此端口上的错误统一为 `StorageError`，
 * 带机器可读的 `code` 与 `retryable`，调用方据此重试/降级/上报（复用统一失败通道）。
 */

// ========== 错误模型 ==========

/** 结构化存储错误码（Rust 侧映射，渲染侧只读不造） */
export type StorageErrorCode =
  | "BUSY" // 数据库被占用（可重试）
  | "LOCKED" // 锁冲突（可重试）
  | "NOMEM" // 内存/磁盘不足（降级或上报）
  | "CORRUPT" // 库损坏（走索引重建）
  | "IO" // 文件系统错误（可重试）
  | "CONSTRAINT" // 约束冲突（业务处理）
  | "NOT_FOUND" // 目标不存在
  | "UNAVAILABLE" // 引擎未就绪/已关闭（重试或等待）
  | "UNSUPPORTED" // 端口未实现该能力（迁移期）
  | "OTHER";

const RETRYABLE: ReadonlySet<StorageErrorCode> = new Set<StorageErrorCode>(["BUSY", "LOCKED", "IO", "UNAVAILABLE"]);

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly retryable: boolean;
  /** 建议的重试延迟（毫秒，Rust 侧可给） */
  readonly retryAfterMs?: number;
  readonly detail?: unknown;

  constructor(code: StorageErrorCode, message: string, opts: { retryAfterMs?: number; detail?: unknown } = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.retryAfterMs = opts.retryAfterMs;
    this.detail = opts.detail;
  }

  static is(e: unknown): e is StorageError {
    return e instanceof StorageError;
  }
}

// ========== 分页 ==========

/** 分页请求：所有列表读都必须支持分页（禁止"把整张表读进内存"） */
export interface PageRequest {
  /** 偏移（行） */
  offset?: number;
  /** 上限（行）。Rust 侧有硬上限，超过会被夹住 */
  limit?: number;
  /** 排序键（端口只接受白名单值，例如 "timestamp" / "-timestamp"） */
  orderBy?: string;
}

/**
 * 分页结果。
 * `hasMore` 由引擎给（不要靠"返回行数 == limit"猜）。
 */
export interface Page<T> {
  items: T[];
  hasMore: boolean;
  /** 引擎侧游标（可选，用于 keyset 分页） */
  nextCursor?: string;
}

// ========== 引擎生命周期 ==========

export interface StorageHealth {
  /** 引擎种类：迁移期是 "wasm"，切换后是 "rust" */
  engine: "wasm" | "rust";
  ready: boolean;
  /** 库文件路径（诊断用） */
  path?: string;
  /** 页数 × 页大小 */
  sizeBytes?: number;
  /** journal 模式（期望 wal） */
  journalMode?: string;
  /** WAL 文件字节数（诊断用；不是 checkpoint 结果 —— 健康检查保持只读） */
  walSizeBytes?: number;
  /** 最近一次错误的错误码 */
  lastErrorCode?: StorageErrorCode;
  /** 索引里的表/视图数（Rust `Health.tables`） */
  tables?: number;
  /** 全文检索表使用的模块：fts4（老库）/ fts5（新建）/ none */
  ftsModule?: string;
}

export interface StorageEnginePort {
  /** 打开（含 schema 与迁移）。幂等。 */
  open(): Promise<StorageHealth>;
  /** 关闭（迁移/测试用）。 */
  close(): Promise<void>;
  /** 健康与规模（诊断面板与门禁用） */
  health(): Promise<StorageHealth>;
  /**
   * 完整性检查（Rust 侧 `PRAGMA quick_check`）。
   * 用于迁移对账与"崩溃后要不要重建索引"的判断。
   */
  integrityCheck(): Promise<{ ok: boolean; detail?: string }>;
  /** 触发一次 WAL checkpoint（迁移/退出前用；不是整库导出） */
  checkpoint(): Promise<void>;
}

// ========== 数据面（异步 + 分页） ==========

/**
 * 仓储方法命名约定：`<表>_<操作>`（与 tools/audit/storage-inventory.mjs 的归类一致），
 * 例如 `messages_list` / `messages_create` / `settings_get_all`。
 *
 * P1 会把 82 个「表 × 操作」映射成具体方法签名；本文件只定**形态**，
 * 具体方法在 `src/core/storage/port-commands.ts`（P1 生成）里扩展，
 * 以免这里变成又一个手写的大接口。
 */
export interface StorageDataPort {
  /**
   * 通用分页查询入口（迁移期过渡）。
   *
   * ⚠️ 注意：它不接受 SQL —— `command` 是**仓储命令名**（白名单），
   * 参数是结构化对象。这是 D 类门禁的硬要求（禁止裸 SQL over IPC）。
   */
  query<T = unknown>(command: string, params?: Record<string, unknown>, page?: PageRequest): Promise<Page<T>>;

  /** 单写事务内执行一批写命令（顺序保持，全成或全败） */
  write(commands: Array<{ command: string; params?: Record<string, unknown> }>): Promise<{ written: number }>;

  /** 单条写命令（便捷形态） */
  execute(command: string, params?: Record<string, unknown>): Promise<{ written: number }>;
}

// ========== 配置面（同步读 + 写穿） ==========

/**
 * 配置面：**唯一**允许同步读的形态。
 * 预热在启动时一次性完成（`warmup`），读走内存；写先更新内存再入队，失败如实上报。
 */
export interface StorageConfigPort {
  /** 启动预热：把配置表整体读进内存（表很小） */
  warmup(): Promise<number>;
  /** 同步读（未预热时返回 fallback，并记录一次告警） */
  get<T = unknown>(key: string, fallback: T): T;
  /** 写入（内存即时生效 + 入队落库） */
  set(key: string, value: unknown): void;
  /** 删除（内存即时生效 + 入队落库） */
  remove(key: string): void;
  /** 落库失败等异常情况（诊断/测试用） */
  stats(): { warmed: boolean; keys: number; pendingWrites: number; failures: number };
}

// ========== 只追加面（入队） ==========

export interface StorageAppendPort {
  /** 入队一条只追加记录（事件/遥测）；返回是否已入队（背压满时为 false，调用方据此降级） */
  append(stream: string, record: Record<string, unknown>): boolean;
  /** 等待队列排空（退出前 / 测试用） */
  flush(): Promise<void>;
  /** 队列状态（诊断/测试用） */
  stats(): { pending: number; dropped: number; failures: number };
}

// ========== 聚合端口 ==========

export interface StoragePort {
  engine: StorageEnginePort;
  data: StorageDataPort;
  config: StorageConfigPort;
  append: StorageAppendPort;
  /** 端口实现标识（迁移期是 "wasm"，切换后是 "rust"） */
  readonly kind: "wasm" | "rust";
}

// ========== 注册表（只有一个实现：Rust 端口） ==========
//
// 第 18 轮：原来的"回滚开关键名" `STORAGE_ENGINE_KEY` 已删除 —— 开关退役（第 15 轮）之后
// 它只剩"清理历史 localStorage 键"这一个用途，而那件事在 `settings` 的启动清理里按字符串直接做。
// 留着一个名叫"引擎开关"的常量，只会让人以为还有开关可拨。

let current: StoragePort | null = null;

/**
 * 端口注册计数（诊断用，第 34 轮）。
 *
 * 为什么要计这个：真机排查时出现了"仪器都装好了、日志通道也确认可用，
 * 但删除就是不经过它们"的僵局。剩下最可能的解释是**注册了不止一个端口实例** ——
 * 那么某些模块拿到的端口与我装仪器的那个不是同一个对象。
 * 计数暴露在 `globalThis.__codemStoragePorts` 上，一次真机读取即可证伪或证实。
 */
let registrationCount = 0;

export function setStoragePort(port: StoragePort | null): void {
  current = port;
  if (port) {
    registrationCount++;
    try {
      (globalThis as unknown as Record<string, unknown>).__codemStoragePorts = registrationCount;
    } catch {
      /* 诊断失败不影响功能 */
    }
  }
}

export function getStoragePort(): StoragePort {
  if (!current) {
    throw new StorageError(
      "UNAVAILABLE",
      "存储端口尚未注册（迁移期：请先 initializeStoragePort()；P3 完成后由启动流程注册 rust 实现）",
    );
  }
  return current;
}

export function hasStoragePort(): boolean {
  return current !== null;
}

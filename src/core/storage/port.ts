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
  /**
   * 是否值得重试。
   *
   * ## 为什么允许线协议**覆盖**本地表（第 45 轮线协议审计 P2-5）
   *
   * 引擎的错误体里**本来就带 `retryable`**（`error.rs` 的 `DbError.retryable`，
   * `storage.rs` 原样转发），而渲染侧此前把它**丢掉**、只用下面这张本地表按 `code` 重算。
   * 两边一旦不一致（例如引擎把某类 `IO` 判成不可重试，或反过来把某类 `OTHER` 判成可重试），
   * 表现是"渲染侧一直在重试一个引擎已经明确说别重试的失败"——**引擎的判断必须优先**，
   * 因为只有它知道那一刻的真实原因（`retryable` 是它算出来的，不是从 code 推出来的）。
   *
   * 线协议没带这个字段时（老的假传输、手搓错误）回落到本地表 —— 保持既有语义不变。
   */
  readonly retryable: boolean;
  /**
   * 建议的重试延迟（毫秒）。
   *
   * ⚠️ **当前没有生产者**：`storage.rs` 的错误体只有 `{code, message, retryable, hint}`，
   * 不含这个字段。`callWithRetry` 会消费它（并夹到 `RETRY_AFTER_CAP_MS`），所以一旦引擎开始
   * 提供（例如按 `busy_timeout` 算出更准的退避），渲染侧立刻就能用上 ——
   * 在那之前这条分支是**待接线**状态，不是"活的机制"。写在这里是为了不让下一个人
   * 以为"引擎已经会给建议延迟了"。
   */
  readonly retryAfterMs?: number;
  readonly detail?: unknown;

  constructor(
    code: StorageErrorCode,
    message: string,
    opts: { retryAfterMs?: number; detail?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
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
  /**
   * 引擎种类。**第 19 轮起只剩 `"rust"` 这一个值** —— 旧引擎（sql.js/WASM）已整体删除，
   * 这里再留 `"wasm"` 只会让类型"说谎"：读代码的人会以为还存在第二种实现。
   */
  engine: "rust";
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

  /**
   * 执行命令并返回**完整的结构化结果**（与 `execute` 的区别只在返回值的整形）。
   *
   * ## 为什么类型上标成可选（第 45 轮补上这一条）
   *
   * 真实端口（`rust-port.ts::RustDataPort.command`）与假端口都提供它，生产代码也一直在用 ——
   * 但**接口上从来没写**，于是调用点只能写成
   * `posrt.data as unknown as { command?: … }`（`self-heal` / `session-log-bridge` /
   * `bootstrap` 里各有几处这种强制转换）。那些转换是"类型撒谎"的常见来源：
   * 一旦某个端口实现不再提供它，`as unknown as` 不会报错，只会在运行时变成
   * "读不到字段 → `?? 0` 兜底"的静默假成功。
   *
   * 标成**可选**而不是必需，是因为它确实不是所有实现都有（测试双可能只实现
   * `query` / `write` / `execute`），调用方必须显式处理"没有这个能力"这一态 ——
   * 而 `?.` 正好把这件事写在脸上。
   */
  command?<T = Record<string, unknown>>(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
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
  /**
   * 端口实现标识。**第 19 轮起收成字面量 `"rust"`**（不再是 `"wasm" | "rust"`）。
   *
   * 为什么必须收：`RustStoragePort` 是**唯一**实现，所以 `kind` 是常量 ——
   * 任何形如 `port.kind !== "rust"` 的判断都**恒不成立**，它们读起来却像"还有另一条路"
   * （那是删旧引擎时留下的最后一批幻影分支，已在第 19 轮全部删除）。
   *
   * 现在"没有可用存储"的**唯一**形态是**端口未注册**，判据只有 `hasStoragePort()`。
   * 留着这个字段不是为了让调用方分支，而是诊断用（日志/健康面板要能打印实现标识）。
   */
  readonly kind: "rust";
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

/**
 * 端口注册/注销的订阅者（第 45 轮 D-17）。
 *
 * 为什么需要：有些模块必须在"配置面可读"之后**立刻**校正自己缓存的首屏预测值
 * （典型：皮肤镜像 `codem-skin-cache` → `ThemeManager.resyncFromStorage()`）。
 * 端口注册发生在 `App.tsx` 首个 effect 里的 `await registerRustStoragePort()`，
 * 没有事件可听；轮询或"等下一次用户操作"都不成立。
 * 这里的回调是**同步**调用的，且注册那一刻内存镜像已经预热完毕
 * （`RustStoragePort.start()` 先 `await config.warmup()` 再 `setStoragePort(port)`），
 * 所以订阅者可以立即同步读到真值。
 */
type StoragePortListener = (port: StoragePort | null) => void;
const portListeners = new Set<StoragePortListener>();

/**
 * 订阅端口注册/注销。返回取消订阅函数。
 * 注册时**不会**立即回调 —— 需要"当下同步一次"的调用方自行判 `hasStoragePort()`。
 */
export function setStoragePortListener(listener: StoragePortListener): () => void {
  portListeners.add(listener);
  return () => {
    portListeners.delete(listener);
  };
}

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
  // 逐个隔离：一个订阅者抛错不能让别的订阅者（以及其他启动流程）看不到这次注册
  for (const listener of portListeners) {
    try {
      listener(port);
    } catch (e) {
      console.warn('[storage/port] 端口订阅者失败', e);
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

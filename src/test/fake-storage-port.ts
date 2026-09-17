/**
 * 纯内存存储端口（测试基座，P5 第 10 段）
 *
 * ## 为什么需要它
 *
 * 删掉 L3 回退分支（22 个模块、约 150 个 `getDatabase()`）的前置条件是：
 * **测试必须跑在端口上**，而不是跑在即将被删掉的旧引擎路径上。
 *
 * 否则会出现最坏的一种情况：测试全绿，但它们验证的是我们马上就要删掉的那条路，
 * 而生产走的是端口那条路 —— 这是"假传输掩盖真实契约"在存储层的版本。
 *
 * 第一版（只实现通用域 + 配置 + 只追加）跑全量套件的结果：**29 个文件 / 194 个用例失败**。
 * 而且它不是噪声 —— 失败集中在消息链路上，指向一个**真实的生产读写分裂**：
 * `createMessage` 把索引写发往 Rust，`getMessage` 却只读旧库。已修（见 message.ts）。
 * 这正是这个基座的价值：它逼出了回退分支一直在掩盖的东西。
 *
 * ## 它不是什么
 *
 * - **不是** wire 契约的替身：Rust 侧真实契约由 `cargo test` 的契约测试 + 真机验证守住。
 * - **不是**"让测试变绿"的开关：写穿失败会真抛、镜像未加载会如实 `isLoaded=false`，
 *   所以路由层与上报层的 bug 照样暴露。
 */

import type {
  Page,
  PageRequest,
  StorageAppendPort,
  StorageConfigPort,
  StorageEnginePort,
  StorageHealth,
  StoragePort,
  StorageDataPort,
} from "../core/storage/port";

type Row = Record<string, unknown>;

/** 深拷贝一行，避免测试之间通过引用串味（真实端口的行总是新对象） */
function cloneRow<T>(row: T): T {
  if (row === null || typeof row !== "object") return row;
  return JSON.parse(JSON.stringify(row)) as T;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

/** 主键列名（upsert / delete 用） */
function primaryKeyOf(table: string): string {
  if (table === "settings") return "key";
  if (table === "recovery_data") return "session_id";
  if (table === "cost_records") return "id";
  if (table === "session_events") return "seq";
  return "id";
}

export interface FakeStoragePortOptions {
  /** 预置表数据（`表名 → 行数组`） */
  seed?: Record<string, Row[]>;
  /** 模拟落库失败（验证"写穿失败必须如实上报"的反向用例） */
  failWrites?: boolean;
  /**
   * 端口标识（默认 `"rust"`）。
   *
   * 设为 `"wasm"` 用来模拟**回滚开关切到旧引擎**的形态：此时读/写路径应走旧库。
   */
  kind?: "rust" | "wasm";
  /**
   * 这些表**永不就绪**：`isReady` 恒为 false。
   *
   * 用来模拟"端口在、但镜像没就绪"（加载中 / 超上限被拒 / LRU 逐出 / 被截断）——
   * 也就是 B0-1 里的 **B 态**。它是"必须由端口接手、不能回退旧库"那条规则的反向用例载体。
   */
  neverReady?: string[];
  /**
   * 配置面扩展域是否已预热（默认 `true`）。
   *
   * 真实端口 `RustDataPort.configDomain` 在 `open()` 里 `warmup()` 一次，之后 `read()`
   * 永远命中快照；未预热时 `read()` 返回 fallback 并留痕。设为 `false` 用来覆盖
   * "端口在、配置面还没预热"那条路径（`settings.ts` 的扩展域据此返回默认值）。
   */
  configWarmed?: boolean;
  /**
   * "旧库里有多少条消息" —— 只用于 `migration.auto` 的测试双语义
   * （`self-heal` 的判据要求"旧库确有可恢复内容"才会恢复）。
   */
  legacyMessageRows?: number;
}

export interface FakeStoragePort extends StoragePort {
  /** 直接读某张表的原始行（断言用） */
  __table(name: string): Row[];
  /** 端口记录到的落库失败次数 */
  __writeFailures(): number;
  /** 端口累计落库的写命令（断言"确实写穿了"，而不是只改了内存） */
  __writes(): Array<{ command: string; params?: Record<string, unknown> }>;
}

export function createFakeStoragePort(opts: FakeStoragePortOptions = {}): FakeStoragePort {
  // ===== 单一事实来源：按表存行 =====
  const tables = new Map<string, Row[]>();
  for (const [name, rows] of Object.entries(opts.seed ?? {})) {
    tables.set(name, rows.map(cloneRow));
  }
  const table = (name: string): Row[] => {
    let t = tables.get(name);
    if (!t) {
      t = [];
      tables.set(name, t);
    }
    return t;
  };

  const writeLog: Array<{ command: string; params?: Record<string, unknown> }> = [];
  let writeFailures = 0;
  /** 全局事件 seq 水位（真实侧是 AUTOINCREMENT，这里用一个单调计数器等价替代） */
  let eventSeqWatermark = 0;
  const reportFakeFailure = (scope: string, e: unknown) => {
    writeFailures += 1;
    // 与产品一致：失败**不静默**（B 类假成功的反面），但也不打断调用方
    console.warn(`[fake-storage-port] ${scope} 落库失败：`, e);
  };

  /** 落库（写穿目标）：这里就是内存表本身 */
  function persist(command: string, params?: Record<string, unknown>): number {
    writeLog.push({ command, params });
    if (opts.failWrites) {
      writeFailures += 1;
      throw new Error(`fake-port: 落库失败（${command}）`);
    }
    if (command === "crud.upsert") {
      const name = String(params?.table ?? "");
      const rows = (params?.rows as Row[] | undefined) ?? [];
      const replace = params?.mode === "replace";
      const pk = String(params?.primaryKey ?? primaryKeyOf(name));
      const target = table(name);
      for (const row of rows) {
        const idx = target.findIndex((r) => r[pk] === row[pk]);
        if (idx >= 0) target[idx] = replace ? cloneRow(row) : { ...target[idx], ...cloneRow(row) };
        else target.push(cloneRow(row));
      }
      return rows.length;
    }
    if (command === "crud.delete") {
      const name = String(params?.table ?? "");
      const where = (params?.where as Record<string, unknown> | undefined) ?? {};
      const kept = table(name).filter((r) => !matches(r, where));
      const removed = table(name).length - kept.length;
      tables.set(name, kept);
      return removed;
    }
    if (command === "crud.replace_table") {
      const name = String(params?.table ?? "");
      const rows = (params?.rows as Row[] | undefined) ?? [];
      tables.set(name, rows.map(cloneRow));
      return rows.length;
    }
    /**
     * 索引写命令：真实 Rust 侧是单事务复合命令（主行 + 两个 JSON 列 + 整批替换 tool_calls）。
     * 这里按同一语义落到内存表：`messages` 存主行，`tool_calls` 整批替换。
     */
    if (command === "messages.upsert_index") {
      const p = (params ?? {}) as Row;
      const id = String(p.id ?? "");
      if (!id) throw new Error("fake-port: messages.upsert_index 缺少 id");
      const target = table("messages");
      const idx = target.findIndex((r) => r.id === id);
      const base = idx >= 0 ? target[idx] : {};
      const merged: Row = {
        ...base,
        id,
        session_id: String(p.session_id ?? base.session_id ?? ""),
        role: String(p.role ?? base.role ?? "user"),
        content: String(p.content ?? ""),
        reasoning: p.reasoning ?? null,
        timestamp: Number(p.timestamp ?? Date.now()),
        model: p.model ?? null,
        status: p.status ?? "done",
        hidden: Number(p.hidden ?? base.hidden ?? 0),
        generated_files: p.generated_files ?? null,
        retrieved_sources: p.retrieved_sources ?? null,
      };
      if (idx >= 0) target[idx] = merged;
      else target.push(merged);

      const calls = p.tool_calls as Row[] | undefined | null;
      if (calls !== undefined) {
        // null/undefined = 不动；数组 = 整批替换（与 Rust 侧一致）
        const kept = table("tool_calls").filter((r) => r.message_id !== id);
        tables.set("tool_calls", kept);
        if (Array.isArray(calls)) {
          for (const c of calls) table("tool_calls").push({ ...cloneRow(c), message_id: id });
        }
      }
      return 1;
    }
    if (command === "messages.delete") {
      /*
       * 软删除（压缩走这条）：把 `hidden` 置 1。
       *
       * 为什么假端口必须实现它（第 39 轮）：Rust 侧 `messages_delete` 支持 `soft: true`，
       * 而假端口早先对这条命令**什么都不做** → 镜像里那些行仍是 `hidden=0` →
       * 读路径照常返回它们 → 一批"压缩后不该复活"的用例**假绿**
       * （掩盖了真实端口上的行为）。测试双不得比实现更宽松。
       *
       * `soft` 未给或为 false 时按硬删除（与 Rust 侧默认一致）。
       */
      const ids = (params?.ids as string[] | undefined) ?? [];
      const soft = params?.soft === true;
      const target = table("messages");
      let n = 0;
      for (const id of ids) {
        const idx = target.findIndex((r) => r.id === id);
        if (idx < 0) continue;
        if (soft) target[idx] = { ...target[idx], hidden: 1 };
        else target.splice(idx, 1);
        n++;
      }
      return n;
    }
    if (command === "messages.rebuild_index") {
      const p = (params ?? {}) as Row;
      const rows = (p.rows as Row[] | undefined) ?? [];
      const name = "messages";
      const target = table(name);
      const pk = "id";
      for (const row of rows) {
        const idx = target.findIndex((r) => r[pk] === row[pk]);
        /*
         * ⚠️ 必须**保留已有的 hidden**（第 40 轮修正）。
         *
         * Rust 侧 `messages_rebuild_index` 只把日志里的字段写回去，不会重置软删除状态；
         * 而日志本身**没有 hidden 语义**。早先这里直接用 `cloneRow(row)` **整行替换**，
         * 等于把 `hidden=1` 悄悄改回 0 —— 于是"压缩后重启又复活"
         * （CB-8/CB-9 那两个用例抓的就是这个）。
         */
        const hidden = idx >= 0 ? Number(target[idx].hidden ?? 0) : Number(row.hidden ?? 0);
        if (idx >= 0) target[idx] = { ...cloneRow(row), hidden };
        else target.push({ ...cloneRow(row), hidden });
      }
      return rows.length;
    }
    if (command === "crud.delete_where") {
      const name = String(params?.table ?? "");
      const where = (params?.where as Record<string, unknown> | undefined) ?? {};
      const before = table(name).length;
      tables.set(name, table(name).filter((r) => !matches(r, where)));
      return before - table(name).length;
    }
    return 0;
  }

  // ===== 会话作用域镜像（messages / events / domains 共用这套语义）=====
  /**
   * 真实端口的"会话镜像"语义（`rust-port.ts` 的 `RustMessageMirror` / `RustEventMirror` /
   * `RustDomainMirror` 是同一个骨架）：
   * - `ensureLoaded(sid)` 触发异步拉取，拉到之前 `isLoaded=false` → 调用方继续走旧路径；
   * - 写入时 `applyWrite` 让镜像与刚写进 Rust 的行一致（避免"写完读不到"）。
   *
   * 内存端口里数据本来就在内存，所以这里**立即就绪** —— 语义等价于"Rust 已经持有这份数据"。
   */
  function sessionMirror(scope: string, sessionColumn: string) {
    const loaded = new Set<string>();
    let truncated = false;
    const rowsFor = (sid: string): Row[] => table(scope).filter((r) => r[sessionColumn] === sid);
    return {
      isLoaded: (sid: string) => loaded.has(sid),
      isTruncated: () => truncated,
      ensureLoaded: (sid: string, onLoaded?: () => void) => {
        loaded.add(sid);
        onLoaded?.();
      },
      list: (sid: string) => rowsFor(sid).map(cloneRow),
      count: (sid: string) => rowsFor(sid).length,
      byIdLookup: (id: string) => {
        const hit = table(scope).find((r) => r.id === id);
        return hit ? (cloneRow(hit) as any) : undefined;
      },
      hiddenIds: (sid: string) => new Set(rowsFor(sid).filter((r) => Number(r.hidden ?? 0) === 1).map((r) => String(r.id))),
      applyWrite: (row: Row) => {
        const pk = primaryKeyOf(scope);
        const target = table(scope);
        const idx = target.findIndex((r) => r[pk] === row[pk]);
        if (idx >= 0) target[idx] = { ...target[idx], ...cloneRow(row) };
        else target.push(cloneRow(row));
        /*
         * ⚠️ **不要**在这里把会话标记为已加载（第 39 轮修正）。
         *
         * 真实端口（`RustMessageMirror.applyWrite`）只把行写进 `byId`，
         * 并**不**把会话加入 `loaded` —— "已加载"只由 `loadSession` 完成时设置。
         * 假端口早先顺手 `loaded.add(...)`，等于谎报"这个会话的镜像已完整"，
         * 于是 `isLoaded` 撒谎 → 读路径基于不完整集合做 hidden 判定，
         * 掩盖了"会话尚未加载"这一真实状态，让一批压缩用例假绿。
         * 这里只写行：与真实端口保持一致（测试双不得比实现更宽松）。
         */
      },
      removeByIds: (sid: string, ids: string[]) => {
        const set = new Set(ids);
        tables.set(
          scope,
          table(scope).filter((r) => !set.has(String(r.id))),
        );
      },
      /** 供 `applyMessageWrite` / `applyEventWrite` 这类按行同步的入口使用 */
      __markLoaded: (sid: string) => loaded.add(sid),
      __setTruncated: (v: boolean) => {
        truncated = v;
      },
    };
  }

  const messages = sessionMirror("messages", "session_id");
  const eventsBase = sessionMirror("session_events", "session_id");

  /**
   * 事件镜像（对齐 `rust-port.ts` 的 `RustEventMirror`）。
   *
   * 它比消息镜像多三件事，缺了任何一件 `EventLog` 就会在运行时炸
   * （这正是第一版基座漏掉的：端口只暴露了 `ensureLoaded`，产品探测到 `events`
   * 存在就整体切过来，然后在 `readAll` / `appendLocal` 上抛 TypeError）：
   * - `readAll` / `readFrom` / `readRange` / `latestSeq`（事件是按 seq 区间读的）；
   * - `appendLocal`：**本地占位 seq**（真实 seq 是全局 AUTOINCREMENT，本地预知不了），
   *   先给一个远大于真实水位的占位保证镜像内相对顺序，落库后由引擎回传真实 seq 修正；
   * - `replaceSession`：整会话重放（快照压缩用）。
   */
  /**
   * 事件行的真实列名是 `event_type`（不是 `type`）、主键是 `seq`（不是 `id`）——
   * 这里必须按**真实列名**映射，否则镜像读出来的 `type` 全是空串，
   * 于是 `session_meta` 保不住、`session_snapshot` 也认不出来。
   */
  const asEvent = (r: Row) => ({
    seq: Number(r.seq ?? 0),
    sessionId: String(r.session_id ?? r.sessionId ?? ""),
    type: String(r.event_type ?? r.type ?? ""),
    payload: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload ?? {}),
    timestamp: Number(r.timestamp ?? 0),
  });
  const eventRows = (sid: string) => table("session_events").filter((r) => r.session_id === sid);
  const eventsSorted = (sid: string) => eventRows(sid).map(asEvent).sort((a, b) => a.seq - b.seq);

  const events = {
    isLoaded: eventsBase.isLoaded,
    isTruncated: eventsBase.isTruncated,
    ensureLoaded: eventsBase.ensureLoaded,
    count: (sid: string) => eventsSorted(sid).length,
    readAll: (sid: string) => eventsSorted(sid),
    readFrom: (sid: string, from: number) => eventsSorted(sid).filter((e) => e.seq >= from),
    readRange: (sid: string, from: number, to: number) =>
      eventsSorted(sid).filter((e) => e.seq >= from && e.seq <= to),
    latestSeq: (sid: string) => {
      const list = eventsSorted(sid);
      return list.length ? list[list.length - 1].seq : 0;
    },
    sessions: () => [...new Set(table("session_events").map((r) => String(r.session_id ?? "")))],
    appendLocal: (sid: string, type: string, payload: string, timestamp: number) => {
      /**
       * ⚠️ 与真实端口的**唯一刻意差异**：这里直接分配**真实的、从 1 递增的 seq**，
       * 而不是 `MAX_SAFE_INTEGER` 附近的占位值。
       *
       * 理由：真实端口的占位是"IPC 往返期间同步返回"的无奈之举（`seq` 是全局
       * AUTOINCREMENT，本地预知不了），测试环境里这个往返是同步完成的，没有窗口 ——
       * 用占位值只会让"seq 从 1 连续递增"这类断言失去意义（断言变成在验证占位机制）。
       * 落库时 `appendEventAsync` 会拿同一个 seq 对账，语义等价。
       */
      const list = eventsSorted(sid);
      const last = list.length ? list[list.length - 1].seq : 0;
      const seq = last + 1;
      table("session_events").push({
        seq,
        session_id: sid,
        event_type: type,
        payload,
        timestamp,
      });
      eventsBase.__markLoaded(sid);
      return { seq };
    },
    reconcile: (sid: string, placeholderSeq: number, realSeq: number) => {
      const hit = table("session_events").find(
        (r) => r.session_id === sid && Number(r.seq) === placeholderSeq,
      );
      if (hit) hit.seq = realSeq;
    },
    replaceSession: (sid: string, list: Array<Row>) => {
      tables.set(
        "session_events",
        table("session_events").filter((r) => r.session_id !== sid),
      );
      for (const e of list) {
        table("session_events").push({
          seq: Number(e.seq ?? 0),
          session_id: String(e.sessionId ?? e.session_id ?? sid),
          event_type: String(e.event_type ?? e.type ?? ""),
          payload: typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload ?? {}),
          timestamp: Number(e.timestamp ?? 0),
        });
      }
      eventsBase.__markLoaded(sid);
    },
  };

  // ===== 配置面（同步读 + 写穿）=====
  const configMemory = new Map<string, unknown>();
  let configWarmed = false;
  let pendingWrites = 0;
  let configFailures = 0;

  const config: StorageConfigPort = {
    async warmup() {
      configMemory.clear();
      for (const row of table("settings")) configMemory.set(String(row.key), row.value);
      configWarmed = true;
      return configMemory.size;
    },
    get<T>(key: string, fallback: T): T {
      if (!configMemory.has(key)) return fallback;
      return configMemory.get(key) as T;
    },
    set(key: string, value: unknown) {
      configMemory.set(key, value);
      pendingWrites += 1;
      try {
        persist("crud.upsert", {
          table: "settings",
          mode: "replace",
          primaryKey: "key",
          rows: [{ key, value, updated_at: Date.now() }],
        });
      } catch (e) {
        configFailures += 1;
        throw e;
      } finally {
        pendingWrites -= 1;
      }
    },
    remove(key: string) {
      configMemory.delete(key);
      pendingWrites += 1;
      try {
        persist("crud.delete", { table: "settings", where: { key } });
      } catch (e) {
        configFailures += 1;
        throw e;
      } finally {
        pendingWrites -= 1;
      }
    },
    stats() {
      return { warmed: configWarmed, keys: configMemory.size, pendingWrites, failures: configFailures };
    },
  };

  // ===== 只追加面 =====
  const appendStats = { pending: 0, dropped: 0, failures: 0 };
  const append: StorageAppendPort = {
    append(stream: string, record: Record<string, unknown>) {
      try {
        persist("append", { stream, record });
        table(stream).push(cloneRow(record));
        return true;
      } catch {
        appendStats.failures += 1;
        return false;
      }
    },
    async flush() {
      appendStats.pending = 0;
    },
    stats() {
      return { ...appendStats };
    },
  };

  // ===== 数据面 =====
  const data: StorageDataPort = {
    async query<T>(command: string, params?: Record<string, unknown>, page?: PageRequest): Promise<Page<T>> {
      const name = String(params?.table ?? command.split("_")[0] ?? "");
      let rows = table(name).map(cloneRow) as T[];
      const where = params?.where as Record<string, unknown> | undefined;
      if (where) rows = rows.filter((r) => matches(r as Row, where)) as T[];
      const total = rows.length;
      const limit = page?.limit ?? total;
      const offset = page?.offset ?? 0;
      return { items: rows.slice(offset, offset + limit), total, limit, offset };
    },
    async write(commands) {
      let written = 0;
      for (const c of commands) written += persist(c.command, c.params);
      return { written };
    },
    async execute(command: string, params?: Record<string, unknown>) {
      return { written: persist(command, params) };
    },
    /**
     * **结构化命令**（与真实 `RustDataPort.command` 对应）。
     *
     * 假端口早先没有这个方法 —— 而产品代码里
     * `self-heal.ts` / `bootstrap.ts` / `session-log-bridge.ts` 都用它读**结构化结果**
     * （`crud.count` 的行数、`migration.auto` 的 per_table）。
     * 缺了它，那些调用在测试里只会走"能力缺失 → 返回 null"的分支，
     * 于是"自检判据"这条最关键的逻辑**在测试基座里从来没有被真正执行过**。
     */
    async command<T = Record<string, unknown>>(command: string, params?: Record<string, unknown>): Promise<T> {
      writeLog.push({ command, params });
      if (command === "crud.count") {
        const name = String(params?.table ?? "");
        return { count: table(name).length, table: name } as unknown as T;
      }
      /**
       * `migration.auto`：测试双按"从旧库搬 N 条消息"的等价语义实现 ——
       * `dry_run` 只报数（旧库探测），真跑则把 N 行写进 messages 表
       * （真实侧是整库重灌；这里只需要"搬运后行数变了"这个可观测效果）。
       */
      if (command === "migration.auto") {
        const legacyMessages = opts.legacyMessageRows ?? 0;
        if (params?.dry_run === true) {
          return { dry_run: true, per_table: [{ table: "messages", rows: legacyMessages }] } as unknown as T;
        }
        if (legacyMessages > 0) {
          const target = table("messages");
          for (let i = 0; i < legacyMessages; i++) {
            const id = `legacy-${i}`;
            if (!target.some((r) => r.id === id)) {
              target.push({ id, session_id: "legacy-session", role: "user", content: "旧库内容", timestamp: i, hidden: 0 });
            }
          }
        }
        return {
          migrated: true,
          tables: 1,
          rows: legacyMessages,
          total_rows: legacyMessages,
          per_table: [{ table: "messages", rows: legacyMessages }],
        } as unknown as T;
      }
      throw new Error(`fake-port: 未实现的命令 ${command}（测试双不得比实现更宽松）`);
    },
  };

  // ===== 通用域镜像（`domainPort` 只认 rust，且要求 domains.ensureLoaded 存在）=====
  const ready = new Set<string>();
  /** 永不就绪的表（B 态载体）：见 FakeStoragePortOptions.neverReady */
  const neverReady = new Set(opts.neverReady ?? []);
  const domains = {
    isReady: (name: string) => ready.has(name) && !neverReady.has(name),
    ensureLoaded: (name: string, onLoaded?: () => void) => {
      ready.add(name);
      onLoaded?.();
    },
    all<R>(name: string): R[] {
      return table(name).map(cloneRow) as R[];
    },
    find<R>(name: string, where: Record<string, unknown>): R[] {
      return table(name)
        .filter((r) => matches(r, where))
        .map(cloneRow) as R[];
    },
    findOne<R>(name: string, where: Record<string, unknown>): R | null {
      const hit = table(name).find((r) => matches(r, where));
      return hit ? (cloneRow(hit) as R) : null;
    },
    count: (name: string) => table(name).length,
    applyWrite(name: string, row: Row, primaryKey = primaryKeyOf(name)) {
      const target = table(name);
      const idx = target.findIndex((r) => r[primaryKey] === row[primaryKey]);
      if (idx >= 0) target[idx] = { ...target[idx], ...cloneRow(row) };
      else target.push(cloneRow(row));
      ready.add(name);
    },
    applyWriteMany(name: string, rows: Row[], primaryKey = primaryKeyOf(name)) {
      for (const row of rows) domains.applyWrite(name, row, primaryKey);
    },
    applyDelete(name: string, where: Record<string, unknown>) {
      tables.set(
        name,
        table(name).filter((r) => !matches(r, where)),
      );
    },
    applyDeleteWhere(name: string, match: (row: Row) => boolean) {
      const before = table(name).length;
      tables.set(
        name,
        table(name).filter((r) => !match(r)),
      );
      return before - table(name).length;
    },
    replaceTable(name: string, rows: Row[]) {
      tables.set(name, rows.map(cloneRow));
      ready.add(name);
    },
  };

  // ===== 配置面扩展域（quick_phrases / mcp_servers / memory）=====
  //
  // 真实端口（`RustDataPort.configDomain`）在 `open()` 时 `warmup()` 一次，
  // 之后 `read()` 永远从快照取值、`patch()` 只改快照（落库靠 `writeThrough` 的命令）。
  //
  // 这里等价映射到内存表：**read 直接按表拼快照**（而不是在 warmup 时拷贝一份），
  // 这样"测试先往表里塞数据、再调 loadXxx"的既有写法仍然成立 ——
  // 快照式拷贝会让那一类用例突然读不到东西（那是测试基座的偏差，不是产品行为）。
  type ConfigSnapshotLike = { quickPhrases: Row[]; mcpServers: Row[]; memory: string };
  let configDomainWarmed = opts.configWarmed ?? true;
  const configSnapshots: Array<Partial<ConfigSnapshotLike>> = [];
  const readConfigSnapshot = (): ConfigSnapshotLike => {
    const fromPatches = Object.assign({}, ...configSnapshots) as Partial<ConfigSnapshotLike>;
    return {
      quickPhrases: (fromPatches.quickPhrases ?? table("quick_phrases")).map(cloneRow),
      mcpServers: (fromPatches.mcpServers ?? table("mcp_servers")).map(cloneRow),
      memory:
        fromPatches.memory ??
        String((table("memory").find((r) => r.id === "default") ?? {}).content ?? ""),
    };
  };
  const configDomain = {
    isWarmed: () => configDomainWarmed,
    async warmup(): Promise<ConfigSnapshotLike> {
      configDomainWarmed = true;
      return readConfigSnapshot();
    },
    read<T>(pick: (s: ConfigSnapshotLike) => T, fallback: T, scope: string): T {
      if (!configDomainWarmed) {
        reportFakeFailure(scope, new Error("配置面尚未预热"));
        return fallback;
      }
      try {
        return pick(readConfigSnapshot());
      } catch (e) {
        reportFakeFailure(scope, e);
        return fallback;
      }
    },
    /** 与真实端口一致：只改镜像；落库由调用方的 `writeThrough` 负责 */
    patch(patch: Partial<ConfigSnapshotLike>): void {
      configSnapshots.push(patch);
    },
    stats() {
      const s = readConfigSnapshot();
      return {
        warmed: configDomainWarmed,
        quickPhrases: s.quickPhrases.length,
        mcpServers: s.mcpServers.length,
        memoryBytes: s.memory.length,
        failures: writeFailures,
      };
    },
    bumpFailure() {
      writeFailures += 1;
    },
  };

  // ===== 引擎面 =====
  const health = (): StorageHealth =>
    ({ ok: true, tables: tables.size, engine: "rust", ftsModule: "fts5" }) as StorageHealth;
  const engine: StorageEnginePort = {
    async open() {
      return health();
    },
    async close() {
      /* 内存端口无资源可释放 */
    },
    async health() {
      return health();
    },
    async integrityCheck() {
      return { ok: true, detail: "fake-port" };
    },
    async checkpoint() {
      /* 无 WAL */
    },
  };

  return {
    kind: opts.kind ?? "rust",
    engine,
    data,
    config,
    append,
    // 下面这些不在 `StoragePort` 声明里（迁移期扩展能力），但产品代码会运行时探测它们。
    // 探测不到时产品会"继续走旧库"—— 那正是这套删除工作要消灭的分支，所以这里必须如实提供。
    ...({
      domains,
      messages,
      events,
      configDomain,
      applyMessageWrite: (row: Row) => messages.applyWrite(row),
      applyMessageDelete: (sid: string, ids: string[]) => messages.removeByIds(sid, ids),
      appendEventAsync: (sid: string, type: string, payload: string, timestamp: number, placeholderSeq: number) => {
        try {
          /**
           * ⚠️ 落库用的 seq **必须就是 `appendLocal` 已分配的那个**。
           *
           * 这里起初另取了一个流水号，然后 `reconcile` 把镜像行从 `placeholderSeq` 改到它 ——
           * 而那个流水号在**另一个会话**里可能已被占用，于是两条行挤到同一个 seq 上，
           * 读出来就少了一条（实测症状：压缩后 `session_meta` 消失，而它本该"永不删除"）。
           * 真实端口用 `r.seq`（引擎分配的真实水位）对账，这里的等价物就是"占位即真实"。
           */
          const real = placeholderSeq;
          persist("events.append", {
            session_id: sid,
            event_type: type,
            payload,
            timestamp,
            seq: real,
          });
          events.reconcile(sid, placeholderSeq, real);
        } catch (e) {
          reportFakeFailure("appendEventAsync", e);
        }
      },
      appendEventBatchAsync: (
        sid: string,
        list: Array<{ type: string; payload: string; timestamp: number; placeholderSeq: number }>,
      ) => {
        for (const e of list) {
          try {
            // 同 appendEventAsync：落库 seq 必须等于已分配的那个（见那里的注释）
            const real = e.placeholderSeq;
            persist("events.append", {
              session_id: sid,
              event_type: e.type,
              payload: e.payload,
              timestamp: e.timestamp,
              seq: real,
            });
            events.reconcile(sid, e.placeholderSeq, real);
          } catch (err) {
            reportFakeFailure("appendEventBatchAsync", err);
          }
        }
      },
      /**
       * 与 Rust `events_compact` **逐字对齐**（`repo.rs`）：
       * 1. 锚点必须存在（否则报错，绝不凭空造一条孤立快照）；
       * 2. `INSERT OR REPLACE` 快照到 `snapshotSeq`（不是"再插一条"——是**替换那条事件**）；
       * 3. `DELETE ... WHERE seq < cutoff AND event_type <> 'session_meta'`。
       *
       * ⚠️ 这里先前写成了"再删一遍 seq < cutoff"，而 `replaceSession` 已经把镜像整理好了 ——
       * 同一条规则施加两次就把**刚写进去的快照**也删掉了（症状：压缩后整段历史消失）。
       * 镜像的乐观更新由调用方负责，这里只做与引擎等价的那两条。
       */
      compactEventAsync: (sid: string, snapshotSeq: number, cutoffSeq: number, payload: string) => {
        try {
          const anchor = table("session_events").find(
            (r) => r.session_id === sid && Number(r.seq) === snapshotSeq,
          );
          if (!anchor) throw new Error(`锚点事件不存在：session=${sid} seq=${snapshotSeq}`);
          anchor.event_type = "session_snapshot";
          anchor.payload = payload;
          anchor.timestamp = Date.now();
          persist("events.compact", { session_id: sid, snapshot_seq: snapshotSeq, cutoff_seq: cutoffSeq, payload });
          tables.set(
            "session_events",
            table("session_events").filter(
              (r) =>
                !(
                  r.session_id === sid &&
                  Number(r.seq) < cutoffSeq &&
                  Number(r.seq) !== snapshotSeq &&
                  r.event_type !== "session_meta" &&
                  r.event_type !== "session_snapshot"
                ),
            ),
          );
        } catch (e) {
          reportFakeFailure("compactEventAsync", e);
        }
      },
      deleteEventsAsync: (sid: string) => {
        try {
          persist("events.delete", { session_id: sid });
          tables.set(
            "session_events",
            table("session_events").filter((r) => r.session_id !== sid),
          );
        } catch (e) {
          reportFakeFailure("deleteEventsAsync", e);
        }
      },
    } as object),
    __table(name: string) {
      return table(name).map(cloneRow);
    },
    __writeFailures() {
      return writeFailures;
    },
    __writes() {
      return writeLog.map((w) => ({ ...w }));
    },
  } as FakeStoragePort;
}

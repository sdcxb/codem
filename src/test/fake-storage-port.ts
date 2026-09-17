/**
 * 纯内存存储端口（测试基座，P5 第 10 段）
 *
 * ## 为什么需要它
 *
 * 删掉 L3 回退分支（22 个模块、约 150 处旧库句柄调用）的前置条件是：
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
 * ## ⚠️ 就绪时机：**真端口是异步的**（A-7，第 20 轮）
 *
 * 真实端口（`rust-port.ts` 的 `RustDomainMirror` / `RustMessageMirror`）的
 * `ensureLoaded` 会发一次 **IPC**，所以"调用 `ensureLoaded`"与"`isReady` 为真"
 * 之间**隔着一段真实的时间** —— 这就是"加载窗口"。
 *
 * 本假端口默认**同步就绪**（`ensureLoaded` 立刻就绪）。这是刻意的取舍：
 * 5194 个既有用例都建立在"端口即时可用"之上，一次性改成异步会把基线整体打红，
 * 而那些用例验证的本来**不是**加载窗口的语义。
 *
 * 代价必须说清楚：**默认（同步）模式下，测试在结构上看不见"加载窗口"这一类缺陷**
 * （`domainWrite` 的首触必丢就是这一类，见 A-1）。所以：
 *
 * - 新增的、与"加载窗口 / 首触写 / 就绪时机"有关的用例**必须显式切到异步**：
 *   `createFakeStoragePort({ asyncLoad: true })` 或构造后 `port.__setAsyncLoad(true)`；
 * - 改动任何写/读路径的就绪判据时，顺手加一条异步模式用例 —— 否则修好的东西没人守。
 *
 * ## 它不是什么
 *
 * - **不是** wire 契约的替身：Rust 侧真实契约由 `cargo test` 的契约测试 + 真机验证守住。
 * - **不是**"让测试变绿"的开关：写穿失败会真抛、镜像未加载会如实 `isLoaded=false`，
 *   所以路由层与上报层的 bug 照样暴露。
 *
 * ## 命令清单的边界（L1 收尾，第 19 轮）
 *
 * 这里实现的命令名**逐一对照** `src-tauri/codem-db/src/lib.rs` 的 `COMMANDS`
 * （真引擎只认白名单里的名字，渲染侧发别的名字会拿到 `UNSUPPORTED`）。
 * 本文件早先还实现过两条**引擎里根本不存在**的命令（`crud.replace_table` /
 * `crud.delete_where`，是 `domain-store.ts` 的**审计标签**，没有任何调用点真的发它们）——
 * 那等于"假端口接受真引擎会拒绝的命令"，已删除。
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
  /**
   * **异步就绪模式**（默认 `false`，A-7）。
   *
   * 打开后 `domains.ensureLoaded` 不再同步就绪，而是把"完成加载"排到下一个微任务，
   * 于是"调用 ensureLoaded"与"isReady 为真"之间真的存在一个窗口 —— 与真端口的
   * 异步 IPC 同形。**验证"加载窗口"语义的用例必须打开它**；
   * 既有用例默认保持同步（理由见文件头）。
   */
  asyncLoad?: boolean;
  /**
   * `storage.compact` 的测试双开关：**要模拟"真的回收了 N 字节"就设它**
   * （默认 `0` = `performed: false`，与真机小库的实际形态一致）。
   */
  compactReclaims?: number;
  /**
   * `integrity_check` 的测试双开关：设成一段细节文本即表示**检查失败**
   * （用来验"页损坏 → 写索引重建标记 + 如实上报"那条路径）。
   */
  integrityFailure?: string;
}

export interface FakeStoragePort extends StoragePort {
  /** 直接读某张表的原始行（断言用） */
  __table(name: string): Row[];
  /** 端口记录到的落库失败次数 */
  __writeFailures(): number;
  /** 端口累计落库的写命令（断言"确实写穿了"，而不是只改了内存） */
  __writes(): Array<{ command: string; params?: Record<string, unknown> }>;
  /**
   * 运行期切换"异步就绪"（A-7）。
   *
   * 为什么要有 setter 而不只是构造参数：部分用例的形状是"先建端口 → 塞数据 →
   * 切模式 → 触发一次写"，构造参数在这一类里用不上。
   */
  __setAsyncLoad(on: boolean): void;
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
    /*
     * `settings.set`：真引擎 `repo::settings_set` 是 `INSERT … ON CONFLICT(key) DO UPDATE`。
     *
     * ⚠️ 补它的理由（第 45 轮）：假端口原来对这条命令**什么都不做**（落到末尾 `return 0`），
     * 于是**任何"把状态写进 settings"的生产代码在测试里都静默不生效**。
     * 实测踩到：`self-heal` 的内容水位、完整性检查的节流时间戳都写不进去 ——
     * 于是"水位写下了没有""12 小时内不重复跑"这些契约在测试里根本验不了，
     * 而且用例红点看起来像被测代码的错（其实是基座缺了这条命令）。
     */
    if (command === "settings.set") {
      const key = String((params as { key?: unknown } | undefined)?.key ?? "");
      if (!key) throw new Error("fake-port: settings.set 需要 key");
      const value = String((params as { value?: unknown } | undefined)?.value ?? "");
      const target = table("settings");
      const idx = target.findIndex((r) => r.key === key);
      if (idx >= 0) target[idx] = { ...target[idx], value };
      else target.push({ key, value });
      return 1;
    }
    if (command === "crud.delete") {
      const name = String(params?.table ?? "");
      const where = (params?.where as Record<string, unknown> | undefined) ?? {};
      const kept = table(name).filter((r) => !matches(r, where));
      const removed = table(name).length - kept.length;
      tables.set(name, kept);
      return removed;
    }
    /**
     * `feedback.set`（轻量路径，见 `config.rs::feedback_set`）。
     *
     * ## 为什么必须实现它（第 44 轮：测试双不能比实现宽松）
     *
     * 真实现是"**先按 message_id 整行 DELETE，再 INSERT 这 5 列**"
     * （`message_id / session_id / feedback / timestamp` + 主键）。
     * 也就是说：**它会抹掉它不认识的那四列**（`note` / `version` / `created_at` / `updated_at`）。
     *
     * 真 CLI 实测的后果：先用 9 列域写写入 note/version，再来一次 5 列的 `feedback.set`，
     * 读回来 `note` / `version` / `created_at` / `updated_at` **全变成 NULL**。
     * 而假端口原来对这条命令什么都不做（落到末尾 `return 0`），于是
     * "一次点击把备注与版本号抹掉"这个真实缺陷**在测试基座里完全看不见**。
     *
     * 现在按真实现逐条对齐，包括它最不讨人喜欢的那一面：
     * - 先删该 message_id 的所有行，再插一行 5 列（四列写 NULL）；
     * - `feedback` 只允许 `like` / `dislike`；`null`/`undefined`/空串 = 取消（只删不插）。
     *   真引擎对非法值直接报错（`参数 feedback 不合法：只允许 like / dislike（或 null 取消）`），
     *   这里同样报错 —— 否则"写了个库里存不进去的值"在测试里会被静默放过。
     */
    if (command === "feedback.set") {
      const messageId = String(params?.message_id ?? "");
      if (!messageId) throw new Error("fake-port: feedback.set 缺少 message_id");
      const feedback = params?.feedback;
      const target = table("message_feedback");
      tables.set(
        "message_feedback",
        target.filter((r) => r.message_id !== messageId),
      );
      if (feedback === null || feedback === undefined || feedback === "") return 0; // 取消反馈
      if (feedback !== "like" && feedback !== "dislike") {
        throw new Error(
          `fake-port: feedback.set 只允许 like / dislike（或 null 取消），收到 ${String(feedback)}`,
        );
      }
      table("message_feedback").push({
        id: `fb-${messageId}`,
        message_id: messageId,
        session_id: String(params?.session_id ?? ""),
        feedback,
        timestamp: Number(params?.timestamp ?? Date.now()),
        // 真实现不写这四列 → NULL（这正是"5 列路径会抹掉它们"的机制）
        note: null,
        version: null,
        created_at: null,
        updated_at: null,
      });
      return 1;
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
    /**
     * `attachments.update`：按 COALESCE 语义更新附件正文/预览（真 Rust 命令见
     * `codem-db/src/config.rs::attachments_update`）。假端口早先没实现它 →
     * "大附件外置后把标记写回库"这一步在测试里**静默丢行**（ATT-2 因此假红）。
     */
    if (command === "attachments.update") {
      const id = String(params?.id ?? "");
      const target = table("attachments");
      const idx = target.findIndex((r) => r.id === id);
      if (idx < 0) throw new Error(`fake-port: attachments 里没有 id=${id}`);
      const content = params?.content;
      const preview = params?.preview;
      target[idx] = {
        ...target[idx],
        content: content === undefined || content === null ? target[idx].content : content,
        preview: preview === undefined || preview === null ? target[idx].preview : preview,
      };
      return 1;
    }
    /**
     * `tool_calls.replace`：**整批替换**某条消息的工具调用（真 Rust 实现见
     * `codem-db/src/repo.rs::tool_calls_replace`，命令名在 `COMMANDS` 白名单里）。
     *
     * 为什么必须补齐（第 19 轮，L1 收尾）：
     *
     * 1. 产品的 `addToolCall` / `updateToolCall`（`message.ts`）走的就是它 ——
     *    假端口早先对这条命令**什么都不做**（`persist` 落到末尾 `return 0`），
     *    于是"工具调用写进了索引"在测试里是**假成功**：内存表里一行都没有；
     * 2. 配套的读命令 `tool_calls.list`（见 `command()`）正是从这张表读的 ——
     *    只补读不补写，假端口会自相矛盾（写完读不到），把产品路径引到"它坏了"的错觉上。
     *
     * 语义逐条对齐 Rust：目标消息**必须存在**（否则报 `not found`，绝不写孤儿行）；
     * 先删该消息的全部旧行，再整批插入（`tool_calls: []` = 清空）。
     */
    if (command === "tool_calls.replace") {
      const messageId = String(params?.message_id ?? "");
      if (!messageId) throw new Error("fake-port: tool_calls.replace 缺少 message_id");
      const calls = params?.tool_calls;
      if (!Array.isArray(calls)) throw new Error("fake-port: tool_calls.replace 的 tool_calls 必须是数组");
      if (!table("messages").some((r) => r.id === messageId)) {
        throw new Error(`fake-port: messages 里没有 id=${messageId}（不能写入孤儿工具调用）`);
      }
      tables.set(
        "tool_calls",
        table("tool_calls").filter((r) => r.message_id !== messageId),
      );
      for (const c of calls as Row[]) table("tool_calls").push({ ...cloneRow(c), message_id: messageId });
      return (calls as Row[]).length;
    }
    if (command === "messages.delete") {
      /*
       * 软删除（压缩走这条）：把 `hidden` 置 1；裁剪（`trim: true`）额外置 `trimmed = 1`。
       *
       * 为什么假端口必须实现它（第 39 轮）：Rust 侧 `messages_delete` 支持 `soft: true`，
       * 而假端口早先对这条命令**什么都不做** → 镜像里那些行仍是 `hidden=0` →
       * 读路径照常返回它们 → 一批"压缩后不该复活"的用例**假绿**
       * （掩盖了真实端口上的行为）。测试双不得比实现更宽松。
       *
       * `trim`（第 44 轮）必须逐字对齐真实现：真引擎写的是
       * `UPDATE messages SET hidden = 1, trimmed = 1` —— 因为它与"压缩隐藏"
       * （只设 hidden）**语义相反**（前者读路径要保留、后者要排除），
       * 而两者的区别是**库里的持久事实**。假端口若只设 `hidden`，
       * 那么"被裁的历史仍然读得到"这条不变量在测试里就永远测不出来。
       *
       * `soft` 未给或为 false 时按硬删除（与 Rust 侧默认一致）。
       */
      const ids = (params?.ids as string[] | undefined) ?? [];
      const trim = params?.trim === true;
      const soft = params?.soft === true || trim;
      const target = table("messages");
      let n = 0;
      for (const id of ids) {
        const idx = target.findIndex((r) => r.id === id);
        if (idx < 0) continue;
        if (soft) {
          target[idx] = trim
            ? { ...target[idx], hidden: 1, trimmed: 1 }
            : { ...target[idx], hidden: 1 };
        } else target.splice(idx, 1);
        n++;
      }
      return n;
    }
    if (command === "messages.rebuild_index") {
      /**
       * ⚠️ 参数形状必须与**线上契约**一致（第 14 轮修正）：
       * `{ sessions: [{ id, messages: [...] }] }`（`repo.rs::messages_rebuild_index` 读的就是它），
       * 而这里原来只认 `{ rows: [...] }` —— 于是测试里"重建索引"根本没写进去，
       * `authority-first-storage` 的 AR-4 因此**假红**（产品真机上是对的）。
       * 同时保留对旧 `rows` 形状的兼容（早期用例可能仍在用）。
       */
      const p = (params ?? {}) as Row;
      const sessions = (p.sessions as Array<{ id?: string; messages?: Row[] }> | undefined) ?? [];
      const flat: Row[] =
        sessions.length > 0
          ? sessions.flatMap((s) => (s.messages ?? []).map((m) => ({ ...m, session_id: m.session_id ?? s.id })))
          : ((p.rows as Row[] | undefined) ?? []);
      const name = "messages";
      const target = table(name);
      const pk = "id";
      for (const row of flat) {
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
      // 会话行也要补（与 Rust 侧一致：先 upsert sessions 再写 messages，满足外键）
      for (const s of sessions) {
        if (!s.id) continue;
        const sessTarget = table("sessions");
        if (!sessTarget.some((r) => r.id === s.id)) {
          sessTarget.push({
            id: s.id,
            project_id: "",
            title: `会话 ${s.id}`,
            created_at: Number((s.messages?.[0] as Row | undefined)?.timestamp ?? 1),
            last_message_at: Number((s.messages?.[s.messages.length - 1] as Row | undefined)?.timestamp ?? 1),
            message_count: (s.messages ?? []).length,
            pinned: 0,
          });
        }
      }
      return flat.length;
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
      /**
       * 只返回**上下文压缩隐藏**的 id（`hidden=1 && trimmed≠1`）—— 与真镜像逐字对齐。
       *
       * `hidden` 被两条语义相反的路径共用：压缩（读路径要排除）与索引裁剪
       * （读路径要**保留**，否则用户看不到自己的历史）。引擎把裁剪写成
       * `hidden=1, trimmed=1`，读路径据此区分；假端口若只认 `hidden`，
       * 就会把"被裁掉的历史"当成"已压缩"而从读集合里赶走 ——
       * 那正是 `session-jsonl-index.test.ts` 的 SLOG-6/SLOG-8 要守的东西
       * （实测：不区分时 12 条会变成 3 条）。
       */
      hiddenIds: (sid: string) =>
        new Set(
          rowsFor(sid)
            .filter((r) => Number(r.hidden ?? 0) === 1 && Number(r.trimmed ?? 0) !== 1)
            .map((r) => String(r.id)),
        ),
      /**
       * 索引裁剪的镜像同步（第 44 轮）：**改标记而不是移除行**。
       *
       * 真引擎只把行改成 `hidden = 1, trimmed = 1`（行还在库里，`message_feedback`
       * 的外键目标必须留着）；镜像若把行删掉就比引擎"更狠"，下一次整会话加载两边不一致。
       */
      applyTrim: (sid: string, ids: string[]) => {
        const wanted = new Set(ids);
        const target = table(scope);
        for (const r of target) {
          if (r[sessionColumn] === sid && wanted.has(String(r.id))) {
            r.hidden = 1;
            r.trimmed = 1;
          }
        }
      },
      applyWrite: (row: Row) => {
        const pk = primaryKeyOf(scope);
        const target = table(scope);
        const idx = target.findIndex((r) => r[pk] === row[pk]);
        /*
         * 同样按"未提供 = 保留已有值"合并（A-3/A-7）。
         *
         * `writeIndexViaRust` 不传 `hidden`（流式更新不该碰软删除状态），
         * 若这里把 `hidden: undefined` 展开进去，就等于"每次更新都把已压缩的消息复活" ——
         * 真实端口早先正是这么错的，而假端口当时是"合并进共享表、恰好保住了 hidden"，
         * 于是那个缺陷在测试里看不见（测试双比实现宽松的典型形态）。
         */
        const patch: Row = {};
        for (const [k, v] of Object.entries(row)) {
          if (v === undefined) continue;
          patch[k] = v;
        }
        if (idx >= 0) target[idx] = { ...target[idx], ...cloneRow(patch) };
        else target.push(cloneRow(patch));
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
  /**
   * `execute` 的入口：真端口里 `execute` 与 `command` 是**同一条 dispatch**
   * （差别只在返回值的整形），而假端口的额外能力都实现在 `persist()` 里 ——
   * 所以这里保持"转发到 persist"这一层，不做别的事。
   */
  function writeCommand(command: string, params?: Record<string, unknown>): number {
    return persist(command, params);
  }

  const data: StorageDataPort = {
    async query<T>(command: string, params?: Record<string, unknown>, page?: PageRequest): Promise<Page<T>> {
      /**
       * `messages.count`：真引擎返回 `{count, total, visible, hidden}`（见 `repo.rs::messages_count`）。
       *
       * 为什么必须**在通用分支之前**实现（第 44 轮实测踩到）：
       * 通用分支用 `params.table ?? command.split("_")[0]` 猜表名，而这条命令的名字里
       * **没有下划线**（`messages.count`），于是 `split("_")[0]` 原样返回 `"messages.count"` ——
       * 表名不存在 → 命中空表 → `total` 恒为 **0**。
       * 后果不是"读不到"，而是 `maintenance.ts` 的会话计数对账会把
       * `sessions.message_count` **写成 0**（真值 5、写成 0），也就是"测试里看起来跑了、实际写坏数据"。
       * 这正是本仓库反复消灭的那类偏差：测试双必须与实现同语义，而不是"能跑就行"。
       */
      if (command === "messages.count") {
        const sid = String(params?.session_id ?? "");
        if (!sid) throw new Error("fake-port: messages.count 缺少 session_id");
        const all = table("messages").filter((r) => r.session_id === sid);
        const visible = all.filter((r) => Number(r.hidden ?? 0) === 0).length;
        return {
          count: all.length,
          total: all.length,
          visible,
          hidden: all.length - visible,
        } as unknown as Page<T>;
      }
      const name = String(params?.table ?? command.split("_")[0] ?? "");
      let rows = table(name).map(cloneRow) as T[];
      const where = params?.where as Record<string, unknown> | undefined;
      if (where) rows = rows.filter((r) => matches(r as Row, where)) as T[];
      /**
       * `columns` 参数必须**真的生效**（第 20 轮）。
       *
       * 真引擎的 `crud.list` 支持"只取指定列"，并在引擎侧核对列名
       * （`crud.rs::check_columns`，列不存在直接报错）。假端口早先**忽略这个参数** ——
       * 于是"按需只取某一列"（`file-change-tracker.ts::fetchPatchById` 取 `patch` 正文）
       * 在测试里看起来也对（整行返回、字段都在），而真机上"忘了传 columns"
       * 或"列名拼错"都不会被发现。测试双不得比实现宽松。
       */
      const columns = params?.columns;
      if (Array.isArray(columns) && columns.length > 0) {
        const wanted = columns.map(String);
        rows = rows.map((r) => {
          const src = r as Row;
          const picked: Row = {};
          for (const c of wanted) if (c in src) picked[c] = src[c];
          return picked as T;
        });
      }
      const total = rows.length;
      const limit = page?.limit ?? total;
      const offset = page?.offset ?? 0;
      return { items: rows.slice(offset, offset + limit), total, limit, offset };
    },
    async write(commands) {
      let written = 0;
      for (const c of commands) written += writeCommand(c.command, c.params);
      return { written };
    },
    async execute(command: string, params?: Record<string, unknown>) {
      /*
       * ⚠️ **落库失败必须 reject，不能"记账 + 返回 {written:0}"**（第 20 轮修正）。
       *
       * 真端口的 `RustDataPort.execute` 在引擎报错时是 **reject**（`call()` 里
       * `unwrap` 直接抛）—— 而这里早先 catch 掉自己抛的错、只把计数加一就返回，
       * 于是"写穿失败"在测试里**永远走不到调用方的 `.catch`**：
       * 上报通道、重试、以及"失败要如实上报"这条纪律全都没有被真正执行过。
       * 测试双比实现宽松，正是本仓库一直在消灭的那类偏差。
       *
       * `writeFailures` 计数保留（既有用例用它断言"失败被记账"）。
       *
       * 第 45 轮：`settings.set` 改走 `writeCommand`（与 `command` 分支共用同一个实现）——
       * 真端口里 `execute` 与 `command` **是同一条 dispatch**，差别只在返回值的整形。
       * 假端口原来 `settings.set` 落到末尾的通用 `persist`（不动任何表），
       * 于是"把状态写进 settings"的生产代码在测试里**静默不生效**：
       * 实测踩到完整性检查的节流时间戳写不进去。
       */
      return { written: writeCommand(command, params) };
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
      /**
       * `tool_calls.list`：**读**命令（真实现见 `codem-db/src/repo.rs::tool_calls_list`）。
       *
       * 必须补它的理由（第 19 轮，L1 收尾的"最后一处噪音"）：产品的
       * `warmToolCalls`（`message.ts`）用 `command`（而不是 `execute`）读工具调用 ——
       * 因为 `execute` 会把结果压成 `{written}`，永远拿不到 `items`（第 14 轮踩过）。
       * 而假端口早先对这条命令落到末尾的 `throw 未实现的命令` → 每次读工具调用都产出一批
       * "未实现的命令 tool_calls.list" 噪音，且**预热恒失败**（缓存永远空）——
       * 测试里看到的"读完读不到"是基座缺陷，不是产品行为。
       *
       * 返回形状与 Rust 逐字对齐：`{ items, has_more, next_cursor }`，items 按 `id ASC`
       * 稳定排序（`repo.rs` 的 `ORDER BY id ASC`）。
       *
       * ⚠️ 这是**读**命令：刻意不写 `writeLog`（否则 `__writes()` 会混进读调用，
       * 而它是"确实写穿了"的判据）。
       */
      if (command === "tool_calls.list") {
        const messageId = String(params?.message_id ?? "");
        const items = table("tool_calls")
          .filter((r) => r.message_id === messageId)
          .map(cloneRow)
          .sort((a, b) => {
            const ai = String(a.id ?? "");
            const bi = String(b.id ?? "");
            return ai < bi ? -1 : ai > bi ? 1 : 0;
          });
        return { items, has_more: false, next_cursor: null } as unknown as T;
      }
      writeLog.push({ command, params });
      if (command === "crud.count") {
        const name = String(params?.table ?? "");
        return { count: table(name).length, table: name } as unknown as T;
      }
      /**
       * `crud.list`（**读**命令）：真实现见 `codem-db/src/crud.rs::crud_list`。
       *
       * 为什么必须给 `command` 也补上它（第 20 轮）：
       * 「按需只取某一列」这条路径（`file-change-tracker.ts::fetchPatchById` 用
       * `crud.list` + `columns: ["patch"]` + `where: { id }` 取补丁正文）走的是
       * `data.command`。假端口早先只给 `data.query` 实现了 `crud.list`，
       * 于是同一条命令经 `command` 发出时落到末尾的
       * `throw 未实现的命令 crud.list` —— 测试里表现为"取补丁失败"，
       * 掩盖的是**假端口的缺口**，不是产品的行为。
       *
       * 逐条对齐真引擎：`columns` 缺省 = 整行，给了就只返回那些列；
       * **列名必须真实存在**（真引擎 `check_columns` 会报错，这里同样报错，
       * 否则"列名拼错"在测试里被静默忽略）；`where` 只支持等值匹配；
       * 返回 `{items, has_more, next_cursor}`。
       */
      if (command === "crud.list") {
        const name = String(params?.table ?? "");
        const src = table(name);
        // 列名核对：只按"表里已有行"的键判断（空表无从核对，与真引擎的 schema 核对不同，
        // 但足以挡住拼错的列名）
        if (src.length > 0) {
          const known = new Set(Object.keys(src[0]));
          const check = (cols: string[]) => {
            for (const c of cols) {
              if (!known.has(c)) throw new Error(`fake-port: 表 ${name} 没有列 ${c}`);
            }
          };
          check(Object.keys((params?.where as Record<string, unknown> | undefined) ?? {}));
          if (Array.isArray(params?.columns)) check((params?.columns as unknown[]).map(String));
        }
        let rows = table(name).map(cloneRow);
        const where = (params?.where as Record<string, unknown> | undefined) ?? {};
        if (Object.keys(where).length > 0) rows = rows.filter((r) => matches(r, where));
        const cols = params?.columns;
        if (Array.isArray(cols) && cols.length > 0) {
          const wanted = cols.map(String);
          rows = rows.map((r) => {
            const picked: Row = {};
            for (const c of wanted) if (c in r) picked[c] = r[c];
            return picked;
          });
        }
        const limit = Number(params?.limit ?? rows.length);
        const offset = Number(params?.offset ?? 0);
        const items = rows.slice(offset, offset + limit);
        return { items, has_more: offset + items.length < rows.length, next_cursor: null } as unknown as T;
      }
      /**
       * `messages.count`：真引擎返回 `{count, total, visible, hidden}`（见 `repo.rs::messages_count`）。
       *
       * 为什么必须实现（第 44 轮）：`maintenance.ts` 的"会话计数对账"用它把
       * `sessions.message_count` 修回索引真值。假端口原来对这条命令落到**通用列表分支**
       * （它把任何命令都当成"取某张表的行"），于是 `params.table` 缺失、`command.split("_")[0]`
       * 得到 `"messages"` —— 返回的是一**页消息行**而不是计数对象，
       * `counted.total` 因此恒为 `undefined` → 对账会把 `message_count` 写成 **0**。
       * 也就是说：假端口不实现它，这条对账在测试里会"看起来跑了、实际写坏数据"。
       */
      if (command === "messages.count") {
        const sid = String(params?.session_id ?? "");
        if (!sid) throw new Error("fake-port: messages.count 缺少 session_id");
        const rows = table("messages").filter((r) => r.session_id === sid);
        const visible = rows.filter((r) => Number(r.hidden ?? 0) === 0).length;
        return {
          count: rows.length,
          total: rows.length,
          visible,
          hidden: rows.length - visible,
        } as unknown as T;
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
      /**
       * 其余命令：真端口里 `command` 与 `execute` 走同一条 dispatch，区别只在**返回值的整形**
       * （`execute` 压成 `{written}`，`command` 给结构化结果）。所以这里也让 `command`
       * 落到同一套 `persist()` 语义上，再补出结构化字段 ——
       * 否则"用 command 调一条已实现的命令"会在测试里报"未实现"（AR-4 踩到的就是它）。
       */
      const written = persist(command, params);
      /**
       * ⚠️ `settings.set` 在这里**不走 `persist`**（`persist` 对它什么都不做），
       * 而是就地更新 `settings` 表 —— 真引擎 `repo::settings_set` 是
       * `INSERT … ON CONFLICT(key) DO UPDATE`。
       *
       * 为什么要补（第 45 轮）：`settings.set` 原来落到末尾的通用 `persist`（返回 0、不动表），
       * 于是**任何"把状态写进 settings"的生产代码在测试里都静默不生效**。
       * 实测踩到：完整性检查的节流时间戳写不进去 → "12 小时内不重复"这条契约验不了，
       * 而且红点看起来像被测代码的错（其实是基座缺了这条命令）。
       */
      if (command === "settings.set") {
        const key = String((params as { key?: unknown } | undefined)?.key ?? "");
        if (!key) throw new Error("fake-port: settings.set 需要 key");
        const value = String((params as { value?: unknown } | undefined)?.value ?? "");
        const target = table("settings");
        const idx = target.findIndex((r) => r.key === key);
        if (idx >= 0) target[idx] = { ...target[idx], value };
        else target.push({ key, value });
        return { written: 1, key } as unknown as T;
      }
      if (command === "messages.rebuild_index") {
        const sessions = (params?.sessions as Array<{ messages?: unknown[] }> | undefined) ?? [];
        return { written, sessions: sessions.length, messages: written } as unknown as T;
      }
      if (command === "attachments.content") {
        const id = String(params?.id ?? "");
        const row = table("attachments").find((r) => r.id === id);
        if (!row) throw new Error(`fake-port: attachments 里没有 id=${id}`);
        return { id, content: (row.content as string | null) ?? null } as unknown as T;
      }
      if (command === "attachments.externalized") {
        const items = table("attachments")
          .filter((r) => typeof r.content === "string" && String(r.content).startsWith("file:"))
          .map((r) => ({ id: String(r.id), path: String(r.content).slice("file:".length) }));
        return { items, count: items.length } as unknown as T;
      }
      /*
       * ===== 第 45 轮接线的四条引擎命令 =====
       *
       * 它们原来在假端口里落到末尾的 `throw 未实现的命令` —— 于是"维护接了它们"
       * 这件事在测试里**只能测到失败分支**（真实语义一条都测不到）。
       * 这里按真引擎的返回形状逐条实现（`lib.rs::audit_prune` / `audit_stats` /
       * `storage_compact`、`engine.rs::integrity_check`），
       * 并保留"测试双不得比实现更宽松"这条要求：形状与字段名逐字对齐。
       */
      /*
       * `settings.set`：真引擎 `repo::settings_set` 是 `INSERT … ON CONFLICT(key) DO UPDATE`。
       *
       * ⚠️ 补它的理由（第 45 轮）：假端口原来对这条命令落到"通用 persist 返回 0"——
       * 于是**任何"把状态写进 settings"的生产代码在测试里都静默不生效**。
       * 实测踩到：完整性检查的节流时间戳写不进去 → 第二次维护又跑满一次 `quick_check`
       * （"12 小时内不重复"这条契约在测试里根本验不了），而且用例的红点是
       * "读不到时间戳"，看起来像被测代码的错。
       */
      if (command === "settings.set") {
        const key = String((params as { key?: unknown } | undefined)?.key ?? "");
        if (!key) throw new Error("fake-port: settings.set 需要 key");
        const value = String((params as { value?: unknown } | undefined)?.value ?? "");
        const target = table("settings");
        const idx = target.findIndex((r) => r.key === key);
        if (idx >= 0) target[idx] = { ...target[idx], value };
        else target.push({ key, value });
        return { written: 1, key } as unknown as T;
      }
      if (command === "audit.prune") {
        const before = Number((params as { before?: unknown } | undefined)?.before ?? NaN);
        // 真引擎里 `before` 是**必填**（`repo::req_i64`），缺了直接报错
        if (!Number.isFinite(before)) {
          throw new Error("fake-port: audit.prune 需要 before（毫秒水位线，真引擎里是必填）");
        }
        /** `storage_audit` 的现状（真引擎 `audit.stats` 的等价实现：行数 / 最早 / 最晚） */
        const auditStats = () => {
          const rows = table("storage_audit");
          if (rows.length === 0) return { count: 0, oldest: null as number | null, newest: null as number | null };
          const times = rows.map((r) => Number(r.at ?? 0));
          return { count: rows.length, oldest: Math.min(...times), newest: Math.max(...times) };
        };
        const target = table("storage_audit");
        const kept = target.filter((r) => Number(r.at ?? 0) >= before);
        const removed = target.length - kept.length;
        tables.set("storage_audit", kept);
        const stats = auditStats();
        return {
          removed,
          before,
          remaining: stats.count,
          oldest: stats.oldest,
          newest: stats.newest,
        } as unknown as T;
      }
      if (command === "audit.stats") {
        const rows = table("storage_audit");
        if (rows.length === 0) {
          return { count: 0, oldest: null, newest: null } as unknown as T;
        }
        const times = rows.map((r) => Number(r.at ?? 0));
        return {
          count: rows.length,
          oldest: Math.min(...times),
          newest: Math.max(...times),
        } as unknown as T;
      }
      if (command === "storage.compact") {
        /**
         * 真引擎按阈值（默认 8 MiB 且 25%）决定做不做整库重写。
         *
         * 内存假端口没有页/空闲页的概念，用一个显式开关模拟两种形态 ——
         * **默认走 `performed: false`**（小库的正常形态，真机探针实测同一份库就是它）。
         * `opts.compactReclaims` 用来验"跑了并回收了 N 字节"那一条分支。
         */
        const reclaim = opts.compactReclaims ?? 0;
        if (reclaim <= 0) {
          return {
            performed: false,
            reason: "空闲页规模未达阈值（不做整库重写）",
            page_size: 4096,
            page_count: 0,
            freelist_count: 0,
            free_bytes: 0,
            free_ratio: 0,
            auto_vacuum: 2,
          } as unknown as T;
        }
        return {
          performed: true,
          before_bytes: reclaim * 2,
          after_bytes: reclaim,
          reclaimed_bytes: reclaim,
          freelist_before: Math.ceil(reclaim / 4096),
          freelist_after: 0,
          auto_vacuum_before: 0,
          auto_vacuum_after: 2,
          elapsed_ms: 10,
        } as unknown as T;
      }
      if (command === "integrity_check") {
        // 真引擎：`PRAGMA quick_check` → `{ ok, detail }`
        return (opts.integrityFailure
          ? { ok: false, detail: opts.integrityFailure }
          : { ok: true, detail: "ok" }) as unknown as T;
      }
      throw new Error(`fake-port: 未实现的命令 ${command}（测试双不得比实现更宽松）`);
    },
  };

  // ===== 通用域镜像（`domainPort` 只认 rust，且要求 domains.ensureLoaded 存在）=====
  const ready = new Set<string>();
  /** 正在加载的表（异步就绪模式下的"加载窗口"） */
  const loading = new Set<string>();
  let asyncLoad = opts.asyncLoad ?? false;
  /**
   * 走完一次"加载"：标为就绪并通知**所有**等待者。
   *
   * ⚠️ **顺序有意为之**：先 `loading.delete` 再 `ready.add`，最后才回调 ——
   * 真端口里 `loading` 是在 `finally` 里清掉的，回调则在 `.then` 里按"isReady"
   * 过滤。三者顺序错了，"就绪回调"与"仍在加载"就会同时为真，
   * 写路径会既排队又当场写，重放就变成重复写。
   *
   * ⚠️ **回调必须攒起来、加载完成时全部触发**（第 20 轮修正）。
   * 真实端口的 `ensureLoaded` 在 `loading` 期间会把 `onLoaded` 挂到
   * **已经在途的那个 job** 上（`this.loading.get(table)?.then(...)`），
   * 所以"窗口期内再注册一个回调"同样是有效的。早先这里在 `loading` 时直接
   * `return`，那个回调就**永远不触发** —— 于是"我要等这批数据就绪"这类调用
   * （`domainEnsureLoaded`、以及写队列的重放）在假端口的异步模式下静默失效。
   */
  const pendingCallbacks = new Map<string, Array<() => void>>();
  const completeLoad = (name: string, onLoaded?: () => void) => {
    loading.delete(name);
    ready.add(name);
    onLoaded?.();
    for (const cb of pendingCallbacks.get(name) ?? []) cb();
    pendingCallbacks.delete(name);
  };
  /** 永不就绪的表（B 态载体）：见 FakeStoragePortOptions.neverReady */
  const neverReady = new Set(opts.neverReady ?? []);
  const domains = {
    isReady: (name: string) => ready.has(name) && !neverReady.has(name),
    /**
     * 真端口的 `isLoading`（A-1 的判据来源）。
     *
     * `neverReady` 的表**不算"加载中"**：它是"永远不会就绪"（超上限被拒 / 加载失败），
     * 写路径对这两种态的处置不同（前者排队、后者如实返回"未接手"）——
     * 假端口必须保住这条区分，否则它会比实现更宽松。
     */
    isLoading: (name: string) => loading.has(name) && !neverReady.has(name),
    ensureLoaded: (name: string, onLoaded?: () => void) => {
      if (neverReady.has(name)) return; // 永不就绪：不回调，与真端口"加载失败不回调"一致
      if (ready.has(name)) {
        onLoaded?.();
        return;
      }
      if (loading.has(name)) {
        // 已在加载：把回调挂到"这次加载完成时"（真端口挂的是在途 job，语义一致）
        if (onLoaded) {
          const list = pendingCallbacks.get(name) ?? [];
          list.push(onLoaded);
          pendingCallbacks.set(name, list);
        }
        return;
      }
      if (!asyncLoad) {
        completeLoad(name, onLoaded);
        return;
      }
      /*
       * **异步就绪**：把"完成加载"排到下一个微任务。
       *
       * 这就是 A-1 的复现条件 —— 同一次同步调用里先 `ensureLoaded()` 再判 `isReady()`，
       * 在真端口上必然拿到"还没好"。默认关掉它是为了不动既有基线（见文件头）。
       */
      loading.add(name);
      void Promise.resolve().then(() => {
        if (loading.has(name)) completeLoad(name, onLoaded);
      });
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
      /*
       * ⚠️ **未提供的列不许把已有值抹成 0/undefined**（A-7/A-3）。
       *
       * 早先这里直接 `{...target[idx], ...row}`：一旦某个调用点传进来的行里
       * 带着 `hidden: undefined`（"我没要改这一列"），展开就会**覆盖**掉已有值。
       * 真实端口在 `RustMessageMirror.applyWrite` 里的处置是"未提供 = 保留"，
       * 假端口必须与之一致 —— 测试双比实现宽松，缺陷就永远测不出来。
       */
      const patch: Row = {};
      for (const [k, v] of Object.entries(row)) {
        if (v === undefined) continue;
        patch[k] = v;
      }
      if (idx >= 0) target[idx] = { ...target[idx], ...cloneRow(patch) };
      else target.push(cloneRow(patch));
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
      applyMessageTrim: (sid: string, ids: string[]) => messages.applyTrim(sid, ids),
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
          /*
           * ⚠️ 与真 SQL **逐字一致**（A-7，第 20 轮）。
           *
           * `repo.rs::events_compact` 的第二条只有两个条件：
           * ```sql
           * DELETE FROM session_events
           *  WHERE session_id = ?1 AND seq < ?2 AND event_type <> 'session_meta'
           * ```
           * 本假端口早先还多两条豁免（`seq !== snapshotSeq`、`event_type !== "session_snapshot"`），
           * 于是它**比真引擎宽松**：真机上"快照被自己的删除规则带走"（症状是压缩后
           * 整段历史消失）在测试里永远不会发生。测试双比实现宽松 = 缺陷测不出来，
           * 所以这两条豁免删除。
           */
          tables.set(
            "session_events",
            table("session_events").filter(
              (r) =>
                !(
                  r.session_id === sid &&
                  Number(r.seq) < cutoffSeq &&
                  r.event_type !== "session_meta"
                ),
            ),
          );
        } catch (e) {
          reportFakeFailure("compactEventAsync", e);
        }
      },
      deleteEventsAsync: (sid: string) => {
        try {
          /**
           * 落库标签用**真命令名** `events.delete_session`（`COMMANDS` 白名单里的那一个）。
           *
           * 早先这里写的是 `events.delete` —— 那个名字在真引擎里**不存在**
           * （会得到 `UNSUPPORTED`）。`__writes()` 是"确实写穿了"的判据，
           * 标签不能是假端口自己发明的名字，否则断言的是与真引擎无关的字符串。
           */
          persist("events.delete_session", { session_id: sid });
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
    __setAsyncLoad(on: boolean) {
      asyncLoad = on;
    },
  } as FakeStoragePort;
}

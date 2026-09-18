/**
 * 会话的持久追加日志（JSONL）—— 对齐 DSH 的 `dsh-session-persistence-jsonl`（第 78 波）
 *
 * 为什么这是"治本"的最后一块：
 *   Codem 的本地 SQLite 是**整库常驻内存**、且 sql.js 只能**整库导出**。只要会话历史住在库里，
 *   库就会随对话无限增长 → 每次保存的导出/编码峰值随之增长 → 渲染进程 out of memory
 *   （用户报的那屏 `out of memory` 刷屏）。前几波把这条路上的风险压到最低（削峰、节流、原子写、
 *   WASM 引擎、溢出、事件快照压缩），但**"整库导出"这个动作本身还在**。
 *
 * DSH 的做法是：会话的权威存储是 **append-only JSONL**（增量追加，没有整库导出），
 * SQLite 只是**可重建的查询索引**。本模块把前半截搬过来：
 *   - 每条消息追加一行 JSON（`<appData>/sessions/<sessionId>.jsonl`），**追加即持久**，
 *     不需要导出任何"整库"；
 *   - 读取时按 id **后写者胜**（同一条消息被更新过就有多行，最后一行是当前状态）；
 *   - 损坏行只计数不致命（崩在写入中途最多丢最后一行，前面全部可读）。
 *
 * 有了它，SQLite 就可以被**有界裁剪**（见 `database.ts` 的 trimIndexedMessages）：
 * 只有当一条消息**确实已经在 JSONL 里**，才允许把它从索引里删掉 —— 这就是"索引可重建"的前提。
 */

import { appendFile, readFile, listDirectory, writeFile, deleteFile, renameFile } from "../file-api";
import type { Message } from "../../store";

/** 单行格式版本：将来改字段时按版本兼容读取 */
const LINE_VERSION = 1;

export interface JsonlMessageRecord {
  v: number;
  id: string;
  sessionId: string;
  role: string;
  content: string;
  reasoning?: string;
  timestamp: number;
  model?: string;
  status?: string;
  /** 工具调用**必须一起持久化**：否则裁剪索引会把工具调用的真实内容丢掉 */
  toolCalls?: unknown;
  /** 生成文件等附加信息 */
  generatedFiles?: unknown;
  /**
   * 引用来源（RAG / 检索证据）。
   *
   * **B-3**：写侧（`message.ts` 的 `writeIndexViaRust`）一直在传 `retrieved_sources`，
   * 但这条**可重建**的路径上它整个缺席 —— 索引行被裁剪/索引崩了重建之后，
   * 消息上的"引用来源"就永久消失了（`MessageBubble` 靠 `message.retrievedSources` 渲染，
   * 于是用户看到引用块消失）。权威日志必须记它，否则"索引可从日志重建"这条不变量
   * 在这一个字段上不成立。
   */
  retrievedSources?: unknown;
  /**
   * ## 压缩状态（第 47 轮补，数据面审计 P1-1）
   *
   * `hidden` = "被上下文压缩隐藏"、`trimmed` = "被索引裁剪隐藏"（两者语义不同，
   * 见 `message.ts` 里 `trimmed` 列的长注释）。
   *
   * **为什么必须进权威日志**：这两列原来只存在于索引里。索引一旦重建
   * （裁剪 / 损坏恢复 → `open_with_recovery` 建空库 → 从日志重建），
   * 重建路径按 `?? 0` 落库 → **所有被压缩掉的消息原地复活**：
   * 用户列表凭空多出几百条旧消息，模型上下文跟着涨回去
   * （正是本项目打过的那场"压缩 840 条、token 一点没降"的仗）。
   *
   * 只写**非 0** 值（0 / 未定义都不写），读侧一律 `?? 0` —— 日志格式不变。
   */
  hidden?: number;
  trimmed?: number;
  /**
   * 墓碑标记（第 78 波自查发现的问题）：删除必须**追加一条墓碑**，否则
   * "日志是权威、索引可重建"会立刻变成"删过的消息下次读取又回来了"。
   */
  deleted?: boolean;
}

let cachedDir: string | null = null;

async function sessionsDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  /**
   * ## 第 62 轮：目录来源改成"**引擎实际使用的库所在目录**"
   *
   * 这里是**权威副本**的落点（`<base>/sessions/<sid>.jsonl`），而它支撑的是 SQLite 里的
   * 消息索引 —— 两者**必须属于同一份数据集**，否则"从日志重建索引"会在另一份数据上跑。
   * 在此之前这个 base 只认 `getAppDataDir()`，而库路径由引擎解析（支持 `CODEM_DB_PATH`
   * 与兜底目录）⇒ 库被指到别处时，日志与索引就分家了（便携模式把库拷走、日志留在本机；
   * 隔离钻取会读写用户的真日志）。现在统一问 `resolveDataRoot()`。
   */
  const { resolveDataRoot } = await import("./data-root");
  const info = await resolveDataRoot();
  const base = info.root;
  const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
  cachedDir = `${base}sessions${sep}`;
  return cachedDir;
}

/** 会话日志文件路径 */
export async function sessionLogPath(sessionId: string): Promise<string> {
  const dir = await sessionsDir();
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  const safe = (sessionId || "global").replace(/[^\w.-]+/g, "_");
  return `${dir}${safe}.jsonl`;
}

/** 测试用：清掉目录缓存 */
export function __resetJsonlCache(): void {
  cachedDir = null;
}

/**
 * 追加写是 fire-and-forget（写日志失败不能打断对话），但**耐久性检查必须看到最新日志**：
 * 否则裁剪索引时可能读到旧内容，导致"该裁的没裁"（无害）或时序上的误判。
 * `flushSessionLogWrites()` 用在需要确定性的地方（裁剪索引前、退出前）。
 */
const pendingAppends = new Set<Promise<void>>();

/** 等待所有在途的追加写落盘 */
export async function flushSessionLogWrites(): Promise<void> {
  if (pendingAppends.size === 0) return;
  await Promise.allSettled([...pendingAppends]);
}

/**
 * 追加一条消息（**追加即持久**，不做任何整库导出）。
 *
 * 失败只记日志、不抛：调用方（消息写入路径）已经有 SQLite 索引兜底，
 * 让"日志写不进去"把整个对话打断是本末倒置。
 */
export function appendSessionMessage(sessionId: string, message: Message): Promise<void> {
  const task = (async () => {
    try {
      /**
       * ## 第 47 轮补：追加前先等在途的**日志改写**（压缩）落定
       *
       * `compactSessionLog` 现在是"读 → 写 .tmp → rename 覆盖"，它运行期间到达的追加
       * 若直接写进原文件，就会被紧随其后的 rename **覆盖掉**（消息从权威日志里消失）。
       * 压缩把自己登记进了 `pendingAppends`，所以这里等一次就能避开那个窗口。
       *
       * ⚠️ **不在** `flushSessionLogWrites()` 里做这件事（那会造成死锁：压缩自己也在等它，
       * 而这些追加又在等压缩）。`flushSessionLogWrites` 的语义保持"等齐**先前**的写"。
       */
      if (pendingAppends.size > 0) await Promise.allSettled([...pendingAppends]);

      const record: JsonlMessageRecord = {
        v: LINE_VERSION,
        id: message.id,
        sessionId,
        role: message.role,
        content: typeof message.content === "string" ? message.content : "",
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        timestamp: message.timestamp ?? Date.now(),
        ...(message.model ? { model: message.model } : {}),
        ...(message.status ? { status: message.status } : {}),
        ...((message as any).toolCalls ? { toolCalls: (message as any).toolCalls } : {}),
        ...((message as any).generatedFiles ? { generatedFiles: (message as any).generatedFiles } : {}),
        /**
         * B-3：引用来源必须进权威日志。
         *
         * 之前这里没有它 —— 于是"索引可从日志重建"在这一个字段上不成立：
         * 索引裁剪 / 索引损坏重建之后，消息的 `retrievedSources` 永久消失
         * （`MessageBubble` 的引用块跟着消失，用户看到的是"引用来源没了"）。
         */
        ...((message as any).retrievedSources ? { retrievedSources: (message as any).retrievedSources } : {}),
        /**
         * ## 第 47 轮补（数据面审计 P1-1）：**压缩状态必须进权威日志**
         *
         * 缺陷形态：`hidden` / `trimmed` 只存在于索引里，日志没有它们。
         * 于是"索引可从日志重建"这条不变量在这两列上**不成立** —— 重建之后
         * （裁剪后的 `hidden=1` 变成 `?? 0` = 可见）**所有被压缩掉的消息原地复活**：
         * 用户列表里凭空多出几百条旧消息，模型上下文跟着涨回去
         * （正是本项目打过的那场"压缩 840 条、token 一点没降"的仗）。
         *
         * 触发路径是真实的、而且和损坏恢复是同一条：
         * 库文件损坏 → `open_with_recovery` 建**空库** → 写"索引需要重建"标记 →
         * 维护从日志重建 → 每一行都是新 INSERT（`hidden` 取不到"库里的原值"，
         * 因为库里根本没有那一行）→ 全部按 `hidden = 0` 落库。
         *
         * 所以这两列必须由**权威副本**承载。只写非 0 值（`hidden=0` / `trimmed` 不写）
         * 是为了让日志体积与既有格式尽量不变 —— 读侧一律 `?? 0`，语义等价。
         */
        ...(Number((message as any).hidden ?? 0) ? { hidden: Number((message as any).hidden) } : {}),
        ...(Number((message as any).trimmed ?? 0) ? { trimmed: Number((message as any).trimmed) } : {}),
      };
      // Rust 侧 append_file 会补一个换行 —— 正好是 JSONL 需要的行分隔
      await appendFile(await sessionLogPath(sessionId), JSON.stringify(record));
    } catch (e) {
      console.warn("[SessionJSONL] 追加消息失败（SQLite 索引仍在）:", e);
    }
  })();
  pendingAppends.add(task);
  void task.finally(() => pendingAppends.delete(task));
  return task;
}

/**
 * 读取会话日志：按 id 后写者胜，损坏行跳过并计数。
 *
 * @returns messages 与 skippedLines（损坏行数，用于诊断"日志是否被截断过"）
 */
/**
 * 错误是否表示"文件不存在"（而不是"读失败"）。
 *
 * 判据见 `readSessionMessages` 的长注释：文件 API 是 Tauri 命令，错误以字符串回来。
 * **判不出来的方向是安全的** —— 不确定就当成"读失败"抛出，宁可多报一次"读不到"，
 * 也不把"读失败"说成"这个会话没有消息"。
 *
 * ## 第 62 轮补：**`os error 3` 也必须算"不存在"**（这是真机抓到的）
 *
 * 磁盘上的"没有这个文件"在 Windows 上有**两种**系统错误码，取决于**父目录在不在**：
 *
 * | 情形 | Win32 | 消息文本 |
 * | --- | --- | --- |
 * | 目录在、文件不在 | `ERROR_FILE_NOT_FOUND` = **2** | 系统找不到指定的文件。 (os error 2) |
 * | **目录本身就不在** | `ERROR_PATH_NOT_FOUND` = **3** | 系统找不到指定的路径。 (os error 3) |
 *
 * 原来只认 2 与两个英文短语 ⇒ 在**全新的数据根目录**（便携模式 / `CODEM_DB_PATH` 隔离 /
 * 库被指到别处）上，"还没有日志目录"会被判成**读失败**并向上抛。
 * 真机取证（隔离实例）：维护里每个会话都打
 * `[SessionLog] 会话 … 回填失败（跳过）: 系统找不到指定的路径。 (os error 3)`
 * ⇒ **权威日志一个文件都建不出来**（"库坏了从日志重建"这条后路一直是空的），
 * 而维护汇总只显示 `日志回填 0 条`。
 *
 * 所以把 3 也算进来。"缺失"的方向仍然是安全的：真正的读失败（权限 / IPC 断）错误码不同，
 * 依旧照原样抛出。
 */
function isFileMissingError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return (
    /os error [23]\b/.test(msg) ||
    /no such file/i.test(msg) ||
    /not found/i.test(msg) ||
    // Windows 中文/其它语言的"找不到路径"提示（错误码缺失时兜底）
    /找不到指定的路径/.test(msg) ||
    /cannot find the path/i.test(msg)
  );
}

export async function readSessionMessages(
  sessionId: string,
): Promise<{ messages: JsonlMessageRecord[]; skippedLines: number }> {
  const result: { messages: JsonlMessageRecord[]; skippedLines: number } = { messages: [], skippedLines: 0 };
  let raw: string;
  try {
    raw = await readFile(await sessionLogPath(sessionId));
  } catch (e) {
    /**
     * ## 第 50 轮：**"文件不存在"与"读失败"必须分开**（同一类缺陷的最后一层）
     *
     * 原来这里一律 `catch { return 空 }`，于是两种完全不同的情况合并成一个空结果：
     * - **还没有日志**（新会话 / 老会话尚未回填）→ 空是**对的**；
     * - **读取失败**（IPC 断了 / 权限 / 磁盘问题）→ 空是**谎话**：
     *   日志是**权威副本**，读不到它却报"没有消息"，用户会以为对话被清空了
     *   （这正是本仓库反复出现的那一类："读失败被渲染成没有数据"）。
     *
     * 现在只有"确实不存在"才返回空，其余**照原样抛出**，让上层如实报"读不到"
     * （`hydrateSessionLog` 会把它记成 `session-log read failed`，
     * 界面显示"暂时读不到…"+ 重试，而不是欢迎页）。
     *
     * 判据为什么按错误文本：文件 API 是 Tauri 命令，错误以字符串回来
     * （Rust 侧 `std::fs::read` 的 `e.to_string()`，形如
     * `系统找不到指定的文件。 (os error 2)` / `No such file or directory (os error 2)`）。
     * 所以认三个信号：`os error 2`、`no such file`、`not found`。
     * ⚠️ 这是**文本判据**，会随 Rust 侧错误格式变化而失效 —— 失效的方向是安全的
     * （判不出来就当成"读失败"抛出，宁可多报一次"读不到"，也不把失败说成"没有"）。
     */
    if (isFileMissingError(e)) return result; // 还没有日志：正常（老会话尚未回填）
    throw e;
  }
  const byId = new Map<string, JsonlMessageRecord>();
  const tombstones = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JsonlMessageRecord;
      if (!parsed || typeof parsed.id !== "string") throw new Error("bad record");
      if (parsed.deleted) {
        // 墓碑：后写者胜的语义在"删除"上同样成立 —— 删除之后再写入就是重新出现
        tombstones.add(parsed.id);
        byId.delete(parsed.id);
        continue;
      }
      tombstones.delete(parsed.id);
      byId.set(parsed.id, parsed);
    } catch {
      result.skippedLines++;
    }
  }
  result.messages = [...byId.values()]
    .filter((m) => !tombstones.has(m.id))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return result;
}

/**
 * 追加一条墓碑（消息被删除时调用）。
 *
 * 为什么必须有：日志是权威存储、索引可重建 —— 如果删除只发生在索引里，
 * 那么下次从日志重建/合并时，删掉的消息会**复活**。墓碑让"删除"也变成一条可回放的记录。
 */
export async function appendMessageTombstone(sessionId: string, messageId: string): Promise<void> {
  const task = (async () => {
    try {
      const record: JsonlMessageRecord = {
        v: LINE_VERSION,
        id: messageId,
        sessionId,
        role: "tombstone",
        content: "",
        timestamp: Date.now(),
        deleted: true,
      };
      await appendFile(await sessionLogPath(sessionId), JSON.stringify(record));
    } catch (e) {
      console.warn("[SessionJSONL] 追加墓碑失败（索引已删除）:", e);
    }
  })();
  /**
   * 第 83 波：墓碑也要进 `pendingAppends`。
   *
   * 为什么：`flushSessionLogWrites()` 是全项目"把日志写入等齐"的**唯一**原语（裁剪索引前、退出前用）。
   * 墓碑走 `appendFile` 但没登记在途状态 —— 于是"删了消息立刻 flush 再读日志"会读到旧内容，
   * 压缩后的耐久性检查（以及退出时的落盘确定性）都跟着不可靠。
   */
  pendingAppends.add(task);
  void task.finally(() => pendingAppends.delete(task));
  return task;
}

/** 日志里已经持久化的消息 id 集合（裁剪索引前的**耐久性检查**用） */
export async function durableMessageIds(sessionId: string): Promise<Set<string>> {
  const { messages } = await readSessionMessages(sessionId);
  return new Set(messages.map((m) => m.id));
}

/**
 * 一次性回填：把 SQLite 里已有的消息导出成 JSONL（迁移用，幂等）。
 *
 * 幂等性靠"已有日志里的 id 集合"判断：只补缺失的消息，不重写整个文件
 * （重写会丢并发追加的窗口）。
 */
export async function backfillSessionLog(sessionId: string, messages: Message[]): Promise<number> {
  if (messages.length === 0) return 0;
  const existing = await durableMessageIds(sessionId);
  let appended = 0;
  for (const message of messages) {
    if (existing.has(message.id)) continue;
    await appendSessionMessage(sessionId, message);
    appended++;
  }
  if (appended > 0) {
    console.log(`[SessionJSONL] 会话 ${sessionId} 回填 ${appended} 条消息到追加日志`);
  }
  return appended;
}

/**
 * 列出已有日志文件的会话 id（维护时用来决定哪些会话需要回填/可裁剪）。
 */
export async function listSessionLogs(): Promise<string[]> {
  try {
    const dir = await sessionsDir();
    const entries = await listDirectory(dir);
    return entries
      .filter((e) => !e.isDirectory && e.name.endsWith(".jsonl"))
      .map((e) => e.name.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

/**
 * 追加一条**会话级墓碑**（B-1：删会话之后索引重建会把整批会话复活）。
 *
 * ## 为什么必须有（缺陷机制，已核实）
 *
 * 删除一个会话走的是 `session.ts::deleteSession` → `domainDelete("sessions")`：
 * 它只删 **sessions 那一行**（Rust 侧再按外键级联删消息/工具调用/事件）。而
 * **JSONL 权威日志一个字节都没动**，索引重建的输入清单又来自**磁盘上的 JSONL 文件**
 * （`session-log-bridge.ts::rebuildIndexFromSessionLogs` → `listSessionLogs()`），
 * 且 Rust 侧 `messages_rebuild_index` 对 `sessions` 是**无条件 upsert**、没有任何墓碑检查 ——
 * 于是"索引崩过一次 / 写过重建标记"之后，**用户删掉的会话会整批回来**。
 *
 * 与消息墓碑同一条道理（见 `appendMessageTombstone`）：日志是权威、索引可重建，
 * 那么"删除"也必须是日志里一条**可回放**的记录 —— 否则重建方向没有删除语义。
 *
 * ## 为什么写在**会话自己的日志文件**里（而不是一个全局清单文件）
 *
 * 1. 复用消息墓碑的存放位置与格式（`deleted: true` + `role: "tombstone"`）：
 *    墓碑与它所属会话的日志同生共死，不会出现"清单与日志不一致"的第二份真相；
 * 2. `rebuildIndexFromSessionLogs` 的输入就是"每个会话的日志"，读墓碑**不需要额外一次 IO**
 *    （`readSessionMessages` 已经把这个文件读进来了）；
 * 3. 全局清单文件在"日志目录被删/迁移"时会出现孤儿状态，而按会话放则天然一致。
 */
export async function appendSessionTombstone(sessionId: string): Promise<void> {
  const task = (async () => {
    try {
      const record: JsonlMessageRecord = {
        v: LINE_VERSION,
        id: `${SESSION_TOMBSTONE_PREFIX}${sessionId}`,
        sessionId,
        role: "tombstone",
        content: "",
        timestamp: Date.now(),
        deleted: true,
      };
      await appendFile(await sessionLogPath(sessionId), JSON.stringify(record));
    } catch (e) {
      console.warn("[SessionJSONL] 追加会话墓碑失败（会话行已删除，但重建时可能复活）:", e);
    }
  })();
  // 与消息墓碑一致：登记在途，`flushSessionLogWrites()` 才等得到它（第 83 波的教训）
  pendingAppends.add(task);
  void task.finally(() => pendingAppends.delete(task));
  return task;
}

/**
 * 会话墓碑的 id 前缀。
 *
 * 为什么要有前缀：墓碑是放在**同一个 JSONL 文件**里的（`session-jsonl.ts` 的行格式
 * 是消息行），所以它必须能被一眼认出来、且不会与真实消息 id 撞车。
 * `readSessionMessages` 会把 `deleted` 行整条丢掉，因此**它不会污染消息集合**。
 */
export const SESSION_TOMBSTONE_PREFIX = "__session_deleted__:";

/** 这份记录是不是会话墓碑 */
export function isSessionTombstone(record: { id?: unknown; deleted?: unknown }): boolean {
  return (
    record?.deleted === true &&
    typeof record.id === "string" &&
    record.id.startsWith(SESSION_TOMBSTONE_PREFIX)
  );
}

/**
 * 这个会话被删除过吗（读它的日志、只看墓碑行）。
 *
 * 与 `readSessionMessages` 分开是刻意的：那个函数**会丢掉墓碑行**（后写者胜的语义），
 * 所以从它的返回值里**看不出**会话是否被删过 —— 必须单独扫一遍原始行。
 *
 * @returns true = 日志里有会话墓碑
 */
export async function isSessionDeleted(sessionId: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(await sessionLogPath(sessionId));
  } catch {
    return false; // 没有日志文件 = 没有墓碑（老会话）
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      if (isSessionTombstone(JSON.parse(trimmed))) return true;
    } catch {
      /* 坏行跳过：坏行不该被当成墓碑（宁可多复活一个会话，也不要因为一行坏数据把活会话判死） */
    }
  }
  return false;
}

/**
 * 会话被删除时同时清掉它的追加日志。
 *
 * ## ⚠️ 这**不是**删除会话的路径（B-1 结论：全仓 0 调用者是刻意的）
 *
 * 审阅时它看起来像"一个没人调用的删除函数"（0 调用者），于是很容易被误判成
 * "删除链路上漏接线了"。**不是漏接线，是它不该被接到删除链路上**：
 *
 * - 追加日志是**权威副本**（`session.ts` 头注释与 `docs` 里那条分层原则）——
 *   索引、事件日志都可以重建，日志本身**删了就不可恢复**；
 * - 会话删除必须留下**墓碑**（`appendSessionTombstone`）让"删除"成为一条可回放记录，
 *   而不是把文件抹掉 —— 抹掉之后"这个会话曾经存在且被用户删过"这件事就无从表达，
 *   而索引重建恰恰需要知道它（否则删掉的会话会整批复活）。
 *
 * 所以 `deleteSession` **不调用**它，只写墓碑。保留这个函数是给**用户显式清理**用的：
 * "删除某会话的全部本地日志"是一个合法的破坏性操作（相当于清空那个会话的历史），
 * 但它必须是用户明确要求的行为，不能被会话删除顺带触发。
 *
 * 换句话说：这个函数的调用点只有两个合法形态 —— 用户显式清理、或测试夹具。
 * 如果将来有人在"删会话"的流程里调用它，那是**回归**（会绕过墓碑 + 丢权威数据）。
 */
export async function deleteSessionLog(sessionId: string): Promise<void> {
  try {
    await deleteFile(await sessionLogPath(sessionId));
  } catch {
    /* 文件可能本来就不存在 */
  }
}

/**
 * 追加日志压缩：把日志**重写**成"每个 id 只留最新一行"（第 79 波，收尾项）。
 *
 * 为什么需要：日志是 append-only，同一条消息被更新（流式回复、工具结果）就会多一行 ——
 * 长会话下日志会持续膨胀（本机实测单会话 2.8 MB）。压缩保留语义不变（后写者胜 + 墓碑），
 * 只是把被后续版本取代的行去掉。
 *
 * 安全要求：
 *   - **先写临时文件再改名**（原子替换）—— 压缩过程中崩掉不能把日志毁掉；
 *   - 压缩后的行数必须 ≥ 唯一 id 数，否则宁可放弃（宁可不省空间，也不能丢记录）；
 *   - 压缩前等齐在途追加写（`flushSessionLogWrites`）。
 *
 * @returns 是否真的压缩了，以及压缩前后的行数
 */
export async function compactSessionLog(
  sessionId: string,
): Promise<{ compacted: boolean; linesBefore: number; linesAfter: number }> {
  const out = { compacted: false, linesBefore: 0, linesAfter: 0 };
  /**
   * ## 第 47 轮补：压缩**自己也要登记进"在途写"集合**，否则它会吃掉并发追加
   *
   * 原来的写法只做到"**开始前**等齐在途追加（`flushSessionLogWrites`）"，
   * 而压缩的读→写→改名跨越了两次 IPC await —— 这期间到达的追加写**不在**它等的集合里：
   *
   * ```text
   * 压缩: flush() 完成 ──► 读日志(await) ──► 写 .tmp(await) ──► rename 覆盖原文件
   * 追加:                          └─► appendFile 落进原文件 ──┘ ← 被 rename 覆盖，**永久丢失**
   * ```
   *
   * 触发时机很现实：维护是**应用完全可交互时**在后台跑的（`App.tsx` 的 `dbReady` 里那段
   * 浮空 async），而它会遍历所有行数 ≥200 的会话日志去压缩。用户恰好在那一刻发消息，
   * 那条消息就从**权威日志**里消失了（索引里还在，所以看不出问题 —— 直到索引被重建）。
   * 这正是本项目最在意的那类缺陷：**权威副本被"保护它的代码"弄丢**。
   *
   * 修法（最小且可验证）：
   * 1. 把这次压缩登记进 `pendingAppends`（名字没改，语义是"在途的日志写"）——
   *    那样**后到的**追加写会在 `appendSessionMessage` 里先等它（见那边的注释），
   *    于是"读→改名"这段窗口里不会再有新追加落进被覆盖的文件；
   * 2. 读到内容之后**再查一次**在途写：万一有追加在我们开始等之前就插进来了，
   *    这次压缩直接放弃（宁可不省空间，也不能丢一条消息）。
   */
  let self: Promise<unknown> | null = null;
  /** 压缩自己也在 `pendingAppends` 里（为了挡住后到的追加），查"别人"时要排掉自己 */
  const othersPending = () => [...pendingAppends].some((p) => p !== self);

  const task = (async () => {
    try {
      await flushSessionLogWrites();
      const path = await sessionLogPath(sessionId);
      let raw: string;
      try {
        raw = await readFile(path);
      } catch {
        return out;
      }
      /**
       * 读完之后再查一次：这段时间里若有**别人的**追加写登记进来，它写的是我们手里
       * 这份 raw 之后的内容，而 rename 会把它的成果覆盖掉 —— 所以放弃这次压缩。
       *
       * ⚠️ 必须排掉自己（`othersPending`）：压缩为了挡住后到的追加，会把自己也登记进
       * `pendingAppends`（见函数尾）。若这里查的是裸 `pendingAppends.size`，它永远 > 0，
       * 压缩就**永远不会执行** —— 这个自锁是我第一版写出来的，`SLOG-10` 当场抓到。
       */
      if (othersPending()) {
        console.log(
          `[SessionJSONL] 会话 ${sessionId} 日志压缩推迟：读到内容后仍有别的追加在途（宁可不压，也不丢消息）`,
        );
        return out;
      }
      const lines = raw.split("\n").filter((l) => l.trim());
      out.linesBefore = lines.length;
      if (lines.length < MIN_LOG_LINES_TO_COMPACT) return out;

      const lastById = new Map<string, string>();
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as JsonlMessageRecord;
          if (parsed && typeof parsed.id === "string") lastById.set(parsed.id, line);
        } catch {
          /* 坏行在压缩时被丢弃（它本来也读不出来） */
        }
      }
      out.linesAfter = lastById.size;
      // 安全性检查：压缩只应减少"被取代的旧行"，不能少于唯一 id 数
      if (out.linesAfter === 0 || out.linesAfter >= lines.length) return out;

      const tmp = `${path}.tmp`;
      await writeFile(tmp, [...lastById.values()].join("\n") + "\n");
      await renameFile(tmp, path);
      out.compacted = true;
      console.log(
        `[SessionJSONL] 会话 ${sessionId} 日志压缩：${out.linesBefore} 行 → ${out.linesAfter} 行（后写者胜语义不变）`,
      );
      return out;
    } catch (e) {
      console.warn("[SessionJSONL] 日志压缩失败（保留原文件）:", e);
      return out;
    }
  })();
  self = task;
  pendingAppends.add(task as unknown as Promise<void>);
  void task.finally(() => pendingAppends.delete(task as unknown as Promise<void>));
  return task;
}

/** 行数低于这个值不值得压缩 */
const MIN_LOG_LINES_TO_COMPACT = 200;

/** 测试用：直接写一份日志文件 */
export async function __writeSessionLogForTests(sessionId: string, lines: string[]): Promise<void> {
  await writeFile(await sessionLogPath(sessionId), lines.join("\n") + "\n");
}

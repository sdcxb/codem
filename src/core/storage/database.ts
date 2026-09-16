// 第 76 波：改用 **WASM** 版 sql.js。
//
// 为什么这是"治本"而不是换个体位：asm.js 版（sql-asm-memory-growth）的内存是 JS 里的一块
// 定型数组，**扩容只能整块复制**——库越大，扩容越慢、越可能分配失败；一旦失败，asm.js 会
// abort 整个模块（用户控制台那屏 `xe[…] is not a function` + `out of memory` 刷屏就是它）。
// WASM 版用的是线性内存，扩容走 `memory.grow`（页级、由引擎负责），不存在"复制整个堆"这一步，
// 内存占用也更省。代价是需要把 `sql-wasm.wasm` 随包发出去（Vite 已 assetsInclude **/*.wasm）。
//
// 兜底：万一 wasm 资源没打进包（打包/资源缺失），自动回退 asm.js —— 宁可慢，也不能打不开应用。
import initSqlJsWasm from "sql.js/dist/sql-wasm.js";
import initSqlJsAsm from "sql.js/dist/sql-asm-memory-growth.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Database as SqlJsDatabase } from "sql.js";
import { reportActionFailure } from "./persist-failure";

let db: SqlJsDatabase | null = null;
/** FTS5 可用性标志 — sql.js 可能不支持 FTS5，创建失败后避免重复报错 */
let ftsAvailable = false;

/**
 * Compaction mutual-exclusion flag.
 * When true, UI auto-save (saveMessages) must NOT touch the database
 * because compactMessages is in the middle of a multi-step DB operation
 * (delete → LLM summary → insert marker). An intervening saveMessages
 * call during the `await` gap corrupts sql.js's internal state and
 * produces "bad parameter or other API misuse" errors.
 */
let compactionInProgress = false;

/** Returns true if a compaction is currently in progress. */
export function isCompactionInProgress(): boolean {
  return compactionInProgress;
}

/** Set the compaction flag. Called by AgenticLoop.compactMessages. */
export function setCompactionInProgress(value: boolean): void {
  compactionInProgress = value;
}
// DB_STORAGE_KEY was used in old localStorage-based persistence; now using Tauri file system
// const DB_STORAGE_KEY = "codem-sqlite-db";
const DB_FILE_NAME = "codem-db.bin";

const isTauri = () => !!(window as any).__TAURI__;

async function getDbPath(): Promise<string> {
  if (isTauri()) {
    const { invoke } = (window as any).__TAURI__.core;
    const appDir: string = await invoke("get_app_data_dir");
    return `${appDir}${DB_FILE_NAME}`;
  }
  return DB_FILE_NAME;
}

/**
 * 分块 base64 编码（导出给测试：分块边界的填充错位会立刻表现为字节不一致，
 * 必须能被独立验证，而不是只靠"保存成功"这种间接证据）。
 */
export function encodeBytesToBase64(data: Uint8Array): string {
  const CHUNK = 3 * 8192; // 3 的倍数：base64 每 3 字节 → 4 字符，分块不会产生填充错位
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += CHUNK) {
    const slice = data.subarray(i, Math.min(i + CHUNK, data.length));
    let binary = "";
    for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
    parts.push(btoa(binary));
  }
  return parts.join("");
}

function uint8ToBase64(data: Uint8Array): string {
  // 分块编码后一次 join：避免旧实现先拼出一个与数据库等大的"二进制字符串"，再 btoa 出
  // 1.33 倍的第二份 —— 每次保存的峰值内存因此从 ~2.3× 降到 ~1.33×。
  // 为什么值得为此改：保存是全库导出（sql.js 只能整库 export），长会话下数据库本身就是几十 MB，
  // 峰值内存翻倍足以把渲染进程推到 OOM。
  return encodeBytesToBase64(data);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 是否脏（自上次成功导出后有写入）。用来避免"没有变化也整库导出"。 */
let dirty = false;
/** 上次成功导出的时间戳（用于合并高频写入）。 */
let lastSaveAt = 0;

/**
 * 高频写入的合并窗口：无论有多少次 persistDatabase，两次整库导出之间至少间隔这么久。
 * 为什么需要：sql.js 只能整库 export，而 telemetry / cost-tracker / autosave / 设置写入
 * 会在一次对话里触发几十次 —— 每次都导出几十 MB，峰值内存反复冲高，最终把渲染进程推爆。
 */
const MIN_SAVE_INTERVAL_MS = 2000;

/** 标记数据库已变更（所有写入路径都应调用；persistDatabase 会代为调用）。 */
export function markDatabaseDirty(): void {
  dirty = true;
}

/** 测试用：复位脏标记与节流时间戳。 */
export function __resetDirtyForTests(): void {
  dirty = false;
  lastSaveAt = 0;
}

/**
 * 致命错误（sql.js 模块已 abort / 数据库镜像损坏）判定。
 *
 * 事故现场（用户控制台）：先是
 *   `[loadAttachmentsForMessage] Failed: TypeError: xe[e[((s + 12) >> 2)]] is not a function`
 * 然后 `Error: out of memory` 刷屏，`malformed database schema (sqlite_master) - table x already exists`，
 * 接着 saveMessages / loadFeedback / store.updateSession / telemetry / readAll 全部失败 ——
 * 这是 asm.js 堆扩展失败后 **模块被 abort** 的典型级联：之后每一次调用都报同样的错，
 * 而调用方仍在无限重试（日志里同一条 OOM 出现几十次）。
 *
 * 识别出来才有可能终止级联（停止写、停止重试、给用户一条可执行说明并尽力抢救数据）。
 */
export function isFatalDbError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /out of memory|malformed database schema|database disk image is malformed|bad parameter or other API misuse|memory access out of bounds|RuntimeError: unreachable|Cannot enlarge memory|null function or function signature mismatch|table index is out of bounds|abort\(/i.test(
    msg,
  );
}

/**
 * 数据库已进入致命状态后抛出的错误。
 *
 * 第 90 波（用户现场）：`RuntimeError: memory access out of bounds`（sql-wasm 的 WASM 陷阱）
 * **不在** `isFatalDbError` 的名单里，于是：
 *   · `saveDatabase` 把它当成"磁盘满"这类可重试错误 → 一直重试；
 *   · 查询路径（`saveMessages` / `loadFeedback` / `EventLog.append` / 遥测）根本没有分类，
 *     每次调用都往已经崩掉的 WASM 堆上再撞一次，日志里同一条错误刷几十遍；
 *   · `codem:db-fatal` 从未派发 → App 的**抢救流程（把会话落到 JSON）根本没跑**，
 *     用户的 113 条消息只存在于内存里。
 * 现在这类错误被识别、闩锁，并且后续调用**不再碰堆**，直接抛这个错误（信息可读、成本为零）。
 */
export class DatabaseFatalError extends Error {
  constructor(detail = "sql.js 模块已崩溃") {
    super(
      `数据库模块已不可用（${detail}）。本次运行内不再尝试读写数据库：请重启应用；` +
        `当前会话内容已尝试抢救到磁盘（见界面提示）。`,
    );
    this.name = "DatabaseFatalError";
  }
}

/** sql.js 模块已 abort 后就再也救不回来；此标志用于停止一切写入与重试。 */
let dbFatal = false;
/** 致命错误事件名（App 监听 → 抢救当前会话 + 提示用户）。 */
export const DB_FATAL_EVENT = "codem:db-fatal";

/** 数据库是否已进入致命状态（模块不可用）。 */
export function isDatabaseFatal(): boolean {
  return dbFatal;
}

/** 复位致命状态（恢复成功后 / 测试隔离）。 */
export function resetDatabaseFatalState(): void {
  dbFatal = false;
}

function noteFatalDbError(e: unknown): void {
  if (dbFatal) return; // 只报一次：避免几十条同样的 OOM 刷屏
  dbFatal = true;
  const detail = { message: e instanceof Error ? e.message : String(e) };
  console.error("[Database] FATAL — sql.js 模块已不可用，停止写入并进入抢救流程:", detail.message);
  /**
   * 第 91 波（自愈）：留一个**不依赖数据库**的标记文件，下次启动时用它触发
   * "从权威日志重建索引"。这样"索引崩了"不再是"重启后索引里空空如也"，
   * 而是"重启后自动重建"（消息本身一直在 JSONL 里）。
   */
  void markIndexRebuildNeeded(detail.message);
  try {
    window.dispatchEvent(new CustomEvent(DB_FATAL_EVENT, { detail }));
  } catch {
    /* dispatch 失败不影响主流程 */
  }
}

/** 索引重建标记文件（写文件走 IPC，与数据库无关） */
export const INDEX_REBUILD_MARKER = "codem-index-rebuild-needed.json";

async function markIndexRebuildNeeded(reason: string): Promise<void> {
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return; // 浏览器/测试环境：跳过
    const dir = await invoke("get_app_data_dir");
    await invoke("write_file", {
      path: `${dir}${INDEX_REBUILD_MARKER}`,
      content: JSON.stringify({ reason, at: new Date().toISOString() }),
    });
    console.log("[Database] 已留索引重建标记（下次启动将自动从权威日志重建索引）");
  } catch (e) {
    console.warn("[Database] 写索引重建标记失败（不影响抢救流程）:", e);
  }
}

/** 是否存在"需要重建索引"的标记（启动维护用） */
export async function indexRebuildNeeded(): Promise<{ needed: boolean; reason?: string }> {
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return { needed: false };
    const dir = await invoke("get_app_data_dir");
    const path = `${dir}${INDEX_REBUILD_MARKER}`;
    const exists = await invoke("path_exists", { path });
    if (!exists) return { needed: false };
    let reason: string | undefined;
    try {
      const raw = await invoke("read_file", { path });
      reason = JSON.parse(raw)?.reason;
    } catch {
      /* 内容读不出来也照样重建 */
    }
    return { needed: true, reason };
  } catch {
    return { needed: false };
  }
}

/** 清除重建标记（重建成功后调用） */
export async function clearIndexRebuildMarker(): Promise<void> {
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (!invoke) return;
    const dir = await invoke("get_app_data_dir");
    await invoke("delete_file", { path: `${dir}${INDEX_REBUILD_MARKER}` });
  } catch {
    /* 删不掉也无害：重建是幂等的 */
  }
}

/**
 * 查询路径的致命错误上报入口（第 90 波）。
 *
 * `saveDatabase` 只覆盖"写盘"这一步；而用户现场里最先炸的是**查询**路径
 * （`saveMessages` 批量写、`loadFeedback`、`EventLog.append`、遥测 flush）。
 * 那些地方各自 catch 一下就过去了，没人分类 → 闩锁永远不生效。
 * 现在这些 catch 统一调用这里；更彻底的一道保险是 `installFatalGuard()`：
 * 直接包住 `db.exec/run/prepare`，**任何** WASM 陷阱都会在此闩锁。
 */
export function noteDatabaseError(e: unknown): boolean {
  if (!isFatalDbError(e)) return false;
  noteFatalDbError(e);
  return true;
}

/**
 * 给 sql.js 实例装上"致命陷阱"护栏（第 90 波）。
 *
 * 两个作用：
 *  1. **分类**：任何 `exec/run/prepare` 抛出的 WASM 陷阱（memory access out of bounds 等）
 *     立即闩锁致命状态并派发 `codem:db-fatal` → App 抢救会话；
 *  2. **止血**：闩锁之后再调用直接抛 `DatabaseFatalError`，**不再进入已崩掉的 WASM 堆**
 *     （原来每次调用都真撞一次，日志刷屏 + CPU 白烧）。
 */
function installFatalGuard(target: any): void {
  if (!target || target.__fatalGuardInstalled) return;
  for (const method of ["exec", "run", "prepare"] as const) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = function guardedDbCall(...args: any[]) {
      if (dbFatal) throw new DatabaseFatalError();
      try {
        return original.apply(this, args);
      } catch (e) {
        noteDatabaseError(e);
        throw e;
      }
    };
  }
  target.__fatalGuardInstalled = true;
}

/**
 * 测试入口：把护栏装到任意"类 sql.js 对象"上（用于验证分类/闩锁/止血三条语义）。
 * 生产代码只在 `initDatabase()` 里对本进程唯一的 DB 实例调用一次。
 */
export function __installFatalGuardForTests(target: any): void {
  installFatalGuard(target);
}

/**
 * 整库导出的硬上限（第 91 波）。
 *
 * 单次 `db.export()` 会在 WASM 堆里分配一整份库大小的缓冲再复制出来；库越大，
 * "内存访问越界 / Cannot enlarge memory" 的风险越高。超过这个值就不再整库落盘，
 * 改为"只写权威日志 + 下次启动重建索引"（数据不丢，索引可重建）。
 * 256MB 是个保守值：正常使用（含大文档会话）远低于它。
 */
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
/** 本次运行内是否已因超限暂停整库导出 */
let exportSuspended = false;

/** 诊断用：整库导出是否已暂停（测试与状态面板用） */
export function isWholeFileExportSuspended(): boolean {
  return exportSuspended;
}
async function saveDatabase(force = false): Promise<void> {
  if (!db || dbFatal) return;
  // 没有变化就不导出：整库 export 是最贵的一步
  if (!dirty && !force) return;
  try {
    if (!isTauri()) {
      console.warn("[Database] Browser mode, cannot save");
      return;
    }
    const data = db.export();
    /**
     * 第 91 波（存储压力）：整库导出是**单次 O(库大小) 的 WASM 分配 + 复制**，
     * 库越大越危险（这正是"内存访问越界"最可能的触发点）。
     * 超过上限时**不再整库导出**：权威日志（JSONL）本来就在持续落盘，
     * 索引丢掉也能在下次启动时重建 —— 宁可暂时不落盘索引，也不能把 WASM 堆撞死。
     */
    if (data.length > MAX_EXPORT_BYTES) {
      if (!exportSuspended) {
        exportSuspended = true;
        const mb = (data.length / 1024 / 1024).toFixed(0);
        const limitMb = (MAX_EXPORT_BYTES / 1024 / 1024).toFixed(0);
        console.warn(
          `[Database] 索引库已达 ${mb} MB（超过整库落盘上限 ${limitMb} MB）—— 本次运行内**暂停整库导出**，` +
            `消息仍会持续写入权威日志（JSONL）；索引将在下次启动时从日志重建。请清理不再需要的旧会话或附件。`,
        );
        reportActionFailure(
          "database.wholeFileExportSuspended",
          new Error(`索引库 ${mb} MB 超过上限 ${limitMb} MB`),
          "已切换为「只写权威日志」模式：数据不丢，但本次运行内索引不再落盘（下次启动自动重建）",
        );
      }
      dirty = false; // 别让调度器一直重试
      return;
    }
    const { invoke } = (window as any).__TAURI__.core;
    const path = await getDbPath();
    // 原子写：先写临时文件再改名覆盖。
    // 为什么必须这样：整库 base64 写到一半被杀进程/断电，磁盘上就是一个"半截 DB"，
    // 下次启动会报 malformed database schema（本仓库里那个 codem-db-broken.bin 就是这么来的）。
    const tmpPath = `${path}.tmp`;
    const base64 = uint8ToBase64(data);
    await invoke("write_file", { path: tmpPath, content: base64, encoding: "base64" });
    await invoke("rename_file", { oldPath: tmpPath, newPath: path });
    dirty = false;
    lastSaveAt = Date.now();
    console.debug(`[Database] Saved ${data.length} bytes to file`);
    noteSaveSucceeded();
  } catch (e) {
    if (isFatalDbError(e)) {
      noteFatalDbError(e);
      return; // 不再重试：模块已死，重试只会继续刷屏
    }
    // 不 rethrow（保持写链不中断），但必须让失败可见：
    // 之前这里仅 console.error，磁盘满/权限问题导致保存持续失败时
    // 调用方（含退出前 flushDatabase）完全无感知 —— 静默丢数据。
    notifySaveFailure(e);
  }
}

// ===== 保存失败可见性（对标 dsh：持久化失败必须可诊断、可恢复）=====
// 磁盘满 / 文件被占用等场景下写盘失败：首次失败 dispatch 事件让 UI 提示
// 用户（而不是静默丢弃），随后失败限流不刷屏，并安排一次 3s 重试
// （临时性故障如瞬时占用可能自愈）；任何一次成功即复位，下次失败重新提示。

/** 保存失败事件名（App.tsx 监听 → guidance 提示）。 */
export const DB_SAVE_FAILED_EVENT = "codem:db-save-failed";
/** 保存恢复事件名（从失败状态回到成功时触发）。 */
export const DB_SAVE_RECOVERED_EVENT = "codem:db-save-recovered";

/** 上次保存是否失败（用于限流与恢复判定）。 */
let lastSaveFailed = false;
/** 失败后的一次性重试定时器。 */
let saveRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** 导出供测试断言当前失败状态。 */
export function isLastSaveFailed(): boolean {
  return lastSaveFailed;
}

/** 复位保存失败状态并清除挂起的重试定时器（退出/测试隔离场景）。 */
export function resetSaveFailureState(): void {
  lastSaveFailed = false;
  if (saveRetryTimer) {
    clearTimeout(saveRetryTimer);
    saveRetryTimer = null;
  }
}

function notifySaveFailure(e: unknown): void {
  const firstFailure = !lastSaveFailed;
  lastSaveFailed = true;
  if (firstFailure) {
    const detail = { message: e instanceof Error ? e.message : String(e) };
    try {
      window.dispatchEvent(new CustomEvent(DB_SAVE_FAILED_EVENT, { detail }));
    } catch {
      // dispatch 失败（极端环境）不影响主流程。
    }
  }
  console.error("[Database] Failed to save:", e);
  if (!saveRetryTimer) {
    saveRetryTimer = setTimeout(() => {
      saveRetryTimer = null;
      if (lastSaveFailed) {
        // 重试一次：saveDatabase 内部失败会再次通知（已限流，不刷屏）。
        enqueueSave().catch(() => {});
      }
    }, 3000);
  }
}

function noteSaveSucceeded(): void {
  if (!lastSaveFailed) return;
  lastSaveFailed = false;
  try {
    window.dispatchEvent(new CustomEvent(DB_SAVE_RECOVERED_EVENT));
  } catch {
    // 同上，忽略。
  }
}

let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
/** True while a debounced save is scheduled or in flight; used by flushDatabase. */
let saveScheduled = false;
/** Serializes all database writes so concurrent saves never overlap on the same file. */
let saveChain: Promise<void> = Promise.resolve();

/** Queue a save behind any in-flight save; failures don't break the chain. */
function enqueueSave(force = false): Promise<void> {
  const run = saveChain.then(() => saveDatabase(force));
  saveChain = run.catch(() => {});
  return run;
}

function saveDatabaseAsync(): void {
  if (dbFatal) return; // 模块已死：不再调度任何写入
  // Debounce: if multiple writes happen in quick succession (e.g. createSession + updateProject),
  // only persist once after the last write
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveScheduled = true;
  // 与上次成功导出至少间隔 MIN_SAVE_INTERVAL_MS：把"对话里的几十次写入"合并成少数几次整库导出
  const sinceLast = Date.now() - lastSaveAt;
  const delay = Math.max(500, MIN_SAVE_INTERVAL_MS - sinceLast);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    saveScheduled = false;
    enqueueSave().catch(e => console.error("[Database] Async save failed:", e));
  }, delay);
}

async function loadDatabaseFromStorage(): Promise<Uint8Array | null> {
  try {
    if (!isTauri()) {
      console.warn("[Database] Browser mode detected, database not available");
      return null;
    }
    
    const { invoke } = (window as any).__TAURI__.core;
    const path = await getDbPath();
    try {
      const base64: string = await invoke("read_file", { path, encoding: "base64" });
      if (base64 && base64.length > 100) {
        const data = base64ToUint8(base64);
        // Validate: SQLite files start with "SQLite format 3"
        const header = String.fromCharCode(...data.slice(0, 16));
        if (header.startsWith("SQLite format")) {
          console.log(`[Database] Loaded ${data.length} bytes from file`);
          return data;
        } else {
          console.warn("[Database] File exists but is not valid SQLite, will create new database");
        }
      }
    } catch {
      // File doesn't exist, will create new database
    }
    return null;
  } catch (e) {
    console.error("[Database] Failed to load:", e);
    return null;
  }
}

/** Back up a corrupt database file before it is discarded, so data can be recovered manually. */
async function backupCorruptDatabase(data: Uint8Array): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const path = await getDbPath();
    const backupPath = `${path}.corrupt-${Date.now()}`;
    const base64 = uint8ToBase64(data);
    await invoke("write_file", { path: backupPath, content: base64, encoding: "base64" });
    console.warn(`[Database] Corrupt database backed up to ${backupPath}`);
  } catch (e) {
    console.warn("[Database] Failed to back up corrupt database:", e);
  }
}

/** Remove the corrupt database file so the next launch doesn't re-read it. */
async function discardCorruptDatabase(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const path = await getDbPath();
    await invoke("delete_file", { path });
    console.warn(`[Database] Corrupt database file removed: ${path}`);
  } catch (e) {
    console.warn("[Database] Failed to remove corrupt database file:", e);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
  pinned INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  timestamp INTEGER NOT NULL,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  status TEXT DEFAULT 'done',
  generated_files TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  result TEXT,
  status TEXT DEFAULT 'pending',
  metadata TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT,
  content TEXT,
  preview TEXT,
  sandbox_path TEXT,
  mime_type TEXT,
  size INTEGER,
  added_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  url TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expiry INTEGER,
  org_id TEXT,
  is_active INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT,
  messages TEXT NOT NULL DEFAULT '[]',
  total_usage TEXT NOT NULL DEFAULT '{"promptTokens":0,"completionTokens":0,"cost":0}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_data (
  session_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_file_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  before_tree TEXT,
  after_tree TEXT,
  patch TEXT,
  changed_files TEXT,
  patch_sha256 TEXT,
  current_brief TEXT,
  status TEXT DEFAULT 'completed',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  domain TEXT NOT NULL,
  scope TEXT NOT NULL,
  skills TEXT,
  experience_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS needs_you_pending (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  confirmed_facts TEXT,
  options TEXT,
  resume_path TEXT,
  iteration INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  message_type TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'pending',
  sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  duration INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  summary TEXT,
  summary_status TEXT DEFAULT 'pending',
  source_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notebook_sources (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT,
  file_path TEXT,
  url TEXT,
  mime_type TEXT,
  size INTEGER,
  status TEXT DEFAULT 'pending',
  chunk_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notebook_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  embedding BLOB,
  token_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES notebook_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_cost_records_session ON cost_records(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_timestamp ON cost_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook ON notebook_sources(notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_chunks_notebook ON notebook_chunks(notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_chunks_source ON notebook_chunks(source_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_type TEXT DEFAULT 'markdown',
  tags TEXT,
  pin_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES notebook_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS note_links (
  id TEXT PRIMARY KEY,
  source_note_id TEXT NOT NULL,
  target_note_id TEXT NOT NULL,
  link_text TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebook_id);
CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_note_id);

-- A8: Flashcards table for spaced repetition
CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  note_id TEXT,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  tags TEXT,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 0,
  repetitions INTEGER NOT NULL DEFAULT 0,
  next_review INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_flashcards_notebook ON flashcards(notebook_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_review ON flashcards(next_review);

CREATE TABLE IF NOT EXISTS delegation_tasks (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_delegation_source ON delegation_tasks(source_session_id);
CREATE INDEX IF NOT EXISTS idx_delegation_target ON delegation_tasks(target_session_id);
CREATE INDEX IF NOT EXISTS idx_delegation_project ON delegation_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_delegation_status ON delegation_tasks(status);

-- ========== 知识图谱表 ==========
-- 借鉴思路来源: Understand-Anything (https://github.com/Egonex-AI/Understand-Anything)
-- 该项目使用 React Flow + JSON 文件存储图谱数据;
-- 我们自研实现: 使用 SQLite 存储图谱节点和边, Canvas 渲染力导向图

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  label TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'concept',
  description TEXT,
  source_ids TEXT,
  chunk_ids TEXT,
  weight REAL DEFAULT 1.0,
  community_id INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'related',
  weight REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_notebook ON graph_nodes(notebook_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_notebook ON graph_edges(notebook_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_node_id);

-- A14: 笔记本分组/文件夹
CREATE TABLE IF NOT EXISTS notebook_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES notebook_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notebook_groups_parent ON notebook_groups(parent_id);

-- A17: 笔记版本历史 (快照与回滚)
CREATE TABLE IF NOT EXISTS note_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  version_note TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id);

-- P0: Message feedback (like / dislike)
--
-- P5 第 1 段（列级契约修正）：note / version / created_at / updated_at 四列
-- 原来是在 llm/feedback.ts 的 ensureNoteColumn() 里用**运行期**
-- ALTER TABLE … ADD COLUMN 加的 —— 这几条 ALTER 对 gen-schema-sql.mjs **不可见**
-- （它只读 SCHEMA），所以 Rust 侧的库根本没有这四列，而 putMessageFeedback()
-- 却按九列写入 → Rust 引擎直接拒收（实测报错：表 message_feedback 没有列 created_at）。
-- 也就是说：宽松版反馈（评分 + 备注 + 乐观并发版本）在 Rust 路径下**写不进去**。
-- 真源必须显式声明这些列；老库由 migrations 里的 ALTER 补齐（幂等）。
--
-- 注意：注释里**不要**出现反引号 —— SCHEMA 是模板字符串，反引号会提前把它结束掉。
CREATE TABLE IF NOT EXISTS message_feedback (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  feedback TEXT NOT NULL CHECK (feedback IN ('like', 'dislike')),
  timestamp INTEGER NOT NULL,
  note TEXT,
  version TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_feedback_message ON message_feedback(message_id);

-- P0: Quick phrases for template inputs
CREATE TABLE IF NOT EXISTS quick_phrases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  usage_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quick_phrases_category ON quick_phrases(category);

-- P1: Prompt drafts for version management
CREATE TABLE IF NOT EXISTS prompt_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  tags TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prompt_drafts_session ON prompt_drafts(session_id);

-- P1: Todo lists from todo_display tool
CREATE TABLE IF NOT EXISTS todo_lists (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  todos TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_todo_lists_session ON todo_lists(session_id);

CREATE TABLE IF NOT EXISTS squads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  leader_agent_id TEXT NOT NULL,
  instructions TEXT,
  project_id TEXT,
  archived INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS squad_members (
  id TEXT PRIMARY KEY,
  squad_id TEXT NOT NULL,
  member_type TEXT NOT NULL DEFAULT 'agent',
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  role_description TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_squad_members_squad ON squad_members(squad_id);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT DEFAULT 'normal',
  assignee_type TEXT,
  assignee_id TEXT,
  project_id TEXT,
  squad_id TEXT,
  session_id TEXT,
  labels TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'user',
  author_id TEXT,
  author_name TEXT,
  content TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_squad ON issues(squad_id);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  source_type TEXT,
  source_id TEXT,
  project_id TEXT,
  squad_id TEXT,
  issue_id TEXT,
  priority TEXT DEFAULT 'normal',
  read INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_read ON inbox(read);
CREATE INDEX IF NOT EXISTS idx_inbox_project ON inbox(project_id);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox(created_at);

-- ========== P0-1: Event Sourcing — append-only session event log ==========
-- Design (对标 DeepSeek Harness event-sourcing):
-- - Events are the source of truth; messages are derived projections
-- - Append-only: events are never deleted or updated (except on session deletion)
-- - Supports replay, fork, and projection
CREATE TABLE IF NOT EXISTS session_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq);

-- ========== P2-12: Goals table for goal-driven auto-continuation ==========
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT DEFAULT 'normal',
  parent_id TEXT,
  success_criteria TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES goals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

-- ========== P2-14: Telemetry events table ==========
CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_data TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_events(session_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_name ON telemetry_events(event_name);
`;

/** sql.js 模块（initSqlJs 的解析结果）。缓存下来供 importDatabase 复用。 */
let sqlJsModule: any = null;
/** 实际使用的引擎（wasm / asm）——日志与诊断用。 */
let engineKind: "wasm" | "asm" | "unknown" = "unknown";

/** 当前引擎类型（测试与诊断）。 */
export function getDatabaseEngine(): "wasm" | "asm" | "unknown" {
  return engineKind;
}

/**
 * 初始化 sql.js：优先 WASM，失败则回退 asm.js（并说明原因，不静默）。
 * 测试环境（vitest，MODE=test）直接用 asm：wasm 资源在 Node 下要读磁盘文件，没必要拖慢测试。
 */
async function loadSqlJsEngine(): Promise<any> {
  const isTest = (import.meta as any)?.env?.MODE === "test" || (import.meta as any)?.env?.VITEST === "true";
  if (isTest) {
    engineKind = "asm";
    return await initSqlJsAsm();
  }
  try {
    const mod = await initSqlJsWasm({ locateFile: () => sqlWasmUrl });
    engineKind = "wasm";
    console.log(`[Database] sql.js 引擎：wasm（${sqlWasmUrl}）`);
    return mod;
  } catch (e) {
    console.warn("[Database] wasm 引擎初始化失败，回退 asm.js（内存增长靠整块复制，大库下更脆弱）:", e);
    engineKind = "asm";
    return await initSqlJsAsm();
  }
}

export async function initDatabase(): Promise<SqlJsDatabase> {
  if (db) return db;

  const SQL = await loadSqlJsEngine();
  sqlJsModule = SQL;

  const existingData = await loadDatabaseFromStorage();
  if (existingData) {
    try {
      db = new SQL.Database(existingData) as SqlJsDatabase;
      // Verify the loaded database is not corrupt. If it is, back up the bad file and rebuild
      // fresh instead of running on a broken database (which surfaces as
      // "database disk image is malformed" on the next query).
      const check = db.exec("PRAGMA quick_check");
      const result = check?.[0]?.values?.[0]?.[0]?.toString() ?? "ok";
      if (result !== "ok") {
        console.error(`[Database] Integrity check failed (${result}), backing up corrupt database and recreating`);
        await backupCorruptDatabase(existingData);
        await discardCorruptDatabase();
        db.close();
        db = new SQL.Database() as SqlJsDatabase;
        console.log("[Database] Created new database after corruption recovery");
      } else {
        console.log("[Database] Loaded existing database");
      }
    } catch (e) {
      console.error("[Database] Failed to open database, backing up corrupt file and recreating:", e);
      await backupCorruptDatabase(existingData);
      await discardCorruptDatabase();
      try { db?.close(); } catch { /* already closed */ }
      db = new SQL.Database() as SqlJsDatabase;
      console.log("[Database] Created new database after corruption recovery");
    }
  } else {
    db = new SQL.Database() as SqlJsDatabase;
    console.log("[Database] Created new database");
  }

  db.run("PRAGMA foreign_keys = ON");
  // 第 90 波：装上致命陷阱护栏（分类 + 闩锁 + 止血），必须在任何业务查询之前
  installFatalGuard(db);
  db.run(SCHEMA);

  // FTS full-text search table — created using fts4 for compatibility with sql.js
  // (sql.js does not include FTS5 support). FTS4 supports the same core features:
  // MATCH, snippet(), UNINDEXED columns, and unicode61 tokenizer.
  try {
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts4(
  session_id UNINDEXED,
  message_id UNINDEXED,
  content,
  role,
  timestamp UNINDEXED,
  tokenize=unicode61
);`);
    ftsAvailable = true;
  } catch (e) {
    console.warn("[Database] FTS not supported, session full-text search will be unavailable:", e);
    ftsAvailable = false;
  }

  // Seed a global project record (id="") so that global chat sessions
  // (projectId="") satisfy the sessions.project_id foreign key constraint.
  // Without this, createSession / createMessage silently fail for global chats.
  try {
    db.run(
      "INSERT OR IGNORE INTO projects (id, name, path, description, pinned, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["", "全局对话", "", "Global chat (no project context)", 0, Date.now(), Date.now()]
    );
  } catch (e) {
    console.warn("[Database] Failed to seed global project:", e);
  }

  // Migrations
const migrations = [
"ALTER TABLE messages ADD COLUMN reasoning TEXT",
"ALTER TABLE messages ADD COLUMN generated_files TEXT",
"ALTER TABLE messages ADD COLUMN retrieved_sources TEXT",
"ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0",
"ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0",
"ALTER TABLE attachments ADD COLUMN message_id TEXT",
"ALTER TABLE attachments ADD COLUMN preview TEXT",
"ALTER TABLE attachments ADD COLUMN sandbox_path TEXT",
"ALTER TABLE notebook_sources ADD COLUMN summary TEXT",
"ALTER TABLE notebook_sources ADD COLUMN key_topics TEXT",
"ALTER TABLE notebooks ADD COLUMN group_id TEXT",
"ALTER TABLE messages ADD COLUMN parent_message_id TEXT",
"ALTER TABLE messages ADD COLUMN metadata TEXT",
"ALTER TABLE sessions ADD COLUMN correction_mode INTEGER DEFAULT 0",
"ALTER TABLE sessions ADD COLUMN deep_thinking_mode INTEGER DEFAULT 0",
"ALTER TABLE sessions ADD COLUMN preserve_executor INTEGER DEFAULT 0",
"ALTER TABLE sessions ADD COLUMN execution_mode TEXT",
"ALTER TABLE sessions ADD COLUMN worktree_path TEXT",
"ALTER TABLE sessions ADD COLUMN worktree_branch TEXT",
"ALTER TABLE sessions ADD COLUMN parent_id TEXT", // R3-2.2: Fork support
"ALTER TABLE sessions ADD COLUMN sort_order INTEGER DEFAULT 0", // P2 #29: session reordering
"ALTER TABLE messages ADD COLUMN hidden INTEGER DEFAULT 0", // Soft-delete for compaction: hidden messages stay in DB for history viewing but are excluded from LLM context
"ALTER TABLE tool_calls ADD COLUMN metadata TEXT", // 工具执行元数据（如 subagentId 等）
// P5 第 1 段：这四列原来只在 `llm/feedback.ts` 里运行期 ALTER，真源与 Rust 侧都没有，
// 导致宽松版反馈在 Rust 引擎下写不进去（详见 message_feedback 建表处的注释）。
"ALTER TABLE message_feedback ADD COLUMN note TEXT",
"ALTER TABLE message_feedback ADD COLUMN version TEXT",
"ALTER TABLE message_feedback ADD COLUMN created_at INTEGER",
"ALTER TABLE message_feedback ADD COLUMN updated_at INTEGER",
];
  for (const sql of migrations) {
    try { db.run(sql); } catch (e) { /* column already exists */ }
  }

  // Fix corrupted reasoning values
  try {
    db.run("UPDATE messages SET reasoning = NULL WHERE reasoning IS NOT NULL AND reasoning GLOB '[0-9]*' AND LENGTH(reasoning) >= 10");
  } catch (e) {
    console.warn("[Database] Failed to fix corrupted reasoning:", e);
  }

  await enqueueSave(true);
  return db;
}

export async function resetDatabase(): Promise<SqlJsDatabase> {
  if (db) {
    db.close();
    db = null;
  }
  if (isTauri()) {
    const { invoke } = (window as any).__TAURI__.core;
    const path = await getDbPath();
    try { await invoke("delete_file", { path }); } catch (e) { console.warn('[database.ts]', e) }
  }
  return initDatabase();
}

export function getDatabase(): SqlJsDatabase {
  if (dbFatal) throw new DatabaseFatalError();
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export function persistDatabase(): void {
  markDatabaseDirty();
  saveDatabaseAsync();
}

/** Flush any pending debounced save immediately. Resolves when the pending write chain has
 *  settled, so callers (e.g. close-requested) can await it before quitting. */
export function flushDatabase(): Promise<void> {
  if (dbFatal) return saveChain; // 模块已死：不再尝试写盘
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  saveScheduled = false;
  // 退出/关窗路径必须**强制**写一次：即使此刻不脏（或节流窗口没到），也要保证最后状态落盘。
  enqueueSave(true);
  return saveChain;
}

export function isFts5Available(): boolean {
  return ftsAvailable;
}

/** 数据库文件占用（页数 × 页大小）——维护前后对比用，不需要 VACUUM 也能读。 */
export function databaseSizeBytes(): number {
  if (!db) return 0;
  try {
    const pageCount = db.exec("PRAGMA page_count")?.[0]?.values?.[0]?.[0] as number | undefined;
    const pageSize = db.exec("PRAGMA page_size")?.[0]?.values?.[0]?.[0] as number | undefined;
    if (!pageCount || !pageSize) return 0;
    return pageCount * pageSize;
  } catch {
    return 0;
  }
}

export interface MaintenanceResult {
  sizeBefore: number;
  sizeAfter: number;
  reclaimed: number;
  prunedEvents: number;
  prunedTelemetry: number;
  vacuumed: boolean;
  /** 本次被快照式压缩的会话数（第 77 波） */
  compactedSessions: number;
  /** 本次回填进追加日志的消息数（第 78 波） */
  backfilledMessages: number;
  /** 本次**从权威日志重建进索引**的消息数（第 91 波：崩溃自愈） */
  rebuiltIndexMessages: number;
  /** 本次从 SQLite 索引裁剪掉的消息数（第 78 波） */
  trimmedIndexMessages: number;
}

/**
 * 数据库维护：裁剪"只增不减"的表 + VACUUM 回收文件空间（第 76 波）。
 *
 * 为什么必须做：本地库是**整库常驻内存**的（sql.js），表只增不减 → 库越大，
 * 每次保存的导出/编码峰值越大，最终推爆渲染进程（用户报的 out of memory）。
 * 本机实测：`session_events` 3.8 MB（2130 行）、`tool_calls.result` 2.6 MB。
 *
 * 取舍（诚实说明）：
 *   - `session_events` 是事件溯源的日志，用于回放/分叉；这里**每会话保留最新 N 条**，
 *     更早的事件删除。老会话的历史细节会让位给"应用还能跑"。
 *   - `telemetry_events` 是本地遥测，只保留最近若干天。
 *   - 删除后 `VACUUM` 才能真正把文件缩小（SQLite 的删除只把页标记为空闲）。
 */
/**
 * 数据库维护：清理**只增不减且只写不读语义**的数据 + VACUUM 回收文件空间（第 76 波）。
 *
 * 为什么必须做：本地库是**整库常驻内存**的（sql.js），库越大，每次保存的导出/编码峰值越大，
 * 最终推爆渲染进程（用户报的 out of memory）。
 *
 * ⚠️ 审计发现（本波自查，重要）：**默认不再裁剪 `session_events`**。
 * 事件日志不是"日志"，而是**被当作状态读取**的：`event-projection.ts`（4 处）从事件重建投影、
 * `runtime-invariants.ts` 靠回放检查不变量、`preset-discovery` / `feedback` / `postmortem` /
 * `time-context` / `session-search` / `ui-trajectory` / `sync-engine` 都在 readAll。
 * 按 seq 截断尾部会让投影缺段、让不变量检查看到"事件序列不完整" —— 那是**悄悄改数据**，
 * 不是维护。要安全缩小事件日志，正确做法是**写快照事件**（把投影状态固化成一个
 * `session_snapshot` 事件）之后再丢掉快照之前的事件；那是一次需要设计的事（见 CHANGELOG 的
 * "留给下一波"）。因此这里把 `keepEventsPerSession` 默认设为 `0`（不裁剪），保留参数供
 * 快照式压缩落地后显式开启。
 *
 * 会做的清理：
 *   - `telemetry_events`：本地遥测，按天保留（只用于本地统计，删除不影响任何状态重建）；
 *   - `VACUUM`：删除后回收文件空间（带两个护栏，见下）。
 */
export async function runDatabaseMaintenance(
  opts: {
    keepEventsPerSession?: number;
    keepTelemetryDays?: number;
    vacuumMaxBytes?: number;
    /** 事件数超过该值的会话会被**快照式压缩**（0 = 关闭） */
    compactEventsOver?: number;
    /** 每个会话在 SQLite 索引里至少保留多少条消息（0 = 不裁剪索引）（第 78 波） */
    keepIndexedMessages?: number;
  } = {},
): Promise<MaintenanceResult> {
  /** 0 = 不裁剪事件（默认）：事件日志被投影/不变量当作状态读取，见上面的说明 */
  const keepEvents = opts.keepEventsPerSession ?? 0;
  const keepTelemetryDays = opts.keepTelemetryDays ?? 7;
  /** 超过这个体积就不在启动路径上 VACUUM（它在内存里整库重写一遍，大库会卡界面） */
  const vacuumMaxBytes = opts.vacuumMaxBytes ?? 256 * 1024 * 1024;
  /**
   * 快照式压缩阈值（第 77 波）：事件超过这个条数的会话才压缩。
   * 默认 5000 —— 压缩本身也要代价，只对"确实很大"的会话做；
   * 之所以现在敢默认开启，是因为压缩走的是"先写快照再删旧事件"，
   * 回放等价性有 `snapshot-compaction.test.ts` 的 SNAP-2 守着。
   */
  const compactEventsOver = opts.compactEventsOver ?? 5000;
  /** 索引保留窗口：常用会话（≤500 条）完全不会触发裁剪 */
  const keepIndexedMessages = opts.keepIndexedMessages ?? 500;
  const result: MaintenanceResult = {
    sizeBefore: databaseSizeBytes(),
    sizeAfter: 0,
    reclaimed: 0,
    prunedEvents: 0,
    prunedTelemetry: 0,
    vacuumed: false,
    compactedSessions: 0,
    backfilledMessages: 0,
    rebuiltIndexMessages: 0,
    trimmedIndexMessages: 0,
  };
  if (!db || dbFatal) return { ...result, sizeAfter: result.sizeBefore };

  try {
    if (compactEventsOver > 0) {
      result.compactedSessions = await compactOversizedSessionLogs(compactEventsOver);
    }

    // 第 78 波：先把历史回填进**追加日志**（权威存储），再裁剪 SQLite 索引。
    // 顺序不能反 —— 裁剪的耐久性检查依赖日志里已经有这些消息。
    //
    // 注意（第 80 波审计修正）：回填、附件预热、日志压缩**不能被"是否裁剪索引"这个开关挡住** ——
    // 我曾把它们一起塞进 `if (keepIndexedMessages > 0)`，于是关掉裁剪时附件不预热（同步读取拿不到
    // 外置内容）、日志也不压缩。只有"裁剪索引"这一步该受开关控制，其余是常规维护。
    try {
      const bridge = await import("./session-log-bridge");

      // 第 91 波（自愈）：上次崩溃留下的标记 → 先**从权威日志重建索引**，再回填/裁剪。
      // 顺序很重要：重建补回索引里缺的消息，回填再保证日志覆盖索引（双向对齐）。
      try {
        const marker = await indexRebuildNeeded();
        if (marker.needed) {
          console.log(`[Database] 检测到索引重建标记（原因：${marker.reason || "未知"}）—— 从权威日志重建索引`);
          const rebuilt = await bridge.rebuildIndexFromSessionLogs();
          result.rebuiltIndexMessages = rebuilt.messages;
          await clearIndexRebuildMarker();
        }
      } catch (e) {
        console.warn("[Database] 索引重建失败（保留标记，下次再试）:", e);
      }

      result.backfilledMessages = await bridge.backfillAllSessions();

      if (keepIndexedMessages > 0) {
        const trimmed = await bridge.trimIndexedMessages({ keepPerSession: keepIndexedMessages });
        result.trimmedIndexMessages = trimmed.deletedMessages;
        if (trimmed.deletedMessages > 0 || trimmed.skippedSessions > 0) {
          console.log(
            `[Database] 追加日志：索引裁剪 ${trimmed.deletedMessages} 条` +
              `（跳过 ${trimmed.skippedSessions} 个会话：日志尚未覆盖）`,
          );
        }
      }
      if (result.backfilledMessages > 0) {
        console.log(`[Database] 追加日志：回填 ${result.backfilledMessages} 条历史`);
      }

      const attachments = await bridge.hydrateAllAttachments();
      if (attachments.warmed > 0 || attachments.orphansRemoved > 0) {
        console.log(
          `[Database] 外置附件：预热 ${attachments.warmed} 个，清理孤儿文件 ${attachments.orphansRemoved} 个`,
        );
      }

      const compactedLog = await bridge.compactOversizedSessionLogs();
      if (compactedLog.compactedSessions > 0) {
        console.log(
          `[Database] 追加日志压缩：${compactedLog.compactedSessions} 个会话，省下 ${compactedLog.linesSaved} 行`,
        );
      }
    } catch (e) {
      console.warn("[Database] 追加日志/附件维护失败（跳过）:", e);
    }

    if (keepEvents > 0) {
      // 显式开启时也**永不裁剪 session_meta**（预设归属/反馈状态靠它）。
      // 只有事件日志改为"快照 + 截断"之后，这个开关才应该被打开。
      db.run(
        `DELETE FROM session_events WHERE event_type <> 'session_meta' AND seq NOT IN (
           SELECT seq FROM session_events se2
           WHERE se2.session_id = session_events.session_id
           ORDER BY seq DESC LIMIT ?
         )`,
        [keepEvents],
      );
      result.prunedEvents = Number(db.exec("SELECT changes()")?.[0]?.values?.[0]?.[0] ?? 0);
    }

    const cutoff = Date.now() - keepTelemetryDays * 24 * 60 * 60 * 1000;
    db.run("DELETE FROM telemetry_events WHERE timestamp < ?", [cutoff]);
    result.prunedTelemetry = Number(db.exec("SELECT changes()")?.[0]?.values?.[0]?.[0] ?? 0);

    if (result.prunedEvents > 0 || result.prunedTelemetry > 0) {
      // VACUUM 会把整库在内存里重写一遍：只有"真有可回收空间"且库不算大时才做 ——
      // 否则宁可不回收，也不能在启动路径上卡住界面（这正是本波要治的那类自我伤害）。
      const freeRatio = freePageRatio();
      if (result.sizeBefore > vacuumMaxBytes) {
        console.log(
          `[Database] 跳过 VACUUM：库 ${(result.sizeBefore / 1024 / 1024).toFixed(0)} MB 超过阈值 ` +
            `${(vacuumMaxBytes / 1024 / 1024).toFixed(0)} MB（VACUUM 需整库重写）。空闲页 ${(freeRatio * 100).toFixed(1)}%，` +
            `建议删除不再需要的旧会话后重启。`,
        );
      } else if (freeRatio < 0.05) {
        console.log(`[Database] 跳过 VACUUM：空闲页仅 ${(freeRatio * 100).toFixed(1)}%，回收收益极小`);
      } else {
        db.run("VACUUM");
        result.vacuumed = true;
      }
      markDatabaseDirty();
      saveDatabaseAsync();
    }
  } catch (e) {
    console.warn("[Database] 维护失败（不影响使用）:", e);
  }

  result.sizeAfter = databaseSizeBytes();
  result.reclaimed = Math.max(0, result.sizeBefore - result.sizeAfter);
  console.log(
    `[Database] 维护完成：事件裁剪 ${result.prunedEvents} 行、遥测 ${result.prunedTelemetry} 行，` +
      `占用 ${(result.sizeBefore / 1024 / 1024).toFixed(1)} MB → ${(result.sizeAfter / 1024 / 1024).toFixed(1)} MB` +
      `（回收 ${(result.reclaimed / 1024).toFixed(0)} KB${result.vacuumed ? "，已 VACUUM" : ""}）`,
  );
  return result;
}

/**
 * 对事件量过大的会话做**快照式压缩**（先写快照，再删它之前的事件）。
 *
 * 依赖注入：投影函数由调用方传入（storage 层不反向 import projection 层，避免循环依赖）。
 * 失败只记日志 —— 维护永远不能让应用不可用。
 */
async function compactOversizedSessionLogs(threshold: number): Promise<number> {
  if (!db) return 0;
  let compacted = 0;
  try {
    const rows = db.exec(
      "SELECT session_id, count(*) AS n FROM session_events GROUP BY session_id HAVING n > ?",
      [threshold],
    );
    const sessions = rows?.[0]?.values?.map((r) => String(r[0])) ?? [];
    if (sessions.length === 0) return 0;
    for (const sessionId of sessions) {
      try {
        // 动态 import：storage 层不静态依赖 projection/event-log（避免模块循环），
        // 且这条路径只在"确实需要压缩"时才加载。
        const { getEventLog } = await import("./event-log");
        const { getEventProjection } = await import("./event-projection");
        const projection = getEventProjection();
        // 快照载荷按"截至锚点的事件"计算（keepEvents 会保留尾部事件，不能被快照覆盖）
        const res = getEventLog().compactWithSnapshot(sessionId, (events) => ({
          messages: projection.projectFromEvents(events),
        }), { keepEvents: 8 });
        if (res.removedEvents > 0) {
          compacted++;
          console.log(
            `[Database] 事件日志压缩：会话 ${sessionId} 删除 ${res.removedEvents} 条旧事件` +
              `（快照 seq=${res.snapshotSeq}，回放 = 快照 + 其后事件）`,
          );
        }
      } catch (e) {
        console.warn(`[Database] 会话 ${sessionId} 事件压缩失败（跳过）:`, e);
      }
    }
  } catch (e) {
    console.warn("[Database] 事件压缩扫描失败（跳过）:", e);
  }
  return compacted;
}

/** 空闲页占比（判断 VACUUM 值不值得做） */
function freePageRatio(): number {
  if (!db) return 0;
  try {
    const free = Number(db.exec("PRAGMA freelist_count")?.[0]?.values?.[0]?.[0] ?? 0);
    const total = Number(db.exec("PRAGMA page_count")?.[0]?.values?.[0]?.[0] ?? 0);
    return total > 0 ? free / total : 0;
  } catch {
    return 0;
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function exportDatabase(): Uint8Array | null {
  if (!db) return null;
  return db.export();
}

/**
 * 用一份数据库镜像替换当前内存库（恢复/导入用）。
 *
 * 旧实现写的是 `const SQL = initSqlJs(); new SQL.Database(data)` —— `initSqlJs()` 返回的是
 * **Promise**，所以 `SQL.Database` 永远是 undefined，一调用就 `TypeError: SQL.Database is not a
 * constructor`：也就是说"导入恢复"这条路以前根本走不通。现在复用 initDatabase 解析好的模块，
 * 并顺手复位致命状态（这正是恢复路径的意义）。
 */
export function importDatabase(data: Uint8Array): void {
  if (!sqlJsModule) {
    throw new Error("Database module not initialized; call initDatabase() first.");
  }
  if (db) {
    try { db.close(); } catch { /* 已关闭 */ }
  }
  db = new sqlJsModule.Database(data) as SqlJsDatabase;
  dbFatal = false;
  markDatabaseDirty();
  persistDatabase();
}

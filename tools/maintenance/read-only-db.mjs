/**
 * 只读钻取的唯一实现：**打开真库的副本，真库一个字节、一个 mtime 都不动**。
 *
 * ## 它治的是什么（第 231 波，实测取证）
 *
 * 上一轮真机实测：用 SQLite 只读连接直接打开带 WAL 的真库，`codem-db-rust.bin-shm`
 * 的 **mtime 与内容都会被更新**（SQLite 读 WAL 库必须共享 wal-index 共享内存文件，
 * 这是连接标记，不是我们写了数据）。内容类文件（`.bin` / `-wal`）逐字节未变，
 * 但「只读」在文件系统层面留了痕 —— 对"不许碰用户现场"这条纪律来说，这就是痕迹。
 *
 * 本文件的判据（`src/test/read-only-db.test.ts`）用**小合成库**钉住：
 *   · 走本入口读带未 checkpoint 数据的 WAL 库 ⇒ 原库 `.bin` / `-wal` / `-shm`
 *     的 **mtime 与 sha256 全部不变**，且一个多余文件都不出现；
 *   · 同一现场**直接打开**原库做对照 ⇒ `-shm` 的 mtime/sha256 会变（判据能红的证明）。
 *
 * ## 为什么选「复制副本」而不是 `immutable=1`
 *
 * `file:...?immutable=1` 让 SQLite 完全不碰 `-shm`，看起来更省事，但**带 `-wal` 时会丢数据**：
 * immutable 的语义是"这个文件不会被任何进程改"，SQLite 因此**不读 WAL**（它假定 WAL 不存在或已折叠）。
 * 真库常态是「`.bin` + 几十 MB 的 `-wal` 里有未 checkpoint 的会话数据」——
 * 用 immutable 读出来的是**折叠前的旧状态**，钻取结论会静默失真（比动 mtime 更糟）。
 * 所以这里复制 `.bin` + `-wal` + `-shm` 三件套：副本自己带 WAL，读到的就是真库当前状态
 * （判据里专门断言"未 checkpoint 的行也读得到"）。
 *
 * ## 代价（如实写）
 *
 * 1. **磁盘与时间**：每次打开都要整份复制。真库 942 MB（2026-10-17 实测）⇒ 约 1~3 秒 + 942 MB 临时空间；
 *    一次性批量取数请用 `withReadOnlyDb` 只开一次，不要在循环里反复开。
 * 2. **一致性只对"静止的库"成立**：复制期间源库若被写入，三件套可能互相不一致。
 *    所以 `copyDbForRead` 会**校验复制前后源库的指纹**（存在性 / 大小 / mtime，不读内容），
 *    变了就重试（最多 3 次），还在变就抛错 —— 意思是"先把应用停掉再钻取"（既有纪律）。
 * 3. **临时目录要能删**：进程退出时用同步钩子清理（`fs.rmSync`）；`db.close()` 也会立即删。
 *    异常退出（kill -9 / 任务管理器结束进程）会留下 `%TEMP%/codem-ro-db-*`，可手工清。
 *
 * ## 用法
 *
 * 一次性取数（推荐，自带"原库未被动过"的自证）：
 *
 *     import { withReadOnlyDb } from "../../tools/maintenance/read-only-db.mjs";
 *     const { result, changes } = await withReadOnlyDb(REAL_DB, (db) => db.prepare("select ...").all());
 *     // changes 必须为空数组；非空会直接抛 ReadOnlyDbTouchedError，不会带着被污染的现场往下跑
 *
 * 直接替换旧写法（`new DatabaseSync(真库, { readOnly: true })`）：副本连接是 drop-in 的，
 *
 *     import { openReadOnlyDb } from "../../tools/maintenance/read-only-db.mjs";
 *     const db = openReadOnlyDb(REAL_DB);   // 返回 DatabaseSync，指向副本；close() 即删临时目录
 *
 * 只想测一次指纹（不打开库）：
 *
 *     import { snapshotDbFiles, diffDbSnapshots, formatDbChanges } from "...";
 *
 * ⚠️ **新写的钻取脚本一律走这里**，别再 `new DatabaseSync(<真库路径>)` ——
 * 那样做会在真库的 `-shm` 上留 mtime 痕迹，`src/test/read-only-db.test.ts` 的对照实验
 * 就是为了让这件事一眼可见。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** 一个 SQLite 库在文件系统上的三件套：主库 / WAL / 共享内存（后两个可能不存在） */
export const DB_SIBLINGS = ["", "-wal", "-shm"];

/** 三件套的绝对路径（顺序固定，便于快照比对） */
export function dbFiles(dbPath) {
  return DB_SIBLINGS.map((suffix) => dbPath + suffix);
}

/**
 * 取三件套的指纹。
 *
 * `hash: false`（默认）只 stat —— 足够抓住"只读打开却动了 -shm"这个真实症状，且不读几 GB。
 * `hash: true` 额外算 sha256（判据用；真库上一份 942 MB × 3 会花几秒，脚本按需开）。
 */
export function snapshotDbFiles(dbPath, options = {}) {
  const hash = options.hash === true;
  return dbFiles(dbPath).map((file) => {
    if (!fs.existsSync(file)) {
      return { file, exists: false, mtimeMs: null, size: null, sha256: null };
    }
    const st = fs.statSync(file);
    return {
      file,
      exists: true,
      mtimeMs: st.mtimeMs,
      size: st.size,
      sha256: hash ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null,
    };
  });
}

/**
 * 比对两份指纹，返回人话差异（**空数组 = 一动不动**）。
 *
 * 只报"变了 / 出现了 / 消失了"三类事实，不做任何推断 —— 判据与脚本都只消费它。
 */
export function diffDbSnapshots(before, after) {
  const changes = [];
  const afterByFile = new Map(after.map((row) => [row.file, row]));
  for (const b of before) {
    const a = afterByFile.get(b.file);
    if (!a) {
      changes.push({ file: b.file, what: "指纹条目消失（快照不完整）" });
      continue;
    }
    if (!b.exists && !a.exists) continue;
    if (b.exists && !a.exists) {
      changes.push({ file: b.file, what: "被删除" });
      continue;
    }
    if (!b.exists && a.exists) {
      changes.push({ file: b.file, what: "被创建（原本不存在）" });
      continue;
    }
    if (b.size !== a.size) {
      changes.push({ file: b.file, what: "大小变了", before: b.size, after: a.size });
    }
    if (b.mtimeMs !== a.mtimeMs) {
      changes.push({ file: b.file, what: "mtime 变了", before: b.mtimeMs, after: a.mtimeMs });
    }
    if (b.sha256 && a.sha256 && b.sha256 !== a.sha256) {
      changes.push({ file: b.file, what: "内容 sha256 变了", before: b.sha256, after: a.sha256 });
    }
  }
  return changes;
}

/** 把差异拍成人能读的一行一条（脚本打印用） */
export function formatDbChanges(changes) {
  if (!changes || changes.length === 0) return "（无变化）";
  return changes
    .map((c) => "  · " + path.basename(c.file) + "：" + c.what + (c.before !== undefined ? "（" + String(c.before) + " → " + String(c.after) + "）" : ""))
    .join("\n");
}

/** 真库被动过 —— 钻取必须立刻停手，别带着被污染的现场继续下结论 */
export class ReadOnlyDbTouchedError extends Error {
  constructor(dbPath, changes) {
    super(
      "只读钻取动了真库：" +
        dbPath +
        "\n" +
        formatDbChanges(changes) +
        "\n（真库必须一动不动；先停掉应用，再确认没有别的进程在读这个库）",
    );
    this.name = "ReadOnlyDbTouchedError";
    this.dbPath = dbPath;
    this.changes = changes;
  }
}

const TEMP_DIRS = new Set();
let exitHookInstalled = false;

function cleanupTempDir(dir) {
  /*
   * Windows 上 `DatabaseSync.close()` 之后句柄可能还没释放完（尤其有未 finalize 的 statement），
   * 这时 rmSync 会 EPERM —— 那就**留着**，等进程退出的钩子再删一次（别把清理失败当成钻取失败，
   * 但也别假装删掉了：残留目录名是 `%TEMP%/codem-ro-db-*`，一眼能认）。
   */
  const tryRemove = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return !fs.existsSync(dir);
    } catch {
      return false;
    }
  };
  if (tryRemove()) {
    TEMP_DIRS.delete(dir);
    return;
  }
  TEMP_DIRS.add(dir);
  if (tryRemove()) TEMP_DIRS.delete(dir);
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  /* 同步清理：`exit` 钩子里不允许异步操作 */
  process.on("exit", () => {
    for (const dir of [...TEMP_DIRS]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 最后一道：删不掉就留着，绝不因此改变退出码（钻取已经读完了） */
      }
    }
    TEMP_DIRS.clear();
  });
}

/**
 * 把三件套复制到一个全新临时目录，返回副本路径。
 *
 * **复制前后各取一次源库指纹**：不一致说明源库在复制期间被写入（应用没停干净），
 * 副本不可信 —— 重试最多 `retries` 次，仍然不一致就抛错（而不是让钻取读到撕裂的 WAL）。
 */
export function copyDbForRead(dbPath, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 3;
  if (!fs.existsSync(dbPath)) {
    throw new Error("只读钻取：库文件不存在（" + dbPath + "）");
  }
  let lastDiff = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const before = snapshotDbFiles(dbPath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codem-ro-db-"));
    const copyPath = path.join(dir, path.basename(dbPath));
    const copied = [];
    for (const file of dbFiles(dbPath)) {
      if (!fs.existsSync(file)) continue;
      const target = path.join(dir, path.basename(file));
      fs.copyFileSync(file, target);
      copied.push(target);
    }
    const after = snapshotDbFiles(dbPath);
    lastDiff = diffDbSnapshots(before, after);
    if (lastDiff.length === 0) {
      return { dir, dbPath: copyPath, files: copied, attempts: attempt, sourceChanges: [] };
    }
    cleanupTempDir(dir);
  }
  throw new Error(
    "只读钻取：源库在复制期间仍在变化（应用没停干净？）—— " +
      dbPath +
      "\n" +
      formatDbChanges(lastDiff) +
      "\n先停掉应用再钻取（必要时确认没有别的进程在读这个库）。",
  );
}

/**
 * 打开**副本**的只读连接（drop-in 替代 `new DatabaseSync(真库, { readOnly: true })`）。
 *
 * 返回的 `DatabaseSync` 指向临时目录里的副本；`close()` 会连同临时目录一起删掉。
 * 忘了 close 也不怕：进程退出时统一清理。
 */
export function openReadOnlyDb(dbPath, options = {}) {
  const snapshot = copyDbForRead(dbPath, options);
  TEMP_DIRS.add(snapshot.dir);
  installExitHook();
  const db = new DatabaseSync(snapshot.dbPath, { readOnly: true });
  const rawClose = db.close.bind(db);
  let closed = false;
  db.close = () => {
    if (closed) return;
    closed = true;
    try {
      rawClose();
    } finally {
      cleanupTempDir(snapshot.dir);
    }
  };
  /* 副本位置留个记号，排查时能看见"读的是副本，不是真库" */
  db.__readOnlyCopy = { dir: snapshot.dir, dbPath: snapshot.dbPath, source: dbPath, attempts: snapshot.attempts };
  return db;
}

/**
 * 一次性只读钻取：复制 → 打开副本 → 跑 `fn(db)` → 关连接删临时目录 → **复核真库指纹**。
 *
 * 返回 `{ result, changes }`；`changes` 非空（真库被动过）直接抛 `ReadOnlyDbTouchedError`。
 * `fn` 可以是同步/异步函数，返回值原样透传。
 */
export async function withReadOnlyDb(dbPath, fn, options = {}) {
  const hash = options.hash === true;
  const before = snapshotDbFiles(dbPath, { hash });
  const db = openReadOnlyDb(dbPath, options);
  let result;
  try {
    result = await fn(db, {
      copyPath: db.__readOnlyCopy.dbPath,
      tempDir: db.__readOnlyCopy.dir,
      /** 钻取中途想立刻确认原库没动（大库长查询时用） */
      check: () => {
        const changes = diffDbSnapshots(before, snapshotDbFiles(dbPath, { hash }));
        if (changes.length > 0) throw new ReadOnlyDbTouchedError(dbPath, changes);
        return changes;
      },
    });
  } finally {
    db.close();
  }
  const changes = diffDbSnapshots(before, snapshotDbFiles(dbPath, { hash }));
  if (changes.length > 0) throw new ReadOnlyDbTouchedError(dbPath, changes);
  return { result, changes };
}

/** 显式复核：把"真库没动"变成一行断言（脚本收尾时打印它，别只靠 helper 内部） */
export function assertDbUntouched(dbPath, before, options = {}) {
  const changes = diffDbSnapshots(before, snapshotDbFiles(dbPath, { hash: options.hash === true }));
  if (changes.length > 0) throw new ReadOnlyDbTouchedError(dbPath, changes);
  return changes;
}

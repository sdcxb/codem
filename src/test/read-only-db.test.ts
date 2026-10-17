/**
 * RODB-231：只读钻取**连 `-shm` 的 mtime 都不许动**（第 231 波）。
 *
 * ## 守的缺陷（上一轮真机实测）
 *
 * 用 SQLite 只读连接直接打开带 WAL 的真库，`codem-db-rust.bin-shm` 的 mtime（以及内容）
 * 会被更新 —— SQLite 读 WAL 库必须共享 wal-index 共享内存文件，那是连接标记。
 * 内容类文件（`.bin` / `-wal`）逐字节未变，但「只读」在文件系统层面留了痕。
 *
 * ## 判据（全部用**合成的小库**，一个字节都不读真库）
 *
 * - RODB-231-1：走新入口（`withReadOnlyDb`）能读到 `-wal` 里**未 checkpoint** 的数据；
 * - RODB-231-2 ★：读完之后原库 `.bin` / `-wal` / `-shm` 的 **mtime 与 sha256 全部不变**，
 *   也没有多出任何文件；
 * - RODB-231-3 ★对照：同一现场**直接打开**原库 ⇒ `-shm` 的 mtime/sha256 **确实会变**。
 *   这一条是"判据能红"的内建证明：如果哪天 SQLite 不再动 `-shm`，它会先红，
 *   提醒我们这条纪律已经不需要了（而不是让我们永远守着一个不存在的风险）；
 * - RODB-231-4：只拿 `.bin`（不带 `-wal`）读不到那些行 ⇒ 说明为什么**必须复制 -wal**，
 *   以及为什么不能用 `immutable=1`（它等价于"忽略 WAL"，会静默读到折叠前的旧状态）；
 * - RODB-231-5：指纹比对的纯函数能把 mtime / 大小 / 新增 / 删除都判出来（判据的自证）；
 * - RODB-231-6：`openReadOnlyDb` 是 drop-in（`prepare` 照常可用），`close()` 会删掉临时目录。
 *
 * ## 变异自证（人工执行，结论写在交接里）
 *
 * 把 `openReadOnlyDb` 改回 `new DatabaseSync(dbPath, { readOnly: true })`（即直接打开原库）
 * ⇒ RODB-231-2 红在 `codem-...bin-shm：mtime 变了 / 内容 sha256 变了`。
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  DB_SIBLINGS,
  cleanupTempCopies,
  copyDbForRead,
  diffDbSnapshots,
  formatDbChanges,
  openReadOnlyDb,
  snapshotDbFiles,
  withReadOnlyDb,
} from "../../tools/maintenance/read-only-db.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codem-rodb-test-"));
let seq = 0;

afterAll(async () => {
  /*
   * Windows 上连接刚 close 时句柄可能还没释放 ⇒ 重试几次；仍失败就只告警、不判红
   * （残留目录是 `%TEMP%/codem-rodb-test-*`，与本判据要守的东西无关 —— 别让清理噪声
   * 把"真库没被动过"这条结论搅成一条红）。
   */
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
      if (!fs.existsSync(TMP)) break;
    } catch {
      /* 重试 */
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  /*
   * helper 自己建的副本目录（`%TEMP%/codem-ro-db-*`）也收掉：**vitest worker 是被父进程结束的**，
   * `exit` 钩子不一定跑得到 ⇒ 用例跑完会留下几十 KB 的残留（实测见过）。这里显式清；
   * Windows 上 close 之后句柄可能还没释放，删不掉就等一会儿再试 —— 只告警，不判红。
   */
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      cleanupTempCopies();
    } catch {
      /* 清理失败不改变判据结论 */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (fs.existsSync(TMP)) console.warn("[RODB-231] 临时目录残留（可手工清理）：" + TMP);
});

/**
 * 造一个「带未 checkpoint 数据」的 WAL 库 —— 真库的常态就是它。
 *
 * 做法：写入后**先不 close** 就把三件套的字节抄走，再 close（close 会 checkpoint 并删掉
 * `-wal` / `-shm`），最后把抄走的三份原样放回。于是现场与「应用正在用、WAL 还没折叠」一致。
 * ⚠️ 若换成 close 之后再抓，`-wal` 就没了，RODB-231-4 那个"只读 .bin 读不到数据"的前提
 * 也就不成立（会静默变成一条永远绿的断言）—— 所以这里必须按上面的顺序来。
 */
function makeDirtyWalDb() {
  const dbPath = path.join(TMP, "dirty-" + ++seq + ".bin");
  const writer = new DatabaseSync(dbPath);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec("PRAGMA wal_autocheckpoint=0");
  writer.exec("CREATE TABLE t(k TEXT PRIMARY KEY, v TEXT)");
  writer.exec("INSERT INTO t(k,v) VALUES ('a','alpha'),('b','beta')");
  const kept = [];
  for (const suffix of DB_SIBLINGS) {
    const file = dbPath + suffix;
    kept.push([file, fs.existsSync(file) ? fs.readFileSync(file) : null]);
  }
  writer.close();
  for (const [file, bytes] of kept) {
    if (bytes) fs.writeFileSync(file, bytes);
  }
  return dbPath;
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("RODB-231 只读钻取不许动真库（含 -shm 的 mtime）", () => {
  it("RODB-231-1 走新入口能读到 -wal 里未 checkpoint 的数据", async () => {
    const real = makeDirtyWalDb();
    const { result, changes } = await withReadOnlyDb(real, (db) =>
      db.prepare("SELECT k, v FROM t ORDER BY k").all(),
    );
    expect(result, "副本里应当能读到 WAL 里那两行（未 checkpoint 也不能丢）").toEqual([
      { k: "a", v: "alpha" },
      { k: "b", v: "beta" },
    ]);
    expect(changes, "这次钻取不该在真库上留下任何变化：" + formatDbChanges(changes)).toEqual([]);
  });

  it("RODB-231-2 ★读完之后原库三件套的 mtime 与 sha256 全部不变", async () => {
    const real = makeDirtyWalDb();
    /* 先确认现场真的有三件套（否则"没变"是空话） */
    for (const suffix of DB_SIBLINGS) {
      expect(fs.existsSync(real + suffix), "造库失败：缺少 " + path.basename(real + suffix)).toBe(true);
    }
    const before = snapshotDbFiles(real, { hash: true });
    await withReadOnlyDb(real, (db) => {
      db.prepare("SELECT count(*) AS n FROM t").get();
    }, { hash: true });
    const after = snapshotDbFiles(real, { hash: true });
    const changes = diffDbSnapshots(before, after);
    expect(changes, "真库被动过了：" + formatDbChanges(changes)).toEqual([]);
    /* 逐字节再确认一遍（diff 只报差异，这里直接对内容下结论） */
    for (const row of before) {
      expect(sha256(row.file), path.basename(row.file) + " 内容变了").toBe(row.sha256);
    }
  });

  it("RODB-231-3 ★对照实验：直接打开原库 ⇒ -shm 的 mtime / 内容会变（判据能红的证明）", () => {
    const real = makeDirtyWalDb();
    const shm = real + "-shm";
    const beforeShm = snapshotDbFiles(real, { hash: true }).find((row) => row.file === shm);
    expect(beforeShm.exists, "对照实验的前提：-shm 必须存在").toBe(true);

    /* 这就是**旧的写法**：直接只读打开真库。只读也一样会动 -shm（连接标记）。 */
    const db = new DatabaseSync(real, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }

    const afterShm = snapshotDbFiles(real, { hash: true }).find((row) => row.file === shm);
    expect(
      afterShm.mtimeMs,
      "预期落空：直接只读打开原库居然没动 -shm 的 mtime —— 若这是平台行为变了，" +
        "请复核本条判据是否还需要（但不要直接删掉它）",
    ).not.toBe(beforeShm.mtimeMs);
    expect(afterShm.sha256, "直接打开原库后 -shm 的内容（wal-index 头）也变了").not.toBe(beforeShm.sha256);
  });

  it("RODB-231-4 只拿 .bin（不带 -wal）读不到那些行 ⇒ 必须连 -wal 一起复制", () => {
    const real = makeDirtyWalDb();
    const only = path.join(TMP, "bin-only-" + seq + ".bin");
    fs.copyFileSync(real, only);

    let rows = 0;
    let opened = null;
    try {
      opened = new DatabaseSync(only, { readOnly: true });
      rows = opened.prepare("SELECT count(*) AS n FROM t").get().n;
    } catch {
      /* 表还没折叠进主库 ⇒ 直接报 no such table；两种都说明「数据不在 .bin 里」 */
      rows = 0;
    } finally {
      /* ⚠️ 必须关：Windows 上没关掉的连接会把 -shm 一直映射着，
         于是 afterAll 删临时目录时 EPERM（本判据第一版就栽在这上面） */
      if (opened) opened.close();
    }
    expect(rows, "未 checkpoint 的数据只存在于 -wal 里：只读 .bin 应当读不到").toBe(0);

    /* 而副本（带 -wal）读得到 —— 与 RODB-231-1 相互印证 */
    const copy = copyDbForRead(real);
    const db = new DatabaseSync(copy.dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
    } finally {
      db.close();
      fs.rmSync(copy.dir, { recursive: true, force: true });
    }
  });

  /**
   * RODB-231-8：**副本读到的行数 ≥ 只读 `.bin` 读到的行数**（迁移两个 `tools/eval` 报告脚本时的口径）。
   *
   * 为什么要有这一条：把「直接读真库」换成「读副本」时，唯一能影响**结论**的风险是
   * 「数据变少了」（例如漏掉 WAL/`-shm`，于是统计口径静默缩水）。所以这里造一个
   * **一半在 `.bin`、一半在 `-wal`** 的现场：
   *   · 先写 1 条并 `wal_checkpoint(TRUNCATE)` ⇒ 它进主库，WAL 清空；
   *   · 再写 2 条（不 checkpoint）⇒ 它们只在 WAL 里；
   * 然后用**两个报告脚本各自的那条 SQL** 分别从「副本（bin+wal）」和「只读 bin」读一次：
   *   · 只读 bin ⇒ 只有 1 条（看不到 WAL 里那 2 条）；
   *   · 副本 ⇒ 3 条（一条不少，且 ≥ 1）。
   * 这就是「换成副本只会看到更多、不会更少」的可执行证据 —— 报告口径不会因为这次迁移而缩水。
   */
  it("RODB-231-8 ★副本读到的行数 ≥ 只读 .bin 读到的行数（迁移报告工具时不丢数据）", () => {
    const real = path.join(TMP, "counts-" + ++seq + ".bin");
    const writer = new DatabaseSync(real);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("CREATE TABLE session_events(session_id TEXT, seq INTEGER, event_type TEXT, payload TEXT)");
    writer.exec("INSERT INTO session_events VALUES ('s1', 1, 'tool_call', '{\"tool\":\"write\"}')");
    /* 把这 1 条折进主库并清空 WAL：之后的写入才真的是「只在 WAL 里」 */
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.exec("INSERT INTO session_events VALUES ('s1', 2, 'tool_call', '{\"tool\":\"edit\"}')");
    writer.exec("INSERT INTO session_events VALUES ('s1', 3, 'tool_result', '{}')");
    const kept = DB_SIBLINGS.map((suffix) => {
      const file = real + suffix;
      return [file, fs.existsSync(file) ? fs.readFileSync(file) : null] as [string, Buffer | null];
    });
    writer.close();
    for (const [file, bytes] of kept) {
      if (bytes) fs.writeFileSync(file, bytes);
    }

    /* ① 只读 .bin（等价于「直接读主库、忽略 WAL」的口径） */
    const binOnly = path.join(TMP, "counts-bin-only-" + seq + ".bin");
    fs.copyFileSync(real, binOnly);
    let binOnlyRows = 0;
    let opened = null;
    try {
      opened = new DatabaseSync(binOnly, { readOnly: true });
      binOnlyRows = opened.prepare("SELECT count(*) AS n FROM session_events WHERE session_id = ?").get("s1").n;
    } catch {
      binOnlyRows = 0;
    } finally {
      if (opened) opened.close();
    }

    /* ② 副本（bin + wal）：用**报告脚本的 SQL 形状**读 */
    const copy = copyDbForRead(real);
    const db = new DatabaseSync(copy.dbPath, { readOnly: true });
    let copyRows = 0;
    let toolRows: Array<{ event_type: string; payload: string }> = [];
    try {
      copyRows = db.prepare("SELECT count(*) AS n FROM session_events WHERE session_id = ?").get("s1").n;
      toolRows = db
        .prepare(
          "SELECT event_type, payload FROM session_events WHERE session_id = ? AND event_type IN ('tool_call','tool_result') ORDER BY seq",
        )
        .all("s1");
    } finally {
      db.close();
      fs.rmSync(copy.dir, { recursive: true, force: true });
    }

    expect(binOnlyRows, "打底那条（已 checkpoint）在 .bin 里，所以只读 .bin 至少能看到它").toBe(1);
    expect(copyRows, "副本必须看到全部 3 条（WAL 里那 2 条一条不少）").toBe(3);
    expect(copyRows >= binOnlyRows, "迁移口径：副本看到的行数不许少于只读 .bin（否则报告数字会静默缩水）").toBe(true);
    expect(toolRows.length, "报告脚本那条 SQL 在副本上也要读到全部 3 条").toBe(3);
  });

  it("RODB-231-5 指纹比对函数能把 mtime / 大小 / 新增 / 删除都判出来（判据自证）", () => {    const row = (file, exists, mtimeMs, size) => ({ file, exists, mtimeMs, size, sha256: null });
    const base = [row("a.bin", true, 100, 10), row("a.bin-wal", true, 100, 20), row("a.bin-shm", false, null, null)];

    expect(diffDbSnapshots(base, base), "两份一样的指纹不该报差异").toEqual([]);
    expect(
      diffDbSnapshots(base, [row("a.bin", true, 101, 10), row("a.bin-wal", true, 100, 20), row("a.bin-shm", false, null, null)]),
      "mtime 变了要判红",
    ).toHaveLength(1);
    expect(
      diffDbSnapshots(base, [row("a.bin", true, 100, 11), row("a.bin-wal", true, 100, 20), row("a.bin-shm", false, null, null)]),
      "大小变了要判红",
    ).toHaveLength(1);
    expect(
      diffDbSnapshots(base, [row("a.bin", true, 100, 10), row("a.bin-wal", true, 100, 20), row("a.bin-shm", true, 100, 32)]),
      "-shm 冒出来也要判红（只读连接会创建它）",
    ).toHaveLength(1);
    expect(
      diffDbSnapshots(base, [row("a.bin", false, null, null), row("a.bin-wal", true, 100, 20), row("a.bin-shm", false, null, null)]),
      "文件消失也要判红",
    ).toHaveLength(1);
  });

  it("RODB-231-6 openReadOnlyDb 是 drop-in，且 close() 会删掉临时目录", () => {
    const real = makeDirtyWalDb();
    const db = openReadOnlyDb(real);
    const copy = db.__readOnlyCopy;
    expect(copy, "副本位置必须留记号（排查时能看见读的不是真库）").toBeTruthy();
    expect(copy.source).toBe(real);
    expect(copy.dbPath, "副本必须落在别处，不能是原库路径").not.toBe(real);
    expect(fs.existsSync(copy.dir), "临时目录应当存在").toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
    expect(sha256(copy.dbPath), "副本的 .bin 必须与原库逐字节一致").toBe(sha256(real));
    db.close();
    expect(fs.existsSync(copy.dir), "close() 之后临时目录必须删掉").toBe(false);
  });
});

/**
 * RODB-231-7：**仓库里（和本地脚手架里）不许再有「直接打开真库」的写法**。
 *
 * 扫两处：
 * - `tools/`（**受版本控制**，任何 clone 上都会跑）—— 这一层是本轮补的：`tools/eval/` 里两个
 *   出报告的脚本原来也直接只读打开真库（同样会在用户现场的 `-shm` 上留 mtime 痕迹）；
 * - `.preview-shot/`（被 gitignore 的一次性脚本）—— 干净 clone 上不存在 ⇒ 自动跳过
 *   （不是假绿：跳过会在输出里显示 skipped）。
 *
 * 认两种写法（迁移时实测就这两种，别的都是副本）：
 * 1. **内联**：`new DatabaseSync(<含有 APPDATA/com.codem.app 与 codem-db-rust.bin 的表达式>, { readOnly: true })`；
 * 2. **经变量**：同一文件里 `const DB = <真库路径>;`（单行常量）后面又 `new DatabaseSync(DB, { readOnly: true })`。
 * 第二种是第一轮迁移**漏掉**的那批（当时只按调用文本量，漏了 16 个文件）—— 漏掉的后果与本判据要防的
 * 完全相同，所以这里的解析必须跟迁移脚本同口径。
 *
 * 豁免：同一个变量还被**读-写**打开（`new DatabaseSync(DB)`）的脚本 = 会改库的工具，不是只读钻取；
 * 它本来就要写 WAL/-shm，把它的只读那一次换成副本反而制造「读到一份、写另一份」的缺陷。
 * 指向**副本**的路径（`path.join(dir, …)`、`TEMP/codem-dbq`、脚本自己 mkdtemp 的目录）故意不认。
 *
 * ⚠️ 扫之前**先去掉注释**：解释「以前这里是 `new DatabaseSync(真库, { readOnly: true })`」的注释
 * 不该被当成违规（本仓大量注释在讲历史；不剥注释就会逼着人把理由从代码里删掉）。
 */
describe("RODB-231-7 不许再直接打开真库（tools/ + 本地脚手架）", () => {
  const ROOT = process.cwd();
  const inlineOpen = /new DatabaseSync\(\s*(?:[^)]*APPDATA[^)]*codem-db-rust\.bin[^)]*|REAL_DB)\s*,\s*\{\s*readOnly:\s*true\s*\}\s*\)/;

  /** 去掉行注释与块注释（够用的剥法：块注释跨行状态机；行注释遇到 `//` 截断） */
  function stripComments(src: string): string {
    const out: string[] = [];
    let inBlock = false;
    for (const raw of src.split("\n")) {
      let line = raw;
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end < 0) continue;
        line = line.slice(end + 2);
        inBlock = false;
      }
      const blockAt = line.indexOf("/*");
      if (blockAt >= 0 && line.indexOf("*/", blockAt + 2) < 0) {
        inBlock = true;
        line = line.slice(0, blockAt);
      }
      const lineAt = line.indexOf("//");
      if (lineAt >= 0) line = line.slice(0, lineAt);
      out.push(line);
    }
    return out.join("\n");
  }

  /** 单行常量定义里同时出现 APPDATA（或 com.codem.app）与 codem-db-rust.bin 的变量名 */
  function realDbConstNames(src: string): string[] {
    const names = new Set<string>();
    for (const line of src.split("\n")) {
      const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.+);\s*$/.exec(line);
      if (m && /codem-db-rust\.bin/.test(m[2]) && /APPDATA|com\.codem\.app/.test(m[2])) names.add(m[1]);
    }
    return [...names];
  }

  /** 递归收集脚本文件（跳过 node_modules / .git；扩展名 .mjs/.cjs/.js） */
  function collectScripts(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectScripts(p));
      else if (/\.(mjs|cjs|js)$/.test(entry.name)) out.push(p);
    }
    return out;
  }

  /** 这个文件里有没有「直接只读打开真库」（返回违规原因或 null） */
  function realDbReadOffense(file: string): string | null {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    /* 只查**真的会开库**的文件（导入了 `node:sqlite`）：把旧写法当字符串引用的探针/变异脚本不算 */
    if (!/from\s+"node:sqlite"/.test(src)) return null;
    /*
     * 便宜的预筛（先看子串再看正则）：脚手架里有一千多个文件，直接跑带 `[^)]*` 的正则
     * 会在大文件上回溯得很难看（实测曾吃掉 2 秒，全量并行时那 2 秒会去抢别人的超时预算）。
     */
    if (!src.includes("new DatabaseSync(") || !src.includes("codem-db-rust.bin")) return null;
    const names = realDbConstNames(src);
    const openReadOnly = (n: string) =>
      new RegExp("new DatabaseSync\\(\\s*" + n + "\\s*,\\s*\\{\\s*readOnly:\\s*true\\s*\\}\\s*\\)").test(src);
    const openReadWrite = (n: string) => new RegExp("new DatabaseSync\\(\\s*" + n + "\\s*\\)").test(src);
    /* 会改库的工具：它本来就要写 WAL/-shm，只读那一次换副本反而制造「读到一份、写另一份」 */
    if (names.some((n) => openReadWrite(n))) return null;
    if (inlineOpen.test(src)) return "内联了真库路径并只读打开";
    if (names.some((n) => openReadOnly(n))) return "经变量 path 只读打开真库（" + names.join("/") + "）";
    return null;
  }

  function scan(files: readonly string[]): string[] {
    const offenders: string[] = [];
    for (const file of files) {
      const why = realDbReadOffense(file);
      if (why) offenders.push(path.relative(ROOT, file).replace(/\\/g, "/") + "（" + why + "）");
    }
    return offenders;
  }

  it("RODB-231-7a ★受版本控制的 tools/ 里没有「直接只读打开真库」（有就说明没用 helper）", () => {
    const offenders = scan(collectScripts(path.join(ROOT, "tools")));
    expect(
      offenders,
      "这些工具还在直接只读打开真库（会在用户现场的 -shm 上留 mtime 痕迹）：\n  " +
        offenders.join("\n  ") +
        "\n—— 改成 openReadOnlyDb / withReadOnlyDb（见 tools/maintenance/read-only-db.mjs 的说明）",
    ).toEqual([]);
  });

  it.skipIf(!fs.existsSync(path.join(ROOT, ".preview-shot")))(
    "RODB-231-7b 本地脚手架（.preview-shot）里同样没有「直接只读打开真库」",
    () => {
      const scratch = path.join(ROOT, ".preview-shot");
      const offenders = scan(
        fs
          .readdirSync(scratch)
          .filter((name) => /\.(mjs|cjs|js)$/.test(name))
          .map((name) => path.join(scratch, name)),
      );
      expect(
        offenders,
        "这些脚本还在直接只读打开真库（会在真库 -shm 上留 mtime 痕迹）：\n  " +
          offenders.join("\n  ") +
          "\n—— 改成 openReadOnlyDb(...)（见 tools/maintenance/read-only-db.mjs 的说明）",
      ).toEqual([]);
    },
  );

  /**
   * ★ RODB-231-9（第 231 波 A3）：**复制失败也必须收掉临时目录**。
   *
   * ## 被守的缺陷（独立审计实测）
   *
   * `copyDbForRead` 旧写法把 `cleanupTempDir(dir)` / `TEMP_DIRS.add` 都放在复制循环**之后**：
   * `copyFileSync` 一抛（ENOSPC / EPERM / EBUSY，或源路径其实是目录）就带着一个空目录逃走
   * —— 审计那轮实测 `LEAKED_DIRS=["codem-ro-db-jhxC72"]`，而调用方只看到"抛了错"。
   *
   * ## 判据怎么做到可复现
   *
   * 临时根目录用 `options.tmpRoot` 指到**本用例自己的沙箱**（全量跑是 8 worker 共用 `%TEMP%`，
   * 直接数 `%TEMP%` 会把别的 worker 的目录算进来 ⇒ 假红）。
   * 触发失败的办法：把 `<db>-wal` 做成**目录** ⇒ `copyFileSync(目录 → 文件)` 必抛。
   */
  it("RODB-231-9 ★复制失败也不许残留 codem-ro-db-*（临时目录要当场收掉，错误照常抛）", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codem-rodb-fail-"));
    try {
      const dbPath = path.join(sandbox, "dirty.bin");
      fs.writeFileSync(dbPath, "not-really-sqlite");
      /* 让三件套里的 `-wal` 变成目录：copyFileSync 会以 EPERM/EISDIR 失败 */
      fs.mkdirSync(dbPath + "-wal");

      const leftover = () => fs.readdirSync(sandbox).filter((name) => name.startsWith("codem-ro-db-"));
      expect(leftover(), "前提：沙箱里此时还没有副本目录").toEqual([]);

      let thrown: unknown = null;
      try {
        copyDbForRead(dbPath, { retries: 1, tmpRoot: sandbox });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, "复制失败必须**照常抛出**（不许把真实原因吃掉）").not.toBeNull();
      expect(
        leftover(),
        "复制失败后残留了临时目录 —— 每失败一次就漏一个 %TEMP%/codem-ro-db-*（审计实测过）",
      ).toEqual([]);
    } finally {
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch {
        /* 沙箱删不掉不影响判据结论（它自己在 %TEMP% 里，且名字可辨） */
      }
    }
  });
});


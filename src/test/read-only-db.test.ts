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
      if (!fs.existsSync(TMP)) return;
    } catch {
      /* 重试 */
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
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

  it("RODB-231-5 指纹比对函数能把 mtime / 大小 / 新增 / 删除都判出来（判据自证）", () => {
    const row = (file, exists, mtimeMs, size) => ({ file, exists, mtimeMs, size, sha256: null });
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
 * RODB-231-7：**钻取脚手架里不许再有"直接打开真库"的写法**。
 *
 * `.preview-shot/` 被 gitignore（一次性脚本不进仓库），所以纪律只能写在两个地方：
 * 受版本控制的 helper（本判据上方这个文件）＋ 这条**本地棘轮**。
 * 干净 clone 上没有 `.preview-shot/` ⇒ 本条自动跳过（不是假绿：跳过会在输出里显示 skipped）。
 *
 * 只认「明确指向真库」的写法（脚本里的真库路径一共就那几种，迁移前量过）：
 * `process.env.APPDATA` + `com.codem.app` + `codem-db-rust.bin`，或脚本自己的 `REAL_DB`。
 * `path.join(dir, ...)` 这类指向**副本**的路径故意不认（那是本来就该直接读的）。
 */
describe("RODB-231-7 钻取脚手架不许再直接打开真库", () => {
  const scratch = path.join(process.cwd(), ".preview-shot");
  const hasScratch = fs.existsSync(scratch);
  const realDbOpen = /new DatabaseSync\(\s*(?:[^)]*APPDATA[^)]*codem-db-rust\.bin[^)]*|REAL_DB)\s*,\s*\{\s*readOnly:\s*true\s*\}\s*\)/;

  it.skipIf(!hasScratch)("RODB-231-7 .preview-shot/*.mjs 里没有「直接只读打开真库」（有就说明没用 helper）", () => {
    const offenders = [];
    for (const name of fs.readdirSync(scratch)) {
      if (!/\.(mjs|cjs)$/.test(name)) continue;
      const src = fs.readFileSync(path.join(scratch, name), "utf8");
      /*
       * 只查**真的会开库**的脚本（导入了 `node:sqlite`）。一次性变异/探针脚本里可能只是
       * 把旧写法当字符串引用（本判据第一版就把它当成了违规 —— 文本级扫描的固有噪声），
       * 那种文件不 import `node:sqlite`，据此跳过。
       */
      if (!/from\s+"node:sqlite"/.test(src)) continue;
      if (realDbOpen.test(src)) offenders.push(".preview-shot/" + name);
    }
    expect(
      offenders,
      "这些脚本还在直接只读打开真库（会在真库 -shm 上留 mtime 痕迹）：" +
        offenders.join(", ") +
        " —— 改成 openReadOnlyDb(...)（见 tools/maintenance/read-only-db.mjs 的说明）",
    ).toEqual([]);
  });
});

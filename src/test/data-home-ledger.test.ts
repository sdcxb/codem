/**
 * 数据目录**台账**契约（第 62 轮；对标 `dsh-desktop` 的 `desktop-data-directory.ts`）
 *
 * 这一组用例守的是三件在真机上会**静默**的事：
 * ①换数据目录之后界面只是"没有会话/没有项目"，与"数据真的没了"长得一样 ⇒ 台账必须记下"第几代、上一处在哪"；
 * ②台账放在 active 目录里的话，一切换就跟着"重置"（第 1 代与第 9 代看起来一样）⇒ 必须放标准数据目录；
 * ③**只记账、绝不复制** —— 这条最容易做错（半拷贝/覆盖/两代数据混在一起），所以用一个"记账之外没有任何写动作"的断言钉住。
 * 另外"读不出来"与"没有台账"必须分开（本仓库反复踩的塌陷）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeDataHome,
  ledgerPathIn,
  readDataHomeLedger,
  recordActiveDataHome,
  LEDGER_VERSION,
  type DataRootLike,
} from "../core/storage/data-home-ledger";

const STD = "C:\\Users\\tester\\AppData\\Roaming\\com.codem.app";
const HOME_A = "C:\\Users\\tester\\AppData\\Roaming\\com.codem.app\\";
const HOME_B = "E:\\portable\\codem\\";
const LEDGER = ledgerPathIn(STD);

/** 内存"文件系统"桩：只实现台账用到的四条命令 */
function installFs(opts: { files?: Record<string, string>; failRename?: boolean; failRead?: boolean } = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "path_exists") return files.has(String(args?.path ?? ""));
    if (cmd === "read_file") {
      if (opts.failRead) throw new Error("EACCES: 拒绝访问");
      const path = String(args?.path ?? "");
      if (!files.has(path)) throw new Error(`os error 2: 找不到文件 ${path}`);
      return files.get(path);
    }
    if (cmd === "write_file") {
      files.set(String(args?.path ?? ""), String(args?.content ?? ""));
      return null;
    }
    if (cmd === "rename_file") {
      if (opts.failRename) throw new Error("EBUSY: 目标被占用");
      const from = String(args?.oldPath ?? "");
      const to = String(args?.newPath ?? "");
      const content = files.get(from);
      if (content === undefined) throw new Error(`os error 2: 找不到 ${from}`);
      files.set(to, content);
      files.delete(from);
      return null;
    }
    return null;
  };
  (window as any).__TAURI__ = { core: { invoke } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
  return { files, calls, writes: () => calls.filter((c) => c.cmd === "write_file" || c.cmd === "rename_file") };
}

const root = (home: string, dbPath?: string, standard = true): DataRootLike => ({
  root: home,
  origin: "engine",
  dbPath,
  standard,
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("DHOME：数据目录台账", () => {
  it("DHOME-1: 第一次记账 ⇒ 第 1 代、previousHome 为空、目标状态按库文件是否存在判定", async () => {
    const fs = installFs();
    const first = await recordActiveDataHome(STD, root(HOME_A, `${HOME_A}codem-db-rust.bin`));
    expect(first).toMatchObject({ changed: true, firstSeen: true, ledgerUnreadable: false, written: true });
    expect(first.ledger.generation).toBe(1);
    expect(first.ledger.previousHome).toBeNull();
    expect(first.ledger.version).toBe(LEDGER_VERSION);
    expect(first.ledger.targetState, "库文件不存在 ⇒ 新目录当时是空的").toBe("empty");
    expect(fs.files.has(LEDGER), "台账要真的落盘").toBe(true);

    // 台账必须放在**标准数据目录**里（不是 active 目录 —— 否则切换就"重置"）
    expect(LEDGER.startsWith(STD)).toBe(true);
    // 目标目录里换了：库已存在 ⇒ existing
    const fs2 = installFs({ files: { [LEDGER]: JSON.stringify({ version: 1, activeHome: HOME_A, previousHome: null, generation: 1, source: "standard", targetState: "empty", updatedAt: "t", history: [] }) } });
    fs2.files.set(`${HOME_B}codem-db-rust.bin`, "db");
    const second = await recordActiveDataHome(STD, root(HOME_B, `${HOME_B}codem-db-rust.bin`));
    expect(second.ledger.targetState, "新目录里已有库 ⇒ existing（这是'有旧数据可回退'的关键信息）").toBe("existing");
  });

  it("DHOME-2: 目录没变 ⇒ 不递增代数、也**不重写**文件（mtime 就是'上次变化的时间'）", async () => {
    const fs = installFs();
    await recordActiveDataHome(STD, root(HOME_A, `${HOME_A}codem-db-rust.bin`));
    const writesAfterFirst = fs.writes().length;
    const before = fs.files.get(LEDGER);

    const again = await recordActiveDataHome(STD, root(HOME_A, `${HOME_A}codem-db-rust.bin`));
    expect(again).toMatchObject({ changed: false, firstSeen: false, written: false });
    expect(again.ledger.generation).toBe(1);
    expect(fs.files.get(LEDGER), "内容不许被改写").toBe(before);
    expect(fs.writes().length, "第二次不该有任何写动作").toBe(writesAfterFirst);
  });

  it("DHOME-3: 换目录 ⇒ 代数 +1、记下上一处，且**只记账、一个字节都不复制**", async () => {
    const fs = installFs();
    fs.files.set(`${HOME_A}codem-db-rust.bin`, "OLD-DB");
    fs.files.set(`${HOME_A}sessions\\s1.jsonl`, '{"a":1}');
    await recordActiveDataHome(STD, root(HOME_A, `${HOME_A}codem-db-rust.bin`));

    const switched = await recordActiveDataHome(STD, root(HOME_B, `${HOME_B}codem-db-rust.bin`));
    expect(switched.changed).toBe(true);
    expect(switched.firstSeen).toBe(false);
    expect(switched.ledger.generation).toBe(2);
    expect(switched.ledger.previousHome).toBe(HOME_A);
    expect(switched.ledger.history, "历史里要能查到上一代在哪").toEqual([
      { home: HOME_A, at: expect.any(String), generation: 1 },
    ]);

    // ⚠️ 关键的负向断言：除了台账本身，**没有**任何写动作 —— 不复制库、不复制日志
    const writes = fs.writes();
    expect(writes.every((w) => String(w.args?.path ?? "").startsWith(LEDGER) || String(w.args?.newPath ?? "").startsWith(LEDGER))).toBe(true);
    expect(fs.files.get(`${HOME_A}codem-db-rust.bin`), "旧目录的数据必须原地不动").toBe("OLD-DB");
    expect(fs.files.get(`${HOME_A}sessions\\s1.jsonl`)).toBe('{"a":1}');
    expect(fs.files.has(`${HOME_B}codem-db-rust.bin`), "新目录里不许凭空出现库文件").toBe(false);
  });

  it("DHOME-4: 台账读不出来 ⇒ 明说「读不出来」、代数记为「不知道(0)」、且**不覆盖**原文件（现场另存）", async () => {
    const broken = "{ 这不是 JSON";
    const fs = installFs({ files: { [LEDGER]: broken } });

    const out = await recordActiveDataHome(STD, root(HOME_A, `${HOME_A}codem-db-rust.bin`));
    expect(out.ledgerUnreadable).toBe(true);
    expect(out.changed, "不知道第几代 ⇒ 不算'换了目录'").toBe(false);
    expect(out.ledger.generation, "不许假装是第 1 代").toBe(0);
    expect(out.written).toBe(false);
    expect(out.why).toContain("台账读不出来");
    expect(fs.files.get(LEDGER), "读不出来时唯一安全的动作是：不覆盖").toBe(broken);
    const preserved = [...fs.files.keys()].filter((k) => k.includes(".corrupt-"));
    expect(preserved.length, "现场要另存一份，便于事后查").toBe(1);
    expect(fs.files.get(preserved[0])).toBe(broken);
  });

  it("DHOME-5: 台账写入失败 ⇒ `written:false` + 原因（调用方能如实上报，而不是以为记上了）", async () => {
    installFs({ failRename: true });
    const out = await recordActiveDataHome(STD, root(HOME_A, `${HOME_A}codem-db-rust.bin`));
    expect(out.changed).toBe(true);
    expect(out.written).toBe(false);
    expect(out.why).toContain("台账写入失败");
  });

  it("DHOME-6: 说出来的话必须与事实一致（含'没有复制'这句关键信息）", () => {
    const base = { version: 1, activeHome: HOME_B, previousHome: HOME_A, generation: 2, source: "standard" as const, targetState: "existing" as const, updatedAt: "t", history: [] };
    const switched = describeDataHome({ ledger: base, changed: true, firstSeen: false, ledgerUnreadable: false, written: true });
    expect(switched).toContain("已切换");
    expect(switched).toContain(HOME_A);
    expect(switched).toContain("已有");
    expect(switched).toContain("没有被复制过来");

    const first = describeDataHome({ ledger: { ...base, generation: 1, previousHome: null }, changed: true, firstSeen: true, ledgerUnreadable: false, written: true });
    expect(first).toContain("第 1 代");

    const same = describeDataHome({ ledger: base, changed: false, firstSeen: false, ledgerUnreadable: false, written: false });
    expect(same).toContain("未变化");
    expect(same).toContain("第 2 代");

    const broken = describeDataHome({ ledger: { ...base, generation: 0 }, changed: false, firstSeen: false, ledgerUnreadable: true, written: false, why: "台账读不出来：坏 JSON" });
    expect(broken).toContain("读不出来");
    expect(broken).toContain("未改动台账");
  });

  it("DHOME-7: 读台账：**文件不存在返回 null**，读失败则抛错（两者不能混）", async () => {
    installFs();
    await expect(readDataHomeLedger(STD)).resolves.toBeNull();

    // 文件在、但读不了（权限/IO）⇒ 必须抛错，让调用方知道"这不是没有台账"
    installFs({ files: { [LEDGER]: "{}" }, failRead: true });
    await expect(readDataHomeLedger(STD)).rejects.toThrow();
  });
});

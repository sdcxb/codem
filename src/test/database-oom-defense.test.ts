/**
 * 数据库内存耗尽（sql.js OOM）—— 三条防线（第 75 波）
 *
 * 事故现场（用户控制台）：
 *   [loadAttachmentsForMessage] Failed: TypeError: xe[e[((s + 12) >> 2)]] is not a function
 *   [listMessages] Failed to convert row: Error: malformed database schema (sqlite_master) - table x already exists
 *   saveMessages / loadFeedback / store.updateSession / Telemetry / cost-tracker: Error: out of memory ← 刷屏几十次
 *
 * 这是 asm.js 版 sql.js **堆扩展失败 → 模块 abort** 的级联：abort 之后每次调用都报同样的错，
 * 而调用方仍无限重试 —— 于是写入永远不成功（消息丢失风险）+ 控制台被 OOM 刷屏。
 *
 * 本文件守三条防线：
 *   1. 尖峰内存：整库导出的 base64 不再经过"与库等大的二进制字符串"（峰值 2.3× → 1.33×）+ 导出节流合并
 *   2. 写盘原子性：先写 .tmp 再改名 —— 半截 DB 落盘正是"malformed database schema"的来源
 *   3. 致命错误识别：认出 OOM/损坏后**停止写入与重试**、只报一次，交给 App 抢救会话
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Tauri 打桩：必须在**每个用例的 beforeEach 里装**（全局 setup.ts 的 beforeAll 会
// `delete window.__TAURI__` 来模拟非 Tauri 环境，模块作用域里装好的会被它删掉）
const invokeCalls: Array<{ cmd: string; args: any }> = [];
let invokeImpl: ((cmd: string, args: any) => Promise<any>) | null = null;

function installTauriStub(): void {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        invokeCalls.push({ cmd, args });
        if (invokeImpl) return invokeImpl(cmd, args);
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "read_file") throw new Error("no such file");
        return undefined;
      },
    },
  };
  // setup.ts 的 beforeAll 删过一次；这里补回来（window === globalThis，两者都会看到）
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import {
  DB_FATAL_EVENT,
  DB_SAVE_FAILED_EVENT,
  encodeBytesToBase64,
  flushDatabase,
  importDatabase,
  initDatabase,
  isDatabaseFatal,
  isFatalDbError,
  persistDatabase,
  resetDatabaseFatalState,
  resetSaveFailureState,
  __resetDirtyForTests,
} from "../core/storage/database";

let exportSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.useFakeTimers();
  invokeCalls.length = 0;
  invokeImpl = null;
  installTauriStub();
  resetSaveFailureState();
  resetDatabaseFatalState();
  __resetDirtyForTests();

  const database = await initDatabase();
  exportSpy = vi.spyOn(database, "export");
  exportSpy.mockClear();
  await flushDatabase();
  exportSpy.mockClear();
  invokeCalls.length = 0; // 清掉 beforeEach 里那次强制保存的记录，用例只关心自己触发的写入
  __resetDirtyForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetDatabaseFatalState();
  resetSaveFailureState();
  exportSpy?.mockRestore();
});

describe("数据库 OOM 防线", () => {
  it("DB-OOM-1: 认出事故现场的每一条致命错误（OOM / 损坏 / 模块 abort）", () => {
    expect(isFatalDbError(new Error("out of memory"))).toBe(true);
    expect(isFatalDbError(new Error("malformed database schema (sqlite_master) - table x already exists"))).toBe(true);
    expect(isFatalDbError(new Error("database disk image is malformed"))).toBe(true);
    expect(isFatalDbError(new Error("bad parameter or other API misuse"))).toBe(true);
    // 普通写盘失败不是致命错误（磁盘满/被占用仍应走可见的重试）
    expect(isFatalDbError(new Error("ENOSPC: no space left on device"))).toBe(false);
    expect(isFatalDbError(new Error("Failed to write file"))).toBe(false);
    expect(isDatabaseFatal()).toBe(false);
  });

  it("DB-OOM-2: 没有变化不导出；连续写入被 2 秒窗口合并成一次整库导出", async () => {
    // 无写入：时间流逝也不该导出（整库 export 是最贵的一步）
    await vi.advanceTimersByTimeAsync(5000);
    expect(exportSpy).not.toHaveBeenCalled();

    // 第一轮：500ms 防抖后导出一次
    persistDatabase();
    await vi.advanceTimersByTimeAsync(800);
    expect(exportSpy).toHaveBeenCalledTimes(1);

    // 第二轮紧跟着来（距离上一次成功导出不到 2 秒）：**不应**再导出一次。
    // 这一条正是节流窗口的价值：telemetry / cost / autosave 会以几百毫秒的间隔轮番写入。
    persistDatabase();
    await vi.advanceTimersByTimeAsync(800);
    expect(exportSpy).toHaveBeenCalledTimes(1);

    // 窗口到点后才真正导出
    await vi.advanceTimersByTimeAsync(2000);
    expect(exportSpy).toHaveBeenCalledTimes(2);
  });

  it("DB-OOM-3: 原子写 —— 先写 .tmp 再改名覆盖，绝不直接写目标文件", async () => {
    persistDatabase();
    await vi.advanceTimersByTimeAsync(3000);

    const writes = invokeCalls.filter((c) => c.cmd === "write_file");
    const renames = invokeCalls.filter((c) => c.cmd === "rename_file");
    expect(writes).toHaveLength(1);
    expect(writes[0].args.path).toBe("C:\\appdata\\codem-db.bin.tmp");
    expect(writes[0].args.encoding).toBe("base64");
    expect(renames).toHaveLength(1);
    expect(renames[0].args).toEqual({
      oldPath: "C:\\appdata\\codem-db.bin.tmp",
      newPath: "C:\\appdata\\codem-db.bin",
    });
    // 关键：没有任何一次直接写最终文件（半截文件 = 下次启动 malformed schema）
    expect(invokeCalls.some((c) => c.cmd === "write_file" && c.args.path === "C:\\appdata\\codem-db.bin")).toBe(false);
  });

  it("DB-OOM-4: 致命错误只报一次、停止后续写入、不再伪装成可重试的保存失败", async () => {
    invokeImpl = async (cmd) => {
      if (cmd === "write_file") throw new Error("out of memory");
      return undefined;
    };
    const fatalSpy = vi.fn();
    const saveFailSpy = vi.fn();
    window.addEventListener(DB_FATAL_EVENT, fatalSpy);
    window.addEventListener(DB_SAVE_FAILED_EVENT, saveFailSpy);

    persistDatabase();
    await vi.advanceTimersByTimeAsync(3000);
    expect(isDatabaseFatal()).toBe(true);
    expect(fatalSpy).toHaveBeenCalledTimes(1);
    expect(saveFailSpy).not.toHaveBeenCalled();

    // 之后继续写入：不再有任何导出/写盘尝试，也不再重复报错（不刷屏）
    const writesBefore = invokeCalls.filter((c) => c.cmd === "write_file").length;
    persistDatabase();
    await vi.advanceTimersByTimeAsync(10000);
    expect(exportSpy).toHaveBeenCalledTimes(1); // 只有那一次失败的尝试
    expect(invokeCalls.filter((c) => c.cmd === "write_file").length).toBe(writesBefore);
    expect(fatalSpy).toHaveBeenCalledTimes(1);

    window.removeEventListener(DB_FATAL_EVENT, fatalSpy);
    window.removeEventListener(DB_SAVE_FAILED_EVENT, saveFailSpy);
  });

  it("DB-OOM-5: 分块 base64 编码严格无损（边界填充错位会立刻表现为字节不一致）", () => {
    for (const size of [0, 1, 2, 3, 1023, 1024, 24575, 24576, 24577, 100000]) {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;

      const encoded = encodeBytesToBase64(data);
      const decoded = Buffer.from(encoded, "base64");
      expect(decoded.length, `size=${size} 解码长度应一致`).toBe(size);
      expect(Buffer.from(decoded).equals(Buffer.from(data)), `size=${size} 字节应完全一致`).toBe(true);
    }
  });

  it("DB-OOM-6: importDatabase 不再把 Promise 当构造函数用（旧实现必然抛 TypeError）", async () => {
    const snapshot = await initDatabase().then((d) => d.export());
    expect(() => importDatabase(snapshot)).not.toThrow();
    // 导入后仍可读写（恢复路径必须真的可用）
    const db = await initDatabase();
    const rows = db.exec("SELECT count(*) FROM sqlite_master");
    expect(rows.length).toBeGreaterThan(0);
  });
});

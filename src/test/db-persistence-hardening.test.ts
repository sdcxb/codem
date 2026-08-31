/**
 * 测试：数据库持久化加固 — STOR-H1 ~ STOR-H6
 *
 * 覆盖范围（2026-09-01 数据库损坏修复）：
 *   1. flushDatabase 返回 Promise 且正常 resolve（写链完成）
 *   2. 多次 persistDatabase 串行队列不抛错
 *   3. 损坏数据库加载（quick_check 失败）→ 备份 + 删除 + 重建
 *   4. 无法打开的损坏库（异常分支）→ 备份 + 删除 + 重建
 *   5. 正常库加载不触发备份/删除
 *   6. 重建后的数据库可用（表可查、可写）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initDatabase,
  resetDatabase,
  getDatabase,
  flushDatabase,
  persistDatabase,
} from "../core/storage/database";
import initSqlJs from "sql.js/dist/sql-asm.js";

function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode(...data.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

interface TauriCalls {
  writes: string[];
  deletes: string[];
}

/**
 * Mock Tauri 环境：read_file 返回 readBase64（null 表示文件不存在），
 * 记录 write_file / delete_file 调用路径。
 */
function mockTauri(readBase64: string | null, calls: TauriCalls): void {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return "C:\\fake\\appdata\\";
        if (cmd === "read_file") {
          if (readBase64 === null) throw new Error("File not found");
          return readBase64;
        }
        if (cmd === "write_file") {
          calls.writes.push(args.path);
          return null;
        }
        if (cmd === "delete_file") {
          calls.deletes.push(args.path);
          return null;
        }
        throw new Error(`unexpected invoke: ${cmd}`);
      },
    },
  };
}

async function makeGoodDbBytes(): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const tmp = new SQL.Database();
  tmp.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  tmp.run("INSERT INTO t VALUES (1, 'hello')");
  const bytes = tmp.export();
  tmp.close();
  return bytes;
}

describe("存储 — 数据库持久化加固", () => {
  let calls: TauriCalls;

  beforeEach(async () => {
    calls = { writes: [], deletes: [] };
    // 先确保回到无 mock 的浏览器模式并清空模块级 db
    delete (window as any).__TAURI__;
    try { await resetDatabase(); } catch { /* ignore */ }
  });

  afterEach(async () => {
    delete (window as any).__TAURI__;
    try { await resetDatabase(); } catch { /* ignore */ }
  });

  // STOR-H1
  it("STOR-H1: flushDatabase 返回 Promise 并正常 resolve（浏览器模式）", async () => {
    const p = flushDatabase();
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBeUndefined();
  });

  // STOR-H2
  it("STOR-H2: 连续多次 persistDatabase 串行队列不抛错", async () => {
    expect(() => {
      persistDatabase();
      persistDatabase();
      persistDatabase();
      persistDatabase();
      persistDatabase();
    }).not.toThrow();
    // 防抖 500ms 后写链应已排空
    await flushDatabase();
  });

  // STOR-H3：截断的合法库 → 打开成功但 quick_check 失败 → 备份 + 删除 + 重建
  it("STOR-H3: 损坏数据库加载（quick_check 失败）触发备份、删除与重建", async () => {
    const good = await makeGoodDbBytes();
    // 截断一半：header 完整（SQLite format 3），但页面缺失 → quick_check 必然失败
    const truncated = good.slice(0, Math.floor(good.length / 2));
    mockTauri(uint8ToBase64(truncated), calls);

    // resetDatabase 清掉模块级缓存并走 Tauri 加载路径（initDatabase 有缓存，直接调用会跳过加载）
    const db = await resetDatabase();

    // 备份 + 删除均被调用
    expect(calls.writes.some((p) => p.includes("codem-db.bin.corrupt-"))).toBe(true);
    expect(calls.deletes.some((p) => p.includes("codem-db.bin"))).toBe(true);
    // 重建后的库可用
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables.length > 0 ? tables[0].values.map((r: any[]) => r[0] as string) : [];
    expect(names).toContain("projects");
    // 可写
    db.run("CREATE TABLE IF NOT EXISTS post_recovery (id INTEGER)");
  });

  // STOR-H4：垃圾数据 → new SQL.Database 抛异常 → 备份 + 删除 + 重建
  it("STOR-H4: 无法打开的损坏库（异常分支）触发备份、删除与重建", async () => {
    const good = await makeGoodDbBytes();
    // 头部合法但页数据全为垃圾，构造时大概率抛 "malformed"
    const garbage = new Uint8Array(good.length);
    const header = new TextEncoder().encode("SQLite format 3\0");
    garbage.set(header.subarray(0, Math.min(header.length, garbage.length)), 0);
    mockTauri(uint8ToBase64(garbage), calls);

    const db = await resetDatabase();

    expect(calls.writes.some((p) => p.includes("codem-db.bin.corrupt-"))).toBe(true);
    expect(calls.deletes.some((p) => p.includes("codem-db.bin"))).toBe(true);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables.length > 0 ? tables[0].values.map((r: any[]) => r[0] as string) : [];
    expect(names).toContain("projects");
  });

  // STOR-H5：正常库加载不触发备份/删除
  it("STOR-H5: 正常数据库加载不触发备份与删除", async () => {
    const good = await makeGoodDbBytes();
    mockTauri(uint8ToBase64(good), calls);

    const db = await resetDatabase();

    // 正常库不应产生 corrupt 备份
    expect(calls.writes.some((p) => p.includes("codem-db.bin.corrupt-"))).toBe(false);
    // 原始表 t 仍在（正常库被原样加载，SCHEMA 只是 IF NOT EXISTS）
    const res = db.exec("SELECT v FROM t WHERE id = 1");
    expect(res[0].values[0][0]).toBe("hello");
  });

  // STOR-H6：重建后的数据库可正常执行 CRUD（通过真实存储层）
  it("STOR-H6: 损坏恢复后的数据库可正常写入消息", async () => {
    const good = await makeGoodDbBytes();
    const truncated = good.slice(0, Math.floor(good.length / 2));
    mockTauri(uint8ToBase64(truncated), calls);

    await resetDatabase();
    const db = getDatabase();
    db.run("INSERT INTO projects (id, name, path, pinned, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)", [
      "proj-h6", "恢复测试", "D:\\h6", 0, Date.now(), Date.now(),
    ]);
    const res = db.exec("SELECT name FROM projects WHERE id = 'proj-h6'");
    expect(res[0].values[0][0]).toBe("恢复测试");
  });
});

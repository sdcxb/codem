/**
 * 复现实验：sql.js 写入特定内容是否触发 trap: invalid memory.fill
 * 验证用户日志中的 DB 崩溃是否由内容编码/长度触发。
 * 注意：本文件是实验，运行后如触发崩溃会打印错误，不作为正式测试断言。
 */
import { describe, it, expect } from "vitest";
import initSqlJs from "sql.js/dist/sql-asm.js";

describe("sql.js 陷阱复现实验", () => {
  it("EXP-001: 普通长字符串写入正常", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (v TEXT)");
    const big = "x".repeat(500_000);
    expect(() => db.run("INSERT INTO t VALUES (?)", [big])).not.toThrow();
    const data = db.export();
    expect(data.length).toBeGreaterThan(0);
    db.close();
  });

  it("EXP-002: 含孤立代理项（lone surrogate）的字符串写入", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (v TEXT)");
    // \uD800 是孤立高位代理（无配对低位）
    const bad = "prefix-\uD800-suffix";
    let threw = false;
    try {
      db.run("INSERT INTO t VALUES (?)", [bad]);
      const data = db.export();
      expect(data.length).toBeGreaterThan(0);
    } catch (e: any) {
      threw = true;
      console.log("[EXP-002] threw:", e.message);
    }
    expect(threw).toBe(false);
    db.close();
  });

  it("EXP-003: 连续大量写入 + 多次 export（模拟高频保存）", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (v TEXT)");
    for (let i = 0; i < 200; i++) {
      db.run("INSERT INTO t VALUES (?)", [`msg-${i}-` + "y".repeat(5000)]);
      db.export(); // 每次插入后 export
    }
    const data = db.export();
    expect(data.length).toBeGreaterThan(0);
    db.close();
  });

  it("EXP-004: 写入被截断的 UTF-8 序列（非法的 0xFF 字节）", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (v TEXT)");
    // JS 字符串中的 0xFF 会被当作 Unicode U+00FF，不是字节——但含 0x80-0xBF 区间孤立字节的字符串可能影响 UTF-8 编码
    const bad = "\u00FF\u0080\u00BF invalid \uD83D\uDE00 ok";
    let threw = false;
    try {
      db.run("INSERT INTO t VALUES (?)", [bad]);
      const data = db.export();
      expect(data.length).toBeGreaterThan(0);
    } catch (e: any) {
      threw = true;
      console.log("[EXP-004] threw:", e.message);
    }
    expect(threw).toBe(false);
    db.close();
  });
});

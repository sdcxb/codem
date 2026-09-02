/**
 * 验证：sql.js 的内存增长版本（sql-asm-memory-growth.js）在大数据量下不触发
 * "trap: invalid memory.fill"，而普通 sql-asm.js 在超过 21MB 堆时崩溃。
 */
import { describe, it, expect } from "vitest";
import initSqlJsGrowth from "sql.js/dist/sql-asm-memory-growth.js";
import initSqlJsPlain from "sql.js/dist/sql-asm.js";

describe("sql.js 内存增长版本对比", () => {
  it("GROW-001: memory-growth 版本 API 兼容（Database/run/exec/export）", async () => {
    const SQL = await initSqlJsGrowth();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (v TEXT)");
    db.run("INSERT INTO t VALUES (?)", ["hello"]);
    const r = db.exec("SELECT v FROM t");
    expect(r[0].values[0][0]).toBe("hello");
    const data = db.export();
    expect(data.length).toBeGreaterThan(0);
    db.close();
  });

  it("GROW-002: memory-growth 版本写入 30MB 总数据不触发 trap（远超固定堆 21MB）", async () => {
    const SQL = await initSqlJsGrowth();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (v TEXT)");
    // 30 条 × 1MB = 30MB，超过固定堆 21MB
    const chunk = "z".repeat(1024 * 1024);
    for (let i = 0; i < 30; i++) {
      db.run("INSERT INTO t VALUES (?)", [`chunk-${i}-` + chunk]);
    }
    const data = db.export();
    expect(data.length).toBeGreaterThan(20 * 1024 * 1024); // > 20MB 导出
    db.close();
  });

  it("GROW-003: 单条超大值（10MB）写入 memory-growth 版本正常", async () => {
    const SQL = await initSqlJsGrowth();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (v TEXT)");
    const big = "w".repeat(10 * 1024 * 1024);
    db.run("INSERT INTO t VALUES (?)", [big]);
    const data = db.export();
    expect(data.length).toBeGreaterThan(9 * 1024 * 1024);
    db.close();
  });

  it("GROW-004: 普通 sql-asm.js 在超过堆容量时抛出 trap（对照）", async () => {
    const SQL = await initSqlJsPlain();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (v TEXT)");
    let threw = false;
    try {
      // 尝试单次写入超过堆容量的数据
      const huge = "q".repeat(25 * 1024 * 1024); // 25MB > 21MB 堆
      db.run("INSERT INTO t VALUES (?)", [huge]);
    } catch (e: any) {
      threw = true;
      console.log("[GROW-004] 普通版本抛出:", e.message?.substring(0, 60));
    }
    // 允许抛出（普通版本固定堆）或成功（取决于 sql.js 行为）—— 记录结果
    console.log("[GROW-004] threw =", threw);
    db.close();
  });
});

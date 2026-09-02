/**
 * 测试：数据库保存失败可见性 — DBSAVE-F1 ~ DBSAVE-F4
 *
 * 背景：saveDatabase 此前写盘失败仅在 console.error（内部 catch 吞掉），
 * 调用方与用户完全无感知 —— 磁盘满/文件被占用时所有保存静默失败，
 * 退出前 flushDatabase 也"成功"，最后一批更改静默丢失。
 *
 * 修复（对标 dsh：持久化失败必须可诊断）：
 *   1. 首次失败 dispatch `codem:db-save-failed` 事件（UI → guidance 提示）
 *   2. 连续失败限流（只提示一次，不刷屏）
 *   3. 失败后安排一次 3s 自动重试（临时故障自愈）
 *   4. 任何一次成功复位失败状态（下次失败重新提示）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initDatabase,
  resetDatabase,
  getDatabase,
  flushDatabase,
  persistDatabase,
  isLastSaveFailed,
  resetSaveFailureState,
  DB_SAVE_FAILED_EVENT,
  DB_SAVE_RECOVERED_EVENT,
} from "../core/storage/database";

/** 前 N 次 write_file 调用失败（模拟磁盘满）。 */
let failWrites = 0;

function mockTauri(): void {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, _args: any) => {
        if (cmd === "get_app_data_dir") return "C:\\fake\\appdata\\";
        if (cmd === "read_file") throw new Error("File not found");
        if (cmd === "write_file") {
          if (failWrites > 0) {
            failWrites -= 1;
            throw new Error("No space left on device");
          }
          return null;
        }
        if (cmd === "delete_file") return null;
        throw new Error(`unexpected invoke: ${cmd}`);
      },
    },
  };
}

describe("存储 — 数据库保存失败可见性", () => {
  let failSpy: ReturnType<typeof vi.fn>;
  let recoverSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    failWrites = 0;
    failSpy = vi.fn();
    recoverSpy = vi.fn();
    window.addEventListener(DB_SAVE_FAILED_EVENT, failSpy);
    window.addEventListener(DB_SAVE_RECOVERED_EVENT, recoverSpy);
    // 干净状态：无 mock → reset → 浏览器模式；再 mock + init（成功保存一次）。
    delete (window as any).__TAURI__;
    try { await resetDatabase(); } catch { /* ignore */ }
    mockTauri();
    await resetDatabase(); // 走 Tauri 路径：read 失败 → 新建库 → 首次 save 成功
    expect(isLastSaveFailed()).toBe(false);
  });

  afterEach(async () => {
    window.removeEventListener(DB_SAVE_FAILED_EVENT, failSpy);
    window.removeEventListener(DB_SAVE_RECOVERED_EVENT, recoverSpy);
    resetSaveFailureState(); // 清模块级失败状态与挂起的重试定时器（防跨测试泄漏）
    delete (window as any).__TAURI__;
    try { await resetDatabase(); } catch { /* ignore */ }
    failWrites = 0;
  });

  function touchAndFlush(): Promise<void> {
    const db = getDatabase();
    db.run("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
    db.run("INSERT INTO t (v) VALUES ('x')");
    persistDatabase();
    return flushDatabase();
  }

  it("DBSAVE-F1: 写盘失败 → dispatch 保存失败事件且失败状态置位", async () => {
    failWrites = 2; // 首次失败 + 自动重试也失败（磁盘持续满）
    await touchAndFlush();
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(isLastSaveFailed()).toBe(true);
    // 失败后自动重试（3s 定时器）：等待后重试已执行且仍失败，事件不重复。
    await new Promise((r) => setTimeout(r, 3600));
    expect(isLastSaveFailed()).toBe(true);
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("DBSAVE-F2: 连续失败限流 —— 事件只提示一次", async () => {
    failWrites = 100;
    await touchAndFlush();
    await touchAndFlush();
    await touchAndFlush();
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(recoverSpy).not.toHaveBeenCalled();
    expect(isLastSaveFailed()).toBe(true);
  });

  it("DBSAVE-F3: 失败后成功 → 恢复事件 + 状态复位", async () => {
    failWrites = 1;
    await touchAndFlush();
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(isLastSaveFailed()).toBe(true);
    // 磁盘恢复：后续写入成功 → recovered + 复位
    failWrites = 0;
    await touchAndFlush();
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    expect(isLastSaveFailed()).toBe(false);
  });

  it("DBSAVE-F4: 复位后再失败 → 再次提示（限流窗口重置）", async () => {
    failWrites = 1;
    await touchAndFlush();
    expect(failSpy).toHaveBeenCalledTimes(1);
    failWrites = 0;
    await touchAndFlush(); // 恢复
    expect(isLastSaveFailed()).toBe(false);
    failWrites = 1;
    await touchAndFlush(); // 再次失败 → 应再次提示
    expect(failSpy).toHaveBeenCalledTimes(2);
  });
});

/**
 * 全局测试初始化：在每个测试套件前初始化 SQLite 内存数据库
 */
import { beforeEach, beforeAll } from "vitest";
import { initDatabase, resetDatabase, getDatabase } from "../core/storage/database";

// 确保 window.__TAURI__ 不存在（模拟浏览器/非 Tauri 环境）
// 这样 database.ts 会创建纯内存数据库
beforeAll(async () => {
  // 删除可能存在的 __TAURI__ 模拟
  delete (window as any).__TAURI__;
});

beforeEach(async () => {
  // 每个测试前重置数据库，保证隔离
  try {
    await resetDatabase();
  } catch {
    // 如果 resetDatabase 失败（比如没有已初始化的数据库），直接 init
    await initDatabase();
  }

  // 清空 localStorage
  localStorage.clear();
});

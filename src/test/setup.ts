/**
 * 全局测试初始化：在每个测试套件前初始化 SQLite 内存数据库
 */
import { beforeEach, beforeAll, afterAll } from "vitest";
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

// vitest worker teardown 竞态规避：重度引擎日志测试（db-save-failure-alert /
// refactor-prompt-to-data / llm-timeout-hardening / forked-agent 等）在文件结束
// 瞬间仍有在途 console 输出 → threads 下触发 "Closing rpc while onUserConsoleLog
// was pending" unhandled（0 failed 但 exit≠0）。给在途输出一个送达窗口再让
// worker 收尾（保留控制台可见性，不关 console 收集）。
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 150));
});


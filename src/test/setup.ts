/**
 * 全局测试初始化：在每个测试套件前初始化 SQLite 内存数据库
 */
import { beforeEach, beforeAll, afterAll } from "vitest";
import { initDatabase, resetDatabase, getDatabase } from "../core/storage/database";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

// 确保 window.__TAURI__ 不存在（模拟浏览器/非 Tauri 环境）
// 这样 database.ts 会创建纯内存数据库
beforeAll(async () => {
  // 删除可能存在的 __TAURI__ 模拟
  delete (window as any).__TAURI__;
});

/**
 * 是否让测试跑在**存储端口**上（P5 第 10 段）。
 *
 * 默认 `true` —— 这一条是刻意的，理由有三：
 *
 * 1. 删旧引擎路径的前提就是"测试不再依赖旧路径"。默认走旧库 = 测试继续验证
 *    我们马上要删掉的那条路，是"假传输掩盖真实契约"在存储层的版本；
 * 2. 端口一开，路由层的读写分裂**立刻暴露**（实测：5199 全绿 → 96 个失败），
 *    而这些失败全部指向真实缺陷，不是测试噪音（本轮已修 98 个：`getMessage` 只读旧库、
 *    `tool_calls` 读写分裂、`compactWithSnapshot` 在 rust 引擎下是空操作、
 *    镜像同步晚于 IPC 的时序窗口、`anchorSeq` 字符串拼接把快照自己删掉…）；
 * 3. 剩下那 96 个失败就是**删除工作的待办清单** —— 它们开着比藏着有用。
 *
 * 设 `CODEM_TEST_PORT=0` 可退回"纯旧引擎"形态，用于对照实验：
 * 那个形态下套件是全绿的（5199/5199），因为它验证的是旧路径。
 */
const USE_PORT = process.env.CODEM_TEST_PORT !== "0";

beforeEach(async () => {
  /**
   * ⚠️ 顺序很重要：**先**注册一个新的内存端口，**再**重置旧库。
   *
   * 反过来的话，`resetDatabase()`（以及测试自己 `beforeEach` 里对旧库的 DELETE）
   * 会作用在一个**刚刚被端口接管**的数据面上 —— 它们清的是旧库那张表，
   * 而产品此时读写的是端口那份，于是"清空"看起来无效（跨用例数据串味）。
   * 先注册端口再清旧库，两边都是干净起点。
   */
  setStoragePort(USE_PORT ? createFakeStoragePort() : null);

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


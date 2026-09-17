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
 * 测试基座：**端口是唯一形态**（第 16 轮，L4）。
 *
 * 历史（第 92 波 P3 第 10 段起）：这里用 `CODEM_TEST_PORT=0` 切到"纯旧引擎"形态做对照，
 * 因为当时产品还有两条路（端口 / 旧库），需要两侧都测。
 *
 * **现在那个对照模式已退役**，两个理由：
 * 1. 回滚开关退役 + 旧引擎即将删除 → A 态（端口未注册）在生产里不可能出现，
 *    为一个不可能出现的形态维持一整套基座，只会让"删 A 态分支"这件事**无法验收**
 *    （实测：删掉 `note-manager` 的旧库回退后，A 态套件立刻红一条，
 *    而那正是要删的东西本身 —— 这不是回归，是基座在替已死的路径说话）；
 * 2. 端口模式已经**全绿**（5235 通过 / 0 失败），它有资格独自承担"产品契约"这件事。
 *
 * 个别用例若要验证**旧路径**的行为（例如 `silent-write-guard` 守的
 * `runGuarded` 静默空写探测器只存在于旧库路径），在用例内部**显式** `setStoragePort(null)`
 * —— 变成"谁需要旧路径谁自己声明"，而不是整个套件默认跑在那里。
 */
const USE_PORT = true;

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


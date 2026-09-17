/**
 * 全局测试初始化：每个用例前注册一个干净的内存存储端口。
 *
 * 第 18 轮起**不再初始化旧引擎（sql.js）** —— 见下面 `beforeEach` 的说明。
 */
import { beforeEach, beforeAll, afterAll } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

// 确保 window.__TAURI__ 不存在（模拟浏览器/非 Tauri 环境）
beforeAll(async () => {
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
   * 顺序契约（第 92 波起）：先注册一个新端口，再（如果有旧库）清旧库 ——
   * 反过来的话清理会作用在"刚被端口接管"的数据面上，表现为跨用例串味。
   *
   * ⚠️ 第 18 轮：**测试基座不再初始化旧引擎**（`initDatabase()` / `resetDatabase()` 已从这里删除）。
   *
   * 这一步是 L1（删 sql.js）的前置：基座每例都 init 一次旧库，等于**把"产品不会出现的状态"维持成常态**
   * —— 一整类缺陷会因此隐身（第 18 轮那个"启动维护从未执行"的真机缺陷就是这么藏了很久：
   * 测试里 `db` 永远非空，维护路径在测试里一直活着，与真机恰好相反）。
   *
   * 实测：去掉这一步后全量套件只有 **1 个文件 / 2 条**失败（都是把旧库当夹具的用例，
   * 已改成端口夹具）—— 也就是说"套件依赖旧引擎"这件事被高估了很久。
   */
  setStoragePort(USE_PORT ? createFakeStoragePort() : null);

  // 清空 localStorage
  localStorage.clear();
});

// vitest worker teardown 竞态规避：重度日志测试（refactor-prompt-to-data /
// llm-timeout-hardening / forked-agent 等）在文件结束瞬间仍有在途 console 输出 →
// threads 下触发 "Closing rpc while onUserConsoleLog was pending" unhandled
// （0 failed 但 exit≠0）。给在途输出一个送达窗口再让 worker 收尾
// （保留控制台可见性，不关 console 收集）。
//
// 第 18 轮：清单里原有一个 `db-save-failure-alert`——那个文件测的是旧引擎的"保存失败可见性"，
// 已随引擎退役（覆盖移交见 `db-fatal-cascade.test.ts` 的文件头台账：PF-1/PF-2/PF-4 + DBF-6）。
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 150));
});


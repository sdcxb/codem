/**
 * 启动顺序：**记忆的第一次读盘必须看得见存储端口**（第 233 轮审计 · P1）。
 *
 * ## 缺陷形态（每次启动都发生）
 *
 * `App.tsx` 两条 effect 并行：Cordis 初始化 → `getLLMEngine()` → `getMemoryService()`
 * → **同步** `load()`；另一条 effect `registerRustStoragePort()` → `await port.start()`。
 * 于是记忆必然先读、端口必然后到，每次启动都打出：
 *
 * ```
 * [Advisory] memory.load：…没有可用的存储端口
 * [memory] 迁移推迟（不写标记、不覆盖）：没有可用的存储端口
 * ```
 *
 * 后果不是"吵"：①窗口内 `loadState.ok=false` ⇒ 写入被拒（fail-closed）；
 * ②迁移被推迟，面板会给出"为什么没迁移"的假解释；
 * ③**真故障与这个竞态输出一模一样**，排查时分不清 —— 这条最要命。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | MEM-BOOT-1 | 端口就绪后构造记忆 ⇒ `loadState.ok === true`，且**没有**任何 `memory.load` 上报 |
 * | MEM-BOOT-2（反向对照）| 端口**未**就绪时构造 ⇒ `ok === false` 且如实上报（不许假装成功） |
 * | MEM-BOOT-3 | `ensureStoragePortRegistered()` 单飞：两次并发调用只开库一次 |
 * | MEM-BOOT-4 | Cordis 初始化必须**先 await** 端口就绪，再构造引擎（源码顺序，防回退） |
 *
 * 变异自证：把 App 里的 `await ensureStoragePortRegistered()` 删掉 ⇒ MEM-BOOT-4 红；
 * 把单飞缓存去掉（每次新建 promise）⇒ MEM-BOOT-3 红。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const reported: Array<{ scope: string; note: string }> = [];

/**
 * ?? ? `importOriginal` ?**??**??????????????? ??
 * ?? `persist-failure-mock-parity` PFP-2 ???mock ????????
 * ??????? `withdrawFailure` / `composePersistAlertText` ?????????????????
 */
vi.mock("../core/storage/persist-failure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/storage/persist-failure")>();
  return {
    ...actual,
    reportActionFailure: (scope: string, _error: unknown, note: string) => reported.push({ scope, note }),
    reportPersistFailure: (scope: string, _error: unknown, note: string) => reported.push({ scope, note }),
    reportAdvisory: (scope: string, finding: unknown) =>
      reported.push({ scope, note: typeof finding === "string" ? finding : String(finding) }),
  };
});

import { setStoragePort, hasStoragePort } from "../core/storage/port";
import type { StorageTransport } from "../core/storage/rust-port";

/** 统计真正开了几次库 */
let openCount = 0;

function makeTransport(): StorageTransport {
  return {
    invokeCommand: async (command: string) => {
      if (command === "settings.get_all") {
        openCount += 1;
        return { ok: true, result: { theme: "dark" } } as never;
      }
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () =>
      ({
        ok: true,
        result: {
          ready: true,
          path: "C:/tmp/rust.bin",
          size_bytes: 4096,
          journal_mode: "wal",
          wal_size_bytes: 0,
          tables: 45,
          fts_module: "fts5",
        },
      }) as never,
  } as unknown as StorageTransport;
}

beforeEach(async () => {
  reported.length = 0;
  openCount = 0;
  const { shutdownRustStoragePort, __resetStoragePortRegistrationForTests } = await import("../core/storage/bootstrap");
  await shutdownRustStoragePort().catch(() => undefined);
  __resetStoragePortRegistrationForTests();
  setStoragePort(null);
});

describe("启动顺序：记忆读盘必须看得见存储端口", () => {
  it("MEM-BOOT-3: ensureStoragePortRegistered 单飞（并发两次只开库一次）", async () => {
    const { ensureStoragePortRegistered, __resetStoragePortRegistrationForTests } = await import(
      "../core/storage/bootstrap"
    );
    __resetStoragePortRegistrationForTests();
    const [a, b] = await Promise.all([
      ensureStoragePortRegistered(makeTransport()),
      ensureStoragePortRegistered(makeTransport()),
    ]);
    expect(a.kind, `第一次注册结果：${JSON.stringify(a)}`).toBe("registered");
    expect(b.kind).toBe("registered");
    expect(openCount, "两次并发必须只开库一次（单飞）").toBe(1);
    expect(hasStoragePort()).toBe(true);
  });

  it("MEM-BOOT-1: 端口就绪后构造记忆 ⇒ 读成功且零上报", async () => {
    const { registerRustStoragePort } = await import("../core/storage/bootstrap");
    await registerRustStoragePort(makeTransport(), "test.boot");
    reported.length = 0;

    const { MemoryService } = await import("../core/memory/memory");
    const svc = new MemoryService();
    expect(svc.getLoadState().ok, `读盘状态：${JSON.stringify(svc.getLoadState())}`).toBe(true);
    const loadReports = reported.filter((r) => r.scope.includes("memory.load"));
    expect(loadReports, `端口已就绪时不该有任何 memory.load 上报，实际：${JSON.stringify(loadReports)}`).toHaveLength(0);
  });

  it("MEM-BOOT-2（反向对照）: 端口未就绪时构造 ⇒ 如实失败，不许假装成功", async () => {
    setStoragePort(null);
    const { MemoryService } = await import("../core/memory/memory");
    const svc = new MemoryService();
    expect(svc.getLoadState().ok, "没端口就必须是失败态（否则写入会覆盖真实记忆）").toBe(false);
    expect(
      reported.some((r) => r.scope.includes("memory.load") || r.note.includes("存储端口")),
      "必须如实上报（这条是「真故障」与「启动竞态」共用的通道）",
    ).toBe(true);
  });

  it("MEM-BOOT-4: Cordis 初始化必须先 await 端口就绪（源码顺序，防回退）", () => {
    const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
    const cordis = app.slice(app.indexOf("_codemCtxPromise = (async () => {"));
    const waitIdx = cordis.indexOf("await ensureStoragePortRegistered()");
    const engineIdx = cordis.indexOf("getLLMEngine(ctx)");
    expect(waitIdx, "Cordis 初始化里必须等端口就绪").toBeGreaterThan(-1);
    expect(engineIdx, "找不到引擎构造点（判据锚点过期）").toBeGreaterThan(-1);
    expect(waitIdx, "端口等待必须**先于**引擎构造（否则记忆又会先读）").toBeLessThan(engineIdx);
  });
});

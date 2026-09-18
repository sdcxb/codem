/**
 * 库损坏 → **当场**留下「索引需要重建」标记（第 49 轮，损坏恢复链路补完）
 *
 * ## 守的缺陷
 *
 * `port.ts` 的错误码表上写着 `"CORRUPT" // 库损坏（走索引重建）`，
 * 但实现里**没有这条链路**。全仓 `markIndexRebuildNeeded` 的调用点当时只有两个：
 *
 * 1. 引擎在**打开**时发现头部损坏并重建（`health()` 报 `recovered`）；
 * 2. **12 小时节流**的完整性检查判定失败。
 *
 * 于是当一条**普通命令**在数据页损坏上报 `CORRUPT` 时，界面只会看到那一次操作失败，
 * "索引需要重建"这个标记**不会被写** —— 自愈要等到下一次完整性检查，
 * 最长 **12 小时**（真机日志里那句"距上次检查 7.7 小时…还需 4.3 小时"就是这个形态）。
 * 这期间引擎会继续用一份**不可信的索引**回答查询。
 *
 * 引擎侧的取证（同一轮，真机 CLI，对着**用户库的副本**做，从不碰 %APPDATA% 那份）：
 * - 头部损坏 → `open_with_recovery` 把坏文件**改名**成 `<db>.corrupt-<ts>`（16.24 MB 原样保留）
 *   并建出全新库（46 张表），返回值里带 `recovered: true` 与 `recovered_from`；
 * - 数据页损坏（仍能打开）→ `integrity_check` 精确报出坏页，
 *   而**普通读命令照样成功** —— 这正是"必须靠这道检查发现"的原因。
 *
 * ## 判据
 *
 * | 情形 | 期望 |
 * | --- | --- |
 * | 端口已注册 + 命令回 `CORRUPT` | 标记文件被写；上报一次；错误照常抛给调用方 |
 * | 同一进程里后续命令也回 `CORRUPT` | 标记**只写一次**、只上报一次（损坏是库级状态） |
 * | 端口**未**注册（启动引导阶段） | 不写标记（没有端口就没有维护，标记没人消费） |
 * | 非 `CORRUPT` 的失败（如 `BUSY`） | 完全不碰标记 |
 *
 * ## ⚠️ 这条链是**异步**的，用例不许用固定 sleep
 *
 * 标记写入要经过 `await import("./maintenance")` + 一次文件 IPC。
 * 第一版用例等了 10 ms 就断言 —— 于是"标记没写"与"还没写完"分不开，
 * 用例时红时绿（我先用一个小探针把真实耗时量出来：30 ms 不够、300 ms 稳）。
 * 现在一律用**等条件**（`waitFor`），最后再留一段"沉淀窗口"确认没有第二次写入。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import {
  RustStoragePort,
  __resetCorruptNotedForTests,
  type StorageTransport,
} from "../core/storage/rust-port";
import { INDEX_REBUILD_MARKER } from "../core/storage/maintenance";

/** 假的应用数据目录 + 假的文件 IPC（与 maintenance-rust-mode.test.ts 同一种做法） */
const files = new Map<string, string>();
/** 每个路径被写了几次 —— "不重复写标记"必须数**写次数**，光看文件在不在看不出重复 */
const writes = new Map<string, number>();
const APP_DIR = "C:/fake-appdata/";

function installFakeTauri() {
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "get_app_data_dir") return APP_DIR;
        if (cmd === "write_file") {
          const p = String(args?.path);
          files.set(p, String(args?.content ?? ""));
          writes.set(p, (writes.get(p) ?? 0) + 1);
          return null;
        }
        if (cmd === "read_file") {
          const p = String(args?.path);
          if (!files.has(p)) throw new Error("not found");
          return files.get(p);
        }
        return null;
      },
    },
  };
}

const markerPath = `${APP_DIR}${INDEX_REBUILD_MARKER}`;
const markerWrites = () => writes.get(markerPath) ?? 0;

/** 等条件成立（异步链路的唯一可靠写法），最多 `timeoutMs` */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** 沉淀窗口：给"本不该发生"的异步写入留出发作的机会，再断言它没发生 */
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** 造一个假传输层：`CORRUPT` 或指定的错误码 */
function makeTransport(code: string) {
  return {
    invokeCommand: async () => ({ ok: false, error: { code, message: `fake ${code}`, retryable: false } }),
    invokeBatch: async () => ({ ok: true, result: { items: [] } }),
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }),
    integrityCheck: async () => ({ ok: true, result: { ok: true } }),
    checkpoint: async () => ({ ok: true, result: { ok: true } }),
    capabilities: async () => ({ ok: true, result: { commands: [] } }),
  };
}

beforeEach(() => {
  resetPersistFailures();
  // 闩锁是进程级的（生产语义就是"每进程一次"），用例之间必须复位，否则互相污染
  __resetCorruptNotedForTests();
  files.clear();
  writes.clear();
  installFakeTauri();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
});

describe("CORRUPT：库损坏必须当场留下「索引需要重建」标记", () => {
  it("CORRUPT-1: 端口已注册 + 命令回 CORRUPT → 写标记 + 上报（错误仍照常抛出）", async () => {
    const port = new RustStoragePort(
      makeTransport("CORRUPT") as unknown as StorageTransport,
      () => {},
    );
    setStoragePort(port);

    expect(markerWrites(), "前置：还没有标记").toBe(0);

    // 任意一条普通读命令在损坏的库上失败
    let threw = false;
    try {
      await port.data.query("crud.list", { table: "messages", limit: 1 });
    } catch (e) {
      threw = true;
      expect((e as { code?: string }).code, "错误必须仍是 CORRUPT（不许被吞成别的东西）").toBe(
        "CORRUPT",
      );
    }
    expect(threw, "错误必须照常抛给调用方（标记是补充，不是替代）").toBe(true);

    const written = await waitFor(() => markerWrites() > 0);
    expect(
      written,
      "「索引需要重建」标记必须被写下 —— 否则自愈要等到下次完整性检查（最长 12 小时）",
    ).toBe(true);
    expect(files.get(markerPath), "理由里要能看出是哪条命令报的").toContain("crud.list");
    expect(
      getPersistFailures().map((f) => f.area),
      "失败必须可见（静默的损坏比损坏本身更糟）",
    ).toContain("storage.corrupt");
  });

  it("CORRUPT-2: 同一进程里后续命令也报损坏 → 标记只写一次、只上报一次", async () => {
    const port = new RustStoragePort(
      makeTransport("CORRUPT") as unknown as StorageTransport,
      () => {},
    );
    setStoragePort(port);

    for (let i = 0; i < 3; i++) {
      await port.data.query("crud.list", { table: "messages", limit: 1 }).catch(() => {});
    }
    await waitFor(() => markerWrites() > 0);
    await settle(); // 沉淀窗口：等"第二次写入"如果有的话发作

    expect(markerWrites(), "损坏是库级状态 —— 读循环里会失败成百上千次，只该留一次标记").toBe(1);
    const entries = getPersistFailures().filter((f) => f.area === "storage.corrupt");
    expect(entries.length, "只该上报一条（否则会刷屏）").toBe(1);
  });

  it("CORRUPT-3: 端口未注册（启动引导阶段）→ 不写标记（那种失败由 bootstrap 自己上报）", async () => {
    /**
     * 全局 setup 会装一个端口，所以这里**必须先摘掉**才能真正模拟"引导还在探测"。
     * （第一版没摘，于是 `hasStoragePort()` 为真、标记被写了 —— 用例红了，
     *   但红得对：它证明这条判据真的在起作用，而不是永远为真。）
     */
    setStoragePort(null);
    const port = new RustStoragePort(
      makeTransport("CORRUPT") as unknown as StorageTransport,
      () => {},
    );
    // 故意**不** setStoragePort —— 模拟"引导还在探测，端口尚未注册"

    await port.data.query("crud.list", { table: "messages", limit: 1 }).catch(() => {});
    await settle();

    expect(
      files.has(markerPath),
      "没有端口就没有维护 → 标记永远没人消费；而且引导失败已经另有如实上报",
    ).toBe(false);
    expect(getPersistFailures().map((f) => f.area)).not.toContain("storage.corrupt");
  });

  it("CORRUPT-4: 非损坏失败（BUSY）完全不碰标记（不许把正常失败升格成库损坏）", async () => {
    const port = new RustStoragePort(
      makeTransport("BUSY") as unknown as StorageTransport,
      () => {},
    );
    setStoragePort(port);

    await port.data.query("crud.list", { table: "messages", limit: 1 }).catch(() => {});
    await settle();

    expect(markerWrites(), "BUSY 不是损坏 —— 给它留重建标记会让维护白重建一次索引").toBe(0);
    expect(getPersistFailures().map((f) => f.area)).not.toContain("storage.corrupt");
  });
});

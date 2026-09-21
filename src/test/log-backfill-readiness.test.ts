/**
 * 权威日志回填的**就绪契约**（第 62 轮真机取证）
 *
 * ## 现场
 *
 * 用 `CODEM_DB_PATH` 隔离启动一个"从旧库迁移过来"的库（索引里 800+ 条消息、
 * 日志目录还不存在），连续三次维护都打 `日志回填 0 条`，而**权威日志一个文件都没建出来**。
 *
 * 机制与第 44 轮那次"索引裁剪整条从不生效"完全相同：`listMessages` 在该会话的
 * 消息镜像未加载完时返回**空数组**，于是 `messages.length === 0 → continue` ——
 * 回填"跑了但什么都没做"，而返回值 0 在日志上与"确实没有可回填的"长得一模一样。
 *
 * 代价不只是少回填一次：**追加日志是这套架构的权威副本**（"库坏了从日志重建"的唯一输入），
 * 它没被建出来，那条后路在那次启动里就是空的。
 *
 * ## 判据
 *
 * 1. 镜像**未加载**（真端口同形的异步窗口）→ 回填必须**等到就绪再干活**，
 *    并把日志真的建出来（`backfilled > 0`）；
 * 2. 镜像**永远不就绪** → 不许冒充"回填 0 条"：`skippedUnreadable` 必须计上，
 *    维护汇总行也要看得见；
 * 3. 已经在日志里的消息**不许重复回填**（幂等，这条是原有契约，防回归）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { textWindowSlice } from "./helpers/tauri-fs-stub";

const SID = "backfill-session";

/** Tauri 桩：内存文件系统（日志就是写进它的） */
function installTauri(): { files: Map<string, string> } {
  const files = new Map<string, string>();
  const stub = {
    core: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "storage_info") {
          return { engine: "rust", path: "C:\\appdata\\codem-db-rust.bin", exists: true, standard: true, reason: null };
        }
        if (cmd === "write_file") {
          files.set(args.path as string, args.content as string);
          return undefined;
        }
        if (cmd === "append_file") {
          files.set(args.path as string, (files.get(args.path as string) ?? "") + (args.content as string) + "\n");
          return undefined;
        }
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") {
          if (!files.has(args.path as string)) throw new Error("no such file");
          return files.get(args.path as string);
        }
        if (cmd === "exists") return files.has(args.path as string);
        if (cmd === "path_exists") return files.has(args.path as string);
        if (cmd === "list_directory") return [];
        return undefined;
      },
    },
  };
  (window as any).__TAURI__ = stub;
  (globalThis as any).__TAURI__ = stub;
  return { files };
}

/**
 * 建端口 + 播种"索引里有消息、但日志还不存在"这个状态。
 *
 * ⚠️ 事件/消息行必须**直接播种**（走 `createMessage` 会顺手写日志，那就不叫"日志还不存在"了），
 * 而且不 `ensureLoaded` —— `asyncLoad` 打开的假端口与真端口一样，加载要等一个微任务。
 */
function install(opts: { asyncLoad: boolean }): FakeStoragePort {
  const port = createFakeStoragePort({
    asyncLoad: opts.asyncLoad,
    seed: {
      sessions: [
        { id: SID, project_id: "", title: "回填", model: null, created_at: 1, last_message_at: 2, message_count: 2, pinned: 0 },
      ],
      messages: [
        { id: "bf-1", session_id: SID, role: "user", content: "第一条", reasoning: null, timestamp: 100, model: null, status: "done", hidden: 0, trimmed: 0 },
        { id: "bf-2", session_id: SID, role: "assistant", content: "第二条", reasoning: null, timestamp: 200, model: null, status: "done", hidden: 0, trimmed: 0 },
      ],
    },
  });
  setStoragePort(port);
  return port;
}

/** 日志目录里有哪些文件（用 Tauri 桩的文件表判断，就是真机上的磁盘） */
const logFiles = (files: Map<string, string>) => [...files.keys()].filter((k) => k.endsWith(".jsonl"));

/**
 * 等 `sessions` **域镜像**就绪。
 *
 * ⚠️ 夹具要点（第一版漏了这一步，`backfilled` 一直是 0）：`backfillAllSessions` 的会话清单
 * 来自 `domainReadMany("sessions")`，而域镜像与消息镜像**是两套独立就绪状态**。
 * 真机上维护流程在这条步骤之前已经读过 `sessions`（对账那一段），所以它是就绪的；
 * 直接调这个函数就必须自己把这一步补上，否则走的是"域镜像未就绪 → 本次跳过回填"那条早退分支
 * —— 那条分支的返回同样是 0，会把"夹具没准备好"伪装成"被测逻辑没干活"。
 */
async function waitForSessionsDomain(): Promise<void> {
  const { domainEnsureLoaded } = await import("../core/storage/domain-store");
  await new Promise<void>((resolve) => {
    domainEnsureLoaded("sessions", () => resolve());
    // 假端口在异步模式下会在这个 tick 内回调；同步模式立即回调
    setTimeout(resolve, 50);
  });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("BF：权威日志回填必须先等消息镜像就绪", () => {
  it("BF-1: 镜像未加载（异步窗口）→ 仍然要把日志建出来（修前这里是静默的 0 条）", async () => {
    const { files } = installTauri();
    const port = install({ asyncLoad: true });
    // 刻意不 ensureLoaded：这一刻就是真机启动窗口的形态
    expect(port.messages.isLoaded(SID), "夹具前提：镜像确实还没就绪").toBe(false);

    await waitForSessionsDomain();
    const { backfillAllSessions } = await import("../core/storage/session-log-bridge");
    const out = await backfillAllSessions({ mirrorWaitMs: 2000 });

    expect(out.skippedUnreadable, "等到了就绪 → 不该有会话被跳过").toBe(0);
    expect(out.backfilled, "两条消息都要回填进日志").toBe(2);
    expect(logFiles(files), "权威日志必须真的被建出来（这是'库坏了能重建'的唯一输入）").toHaveLength(1);
    expect(files.get(logFiles(files)[0])).toContain("bf-1");
    expect(files.get(logFiles(files)[0])).toContain("bf-2");
  });

  it("BF-2: 镜像**永远不就绪** → 不许冒充「回填 0 条」，要单独计数并上报", async () => {
    const { files } = installTauri();
    const port = install({ asyncLoad: false });
    // 把这个会话的消息通道钉成"永远加载不完"
    const m = port.messages as unknown as { isLoaded: (s: string) => boolean; ensureLoaded: (s: string, cb?: () => void) => void };
    m.isLoaded = () => false;
    m.ensureLoaded = () => {};

    const { backfillAllSessions } = await import("../core/storage/session-log-bridge");
    await waitForSessionsDomain();
    vi.useFakeTimers();
    const pending = backfillAllSessions({ mirrorWaitMs: 1500 });
    await vi.advanceTimersByTimeAsync(2000);
    const out = await pending;
    vi.useRealTimers();

    expect(out.backfilled, "没读到就不该声称回填了东西").toBe(0);
    expect(out.skippedUnreadable, "必须能说出'这个会话本次没回填'").toBe(1);
    expect(logFiles(files), "镜像不可读时不许凭空造日志").toHaveLength(0);
  });

  it("BF-3: 幂等 —— 已在日志里的消息不重复回填（原有契约，防回归）", async () => {
    const { files } = installTauri();
    install({ asyncLoad: true });

    await waitForSessionsDomain();
    const { backfillAllSessions } = await import("../core/storage/session-log-bridge");
    const first = await backfillAllSessions({ mirrorWaitMs: 2000 });
    expect(first.backfilled).toBe(2);
    const afterFirst = files.get(logFiles(files)[0])!;

    const second = await backfillAllSessions({ mirrorWaitMs: 2000 });
    expect(second.backfilled, "第二次不该重复写").toBe(0);
    expect(files.get(logFiles(files)[0]), "日志内容一个字都不该变").toBe(afterFirst);
  });

  it("BF-5: **全新的数据根目录**（目录本身都不存在，os error 3）也要能建出日志", async () => {
    /*
     * 这条是 BF-1 在真机上的真实形态（第 62 轮隔离钻取抓到的）：
     * 磁盘上的"没有这个文件"在 Windows 上有两个错误码 —— 目录在、文件不在是 **os error 2**，
     * 而**目录本身就不在**是 **os error 3**（`ERROR_PATH_NOT_FOUND`）。
     * 判据原来只认 2，于是全新数据根目录下"还没有日志"被判成**读失败**并向上抛：
     * 真机表现为每个会话都打 `回填失败（跳过）: 系统找不到指定的路径。 (os error 3)`，
     * **权威日志一个文件都建不出来**，而汇总只显示 `日志回填 0 条`。
     *
     * 这里让 `read_file` 对**任何**路径都回 os error 3（= 目录不存在），
     * 只有 `append_file` 成功后路径才存在 —— 与真机第一次落盘的形态一致。
     */
    const files = new Map<string, string>();
    const stub = {
      core: {
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          if (cmd === "get_app_data_dir") return "C:\\appdata\\";
          if (cmd === "storage_info") {
            return { engine: "rust", path: "C:\\appdata\\codem-db-rust.bin", exists: true, standard: true, reason: null };
          }
          if (cmd === "append_file") {
            // 真机 Rust 侧 `append_file` 会 `create_dir_all(parent)` —— 所以它能建目录并落盘
            files.set(args.path as string, (files.get(args.path as string) ?? "") + (args.content as string) + "\n");
            return undefined;
          }
          if (cmd === "read_text_window") return textWindowSlice(files, args);
          if (cmd === "read_file") {
            if (!files.has(args.path as string)) throw new Error("系统找不到指定的路径。 (os error 3)");
            return files.get(args.path as string);
          }
          if (cmd === "exists") return files.has(args.path as string);
          if (cmd === "path_exists") return files.has(args.path as string);
          if (cmd === "list_directory") throw new Error("系统找不到指定的路径。 (os error 3)");
          return undefined;
        },
      },
    };
    (window as any).__TAURI__ = stub;
    (globalThis as any).__TAURI__ = stub;

    const port = install({ asyncLoad: true });
    expect(port.messages.isLoaded(SID)).toBe(false);

    await waitForSessionsDomain();
    const { backfillAllSessions } = await import("../core/storage/session-log-bridge");
    const out = await backfillAllSessions({ mirrorWaitMs: 2000 });

    expect(out.skippedUnreadable).toBe(0);
    expect(out.backfilled, "全新根目录下也必须回填（os error 3 = '还没有日志'，不是读失败）").toBe(2);
    expect(logFiles(files), "日志文件必须被建出来").toHaveLength(1);
  });

  it("BF-4: 维护汇总行把「未回填的会话数」打出来（'没跑' 与 '0 条' 分得开）", async () => {
    /*
     * ⚠️ 这条走**真维护**，并且用**真定时器**：维护链里有大量真实的异步等待
     * （审计等镜像 4 秒 + 回填等镜像 5 秒），假定时器驱动不了它
     * —— 第 61 轮已经在 `RVL-W4` 上踩过一次（会直接挂到超时）。所以这里单独给 30 秒预算。
     */
    const { files } = installTauri();
    const port = install({ asyncLoad: false });
    const m = port.messages as unknown as { isLoaded: (s: string) => boolean; ensureLoaded: (s: string, cb?: () => void) => void };
    m.isLoaded = () => false;
    m.ensureLoaded = () => {};

    await waitForSessionsDomain();
    const { runDatabaseMaintenance } = await import("../core/storage/maintenance");
    const res = await runDatabaseMaintenance({});

    expect(res.backfillSkippedUnreadable, "结果里必须带上这个数字").toBe(1);
    const logs = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0] ?? ""));
    const summary = logs.find((l) => l.includes("维护完成")) ?? "";
    expect(summary, "汇总行必须写出'未回填'（否则与'回填 0 条'长得一样）").toContain("未回填");
    expect(logFiles(files), "没就绪就不该有日志文件").toHaveLength(0);
  }, 30000);
});

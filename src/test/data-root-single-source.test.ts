/**
 * 数据根目录的**单一来源**契约（第 62 轮）
 *
 * ## 被修掉的第二个"同一事实两个来源"
 *
 * 第 55 轮真事故的根因是"库文件在哪"有两个来源：渲染侧走 Tauri `app_data_dir()`、
 * 引擎走自己读 `APPDATA` 的解析 —— 两者不等价，于是**渲染侧把日志写进真目录、
 * 引擎把库建到别处**（用户数据在仓库工作目录里长出来，差点被 `git add -A` 提交）。
 * 第 55 轮把引擎改成同一个已知文件夹 API，看上去"按构造一致"了。
 *
 * **但第二个来源还在**：引擎支持 `CODEM_DB_PATH` 显式指定库路径（便携模式与隔离钻取的
 * 唯一受支持入口），而渲染侧的四个存储文件仍然只认 `appDataDir`：
 * `sessions/*.jsonl`（**权威副本**）、`attachments/*`（正文外置）、`spill/*`（超大工具结果）、
 * `codem-index-rebuild-needed.json`（自愈标记）。库一指到别处，**权威日志与被它支撑的索引
 * 就不在同一份数据集里**：自愈会在另一份数据上跑；便携模式把库拷走、日志留在本机；
 * 隔离钻取会读写用户的真日志。
 *
 * ## 判据：根目录 = 引擎**实际使用**的那份库文件所在目录
 *
 * 标准情况下逐字不变（库在 `%APPDATA%\<identifier>\codem-db-rust.bin` ⇒ 根目录就是它的父目录）；
 * 库被指到别处时渲染侧跟着走；拿不到 `storage_info` 才退回 `appDataDir`，**并记住原因**。
 *
 * ⚠️ 夹具要点：`__TAURI__` 桩里 `storage_info` 必须给出 `path`（Tauri 命令，第 55 轮就有），
 * 否则测的就是兜底路径 —— 那样"跟着库走"这条断言永远不会被真正验证。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetDataRootCache,
  dataRootInfoIfResolved,
  resolveDataRoot,
  rootFromDbPath,
} from "../core/storage/data-root";

/** 便携/隔离场景：库被 `CODEM_DB_PATH` 指到 D 盘 */
const PORTABLE_DB = "D:\\portable-codem\\codem-db-rust.bin";
const PORTABLE_ROOT = "D:\\portable-codem\\";
const APP_DATA = "C:\\Users\\tester\\AppData\\Roaming\\codem\\";

interface Recorded {
  command: string;
  args?: Record<string, unknown>;
}

/** 装一个记录型 Tauri 桩；`withStorageInfo=false` 用来测兜底路径 */
function installTauri(opts: { withStorageInfo: boolean; dbPath?: string }): Recorded[] {
  const calls: Recorded[] = [];
  const invoke = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "get_app_data_dir") return APP_DATA;
    if (command === "storage_info") {
      if (!opts.withStorageInfo) throw new Error("command storage_info not found");
      return {
        engine: "rust",
        path: opts.dbPath ?? PORTABLE_DB,
        exists: true,
        standard: false,
        reason: "由环境变量 CODEM_DB_PATH 指定",
      };
    }
    if (command === "path_exists") return false;
    if (command === "read_file") throw new Error("no such file");
    return undefined;
  };
  (window as any).__TAURI__ = { core: { invoke } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
  return calls;
}

beforeEach(() => {
  __resetDataRootCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  __resetDataRootCache();
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("DR：根目录解析本身", () => {
  it("DR-1: `rootFromDbPath` —— Windows / Unix 分隔符与裸文件名都要对", () => {
    expect(rootFromDbPath(PORTABLE_DB)).toBe(PORTABLE_ROOT);
    expect(rootFromDbPath("/home/u/.codem/codem-db-rust.bin")).toBe("/home/u/.codem/");
    // 混合分隔符：以最后出现的那个为准（Windows 上两种都可能出现）
    expect(rootFromDbPath("C:/a/b\\codem-db-rust.bin")).toBe("C:/a/b\\");
    // 裸文件名（不该发生）：当成当前目录，绝不返回空串
    expect(rootFromDbPath("codem-db-rust.bin")).toBe("codem-db-rust.bin\\");
  });

  it("DR-2: 有 `storage_info` 时，根目录 = **库所在的目录**，且原因是可查的", async () => {
    installTauri({ withStorageInfo: true });
    const info = await resolveDataRoot();

    expect(info.origin, "必须走引擎那条来源").toBe("engine");
    expect(info.root).toBe(PORTABLE_ROOT);
    expect(info.dbPath).toBe(PORTABLE_DB);
    expect(info.standard, "非标准位置要如实带出来").toBe(false);
    expect(info.reason).toContain("CODEM_DB_PATH");
    expect(dataRootInfoIfResolved()?.root, "解析过之后要能同步读到（诊断/日志用）").toBe(PORTABLE_ROOT);
  });

  it("DR-3: 拿不到 `storage_info` → 退回 appDataDir，**但必须记住为什么**", async () => {
    installTauri({ withStorageInfo: false });
    const info = await resolveDataRoot();

    expect(info.origin).toBe("app-data-dir");
    expect(info.root).toBe(APP_DATA);
    expect(info.fallbackWhy, "兜底不许静默：要说清这次为什么没问成引擎").toContain("storage_info");
  });

  it("DR-4: 没有 Tauri 运行时 → **拒绝**给出落点并说清原因（绝不退回相对路径）", async () => {
    delete (window as any).__TAURI__;
    delete (globalThis as any).__TAURI__;

    /*
     * 这条判据来自第 55 轮真事故：当时的兜底是"当前目录里的裸文件名"，
     * 于是数据落进了仓库工作目录。所以"两个来源都拿不到"时必须**失败**，
     * 而不是挑一个没人能说清的位置 —— 这一层会由调用方如实上报。
     */
    await expect(resolveDataRoot()).rejects.toThrow(/拒绝退回相对路径/);

    // 失败**不缓存**：Tauri 晚一点就绪时，下一次调用必须能成功
    installTauri({ withStorageInfo: true });
    await expect(resolveDataRoot()).resolves.toMatchObject({ root: PORTABLE_ROOT });
  });

  it("DR-5: 只解析一次（并发调用共享同一次 IPC）", async () => {
    const calls = installTauri({ withStorageInfo: true });
    const [a, b, c] = await Promise.all([resolveDataRoot(), resolveDataRoot(), resolveDataRoot()]);
    expect(a.root).toBe(b.root);
    expect(b.root).toBe(c.root);
    expect(calls.filter((x) => x.command === "storage_info").length, "三次并发不该问三次").toBe(1);
  });
});

describe("DR：四个存储文件必须跟着库走（同一份数据集）", () => {
  it("DR-6: 权威日志 `<root>sessions/<sid>.jsonl` 落在**库所在目录**", async () => {
    installTauri({ withStorageInfo: true });
    const { sessionLogPath, __resetJsonlCache } = await import("../core/storage/session-jsonl");
    __resetJsonlCache();

    const path = await sessionLogPath("sess-1");
    expect(path).toBe(`${PORTABLE_ROOT}sessions\\sess-1.jsonl`);
    // 与"库在哪"逐字对齐：根目录必须等于库文件的父目录
    expect(path.startsWith(rootFromDbPath(PORTABLE_DB))).toBe(true);

    // 对照组：拿不到 storage_info 时保持旧行为（appDataDir）
    __resetDataRootCache();
    __resetJsonlCache();
    installTauri({ withStorageInfo: false });
    expect(await sessionLogPath("sess-1")).toBe(`${APP_DATA}sessions\\sess-1.jsonl`);
  });

  it("DR-7: 附件外置正文落在 `<root>attachments/`", async () => {
    const calls = installTauri({ withStorageInfo: true });
    const { externalizeAttachmentContent } = await import("../core/storage/attachment-files");

    const res = await externalizeAttachmentContent("att-1", "note.txt", "正文");
    expect(res.marker).toContain(`${PORTABLE_ROOT}attachments\\`);
    const write = calls.find((c) => c.command === "write_file" && String(c.args?.path ?? "").includes("attachments"));
    expect(write, "必须真的写到那个目录").toBeTruthy();
  });

  it("DR-8: 超大工具结果的溢出文件落在 `<root>spill/`", async () => {
    const calls = installTauri({ withStorageInfo: true });
    const { retainToolResult } = await import("../core/storage/spill");

    const big = "x".repeat(200 * 1024);
    const res = await retainToolResult(big, { sessionId: "sess-1", toolName: "bash", callId: "c1", maxInlineBytes: 1024 });
    expect(res.spilled).toBe(true);
    expect(res.locator).toContain(`${PORTABLE_ROOT}spill\\`);
    const write = calls.find((c) => c.command === "write_file" && String(c.args?.path ?? "").includes("spill"));
    expect(write, "溢出文件必须真的写到那个目录").toBeTruthy();
  });

  it("DR-9: 索引重建标记落在 `<root>`（它与库是同一件事的两半）", async () => {
    const calls = installTauri({ withStorageInfo: true });
    const { markIndexRebuildNeeded, INDEX_REBUILD_MARKER } = await import("../core/storage/maintenance");

    const ok = await markIndexRebuildNeeded("自检测到索引落后");
    expect(ok).toBe(true);
    const write = calls.find((c) => c.command === "write_file" && String(c.args?.path ?? "").endsWith(INDEX_REBUILD_MARKER));
    expect(write, "标记必须写").toBeTruthy();
    expect(String(write?.args?.path)).toBe(`${PORTABLE_ROOT}${INDEX_REBUILD_MARKER}`);
  });

  it("DR-10: 标记的**读**也用同一个根目录（写与读不许分家）", async () => {
    const calls = installTauri({ withStorageInfo: true });
    const { indexRebuildNeeded } = await import("../core/storage/maintenance");

    await indexRebuildNeeded();
    const look = calls.find((c) => c.command === "path_exists");
    expect(String(look?.args?.path)).toBe(`${PORTABLE_ROOT}codem-index-rebuild-needed.json`);
  });
});

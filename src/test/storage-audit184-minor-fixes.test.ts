/**
 * 存储审计（第 184 波）的四条次要缺陷 —— 逐条判据。
 *
 * | 编号 | 缺陷 | 判据 |
 * | --- | --- | --- |
 * | ① | 维护的委派判据把「messages 域读不到」当空表（`?? []`）⇒ 清理功能**静默恒不执行** | MF-1 |
 * | ② | 引擎写的两条串行化通道互不相识（delete 侧绕过 `writeChains`）⇒ 同一行 upsert/delete 可乱序 | MF-2 |
 * | ③ | `updateSession` 白名单**静默丢弃**未列字段 | MF-3 |
 * | ④ | 会话计数对账在 `sessions` 镜像未就绪时**静默不跑**，汇总行看不出 | MF-4 |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import {
  __awaitPendingWrites,
  domainDeleteWhere,
  domainEnsureLoaded,
  domainWrite,
} from "../core/storage/domain-store";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { runDatabaseMaintenance } from "../core/storage/maintenance";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { textWindowSlice } from "./helpers/tauri-fs-stub";

const SESSION = "sess-audit184-minor";
const APP_DIR = "C:\\appdata\\";

/** 内存文件系统桩（维护会碰 JSONL 日志/标记文件） */
const files = new Map<string, string>();
function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return APP_DIR;
        if (cmd === "write_file") {
          files.set(args.path, args.content);
          return undefined;
        }
        if (cmd === "append_file") {
          files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n");
          return undefined;
        }
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") {
          if (!files.has(args.path)) throw new Error("no such file");
          return files.get(args.path);
        }
        if (cmd === "list_directory") {
          const dir = String(args.path);
          const sep = dir.endsWith("\\") ? "" : "\\";
          const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
          for (const key of files.keys()) {
            if (!key.startsWith(dir + sep)) continue;
            const rest = key.slice(dir.length + sep.length);
            if (rest.includes("\\")) continue;
            out.push({ name: rest, path: key, isDirectory: false });
          }
          return out;
        }
        if (cmd === "delete_file") {
          files.delete(args.path);
          return undefined;
        }
        if (cmd === "rename_file") {
          const content = files.get(args.oldPath);
          files.delete(args.oldPath);
          if (content !== undefined) files.set(args.newPath, content);
          return undefined;
        }
        if (cmd === "path_exists") return files.has(args.path);
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

const sessionRow = {
  id: SESSION,
  project_id: "p1",
  title: "会话",
  created_at: 1,
  last_message_at: 2,
  message_count: 0,
};

let port: FakeStoragePort | null = null;
let releaseDelete: (() => void) | null = null;

beforeEach(async () => {
  installFsStub();
  resetPersistFailures();
  const msgMod = await import("../core/storage/message");
  msgMod.clearSessionLogCache();
  const jsonl = await import("../core/storage/session-jsonl");
  jsonl.__resetJsonlCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  releaseDelete?.();
  releaseDelete = null;
  await __awaitPendingWrites();
  setStoragePort(null);
  resetPersistFailures();
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("① 委派判据：读不到 ≠ 一条 user 消息都没有", () => {
  it("MF-1: `messages` 域读不到时必须**如实说「本次跳过委派判据」**，不许静默当成空表", async () => {
    /**
     * 修前：`readMany(...) ?? []` 把"未就绪"收成空表 ⇒ `isDelegationArtifact([])` 恒 false
     * ⇒ 委派判据**静默恒不成立**（用户现场"侧栏里留着交接中间任务"照旧），
     * 而代码里那段"读失败 ⇒ 整体退化为不判委派"的保守退让**根本走不到**。
     * 所以这条判据钉的是"**能看见**"：读不到必须留下这句话。
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    port = createFakeStoragePort({ neverReady: ["messages"], seed: { sessions: [] } });
    setStoragePort(port);

    await runDatabaseMaintenance();

    const warns = warn.mock.calls.flat().map(String).join("\n");
    expect(warns, "读不到 messages ⇒ 必须明确说「跳过委派判据」（修前这里是静默的）").toContain("跳过委派判据");
    expect(warns, "原因要能诊断：这是「未就绪」，不是「没有 user 消息」").toContain("未就绪");
  });
});

describe("② 引擎写只有一条串行化通道（同一行的 delete 与 upsert 必须按调用顺序）", () => {
  it("MF-2: 同一行的 delete 还在飞时，upsert **不得**越过它先到引擎", async () => {
    const TABLE = "serial_probe";
    port = createFakeStoragePort({ seed: { [TABLE]: [{ id: "x", v: 1 }] } });
    setStoragePort(port);
    domainEnsureLoaded(TABLE, () => {});

    const events: string[] = [];
    const realExecute = port.data.execute.bind(port.data);
    const gate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    (port.data as { execute: unknown }).execute = async (cmd: string, params?: Record<string, unknown>) => {
      const table = (params as { table?: string } | undefined)?.table;
      if (cmd === "crud.delete" && table === TABLE) {
        events.push("delete:start");
        await gate;
        const r = await realExecute(cmd, params);
        events.push("delete:end");
        return r;
      }
      if (cmd === "crud.upsert" && table === TABLE) {
        events.push("upsert:start");
        const r = await realExecute(cmd, params);
        events.push("upsert:end");
        return r;
      }
      return realExecute(cmd, params);
    };

    // 同一行的两种写，按调用顺序发出：先删（按谓词，走 persistDeleteIdsBounded），再 upsert
    domainDeleteWhere(TABLE, (r) => r.id === "x", "id", { scope: "test.delete", note: "删" });
    domainWrite(TABLE, [{ id: "x", v: 2 }], { mode: "replace", scope: "test.write", note: "写" });

    await new Promise((r) => setTimeout(r, 0));
    expect(
      events,
      "修前 delete 自己造一条局部链、与 upsert 的 writeChains 互不相识 ⇒ upsert 会当场越过去",
    ).toEqual(["delete:start"]);

    releaseDelete?.();
    releaseDelete = null;
    await __awaitPendingWrites();
    expect(events, "两条写必须严格按调用顺序抵达引擎").toEqual([
      "delete:start",
      "delete:end",
      "upsert:start",
      "upsert:end",
    ]);
  });
});

describe("③ `updateSession` 白名单不许静默丢弃未列字段", () => {
  it("MF-3: 未在白名单里的字段必须**可见**（点名到字段；且列内字段照常生效）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    port = createFakeStoragePort({ seed: { sessions: [sessionRow] } });
    setStoragePort(port);
    const SessionStorage = await import("../core/storage/session");

    // 列内字段：照常写入（这条可见性机制不许打断正常更新）
    SessionStorage.updateSession(SESSION, { title: "改过的标题" });
    expect(port.__table("sessions").find((r) => r.id === SESSION)?.title).toBe("改过的标题");

    // 列外字段：修前是查无痕迹的 no-op
    SessionStorage.updateSession(SESSION, { parentId: "parent-1" } as never);

    const lines = warn.mock.calls.flat().map(String).join("\n");
    expect(lines, "未列字段必须留下可查的痕迹（否则没人知道那次更新被丢了一半）").toContain("parentId");
    expect(lines, "要说清是「未在字段白名单」这一条，而不是别的告警").toContain("白名单");

    /**
     * ⚠️ 刻意**不进横幅通道**：这是**调用方写错字段名**（开发者问题），
     * 用户没有任何可介入的动作 —— 按第 50 波的规则（「用户没有可介入动作的发现
     * 不许进任何上报通道」）它只该进日志。所以这里反向钉一条：
     */
    expect(
      getPersistFailures().filter((e) => e.area === "session.update"),
      "字段名写错是开发者问题 ⇒ 不许弹用户横幅（只进日志）",
    ).toEqual([]);
  });
});

describe("④ 会话计数对账「没跑」必须看得出", () => {
  it("MF-4: `sessions` 镜像未就绪 ⇒ 汇总行/返回值都要说「本次没对账」，不许与「都对上了」同形", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    port = createFakeStoragePort({ neverReady: ["sessions"], seed: { sessions: [sessionRow] } });
    setStoragePort(port);

    const skipped = await runDatabaseMaintenance();

    expect(skipped.recountCheckedSessions, "镜像未就绪 ⇒ 一个会话都没检查").toBe(0);
    expect(skipped.recountSkippedReason, "原因必须进返回值（汇总行才有东西可打）").toContain("未就绪");
    const warns = warn.mock.calls.flat().map(String).join("\n");
    expect(warns, "日志里也要说清「这不是都对上了」").toContain("本次一个会话都没对账");

    // 对照：镜像是好的 ⇒ 真的对账过，`recountSkippedReason` 必须为空（两态不同形）
    warn.mockClear();
    port = createFakeStoragePort({ seed: { sessions: [sessionRow] } });
    setStoragePort(port);
    const ran = await runDatabaseMaintenance();
    expect(ran.recountCheckedSessions, "镜像正常时真的检查了会话").toBeGreaterThan(0);
    expect(ran.recountSkippedReason, "跑过就是跑过（空串），不许留一个含糊的读数").toBe("");
  });
});

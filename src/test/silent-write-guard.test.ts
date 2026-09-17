/**
 * 静默空写探测器（第 83 波）
 *
 * 为什么需要它：后台执行路径曾经"只换内存 id、不建行"，随后所有
 * `UPDATE messages … WHERE id = ?` **影响 0 行、无报错、无日志** ——
 * 第 2 轮之后的正文/工具调用/工具结果静默丢失，表现为"会话原地打转、父会话干等"。
 * 排查时只能靠一句旁证日志，代价极大。
 *
 * 这份用例守三件事：
 *   ① 探测器本身正确（0 行 = 记账 + 告警；改到行 = 不记账）；
 *   ② 真的接进了写入路径（updateMessage / updateToolCall 打不存在的 id 会被记下来）；
 *   ③ **系统级不变量**：跑一整轮后台执行（含两轮迭代、工具调用、工具结果），
 *      **不允许出现任何静默空写** —— 这条断言与"具体哪个 bug"无关，属于长期护栏。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const files = new Map<string, string>();
function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") { files.set(args.path, args.content); return undefined; }
        if (cmd === "append_file") { files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n"); return undefined; }
        if (cmd === "read_file") { if (!files.has(args.path)) throw new Error("no such file"); return files.get(args.path); }
        if (cmd === "list_directory") return [];
        if (cmd === "delete_file") { files.delete(args.path); return undefined; }
        if (cmd === "rename_file") { const c = files.get(args.oldPath); files.delete(args.oldPath); if (c !== undefined) files.set(args.newPath, c); return undefined; }
        if (cmd === "execute_command") return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd === "exists") return false;
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import {
  noteWriteResult, runGuarded, getSilentWriteReport, resetSilentWriteReport, setSilentWriteDetection,
} from "../core/storage/write-guard";
import { getDatabase, initDatabase, resetDatabaseFatalState, resetSaveFailureState } from "../core/storage/database";
import { setStoragePort, getStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { createMessage, updateMessage, updateToolCall, addToolCall, listMessages, clearSessionLogCache } from "../core/storage/message";
import { flushSessionLogWrites, __resetJsonlCache } from "../core/storage/session-jsonl";
import { createProject } from "../core/storage/project";
import { createSession, updateSession, togglePinned } from "../core/storage/session";
import { executeSessionTurn } from "../core/session/executor";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";

const SESSION = "sess-write-guard";

/** 当前注册的存储端口（`setup.ts` 每个用例前注册一个内存假端口）—— 断言读端口表 / `__writes()` */
function port(): FakeStoragePort {
  return getStoragePort() as unknown as FakeStoragePort;
}

/**
 * 用例内**自己**注册一个内存端口（覆盖 `setup.ts` 那一个），让断言针对端口契约。
 * `CODEM_TEST_PORT=0`（A 态对照）下 `setup.ts` 注册的是 `null`，所以断言端口的用例
 * 必须显式注册，才能在两种档位下验证同一条契约。
 */
function useFreshPort(): FakeStoragePort {
  const p = createFakeStoragePort();
  setStoragePort(p);
  return p;
}

/**
 * 把用例显式切到**回滚 / 旧引擎档（A 态）**：`setStoragePort(null)` 与 `setup.ts` 在
 * `CODEM_TEST_PORT=0` 下注册的完全是同一个形态。
 *
 * 为什么 SWG-2 / SWG-3 / SWG-4 需要它：这三条守的是**旧库 SQL 写入**的静默空写探测器，
 * 而 `runGuarded(db, sql)` 本身就只存在于旧库路径 —— 端口模式下写的是
 * `crud.upsert` / `messages.upsert_index` / `tool_calls.replace` 这类**盲 upsert**，
 * 根本没有"影响 0 行"这个概念，也就没有可探测的空写。切档后旧库里要补齐父行夹具：
 * 本文件 beforeEach 的项目 / 会话是**在端口档下**建的，而旧库同样开着
 * `PRAGMA foreign_keys = ON`，缺父行时消息行会被外键拒绝。
 */
function switchToLegacyEngine(): void {
  setStoragePort(null);
  const db = getDatabase();
  db.run(
    "INSERT OR REPLACE INTO projects (id, name, path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
    ["proj-guard", "空写测试", "D:\\proj", Date.now(), Date.now()],
  );
  db.run(
    "INSERT OR REPLACE INTO sessions (id, project_id, title, created_at, last_message_at, message_count) VALUES (?, ?, ?, ?, ?, ?)",
    [SESSION, "proj-guard", "空写测试会话", Date.now(), Date.now(), 0],
  );
}

beforeEach(async () => {
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSaveFailureState();
  resetDatabaseFatalState();
  resetSessionMessageBus();
  resetDelegationOrchestrator();
  setSilentWriteDetection(true);
  await initDatabase();
  const db = getDatabase();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM tool_calls");
  db.run("DELETE FROM sessions");
  db.run("DELETE FROM projects");
  resetSilentWriteReport();
  createProject({ id: "proj-guard", name: "空写测试", path: "D:\\proj", createdAt: Date.now(), lastAccessedAt: Date.now() } as any);
  createSession({
    id: SESSION, projectId: "proj-guard", title: "空写测试会话",
    createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  } as any);
  resetSilentWriteReport(); // 建表/建会话的过程不计入
});

afterEach(() => {
  delete (window as any).__TAURI__;
  resetSilentWriteReport();
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("静默空写探测器", () => {
  it("SWG-1: runGuarded 把「影响 0 行」记下来并告警一次（重复不再刷屏）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = getDatabase();
    resetSilentWriteReport();

    const r1 = runGuarded(db, "UPDATE messages SET status = ? WHERE id = ?", ["done", "根本不存在"], {
      table: "messages", op: "set-status", id: "根本不存在", from: "SWG-1",
    });
    expect(r1).toBe(0);
    runGuarded(db, "UPDATE messages SET status = ? WHERE id = ?", ["done", "根本不存在"], {
      table: "messages", op: "set-status", id: "根本不存在", from: "SWG-1",
    });

    const report = getSilentWriteReport();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ table: "messages", op: "set-status", count: 2, lastFrom: "SWG-1" });
    expect(warn).toHaveBeenCalledTimes(1); // 只告警一次
    expect(String(warn.mock.calls[0][0])).toContain("空写");
    warn.mockRestore();
  });

  it("SWG-2: 真改到行时不记账（正常路径零噪音）", () => {
    switchToLegacyEngine(); // 探测器只对旧库 SQL 生效（端口侧是盲 upsert，没有空写这个概念）
    const db = getDatabase();
    createMessage({ id: "m-ok", role: "user", content: "x", timestamp: Date.now(), status: "done" } as any, SESSION);
    resetSilentWriteReport();

    const modified = runGuarded(db, "UPDATE messages SET status = ? WHERE id = ?", ["done", "m-ok"], {
      table: "messages", op: "set-status", id: "m-ok", from: "SWG-2",
    });
    expect(modified).toBe(1);
    expect(getSilentWriteReport()).toHaveLength(0);
  });

  it("SWG-3: 接了线的写入路径 —— updateMessage / updateToolCall 打不存在的 id 会被发现", () => {
    switchToLegacyEngine(); // 旧库写入路径才接了探测器（见 switchToLegacyEngine 的说明）
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetSilentWriteReport();

    updateMessage("幽灵消息", { content: "这条写不进去" });
    updateToolCall("幽灵消息", "幽灵工具", { status: "done", result: "结果" });

    const keys = getSilentWriteReport().map((e) => `${e.table}:${e.op}`);
    expect(keys).toContain("messages:update");
    expect(keys).toContain("tool_calls:update");
    warn.mockRestore();
  });

  it("SWG-4: 任务管理侧写入打不到行 —— 不造幽灵行，且对调用方**可见**（第 17 轮 L4 后的新契约）", () => {
    /**
     * 这条用例原来是"旧库 UPDATE 影响 0 行 → 静默空写探测器记账"。
     * A 态（旧库回退）删除后，`sessions` 的写入只走端口，而端口侧不存在
     * "UPDATE 影响 0 行"这件事 —— 判据变成两条更本质的不变量：
     *
     *   1. **不许造幽灵行**：端口是 `crud.upsert`（会 insert），所以"会话不存在"时
     *      必须在写入前就返回，而不是 upsert 出一行不存在的会话；
     *   2. **不许静默假成功**：`togglePinned` 必须把"没切成"通过返回值告诉调用方。
     *
     * 这正是原用例想守的东西（"写没落地必须可见"），只是换到了端口这半边。
     */
    const p = useFreshPort();
    resetSilentWriteReport();

    const pinned = togglePinned("不存在的会话");
    expect(pinned, "切换不存在的会话必须返回 false（可见的如实回绝，不是静默成功）").toBe(false);

    updateSession("不存在的会话", { title: "新标题" } as any);

    const ghost = p
      .__writes()
      .filter(
        (w) =>
          w.command === "crud.upsert" &&
          (w.params as { table?: string } | undefined)?.table === "sessions",
      );
    expect(ghost, "会话不存在时不许 upsert 出幽灵行（旧实现是 UPDATE 影响 0 行）").toHaveLength(0);
  });

  it("SWG-5（系统级不变量）: 跑完一整轮后台执行，不允许出现任何静默空写", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = {
      process: async function* () {
        yield { type: "start", iteration: 1 };
        yield { type: "text_delta", text: "先跑脚本。" };
        yield { type: "tool_start", toolCall: { id: "tc1", name: "bash", input: { command: "python x.py" }, status: "running" } };
        yield { type: "tool_complete", toolCall: { id: "tc1", name: "bash", input: { command: "python x.py" }, status: "completed" }, result: "输出" };
        yield { type: "start", iteration: 2 };
        yield { type: "tool_start", toolCall: { id: "tc2", name: "bash", input: { command: "python y.py" }, status: "running" } };
        yield { type: "tool_complete", toolCall: { id: "tc2", name: "bash", input: { command: "python y.py" }, status: "completed" }, result: "输出2" };
        yield { type: "text_delta", text: "两轮都跑完了。" };
        yield { type: "end", result: { reason: "done" } };
      },
    } as any;

    resetSilentWriteReport();
    await executeSessionTurn({ sessionId: SESSION, message: "跑两轮", cwd: "D:\\proj", engine });
    await flushSessionLogWrites();

    const report = getSilentWriteReport();
    expect(
      report,
      `后台执行期间出现了静默空写（说明有写入打不到行）：${JSON.stringify(report)}`,
    ).toEqual([]);
    expect(listMessages(SESSION).filter((m) => m.role === "assistant")).toHaveLength(2);
    warn.mockRestore();
  });

  it("SWG-6: addToolCall 落在真实消息上（幽灵 tool_calls 会污染历史）", () => {
    useFreshPort();
    createProject({ id: "proj-guard", name: "空写测试", path: "D:\\proj", createdAt: Date.now(), lastAccessedAt: Date.now() } as any);
    createSession({
      id: SESSION, projectId: "proj-guard", title: "空写测试会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    } as any);
    createMessage({ id: "m-parent", role: "assistant", content: "", timestamp: Date.now(), status: "streaming" } as any, SESSION);
    addToolCall("m-parent", { id: "tc-x", tool: "bash", args: {}, status: "running" } as any);
    /**
     * B 态：工具调用写穿到端口（`tool_calls.replace`，Rust 侧单事务、按 message_id 整批替换）。
     *
     * 假端口刻意没有为这条命令实现内存落表（基座缺口），所以"确实写穿了"用 `__writes()` 断言：
     * 命令在、参数里的 `message_id` 是**真实存在的那条消息**（幽灵 id 才是这条用例要防的）。
     */
    const replace = port().__writes().filter((w) => w.command === "tool_calls.replace").at(-1);
    expect(replace, "工具调用必须写穿到端口（否则重启后历史里是幽灵 tool_calls）").toBeTruthy();
    const params = (replace?.params ?? {}) as { message_id?: string; tool_calls?: Array<{ id?: string }> };
    expect(params.message_id).toBe("m-parent");
    expect((params.tool_calls ?? []).map((c) => c.id)).toContain("tc-x");
    expect(listMessages(SESSION).find((m) => m.id === "m-parent")?.toolCalls?.length).toBe(1);
  });
});

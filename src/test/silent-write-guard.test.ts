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
import { createMessage, updateMessage, updateToolCall, addToolCall, listMessages, clearSessionLogCache } from "../core/storage/message";
import { flushSessionLogWrites, __resetJsonlCache } from "../core/storage/session-jsonl";
import { createProject } from "../core/storage/project";
import { createSession, updateSession, togglePinned } from "../core/storage/session";
import { executeSessionTurn } from "../core/session/executor";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";

const SESSION = "sess-write-guard";

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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetSilentWriteReport();

    updateMessage("幽灵消息", { content: "这条写不进去" });
    updateToolCall("幽灵消息", "幽灵工具", { status: "done", result: "结果" });

    const keys = getSilentWriteReport().map((e) => `${e.table}:${e.op}`);
    expect(keys).toContain("messages:update");
    expect(keys).toContain("tool_calls:update");
    warn.mockRestore();
  });

  it("SWG-4: 接了线的任务管理侧写入（sessions）同样会被发现", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetSilentWriteReport();
    updateSession("不存在的会话", { title: "新标题" } as any);
    togglePinned("不存在的会话");
    const keys = getSilentWriteReport().map((e) => `${e.table}:${e.op}`);
    expect(keys).toContain("sessions:update");
    expect(keys).toContain("sessions:pin");
    warn.mockRestore();
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
    createMessage({ id: "m-parent", role: "assistant", content: "", timestamp: Date.now(), status: "streaming" } as any, SESSION);
    addToolCall("m-parent", { id: "tc-x", tool: "bash", args: {}, status: "running" } as any);
    const rows = getDatabase().exec("SELECT message_id FROM tool_calls WHERE id = 'tc-x'");
    expect(String(rows?.[0]?.values?.[0]?.[0])).toBe("m-parent");
    expect(listMessages(SESSION).find((m) => m.id === "m-parent")?.toolCalls?.length).toBe(1);
  });
});

/**
 * 静默空写探测器（第 83 波）
 *
 * 为什么需要它：后台执行路径曾经"只换内存 id、不建行"，随后所有
 * `UPDATE messages … WHERE id = ?` **影响 0 行、无报错、无日志** ——
 * 第 2 轮之后的正文/工具调用/工具结果静默丢失，表现为"会话原地打转、父会话干等"。
 * 排查时只能靠一句旁证日志，代价极大。
 *
 * ## 第 18 轮（L1）：探测器本身随旧引擎退役，**它守的不变量换了实现**
 *
 * | 原用例 | 处置 |
 * | --- | --- |
 * | SWG-1（`runGuarded` 把"影响 0 行"记账 + 告警一次）、SWG-2（真改到行时不记账） | **删除**：这两个是 `write-guard.ts` 的**单元测试**，而 `runGuarded` 只在旧库路径上有意义（它包的是 sql.js 的 `run`），A 态删完后**全仓已无生产调用点** |
 * | SWG-3（打不存在的 id 会被发现）、SWG-4（任务管理侧写入） | **保留并已改成端口语义**：判据是"不造幽灵行 + 对调用方可见（返回值 / 上报）" |
 * | SWG-5（跑一整轮后台执行不许有静默空写）、SWG-6（tool_calls 不挂孤儿） | **保留**：与引擎无关的系统级不变量 |
 *
 * **覆盖移交**：`runGuarded` 想守的"写没落地必须可见"，在端口世界里由
 * ①写路径的 `reportPersistFailure` / `reportWriteNotAccepted`（见 `persist-failure-reporting.test.ts`、
 * 各域契约用例）与 ②SWG-4 的"返回值可见 + 不造幽灵行"共同承担。
 * 留在这里的 SWG-3/4/5/6 就是那条不变量的新载体。
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
 * ⚠️ 第 18 轮：原来的 `switchToLegacyEngine()`（把用例切到 A 态并在旧库里补父行夹具）已删除 ——
 * A 态与旧引擎一起退役，需要它的 SWG-1 / SWG-2 也随之退休（覆盖移交见文件头）。
 */

beforeEach(async () => {
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSessionMessageBus();
  resetDelegationOrchestrator();
  // 干净端口 = 干净数据面（第 18 轮：原来的旧库清表与 initDatabase 已删）
  setStoragePort(createFakeStoragePort());
  createProject({ id: "proj-guard", name: "空写测试", path: "D:\\proj", createdAt: Date.now(), lastAccessedAt: Date.now() } as any);
  createSession({
    id: SESSION, projectId: "proj-guard", title: "空写测试会话",
    createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  } as any);
});

afterEach(() => {
  delete (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("静默空写探测器", () => {
  it("SWG-3: 打不存在的 id —— 不造幽灵行，且不抛（第 17 轮 L4 后的新契约）", () => {
    /**
     * 这条用例原来断言"旧库 UPDATE 影响 0 行 → 探测器记账"（`messages:update` / `tool_calls:update`）。
     * A 态删除后，`updateMessage` / `updateToolCall` 的索引写只走端口 —— 端口侧不存在
     * "UPDATE 影响 0 行"这件事，判据因此换成更本质的两条：
     *
     *   1. **不许造幽灵行**：端口写是 `crud.upsert` / `tool_calls.replace`（会 insert），
     *      所以"消息不存在"时不得凭空造出一条消息或一批工具调用；
     *   2. **不许抛**：更新一个不存在的 id 必须静默成为一次"没落地"（并且由索引层的
     *      `reportWriteNotAccepted` 如实上报），而不是把渲染路径打崩。
     *
     * 覆盖去哪了：原探测器守的"写没落地必须可见"，现在由端口写路径的
     * `reportPersistFailure` / `reportWriteNotAccepted`（见 `persist-failure-reporting.test.ts`）
     * 与 SWG-4 的"返回值可见 + 不造幽灵行"共同承担。
     */
    const p = useFreshPort();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => {
      updateMessage("幽灵消息", { content: "这条写不进去" });
      updateToolCall("幽灵消息", "幽灵工具", { status: "done", result: "结果" });
    }, "更新不存在的 id 不得抛（渲染路径不能因为一次空写而崩）").not.toThrow();

    const ghostMessages = p
      .__writes()
      .filter((w) => w.command === "messages.upsert_index" && (w.params as { id?: string })?.id === "幽灵消息");
    expect(ghostMessages, "不得为不存在的消息 upsert 出幽灵行").toHaveLength(0);
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

  it("SWG-5（系统级不变量）: 跑完一整轮后台执行，不许有「没落地却被当成成功」的写入", async () => {
    /**
     * 第 18 轮改判据：原来这里断言"静默空写探测器没记账"，而那个探测器（`runGuarded`）
     * 已随旧引擎退役 —— 留着它这条用例会变成**恒真**（报告永远为空）。
     *
     * 现在用端口世界真正能证伪的两条判据：
     *   ① 落库事件必须**真的发生**（消息 2 条、工具调用 2 个都写穿到端口）—— 不是"没报错就算过"；
     *   ② 期间**不许有持久化失败上报**（`reportPersistFailure` 是端口世界唯一的可见失败通道，
     *      "写没落地必须可见"这条不变量的新落点）。
     */
    const persist = await import("../core/storage/persist-failure");
    persist.resetPersistFailures();
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

    await executeSessionTurn({ sessionId: SESSION, message: "跑两轮", cwd: "D:\\proj", engine });
    await flushSessionLogWrites();

    // ① 落库确实发生（证伪"空写"这件事本身）
    expect(listMessages(SESSION).filter((m) => m.role === "assistant"), "两条助手消息都要落地").toHaveLength(2);
    const toolRows = port().__table("tool_calls");
    expect(toolRows.length, "工具调用必须写穿到端口（否则就是静默丢写）").toBeGreaterThanOrEqual(2);

    // ② 期间不许有持久化失败上报（唯一可见的失败通道必须干净）
    const failures = persist.getPersistFailures();
    expect(
      failures,
      `后台执行期间出现了持久化失败上报（说明有写入没落地）：${JSON.stringify(failures)}`,
    ).toEqual([]);
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

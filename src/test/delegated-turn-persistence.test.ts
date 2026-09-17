/**
 * 后台会话（跨会话委派的目标会话）**每轮的助手消息必须落库**（第 83 波）
 *
 * ## 用户现场
 *
 * 「a 对话把情况交给 b 对话 → b 开始读材料 → 然后卡住不再反馈，a 一直等」
 * 控制台里 b 反复执行同一个 `python _tmp_extract.py`（输出长度恒为 358），
 * 每次更新消息都打：
 *
 *   [SessionJSONL] 更新消息 assistant-1789451758233-2 时找不到所属会话，日志未更新（索引仍是最新）
 *
 * ## 根因
 *
 * `executeSessionTurn` 在 `start`（iteration > 1）里只**换了 currentAssistantMsgId**、没有建行，
 * 而之后所有 `text_delta` / `tool_start` / `tool_complete` 走的都是
 * `updateMessage(currentAssistantMsgId, …)` / `addToolCall(currentAssistantMsgId, …)` ——
 * 于是**第 2 轮之后的正文、工具调用、工具结果全部写不进库**（UPDATE 影响 0 行，静默）。
 *
 * 而 `AgenticLoop` 每轮都从库里重建上下文（`buildMessages` → `listMessages`）：
 * 模型看不到自己上一轮发出的调用和拿到的结果 → **一遍遍重发同一个工具调用**，
 * 直到父会话等到超时。用户交互路径（App.tsx）每轮 `saveMessages` 会 upsert，所以只有
 * "后台执行"这条路径会踩。
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

import { listMessages, clearSessionLogCache } from "../core/storage/message";
import { flushSessionLogWrites, __resetJsonlCache } from "../core/storage/session-jsonl";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import { getStoragePort } from "../core/storage/port";
import type { FakeStoragePort } from "./fake-storage-port";
import { executeSessionTurn } from "../core/session/executor";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";

const PROJECT_ID = "proj-exec-test";
const SESSION_ID = "sess-delegated-target";

/** 一个"两轮、每轮都调工具"的脚本化引擎：第 2 轮正是用户现场出事的地方 */
function makeFakeEngine(events: any[]) {
  return {
    process: async function* () {
      for (const e of events) yield e;
    },
  } as any;
}

const SCRIPT: any[] = [
  { type: "start", iteration: 1 },
  { type: "reasoning_delta", text: "先看看文件在不在" },
  { type: "text_delta", text: "我先跑提取脚本。" },
  {
    type: "tool_start",
    toolCall: { id: "tc1", name: "bash", input: { command: 'python "D:\\proj\\_tmp_extract.py"' }, status: "running" },
  },
  {
    type: "tool_complete",
    toolCall: { id: "tc1", name: "bash", input: { command: 'python "D:\\proj\\_tmp_extract.py"' }, status: "completed" },
    result: "提取完成：三个 docx 已转成 txt（358）",
  },
  { type: "start", iteration: 2 },
  { type: "reasoning_delta", text: "读一下提取结果" },
  { type: "text_delta", text: "已经拿到三个文件的内容，我写确认文件。" },
  {
    type: "tool_start",
    toolCall: { id: "tc2", name: "write", input: { path: "D:\\proj\\确认.md" }, status: "running" },
  },
  {
    type: "tool_complete",
    toolCall: { id: "tc2", name: "write", input: { path: "D:\\proj\\确认.md" }, status: "completed" },
    result: "Successfully wrote 确认.md",
  },
  { type: "end", result: { reason: "done" } },
];

/**
 * 夹具（第 18 轮，L1）：**端口基座**，不再初始化旧库。
 *
 * 原来这里 `await initDatabase()` + 四条裸 `DELETE FROM messages/tool_calls/sessions/projects`：
 * 那是"旧库是唯一数据源"（A 态）时代的清表夹具。A 态已删 —— `setup.ts` 每个用例前
 * 注册一个**全新**的内存假端口，端口即唯一数据源，所以"清表"这一步不再存在。
 *
 * `createProject` / `createSession` 这两个**产品 API**保留：它们现在走 `domainWrite`，
 * 把父行播种到端口上（与真机同一条路），后台轮次落库正是落在同一份端口里。
 */
beforeEach(() => {
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSessionMessageBus();
  resetDelegationOrchestrator();
  createProject({
    id: PROJECT_ID, name: "后台执行测试", path: "D:\\proj",
    createdAt: Date.now(), lastAccessedAt: Date.now(),
  } as any);
  createSession({
    id: SESSION_ID, projectId: PROJECT_ID, title: "b 对话",
    createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  } as any);
});

afterEach(() => {
  delete (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("后台会话每轮消息的持久化", () => {
  it("EXEC-1: 第 2 轮的助手消息、工具调用、工具结果**必须都在库里**（否则模型下一轮看不见自己干过什么）", async () => {
    const engine = makeFakeEngine(SCRIPT);
    const result = await executeSessionTurn({
      sessionId: SESSION_ID,
      message: "把课题3 的材料读完并写确认文件",
      cwd: "D:\\proj",
      engine,
    });
    await flushSessionLogWrites();

    const messages = listMessages(SESSION_ID);
    const assistants = messages.filter((m) => m.role === "assistant");
    const ids = messages.map((m) => m.id);

    // 1) 用户消息在
    expect(messages.some((m) => m.role === "user")).toBe(true);
    // 2) **两轮各有自己的助手消息** —— 修复前第 2 轮那条只存在于内存命名里，库里没有
    expect(assistants.length, `助手消息应当有 2 条（第 1 轮 + 第 2 轮），实际 id: ${ids.join(", ")}`).toBe(2);

    // 3) 第 2 轮的正文真的落库了
    expect(assistants.some((m) => (m.content || "").includes("已经拿到三个文件的内容"))).toBe(true);

    // 4) 第 2 轮的工具调用也挂在那条消息上（修复前 tool_calls 挂在一条不存在的消息上 → 历史里查无此调用）
    const second = assistants.find((m) => (m.content || "").includes("已经拿到三个文件的内容"));
    expect(second?.toolCalls?.map((tc) => tc.tool)).toContain("write");

    // 5) 第 1 轮的工具结果同样在（模型据此知道脚本已经跑过）
    const first = assistants.find((m) => (m.content || "").includes("我先跑提取脚本"));
    expect(first?.toolCalls?.[0]?.result ?? "").toContain("提取完成");

    expect(result.success).toBe(true);
  });

  it("EXEC-2: 每一轮都不能出现「更新了不存在的消息」—— 消息 id 必须都在库里", async () => {
    const engine = makeFakeEngine(SCRIPT);
    await executeSessionTurn({
      sessionId: SESSION_ID,
      message: "再来一次",
      cwd: "D:\\proj",
      engine,
    });
    await flushSessionLogWrites();

    const ids = new Set(listMessages(SESSION_ID).map((m) => m.id));
    /**
     * 工具调用引用的消息必须存在（tool_calls.message_id 是外键语义）。
     *
     * 第 18 轮：判据从"旧库 `SELECT DISTINCT message_id FROM tool_calls`"换成
     * **端口的 tool_calls 表**（`messages.upsert_index` 的 `tool_calls` 整批替换落的那张表）。
     * A 态（旧库是唯一数据源）已删，索引在 B 态就是端口 —— 读旧库只会读到空集，
     * 断言会**静默变成永真**（假绿），这正是必须换判据的原因。强度不变：
     * 仍是"每一条落库的 tool_call 都必须挂在一个能读回来的消息上"。
     */
    const toolCallRows = (getStoragePort() as unknown as FakeStoragePort).__table("tool_calls");
    expect(toolCallRows.length, "端口上必须有工具调用行（否则这条断言是空洞的）").toBeGreaterThan(0);
    for (const row of toolCallRows) {
      expect(ids.has(String(row.message_id)), `tool_calls 挂在不存在/不可读的消息上: ${row.message_id}`).toBe(true);
    }
  });

  it("EXEC-3: 模型「一句话不说直接调工具」时，这次调用与结果也必须落库", async () => {
    // 带思考的模型常把输出预算全花在 reasoning 上，正文一个字都没有就直接调工具
    const engine = makeFakeEngine([
      { type: "start", iteration: 1 },
      {
        type: "tool_start",
        toolCall: { id: "tc9", name: "bash", input: { command: "python _tmp_extract.py" }, status: "running" },
      },
      {
        type: "tool_complete",
        toolCall: { id: "tc9", name: "bash", input: { command: "python _tmp_extract.py" }, status: "completed" },
        result: "提取完成（358）",
      },
      { type: "end", result: { reason: "done" } },
    ]);
    await executeSessionTurn({ sessionId: SESSION_ID, message: "先跑脚本", cwd: "D:\\proj", engine });
    await flushSessionLogWrites();

    const assistants = listMessages(SESSION_ID).filter((m) => m.role === "assistant");
    expect(assistants.length, "至少要有一条助手消息承载这次工具调用").toBeGreaterThan(0);
    const withCall = assistants.find((m) => (m.toolCalls?.length ?? 0) > 0);
    expect(withCall, "工具调用凭空消失了（下一轮模型会看不到自己调过工具 → 重发）").toBeDefined();
    expect(withCall?.toolCalls?.[0]?.tool).toBe("bash");
    expect(withCall?.toolCalls?.[0]?.result ?? "").toContain("提取完成");
  });
});

describe("委派不许「假成功」", () => {
  it("DELE-X1: 目标会话不存在 → 工具直接报错，且**不创建任务**（真机验证时发现的假成功）", async () => {
    const { createDelegateToSessionTool } = await import("../core/session/tools");
    const { getDelegationOrchestrator } = await import("../core/session/orchestrator");
    const tool = createDelegateToSessionTool();
    const before = getDelegationOrchestrator().getAll?.().length ?? 0;

    const res = await tool.execute(
      {
        target_session_id: "根本不存在的会话",
        task: "工作目录：D:\\proj（绝对路径）。完成判据：输出 done。读 D:\\proj\\a.md 后回复 done。",
      } as any,
      { sessionId: SESSION_ID, cwd: "D:\\proj" } as any,
    );
    expect(String(res.output)).toMatch(/不存在|not found/);
    const after = getDelegationOrchestrator().getAll?.().length ?? 0;
    expect(after, "目标不存在时不该留下一个会立刻失败的任务").toBe(before);
  });

  it("DELE-X2: 目标只在持久层（不在当前项目的 UI 列表）→ 允许委派（跨作用域不该被判死）", async () => {
    const { createDelegateToSessionTool } = await import("../core/session/tools");
    // 造一个"当前项目列表里没有"的会话：直接写库，不经过 store
    createProject({
      id: "proj-other", name: "别的项目", path: "D:\\other",
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    } as any);
    createSession({
      id: "sess-other-scope", projectId: "proj-other", title: "另一个项目的会话",
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    } as any);

    const tool = createDelegateToSessionTool();
    const res = await tool.execute(
      {
        target_session_id: "sess-other-scope",
        task: "工作目录：D:\\proj（绝对路径）。完成判据：输出 done。请读 D:\\proj\\a.md 后回复 done。",
      } as any,
      { sessionId: SESSION_ID, cwd: "D:\\proj" } as any,
    );
    expect(String(res.output), "存在就该放行").not.toMatch(/不存在|not found/);
  });
});

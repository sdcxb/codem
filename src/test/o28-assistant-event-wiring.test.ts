/**
 * O-28：后台/微信回合的助手消息必须「看得见**也**有记录」。
 *
 * ## 真机现场（1.16.152，装机版，2026-09-25）
 *
 * 微信桥驱动的那个回合跑完之后，维护的不变量审计当场报「本次新产生 3 条缺口」，
 * 样例三条全部落在微信会话上：
 *
 * ```text
 * wx-demo-peer-im-wechat|VISIBLE_BUT_NOT_RECORDED|assistant-1790319154162
 * …|-2   …|-3
 * ```
 *
 * 用副本库（主库+WAL+SHM 复制后只读打开）把两侧事实摆出来，真因一目了然：
 *
 * | 轮 | messages 表的行 | tool_calls.message_id | 事件里 tool_call.messageId |
 * | --- | --- | --- | --- |
 * | 1 | `assistant-1790319154162`（空正文） | `assistant-1790319154162` | `msg-1790319153390` ❌ |
 * | 2 | `assistant-1790319155690-2`（空正文） | `assistant-1790319155690-2` | `msg-1790319155791` ❌ |
 * | 3 | `assistant-1790319157180-3`（空正文） | `assistant-1790319157180-3` | `msg-1790319157282` ❌ |
 * | 4 | `assistant-1790319158892-4`（312 字） | — | — （它有一条 `assistant_text` ✅） |
 *
 * 也就是说：**这三条缺口和 `assistant_text` 无关** —— 那三行是纯工具轮的助手行
 * （正文为空，`appendMessageTextEvent` **刻意**不写 `assistant_text`，它的事实记在
 * 工具事件里，口径见 FWT-C1a）。它们被判缺口，是因为工具事件里的 `messageId`
 * 是**引擎自造的 `msg-…`**，而 `messages` 表里根本没有这一行
 * （`ctx.messageId` ← `AgenticLoop` 的局部 id；行 id 由落库方
 * `executor.ts` / `App.tsx` 生成 —— 两套 id 从来没对上过）。
 *
 * 后果不止"自检报数"：`event-projection.applyToolCall` 找不到那个 id 就**凭空建一条
 * `msg-…` 的助手行**，真实行在投影里反而消失 —— 事件日志与消息存储从此对不上。
 *
 * ## 这一组用例守什么
 *
 * | # | 判据 |
 * | --- | --- |
 * | O28-1 | 后台回合写下的每条 `tool_call`/`tool_result`，其 `messageId` 必须**能在 `messages` 表里查到** |
 * | O28-2 | 纯工具轮（空正文 + 有工具调用）**不再**被判 `VISIBLE_BUT_NOT_RECORDED`（维护自检那三条的形态） |
 * | O28-3 | 一个事实一条事件：不许再出现重复的 `user_message` / `assistant_text` |
 * | O28-4 | 落库方回调**不许被上一轮继承**（loop 是池化复用的：没接线的回合必须退回引擎自造 id，而不是挂到上一轮的行上） |
 * | O28-5 | 空正文**且无工具调用**的收尾行仍要被事件钉住（否则投影重建时它会消失，FWT-C1c 的形态） |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockExecuteCommand, memFs } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  /** 内存文件系统：权威日志（追加式 JSONL）走的就是 `file-api` 这条通道，别让它报错刷屏 */
  memFs: new Map<string, string>(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  /** 数据根：权威日志（`sessions/*.jsonl`）靠它定位；少了它会走"拒绝退回相对路径"并刷屏 */
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\o28",
  exists: async (p: string) => memFs.has(p),
  readFile: async (p: string) => {
    if (!memFs.has(p)) throw new Error("ENOENT: " + p);
    return memFs.get(p)!;
  },
  readTextWindow: async (p: string, offset = 0, maxBytes?: number) => {
    const c = memFs.get(p) ?? "";
    const end = maxBytes ? Math.min(c.length, offset + maxBytes) : c.length;
    let text = c.slice(offset, end);
    const eof = end >= c.length;
    if (!eof) {
      // 与 Rust 侧一致：窗口只含**完整行**
      const cut = text.lastIndexOf("\n");
      if (cut >= 0) text = text.slice(0, cut + 1);
    }
    return { text, nextOffset: offset + text.length, eof: end >= c.length, size: c.length };
  },
  appendFile: async (p: string, c: string) => {
    memFs.set(p, (memFs.get(p) ?? "") + c);
  },
  writeFile: async (p: string, c: string) => {
    memFs.set(p, c);
  },
  deleteFile: async (p: string) => {
    memFs.delete(p);
  },
  deletePath: async (p: string) => {
    memFs.delete(p);
  },
  renameFile: async (a: string, b: string) => {
    const c = memFs.get(a);
    memFs.delete(a);
    if (c !== undefined) memFs.set(b, c);
  },
  listDirectory: async () => [],
  globSearch: async () => [],
  grepSearch: async () => [],
  readFileLines: async (p: string) => ({ text: memFs.get(p) ?? "", hasMore: false, totalLines: 1 }),
  isPathWithinWorkspace: () => true,
}));

/** 会话 JSONL 层要的 fs 通道（权威日志是追加式 JSONL，见 session-jsonl.ts） */
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

import { LLMEngine } from "../core/llm";
import { listMessages, clearSessionLogCache } from "../core/storage/message";
import { getEventLog } from "../core/storage/event-log";
import { flushSessionLogWrites, __resetJsonlCache } from "../core/storage/session-jsonl";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import { setSetting } from "../core/storage/settings";
import { getStoragePort } from "../core/storage/port";
import type { FakeStoragePort } from "./fake-storage-port";
import { executeSessionTurn } from "../core/session/executor";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";
import { checkVisibleRecordedInvariant } from "../core/llm/runtime-invariants";

/**
 * 直接往端口里落一行（**绕过** `MessageStorage.createMessage`，因此不会顺带写事件）——
 * O28-6 要造的正是"库里有一行、事件侧什么都没有"这种形态。
 * 与 `feature-wire-tail-fixes.test.ts` 的 seed 手法一致。
 */
let seedSeq = 0;
function seedRow(table: string, row: Record<string, unknown>) {
  void (getStoragePort() as unknown as FakeStoragePort).data.execute("crud.upsert", {
    table,
    rows: [row],
    mode: "replace",
  });
}
function seedSession(id: string) {
  seedRow("sessions", {
    id, project_id: "p-o28", title: id, model: null,
    created_at: 1, last_message_at: 2, message_count: 0, pinned: 0,
  });
}
function seedRawMessage(sessionId: string, id: string, role: string, content: string, status: string) {
  seedRow("messages", {
    id, session_id: sessionId, role, content, reasoning: null,
    timestamp: ++seedSeq, model: null, status, hidden: 0, trimmed: 0,
  });
}

const PROJECT_ID = "proj-o28";
/** 与真机上出事的那个会话同名 —— 缺口样例里的会话 id 就是它 */
const SESSION_ID = "wx-demo-peer-im-wechat";
const CWD = "C:\\o28";

/** 事件脚本驱动的 mock provider（每次 stream() 消费一个脚本） */
class ScriptedProvider {
  id = "o28-provider";
  name = "O28 Mock";
  config: any = { apiKey: "sk-test", models: [{ id: "o28-model", contextWindow: 128000 }] };
  dynamicModels: any[] | null = null;
  private queue: any[][] = [];

  setScript(scripts: any[][]) {
    this.queue = scripts;
  }
  isConfigured() {
    return true;
  }
  async *stream(_request: any): AsyncGenerator<any> {
    const script = this.queue.length > 0
      ? this.queue.shift()!
      : [{ type: "text_delta", text: "（脚本耗尽）" }, { type: "end", finishReason: "stop" }];
    for (const event of script) yield event;
  }
  async complete(_request: any) {
    return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [{ id: "o28-model", name: "O28", contextWindow: 128000, maxOutputTokens: 4096, supportsTools: true, supportsStreaming: true }];
  }
  async fetchModelsFromServer() {
    return this.listModels();
  }
}

/** 一次「模型直接调 bash」的迭代脚本（与真机那三轮同形：只调工具、一句话不说） */
function bashToolCallEvents(callId: string, command = "dir"): any[] {
  return [
    { type: "tool_use_start", id: callId, name: "bash" },
    { type: "tool_use_delta", id: callId, input: JSON.stringify({ command }) },
    { type: "tool_use_end", id: callId, input: { command } },
    { type: "end", finishReason: "tool_use" },
  ];
}

/** 一次「只吐 reasoning、既不说正文也不调工具」的迭代脚本 */
function reasoningOnlyEvents(text: string): any[] {
  return [
    { type: "reasoning_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

function textResponseEvents(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

let engine: LLMEngine;
let provider: ScriptedProvider;

/** 事件侧读回来的 tool_call / tool_result（带 messageId） */
function toolEventsOf(sessionId: string) {
  return getEventLog()
    .readAll(sessionId)
    .filter((e) => e.type === "tool_call" || e.type === "tool_result")
    .map((e) => ({
      seq: e.seq,
      type: e.type as string,
      messageId: String((e.payload as any)?.messageId ?? ""),
      toolCallId: String((e.payload as any)?.toolCallId ?? ""),
    }));
}

beforeEach(() => {
  vi.clearAllMocks();
  memFs.clear();
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSessionMessageBus();
  resetDelegationOrchestrator();
  mockExecuteCommand.mockResolvedValue({ stdout: "命令输出", stderr: "", exitCode: 0 });

  createProject({
    id: PROJECT_ID, name: "O-28", path: CWD,
    createdAt: Date.now(), lastAccessedAt: Date.now(),
  } as any);
  createSession({
    id: SESSION_ID, projectId: PROJECT_ID, title: "微信",
    createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
  } as any);

  /**
   * 后台执行的安全模式取自设置（`getEffectiveSecurityMode(cwd)`）；
   * 这里设成 full，让工具真的跑起来（`ask` 下后台策略是"自动拒绝需要权限的操作"）。
   */
  setSetting("codem-security-mode", "full");

  provider = new ScriptedProvider();
  engine = new LLMEngine();
  engine.providers.register(provider as any);
  (engine as any).config.defaultProvider = "o28-provider";
  (engine as any).config.defaultModel = "o28-model";
});

afterEach(() => {
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("O-28：后台/微信回合的助手消息「看得见也有记录」", () => {
  it("O28-1: 工具事件的 messageId 必须挂在**消息存储里真实存在的那一行**上", async () => {
    provider.setScript([bashToolCallEvents("call-o28-1"), textResponseEvents("清单出来了。")]);
    await executeSessionTurn({ sessionId: SESSION_ID, message: "你好", cwd: CWD, engine });
    await flushSessionLogWrites();

    const storedIds = new Set(listMessages(SESSION_ID).map((m) => m.id));
    const toolEvents = toolEventsOf(SESSION_ID);

    // 先证明这条断言不是空洞的：真机那三轮就是"有工具调用、也有事件"
    expect(toolEvents.length, "没跑到工具事件 ⇒ 这条用例什么都没验证").toBeGreaterThanOrEqual(2);
    expect(toolEvents.some((e) => e.type === "tool_call")).toBe(true);
    expect(toolEvents.some((e) => e.type === "tool_result")).toBe(true);

    for (const e of toolEvents) {
      expect(
        storedIds.has(e.messageId),
        `tool 事件的 messageId=${e.messageId} 在 messages 表里查不到（真机形态：引擎自造的 msg-…）` +
          `——现存行：${[...storedIds].join(", ")}`,
      ).toBe(true);
    }
  });

  it("O28-2: 纯工具轮（空正文 + 有工具调用）不再被判 VISIBLE_BUT_NOT_RECORDED（真机那 3 条的形态）", async () => {
    // 三轮"只调工具不说话"，最后才给正文 —— 与真机 wx 回合的 4 轮形态一致
    provider.setScript([
      bashToolCallEvents("call-o28-2a"),
      bashToolCallEvents("call-o28-2b"),
      bashToolCallEvents("call-o28-2c"),
      textResponseEvents("环境正常，工作目录只有两个文件。"),
    ]);
    await executeSessionTurn({ sessionId: SESSION_ID, message: "你好", cwd: CWD, engine });
    await flushSessionLogWrites();

    const assistants = listMessages(SESSION_ID).filter((m) => m.role === "assistant");
    const pureToolTurns = assistants.filter((m) => (m.content ?? "") === "" && (m.toolCalls?.length ?? 0) > 0);
    expect(
      pureToolTurns.length,
      `没有造出"空正文 + 有工具调用"的助手行 ⇒ 这条用例什么都没验证（现存：${assistants
        .map((m) => `${m.id}:${(m.content ?? "").length}字/${m.toolCalls?.length ?? 0}工具`)
        .join(", ")}）`,
    ).toBeGreaterThan(0);

    const inv = checkVisibleRecordedInvariant(SESSION_ID);
    expect(
      inv.violations.map((v) => `${v.type}:${v.messageId}`),
      "维护自检报的就是这一项（真机：本次新产生 3 条）",
    ).toEqual([]);
  });

  it("O28-3: 一个事实一条事件 —— user_message / assistant_text 都不许重复", async () => {
    provider.setScript([bashToolCallEvents("call-o28-3"), textResponseEvents("办完了。")]);
    await executeSessionTurn({ sessionId: SESSION_ID, message: "你好", cwd: CWD, engine });
    await flushSessionLogWrites();

    const events = getEventLog().readAll(SESSION_ID);
    const users = events.filter((e) => e.type === "user_message").map((e) => String((e.payload as any)?.messageId ?? ""));
    const texts = events
      .filter((e) => e.type === "assistant_text" && String((e.payload as any)?.content ?? "") !== "")
      .map((e) => String((e.payload as any)?.messageId ?? ""));

    expect(users.length, `用户消息事件条数=${users.length}（改前是"落库一次 + 显式再写一次"= 2）`).toBe(1);
    expect(new Set(texts).size, `有正文的助手事件必须一条一份，实际：${texts.join(", ")}`).toBe(texts.length);
    expect(texts.length).toBeGreaterThan(0);
  });

  it("O28-4: 落库方回调不许被上一轮继承（loop 池化复用：没接线的回合退回引擎自造 id）", async () => {
    const runOnce = async (options: any) => {
      provider.setScript([bashToolCallEvents(`call-${Math.random().toString(36).slice(2, 8)}`), textResponseEvents("好")]);
      for await (const _e of engine.process(SESSION_ID, "跑一下", CWD, undefined, options)) {
        /* 只要事件流跑完 */
      }
      await flushSessionLogWrites();
    };

    await runOnce({ resolveAssistantMessageId: () => "assistant-run1" });
    const afterRun1 = toolEventsOf(SESSION_ID);
    expect(afterRun1.length).toBeGreaterThan(0);
    expect(afterRun1.every((e) => e.messageId === "assistant-run1")).toBe(true);

    // 第二条：**不传**这个回调（子智能体 / 未接线路径）
    await runOnce(undefined);
    const afterRun2 = toolEventsOf(SESSION_ID).slice(afterRun1.length);
    expect(afterRun2.length).toBeGreaterThan(0);
    expect(
      afterRun2.every((e) => e.messageId !== "assistant-run1"),
      "没接线的回合继承了上一轮的回调闭包 ⇒ 工具事件会被挂到上一轮的消息行上（比改前更糟）",
    ).toBe(true);
  });

  it("O28-5: 空正文且**没有**工具调用的收尾行，仍必须有一条事件钉住它（投影重建时不许消失）", async () => {
    provider.setScript([reasoningOnlyEvents("（只想了一下，没说话也没调工具）")]);
    await executeSessionTurn({ sessionId: SESSION_ID, message: "你好", cwd: CWD, engine });
    await flushSessionLogWrites();

    const assistants = listMessages(SESSION_ID).filter((m) => m.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants.every((m) => (m.toolCalls?.length ?? 0) === 0)).toBe(true);

    const inv = checkVisibleRecordedInvariant(SESSION_ID);
    expect(inv.violations.map((v) => `${v.type}:${v.messageId}`)).toEqual([]);
  });
});

/**
 * O-28 装机版复核当场发现的**第三条口径差**（1.16.153 上量出来的）：
 * 系统提示行（`err-…` / `tool-error-…`）永远没有事件，于是**每一条都被判违规**。
 *
 * 真机取证：1.16.153 装机版上跑一次会失败的委派回合，维护自检立刻报
 * 「本次新产生 1 条缺口（样例：`1790320875202-hwcrjkdyl|VISIBLE_BUT_NOT_RECORDED|err-1790320962593-3axyi`）」——
 * 而副本库里 `system` 行共 3 条、**3 条全被判违规**（另两条是更早的 `tool-error-…`）。
 * 判据恒红就等于没有判据（第 45 轮为"无正文的助手行"修过同一件事），所以这里把它收窄到
 * `user` / `assistant` 两类行 —— 而收窄的**边界**必须同时钉住：放宽一点点都不许。
 */
describe("O28-6：不变量口径对 system 行的收窄（只放宽 system，别的角色一条都不许放过）", () => {
  it("O28-6a: system 行没有事件**不是**违规（三条路径一致地不把它当一等公民）", () => {
    const S = "o28-6a-session";
    seedSession(S);
    seedRawMessage(S, "err-1", "system", "Agentic 循环异常终止: too_many_errors", "error");
    const inv = checkVisibleRecordedInvariant(S);
    expect(inv.violations.map((v) => v.messageId)).toEqual([]);
  });

  it("O28-6b: 反向对照 —— user / assistant 行**没有**事件的仍然一条都不许放过", () => {
    const S = "o28-6b-session";
    seedSession(S);
    seedRawMessage(S, "u-no-event", "user", "有正文却没有事件", "done");
    seedRawMessage(S, "a-no-event", "assistant", "有正文却没有事件", "done");
    seedRawMessage(S, "a-empty-no-tool", "assistant", "", "done");
    const inv = checkVisibleRecordedInvariant(S);
    expect(inv.violations.map((v) => String(v.messageId)).sort()).toEqual([
      "a-empty-no-tool",
      "a-no-event",
      "u-no-event",
    ]);
  });
});

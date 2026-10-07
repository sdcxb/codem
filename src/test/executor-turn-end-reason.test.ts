/**
 * 第 309 波：**「这一轮为什么结束」必须留下痕迹** ✓
 *
 * ## 要修的缺陷（§13.188 的真机读数换来的 ✓）
 *
 * `repo-04` 在 `1.16.283` 批里的形状是：3 次工具调用 → **再无任何事件** ✗、
 * `maxIteration=3` ✓、`loopStops=[]` ✓、`diffChars=0` ✓、收尾消息**未定稿**（`status:"streaming"` ✓）。
 *
 * 而它**满足"零产出守卫"的全部条件** ✓（判据跑过且 4 failed ✓、读过源码 ✓）
 * ⇒ 那把守卫**本该触发** ✓ —— 却**一次 `recordLoopStop` 都没写** ✗
 * ⇒ 说明**那段代码根本没执行到** ✗。
 *
 * 读字面代码（`executor.ts` ✓）找到了那一处：
 * ```ts
 * for await (const event of engine.process(...)) {
 *   if (abort.signal.aborted) break;      // ← 385 行
 *   ...
 * }
 * ```
 * **`break` 之后没有 `endResult`** ✗ ⇒ `endShape = endResult?.type` 是 `undefined` ✗
 * ⇒ 下面那一整段失败记账（`error` / `aborted` / `overflow` ✓）**全部跳过** ✗
 * ⇒ 这一轮在事件日志里**没有任何"结束原因"** ✗。
 *
 * 于是一个**中止**的回合与一个**正常收尾**的回合，在记录里长得一样 ✗ ——
 * 而这两件事的修法**完全不同** ✓（前者是看门狗/预算/provider ✓，后者是完成守卫 ✓）。
 *
 * ## ⚠️ 本波第一版判据**只查源码里有没有那句话** ✗，被自己的变异逃掉了 ✓
 *
 * 变异形态：把 `getEventLog().append(sessionId, "turn_end", …)` 变成
 * `void 0; ({} as any) && getEventLog().append(…)` ✓（**写在那儿但永不执行** ✗）
 * ⇒ 判据照样绿 ✗。**这与 §13.184 的 `nudge-3` 是同一个教训** ✓：
 * **"写了" ≠ "执行了"** ✗ —— 而这一条判据的全部意义就是"它真的执行了" ✓。
 * ⇒ 改成本文件现在这样：**真跑 `executeSessionTurn`** ✓（夹具照抄
 * `o28-assistant-event-wiring.test.ts` ✓），从**事件日志**读回来 ✓。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecuteCommand, memFs } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  memFs: new Map<string, string>(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\end-reason",
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

import { LLMEngine } from "../core/llm";
import { clearSessionLogCache } from "../core/storage/message";
import { getEventLog } from "../core/storage/event-log";
import { __resetJsonlCache } from "../core/storage/session-jsonl";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import { setSetting } from "../core/storage/settings";
import { executeSessionTurn } from "../core/session/executor";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";

const SESSION_ID = "end-reason-1";
const CWD = "C:\\end-reason";
const PROJECT_ID = "proj-end-reason";

class ScriptedProvider {
  id = "end-provider";
  name = "EndReason Mock";
  config: any = { apiKey: "sk-test", models: [{ id: "end-model", contextWindow: 128000 }] };
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
    for (const e of script) yield e;
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [{ id: "end-model", name: "End", contextWindow: 128000, maxOutputTokens: 4096, supportsTools: true, supportsStreaming: true }];
  }
  async fetchModelsFromServer() {
    return this.listModels();
  }
}

function textResponseEvents(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

function installFsStub() {
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = { core: { invoke: async () => undefined } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

/** 从**事件日志**里读 `turn_end`（不是读源码 ✗ —— 这正是本波第一版踩的坑 ✓） */
function turnEndsOf(sessionId: string): Array<Record<string, unknown>> {
  return getEventLog()
    .readAll(sessionId)
    .filter((e) => e.type === "turn_end")
    .map((e) => (e.payload ?? {}) as Record<string, unknown>);
}

let engine: LLMEngine;
let provider: ScriptedProvider;

beforeEach(() => {
  vi.clearAllMocks();
  memFs.clear();
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSessionMessageBus();
  resetDelegationOrchestrator();
  mockExecuteCommand.mockResolvedValue({ stdout: "输出", stderr: "", exitCode: 0 });

  createProject({ id: PROJECT_ID, name: "E", path: CWD, createdAt: Date.now(), lastAccessedAt: Date.now() } as any);
  createSession({ id: SESSION_ID, projectId: PROJECT_ID, title: "E", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0 } as any);
  setSetting("codem-security-mode", "full");

  provider = new ScriptedProvider();
  engine = new LLMEngine();
  engine.providers.register(provider as any);
  (engine as any).config.defaultProvider = "end-provider";
  (engine as any).config.defaultModel = "end-model";
});

afterEach(() => {
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("END：中止与收尾必须留下「为什么结束」", () => {
  it("END-2: 正常收尾 ⇒ 落一条 turn_end / reason=loop_end（且不改返回值形状）", async () => {
    provider.setScript([textResponseEvents("做完了。")]);
    const result = await executeSessionTurn({ sessionId: SESSION_ID, message: "你好", cwd: CWD, engine });

    const ends = turnEndsOf(SESSION_ID);
    expect(ends.length, "正常收尾也必须留下结束原因（否则与中止分不开）").toBe(1);
    expect(ends[0].reason, "正常收尾与中止**必须不同名**").toBe("loop_end");
    expect(ends[0].abortCause, "正常收尾没有中止原因").toBeNull();
    expect(typeof ends[0].toolCalls, "工具调用数要能归因").toBe("number");
    /** 反向对照：这一波**只加观测** ✗ —— 不许顺手改返回值形状 ✓ */
    expect(result.success, "返回值形状不许被这一波改动").toBe(true);
  });

  it("END-1/3: 被中止 ⇒ 落一条 turn_end 且 reason **点名**中止原因", async () => {
    /**
     * 造"一开始就已经中止"的信号 ✓ —— 消费侧的 `if (abort.signal.aborted) break;`
     * 会在第一个事件之前就 break ✓，于是**没有 `endResult`** ✗
     * ⇒ 正是真机 repo-04 那个形态 ✓（`loopStops=[]` + 未定稿 ✓）。
     */
    const ac = new AbortController();
    ac.abort();
    provider.setScript([textResponseEvents("这句不该被当成正常完成。")]);
    const result = await executeSessionTurn({
      sessionId: SESSION_ID,
      message: "你好",
      cwd: CWD,
      engine,
      abortSignal: ac.signal,
    });

    const ends = turnEndsOf(SESSION_ID);
    expect(ends.length, "**中止的回合也必须留下结束原因** —— 这正是本波要修的 ✗").toBe(1);
    expect(
      String(ends[0].reason),
      "reason 必须点名中止原因（写死成一个常量就等于没量 ✗）",
    ).toMatch(/^abort:(idle|budget|tool_hung|cancel)$/);
    expect(ends[0].abortCause, "abortCause 必须与 reason 一致").toBe(String(ends[0].reason).replace("abort:", ""));
    expect(
      String(ends[0].reason),
      "这一条是**外部取消**（不是看门狗）⇒ 必须归到 cancel",
    ).toBe("abort:cancel");
    /** 反向对照：中止**不该**被当成成功 ✓（这是既有行为，本波不许改 ✗） */
    expect(result.success, "被中止的回合不许报成功").toBe(false);
  });

  it("END-3: 事件里带够归因字段（iteration / toolCalls / detail 都要在）", async () => {
    provider.setScript([textResponseEvents("做完了。")]);
    await executeSessionTurn({ sessionId: SESSION_ID, message: "你好", cwd: CWD, engine });
    const ends = turnEndsOf(SESSION_ID);
    expect(ends.length).toBe(1);
    expect(ends[0]).toHaveProperty("iteration");
    expect(ends[0]).toHaveProperty("toolCalls");
    expect(ends[0]).toHaveProperty("detail");
    expect(ends[0]).toHaveProperty("abortCause");
  });
});

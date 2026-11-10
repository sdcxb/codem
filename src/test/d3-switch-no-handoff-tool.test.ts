/**
 * D3 不变量（26 §2 / E1）：**自动 switch 不得调用 `handoff_to_new_session`**。
 *
 * ## 为什么需要这条判据
 *
 * `handoff_to_new_session` 是给**用户显式**「新开对话 / 移交」用的工具：它会新建
 * Session 并委派。自动换段（`trySwitchSegment` / `trySwitchOnCompletion`）必须只走
 * **内部 epoch**，否则一次自动切换就会凭空多出一个会话（D1 的「不新建 Session」被破坏）。
 *
 * 判据必须落在**真实完成出口**上（不是源码字符串）：
 * 1. 从 `LLMEngine.process()` 进（App 同一入口）；
 * 2. 断言本回合真的写了一个 `kind="switch"` 的 epoch；
 * 3. 在**同一个工具对象**上包一层计数器（不是另一个 registry）——
 *    自动路径只要通过 registry / 工具对象执行它，计数就会 >0；
 * 4. 同时断言会话数没变（工具的真实副作用）。
 *
 * 显式工具路径仍可用：同一条用例在自动切换后直接调用该工具（空正文），
 * 断言它执行了并返回自己的「交接正文不合规」，证明工具没有被删/禁用。
 *
 * ## 变异
 *
 * 在 `trySwitchOnCompletion` 里调用
 * `this.tools.get("handoff_to_new_session")?.execute(...)` ⇒ 本文件红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecuteCommand, memFs } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  memFs: new Map<string, string>(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\d3-switch",
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
import { getContextManager } from "../core/context/context";
import { clearSessionLogCache, createMessage, listTimelineMessages } from "../core/storage/message";
import { __resetJsonlCache } from "../core/storage/session-jsonl";
import { createProject } from "../core/storage/project";
import { createSession, listSessions } from "../core/storage/session";
import { setSetting } from "../core/storage/settings";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";
import type { ToolDef } from "../core/llm/tools";

const SESSION_ID = "d3-switch-1";
const CWD = "C:\\d3-switch";
const PROJECT_ID = "proj-d3-switch";
const WINDOW = 128_000;
const KEEP = 20;
const THRESHOLD = 0.1;

/** 只回一句话的 provider：不调工具 ⇒ 走「完成」出口 */
class TextProvider {
  id = "d3-switch-provider";
  name = "D3 Switch Mock";
  config: any = { apiKey: "sk-test", models: [{ id: "d3-switch-model", contextWindow: WINDOW }] };
  dynamicModels: any[] | null = null;
  isConfigured() {
    return true;
  }
  async *stream(_request: any): AsyncGenerator<any> {
    yield { type: "text_delta", text: "OK" };
    yield { type: "end", finishReason: "stop" };
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [
      {
        id: "d3-switch-model",
        name: "D3Switch",
        contextWindow: WINDOW,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ];
  }
  async fetchModelsFromServer() {
    return this.listModels();
  }
}

function installFsStub() {
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = { core: { invoke: async () => undefined } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

let engine: LLMEngine;
let provider: TextProvider;
let handoffCalls = 0;
let handoffTool: ToolDef;

beforeEach(async () => {
  vi.clearAllMocks();
  memFs.clear();
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSessionMessageBus();
  resetDelegationOrchestrator();
  mockExecuteCommand.mockResolvedValue({ stdout: "输出", stderr: "", exitCode: 0 });

  createProject({ id: PROJECT_ID, name: "D3Switch", path: CWD, createdAt: Date.now(), lastAccessedAt: Date.now() } as any);
  createSession({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: "D3Switch",
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    messageCount: 0,
  } as any);
  setSetting("codem-security-mode", "full");

  engine = new LLMEngine();
  provider = new TextProvider();
  engine.providers.register(provider as any);
  (engine as any).config.defaultProvider = "d3-switch-provider";
  (engine as any).config.defaultModel = "d3-switch-model";
  /* 等六批「延后注册」工具真正进表（否则 handoff 工具还不在 registry 里） */
  await engine.whenToolsReady();

  /*
   * 在**引擎真正使用的那一个工具对象**上包计数器：
   * - 自动 switch 若通过 registry.execute / tools.get(...).execute 调它，都会命中；
   * - 不替换整个 registry（否则自动路径用别的 registry 就测不到）。
   */
  handoffCalls = 0;
  handoffTool = (engine as any).tools.get("handoff_to_new_session");
  expect(handoffTool, "引擎必须注册 handoff_to_new_session（显式路径）").toBeTruthy();
  const original = handoffTool.execute.bind(handoffTool);
  handoffTool.execute = async (args, ctx) => {
    handoffCalls += 1;
    return original(args, ctx);
  };
});

afterEach(() => {
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

function seedShortHistory(count = 24) {
  for (let i = 0; i < count; i += 1) {
    createMessage(
      {
        id: `d3-msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `短历史第 ${i} 条`,
        timestamp: 1_000 + i,
        status: "done",
      },
      SESSION_ID,
    );
  }
}

describe("D3 不变量：自动 switch 不调用 handoff_to_new_session", () => {
  it("D3-INV-1: 完成态自动换段后，工具调用计数 0 且没有新建会话", async () => {
    seedShortHistory(24);
    const cm = getContextManager();
    cm.updateConfig({ segmentEpochs: true, compactionThreshold: THRESHOLD, maxMessagesAfterCompaction: KEEP });
    try {
      const events: any[] = [];
      for await (const event of engine.process(SESSION_ID, "只回复 OK", CWD)) events.push(event);

      const end = [...events].reverse().find((event) => event.type === "end");
      expect(end?.result?.reason, "本回合必须正常完成（否则走的不是完成态换段）").toBe("completed");

      const epochOf = (m: any) => (m.metadata as Record<string, any> | null | undefined)?.contextEpoch;
      const timeline = listTimelineMessages(SESSION_ID);
      const switches = timeline.filter((m) => epochOf(m)?.kind === "switch");
      expect(switches.length, "完成态必须真的写一个 switch epoch（前提）").toBe(1);

      expect(handoffCalls, "自动 switch 路径调用 handoff_to_new_session 的次数必须是 0").toBe(0);
      expect(
        listSessions(PROJECT_ID).length,
        "自动 switch 不许新建 Session（handoff 工具的真实副作用）",
      ).toBe(1);
    } finally {
      cm.updateConfig({ segmentEpochs: true, compactionThreshold: 0.7, maxMessagesAfterCompaction: 20 });
    }
  });

  it("D3-INV-2: 显式工具路径仍可用（工具没被删/禁用；执行自己的校验）", async () => {
    const before = handoffCalls;
    const result = await handoffTool.execute(
      { task: "" },
      { sessionId: SESSION_ID, cwd: CWD } as any,
    );
    expect(handoffCalls).toBe(before + 1);
    expect(result.isError, "空交接正文必须被工具自身拒绝").toBe(true);
    expect(result.output).toMatch(/交接正文不合规|Fix it/);
    expect(
      listSessions(PROJECT_ID).length,
      "校验失败时不许新建会话",
    ).toBe(1);
  });
});

/**
 * O-46 / MEM-ID-*：**项目身份在 executor（后台）路径上的唯一来源**。
 *
 * ## 要修的缺陷（GAP-LIST O-46）
 *
 * 修复前两侧的兜底是"逐字相同的表达式"：
 *
 * ```
 * 写入侧：options?.memoryProjectId ?? projectIdFromCwd(cwd)
 * 注入侧：sessionMemoryProjectId.get(sessionId) ?? projectIdFromCwd(cwd)
 * ```
 *
 * `executor.executeSessionTurn`（委派 / 微信桥 / 手机续聊）**不传** `options.memoryProjectId`，
 * 而它的 `cwd` 在 git worktree 会话上**就是 worktree 目录**（`App.tsx` 用
 * `session.worktreePath` 当 cwd）。于是两侧**一起**退化成 worktree 目录：
 * "这个会话的项目记忆"落到别处，而因为两边对称、看起来一致，**没有任何判据会红**。
 *
 * `memory-migration-guards.test.ts` 的 R3-IDENTITY / R3-IDENTITY-PROD 钉的是
 * 「**界面传入** `options.memoryProjectId` 时两侧都用它」—— 兜底路径本身当时没有判据。
 *
 * ## 本文件的判据（每条都带反向对照，防恒真）
 *
 * | 判据 | 钉住的事实 | 反向对照（它能变红吗） |
 * | --- | --- | --- |
 * | `MEM-ID-1` | worktree 会话走 **executor 路径**（`executeSessionTurn`，**不传** `memoryProjectId`）时，写入侧与注入侧的项目身份都是**项目根**；且提取出来的记忆真的落进项目根的桶（worktree 桶为空） | 变异：把 `resolveMemoryProjectId` 的登记表那一跳删掉/换成 `projectIdFromCwd(cwd)` ⇒ 身份变成 worktree 目录 ⇒ 红（见 `tools/mutate/specs/project-id-191.mjs`） |
 * | `MEM-ID-1b` | 注入侧**行为**：cwd 是 worktree 目录时，项目根桶里的记忆真的要进系统提示；没登记的会话看不到 | 若注入侧按 cwd 取数 ⇒ 红 |
 * | `MEM-ID-2` | **反向对照**：登记查不到时（`projects` 行删掉）身份**必须不再是项目根**（如实退化到 cwd）**且必须有如实上报** | 若"永远是项目根"（恒真实现）⇒ 红；把上报那句去掉 ⇒ 红 |
 * | `MEM-ID-3` | 写入侧与注入侧在**所有**路径（界面传入 / executor 不传 / 登记缺失）**逐字一致**，且只在登记缺失时才允许退回 cwd | 变异：让注入侧丢掉 `registered`（两侧分叉）⇒ 红 |
 *
 * ⚠️ 本文件用的是**真实的** `LLMEngine.process` / `executeSessionTurn`，只把
 * "发 LLM 请求"（provider / `spawnForked`）与文件通道压成桩 —— 判据里没有任何
 * "源码里含某字符串"式断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecuteCommand, memFs } = vi.hoisted(() => ({
  mockExecuteCommand: vi.fn(),
  /** 内存文件系统：权威日志（追加式 JSONL）走的就是 `file-api` 这条通道，别让它报错刷屏 */
  memFs: new Map<string, string>(),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: mockExecuteCommand,
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\work\\main",
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

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { LLMEngine } from "../core/llm/index";
import { MemoryService, projectIdFromCwd } from "../core/memory/memory";
import * as MessageStorage from "../core/storage/message";
import { clearSessionLogCache } from "../core/storage/message";
import { __resetJsonlCache } from "../core/storage/session-jsonl";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { setSetting } from "../core/storage/settings";
import { executeSessionTurn } from "../core/session/executor";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";

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

/** 事件脚本驱动的 mock provider（只在这一条上用得到真 provider 的路径：executor 回合） */
class ScriptedProvider {
  id = "id191-provider";
  name = "ID191 Mock";
  config: any = { apiKey: "sk-test", models: [{ id: "id191-model", contextWindow: 128000 }] };
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
    return { content: "[]", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [{ id: "id191-model", name: "ID191", contextWindow: 128000, maxOutputTokens: 4096, supportsTools: true, supportsStreaming: true }];
  }
  async fetchModelsFromServer() {
    return this.listModels();
  }
}

/**
 * 项目身份（= 项目根归一化后的路径）与 worktree 目录的归一化值。
 *
 * **刻意写死**（不用 `projectIdFromCwd` 现算）：否则归一化本身坏掉时，判据会跟着一起坏
 * ——那就成了"拿实现证明实现"。归一化口径由 `projectIdFromCwd` 自己的一条断言单独钉住（见下）。
 */
const PROJECT_ROOT = "C:\\work\\main";
const PROJECT_IDENTITY = "c:\\work\\main";
const WORKTREE = "C:\\work\\main\\wt-1";
const WORKTREE_IDENTITY = "c:\\work\\main\\wt-1";

/** 提取出来的事实（`> 10` 字符，否则会被 `safeContent.length <= 10` 丢掉） */
const FACT = "WT_FACT 足够长的一条自动提取内容";

const SESSION_MAIN = "s-id191-executor";
/** MEM-ID-1b 的"没登记"对照会话：**必须与 MEM-ID-2 的会话不同** —— 退化上报按「会话 + 身份」
 *  去重，复用同一个会话会让 MEM-ID-2 抓不到那一行（第一版就是这么假红的）。 */
const SESSION_UNREGISTERED = "s-id191-unregistered";
const SESSION_REVERSE = "s-id191-reverse";
const SESSION_CONSISTENT = "s-id191-consistent";

function textResponseEvents(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

/** 登记一个「会话 → 项目」：项目行 + 会话行（`sessions.project_id`） */
function registerSession(sessionId: string, opts: { projectId: string; projectPath?: string; worktreePath?: string }) {
  if (opts.projectPath) {
    createProject({
      id: opts.projectId,
      name: opts.projectId,
      path: opts.projectPath,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
  }
  createSession({
    id: sessionId,
    projectId: opts.projectId,
    title: sessionId,
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    messageCount: 0,
    ...(opts.worktreePath ? { worktreePath: opts.worktreePath, executionMode: "git_worktree" as const } : {}),
  });
}

/** 引擎的注入侧捕获：记录 `buildMemoryPrompt(scope, projectId, sessionId, …)` 收到的 projectId */
function captureInjectedProjectIds(svc: MemoryService): Array<string | undefined> {
  const seen: Array<string | undefined> = [];
  vi.spyOn(svc, "buildMemoryPrompt").mockImplementation((...args: unknown[]) => {
    seen.push(args[1] as string | undefined);
    return "";
  });
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
  memFs.clear();
  files.clear();
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  resetSessionMessageBus();
  resetDelegationOrchestrator();
  mockExecuteCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  // 每个用例一个干净端口（与全局基座同一形态，但这里显式声明，避免与其他文件的种子串味）
  setStoragePort(createFakeStoragePort());
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("O-46：项目身份在 executor / 后台路径上必须来自 session → project 登记表", () => {
  it("MEM-ID-1：worktree 会话走 executor 路径（不传 memoryProjectId）时，两侧的项目身份都是项目根", async () => {
    // 归一化口径单独钉一条：项目身份是"项目根路径"归一化后的值（大小写/分隔符差异都落进同一个桶）
    expect(projectIdFromCwd(PROJECT_ROOT), "身份口径：项目根归一化").toBe(PROJECT_IDENTITY);
    expect(projectIdFromCwd(WORKTREE), "worktree 目录归一化后**不等于**项目根").toBe(WORKTREE_IDENTITY);

    const svc = new MemoryService();
    registerSession(SESSION_MAIN, { projectId: "proj-id191", projectPath: PROJECT_ROOT, worktreePath: WORKTREE });
    setSetting(`memory-enabled-${SESSION_MAIN}`, "true");
    /** 会话历史够长（`extractMemoriesFromSession` 要求 ≥ 10 条），且写入侧要真的跑提取 */
    for (let i = 0; i < 12; i++) {
      MessageStorage.createMessage(
        { id: `seed-${i}`, role: i % 2 ? "assistant" : "user", content: "历史内容", timestamp: 1000 + i, status: "done" } as never,
        SESSION_MAIN,
      );
    }

    const provider = new ScriptedProvider();
    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    engine.providers.register(provider as never);
    (engine as unknown as { config: { defaultProvider?: string; defaultModel?: string } }).config.defaultProvider = "id191-provider";
    (engine as unknown as { config: { defaultProvider?: string; defaultModel?: string } }).config.defaultModel = "id191-model";
    setSetting("codem-security-mode", "full");
    /** 真发 LLM 请求的那一步压成桩：写入侧要跑**真实的**提取流程（建批次 → 落条目）
     *  ⚠️ 第 196 波：显式 `"scope": "project"` —— 这条用例钉的是"**项目级**记忆的归属键走项目根"，
     *  而同一波把兜底方向改成了**拿不准 ⇒ 对话级**（用户选定）⇒ 不带 scope 会绕开主语。 */
    vi.spyOn(engine, "spawnForked").mockResolvedValue(
      JSON.stringify([{ key: "worktree 事实", content: FACT, tags: [], scope: "project" }]),
    );

    // 写入侧身份：生产路径真的把哪个 projectId 交给了提取（call-through，提取照常发生）
    const extractSpy = vi.spyOn(engine, "extractMemoriesFromSession");
    // 注入侧身份：本次回合里提示词构造真的拿到哪个 projectId
    const injected = captureInjectedProjectIds(svc);

    provider.setScript([textResponseEvents("做完了。")]);
    /**
     * ★ 这就是 executor / 后台路径的形状：**没有** `memoryProjectId`，
     * 而 cwd 是 worktree 目录（`App.tsx` 把 `session.worktreePath` 当 cwd 传给委派路径）。
     */
    const res = await executeSessionTurn({ sessionId: SESSION_MAIN, message: "你好", cwd: WORKTREE, engine });

    expect(res.success, "这一轮必须真的跑完（否则下面测的不是产品路径）").toBe(true);
    expect(injected.length, "必须真的走到了注入侧（提示词构造）").toBeGreaterThan(0);
    for (const got of injected) {
      expect(got, "注入侧的项目身份必须是**项目根**，不是 worktree 目录").toBe(PROJECT_IDENTITY);
    }

    const writeIds = extractSpy.mock.calls.map((c) => c[1]);
    expect(writeIds.length, "必须真的走到了写入侧（提取回调）").toBeGreaterThan(0);
    for (const got of writeIds) {
      expect(got, "写入侧的项目身份必须是**项目根**，不是 worktree 目录").toBe(PROJECT_IDENTITY);
    }
    expect([...injected, ...writeIds], "两侧都不许退回 worktree 目录").not.toContain(WORKTREE_IDENTITY);

    /**
     * 行为落地：身份不是"传了个字符串"就完事 —— 提取出来的条目必须真的落进**项目根**的桶
     * （写入侧是 fire-and-forget，所以这里等它落定）。
     */
    await vi.waitFor(
      () => {
        expect(
          svc.listPending(undefined, { projectId: PROJECT_IDENTITY }).map((e) => e.content),
          "自动提取的项目记忆必须落在**项目根**的桶里",
        ).toContain(FACT);
      },
      { timeout: 5000 },
    );
    expect(
      svc.listPending(undefined, { projectId: WORKTREE_IDENTITY }),
      "worktree 目录那个桶必须是空的（修复前它才是记忆的去处）",
    ).toHaveLength(0);
  });

  it("MEM-ID-1b：同一个 worktree 会话的注入侧确实从项目根那个桶取数（批准后进系统提示）", async () => {
    const svc = new MemoryService();
    registerSession(SESSION_MAIN, { projectId: "proj-id191", projectPath: PROJECT_ROOT, worktreePath: WORKTREE });

    // 手工把一条项目级记忆写进**项目根**的桶（写入侧的行为已由 MEM-ID-1 钉住）
    svc.add({ scope: "project", projectId: PROJECT_IDENTITY, key: "项目约定", content: FACT, source: "manual" });

    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    engine.agents = { get: () => ({ id: "build", name: "build", description: "", systemPrompt: "" }) } as never;
    engine.skills = {
      buildSkillEnvironmentSection: () => "",
      buildSkillPrompt: () => "",
      buildPreloadedSkillPrompt: () => "",
    } as never;
    engine.mcp = { getAllTools: () => [] } as never;

    // cwd 是 worktree 目录（后台路径的真机形态），但登记表说这个会话属于项目根
    const prompt = engine.buildSystemPrompt(SESSION_MAIN, "build", WORKTREE);
    expect(prompt, "worktree 会话必须看得到项目根桶里的记忆（修复前它在 worktree 桶里找不到）").toContain("WT_FACT");

    // 反向：**没有登记**的会话拿同一个 worktree cwd ⇒ 看不到（说明注入不是"到处都注入"）
    const other = engine.buildSystemPrompt(SESSION_UNREGISTERED, "build", WORKTREE);
    expect(other, "没登记的会话不许白拿这条记忆").not.toContain("WT_FACT");
  });

  it("MEM-ID-2（反向对照）：把登记值删掉 ⇒ 身份**必须不再**是项目根（如实退化 + 如实上报）", async () => {
    const svc = new MemoryService();
    registerSession(SESSION_REVERSE, { projectId: "proj-id191-deleted", projectPath: PROJECT_ROOT, worktreePath: WORKTREE });
    /** 删掉登记值：会话行还在，但它指向的项目行"不存在了"（登记解析不出来） */
    vi.spyOn(ProjectStorage, "getProject").mockReturnValue(null);

    const engine = new LLMEngine();
    (engine as unknown as { memory: MemoryService }).memory = svc;
    (engine as unknown as { providers: unknown }).providers = { get: () => ({ id: "test", isConfigured: () => true }) };
    (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
    vi.spyOn(MessageStorage, "listMessages").mockReturnValue(
      Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: "x" })) as never,
    );
    vi.spyOn(engine, "spawnForked").mockResolvedValue("[]");
    engine.agents = { get: () => ({ id: "build", name: "build", description: "", systemPrompt: "" }) } as never;
    engine.skills = {
      buildSkillEnvironmentSection: () => "",
      buildSkillPrompt: () => "",
      buildPreloadedSkillPrompt: () => "",
    } as never;
    engine.mcp = { getAllTools: () => [] } as never;

    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(" "));
    });

    const injected = captureInjectedProjectIds(svc);
    /** 写入侧身份：`process()` 真的登记了什么（call-through：登记照常发生） */
    const setSpy = vi.spyOn(engine, "setSessionMemoryProject");

    await engine.process(SESSION_REVERSE, "你好", WORKTREE, "build").next();

    const writeRegistered = setSpy.mock.calls.map((c) => c[1]);

    expect(writeRegistered.length, "写入侧必须真的登记过身份").toBeGreaterThan(0);
    for (const got of writeRegistered) {
      expect(got, "登记值被删掉 ⇒ 写入侧**不许**再是项目根（否则这条判据是恒真的）").not.toBe(PROJECT_IDENTITY);
      expect(got, "登记值被删掉 ⇒ 如实退化到本轮的工作目录").toBe(WORKTREE_IDENTITY);
    }
    expect(injected.length, "注入侧必须真的跑到").toBeGreaterThan(0);
    for (const got of injected) expect(got, "注入侧与写入侧同一处置").toBe(WORKTREE_IDENTITY);

    expect(
      warns.filter((w) => w.includes("[memory-project-id]")),
      "退化**必须如实上报**（不许静默用一个可能是 worktree 目录的值）",
    ).not.toHaveLength(0);
  });

  it("MEM-ID-3（两侧一致）：界面传入 / executor 不传 / 登记缺失 三条路径上，写入侧与注入侧逐字一致", async () => {
    /**
     * 捕获一次真实 `process()` 里两侧的项目身份。
     *
     * - 写入侧 = `process()` 登记进 `setSessionMemoryProject` 的那一份（它同时是交给
     *   `extractMemoriesFromSession` 的那一份，见 `process()` 里同一个局部变量的两处使用）；
     * - 注入侧 = `buildMemoryPrompt` 真正收到的 `projectId`。
     */
    async function capture(scenario: {
      sessionId: string;
      memoryProjectId?: string;
      /** 登记：项目路径（`null` = 只建会话行，不建项目行 ⇒ 登记解析不出来） */
      projectPath: string | null;
    }): Promise<{ write: Array<string | undefined>; inject: Array<string | undefined>; warns: string[] }> {
      // 每个场景一个**独立**项目 id：三条场景共用同一个端口，共用 id 会让 ③ 读到 ② 建的项目行
      registerSession(scenario.sessionId, {
        projectId: `${scenario.sessionId}-proj`,
        projectPath: scenario.projectPath ?? undefined,
        worktreePath: WORKTREE,
      });
      const svc = new MemoryService();
      const engine = new LLMEngine();
      (engine as unknown as { memory: MemoryService }).memory = svc;
      (engine as unknown as { providers: unknown }).providers = { get: () => ({ id: "test", isConfigured: () => true }) };
      (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
      vi.spyOn(MessageStorage, "listMessages").mockReturnValue(
        Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, role: i % 2 ? "assistant" : "user", content: "x" })) as never,
      );
      vi.spyOn(engine, "spawnForked").mockResolvedValue("[]");
      engine.agents = { get: () => ({ id: "build", name: "build", description: "", systemPrompt: "" }) } as never;
      engine.skills = {
        buildSkillEnvironmentSection: () => "",
        buildSkillPrompt: () => "",
        buildPreloadedSkillPrompt: () => "",
      } as never;
      engine.mcp = { getAllTools: () => [] } as never;

      const warns: string[] = [];
      const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warns.push(args.map((a) => String(a)).join(" "));
      });
      const inject = captureInjectedProjectIds(svc);
      /** call-through 的 spy：登记照常发生，我们只是把值记下来 */
      const writeSpy = vi.spyOn(engine, "setSessionMemoryProject");

      // 不跑完这一轮：登记与提示词构造都发生在第一个 yield 之前
      await engine.process(scenario.sessionId, "你好", WORKTREE, "build", scenario.memoryProjectId !== undefined ? { memoryProjectId: scenario.memoryProjectId } : undefined).next();
      warnSpy.mockRestore();
      return { write: writeSpy.mock.calls.map((c) => c[1]), inject, warns: warns.filter((w) => w.includes("[memory-project-id]")) };
    }

    // ① 界面主路径：显式传入项目身份（`App.tsx:3767` 的形状）
    const ui = await capture({ sessionId: `${SESSION_CONSISTENT}-ui`, memoryProjectId: PROJECT_IDENTITY, projectPath: null });
    expect(ui.write, "界面传入 ⇒ 写入侧就是它").toEqual([PROJECT_IDENTITY]);
    expect(ui.inject, "界面传入 ⇒ 注入侧必须真的跑到").not.toHaveLength(0);
    for (const got of ui.inject) expect(got, "界面传入 ⇒ 注入侧也是它").toBe(PROJECT_IDENTITY);
    expect(ui.warns, "界面传入时不该退化，也就没有退化上报").toHaveLength(0);

    // ② executor / 后台路径：**不传** `memoryProjectId`，身份显式取登记表
    const bg = await capture({ sessionId: `${SESSION_CONSISTENT}-bg`, projectPath: PROJECT_ROOT });
    expect(bg.write, "executor 路径 ⇒ 写入侧取登记值（项目根）").toEqual([PROJECT_IDENTITY]);
    expect(bg.inject, "executor 路径 ⇒ 注入侧必须真的跑到").not.toHaveLength(0);
    for (const got of bg.inject) expect(got, "executor 路径 ⇒ 注入侧同一个值").toBe(PROJECT_IDENTITY);
    expect(bg.warns, "取到了登记值 ⇒ 没有退化，不该上报").toHaveLength(0);

    // ③ 登记缺失：唯一的诚实处置是"退化到 cwd + 如实上报"，而且两侧仍然逐字一致
    const missing = await capture({ sessionId: `${SESSION_CONSISTENT}-none`, projectPath: null });
    expect(missing.write, "登记缺失 ⇒ 退化到本轮 cwd（不静默用登记表以外的第二个来源）").toEqual([WORKTREE_IDENTITY]);
    expect(missing.inject, "登记缺失 ⇒ 注入侧必须真的跑到").not.toHaveLength(0);
    for (const got of missing.inject) expect(got, "登记缺失 ⇒ 注入侧与写入侧同值").toBe(WORKTREE_IDENTITY);
    expect(missing.warns, "登记缺失 ⇒ 必须有如实上报").not.toHaveLength(0);

    // 三条路径的共同不变量：两侧**逐字一致**（这才是 R3 之后真正要守的东西）
    for (const [name, got] of [["界面传入", ui], ["executor 不传", bg], ["登记缺失", missing]] as const) {
      expect(got.write, `${name}：写入侧必须有值`).not.toHaveLength(0);
      expect(new Set(got.write).size, `${name}：写入侧不许有两个不同身份`).toBe(1);
      expect(got.inject, `${name}：两侧必须逐字一致（写进哪个桶 = 从哪个桶注入）`).toEqual(
        Array.from({ length: got.inject.length }, () => got.write[0]),
      );
    }
  });
});

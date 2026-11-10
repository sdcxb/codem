/**
 * **MEM-EXTRACT-1（端到端）**：100 轮 / 3 次压缩，事实在第 2 轮 ⇒ 提取后
 * `memory_search` / `memory_read` 能召回；把提取源改回 `listMessages` ⇒ 红。
 *
 * ## 为什么这条必须"端到端"
 *
 * 既有的 `MEM-T2`（`context-os-scale-acceptance.test.ts`）只断言"提取请求里带旧段事实"，
 * 而 24 §6 的 MEM-EXTRACT-1 要求的是**写进去 + 取得回**：
 * 早期事实 → 提取（真实 `extractMemoriesFromSession` → 真实 `spawnForked` → 真实
 * `messagesToLLMMessages`）→ 真实 `MemoryService` 写入 → 模型面工具 `memory_search` /
 * `memory_read` 召回。中间任何一段断掉（源、请求、写入、检索可见性）都会让这条红。
 *
 * ## 现场怎么造（不 mock 被测逻辑）
 *
 * - 200 条消息（100 轮）；`MEMEX1_FACT` 放在第 2 轮（第 3 条消息）里；
 * - 3 次压缩是**真实读路径**的形态：被压缩区间 `hidden=1`，并写 `compact-*` marker
 *   （`metadata.contextEpoch` 带 cutoff / segmentSeq）。`listMessages` 因此只剩
 *   marker + 最近 20 条 —— 早期事实不在模型视图里；
 * - `extractionMessages()` 走"时间线 / 模型视图里更完整的那个" ⇒ 必须拿到时间线。
 *
 * ## 变异自证
 *
 * 把 `src/core/storage/memory-extraction-source.ts` 改回只读 `listMessages` ⇒
 * 提取请求里没有 `MEMEX1_FACT` ⇒ 假 provider 返回 `[]` ⇒ 没有条目 ⇒ 召回断言红。
 *
 * （本文件不碰 switch 规则/压缩写路径；压缩现场是直接按读路径契约种出来的真实行。）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { memFs } = vi.hoisted(() => ({ memFs: new Map<string, string>() }));
vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  getAppDataDir: async () => "C:\\appdata\\",
  getDefaultCwd: async () => "C:\\mem-e2e",
  exists: async (p: string) => memFs.has(p),
  readFile: async (p: string) => {
    if (!memFs.has(p)) throw new Error("ENOENT: " + p);
    return memFs.get(p)!;
  },
  readTextWindow: async (p: string, offset = 0, maxBytes?: number) => {
    const c = memFs.get(p) ?? "";
    const end = maxBytes ? Math.min(c.length, offset + maxBytes) : c.length;
    return { text: c.slice(offset, end), nextOffset: end, eof: end >= c.length, size: c.length };
  },
  appendFile: async (p: string, c: string) => {
    memFs.set(p, (memFs.get(p) ?? "") + c + "\n");
  },
  writeFile: async (p: string, c: string) => {
    memFs.set(p, c);
  },
  deleteFile: async () => {},
  deletePath: async () => {},
  renameFile: async () => {},
  listDirectory: async () => [],
  globSearch: async () => [],
  grepSearch: async () => [],
  readFileLines: async (p: string) => ({ text: memFs.get(p) ?? "", hasMore: false, totalLines: 1 }),
  isPathWithinWorkspace: () => true,
}));

import { LLMEngine } from "../core/llm";
import { getTokenTracker } from "../core/llm/token-tracker";
import { clearSessionLogCache, listMessages, listTimelineMessages } from "../core/storage/message";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { domainEnsureLoaded } from "../core/storage/domain-store";
import { __resetJsonlCache } from "../core/storage/session-jsonl";
import { saveMemory, setSetting, setSettingJSON } from "../core/storage/settings";
import { getMemoryService, MEMORY_WRITE_APPROVAL_KEY } from "../core/memory/memory";
import { createMemoryReadTool, createMemorySearchTool } from "../core/llm/tools/memory-tools";
import { projectIdFromCwd } from "../core/memory/memory";

const SESSION = "mem-e2e-1";
const PROJECT_ROW = "proj-mem-e2e-1";
const CWD = "C:\\mem-e2e";
const PROJECT_ID = projectIdFromCwd(CWD);
const MODEL_ID = "mem-e2e-model";
const PROVIDER_ID = "mem-e2e-provider";
const FACT = "MEMEX1_FACT：部署前必须先跑 pnpm build --filter core（第 2 轮里确认过的约定）";
/** 3 次压缩的 cutoff（被压缩区间 = 该下标之前的所有消息） */
const COMPACT_CUTOFFS = [120, 160, 180];

let port: FakeStoragePort;

function seedRow(table: string, row: Record<string, unknown>) {
  void port.data.execute("crud.upsert", { table, rows: [row], mode: "replace" });
}

function seedMessage(id: string, index: number, content: string, hidden = 0, metadata?: Record<string, unknown>) {
  seedRow("messages", {
    id,
    session_id: SESSION,
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    reasoning: null,
    timestamp: 1_000 + index,
    model: null,
    status: "done",
    hidden,
    ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
  });
}

/**
 * 造 200 条消息 + 3 次压缩（读路径契约：旧区间 `hidden=1` + `compact-*` marker）。
 *
 * marker 的时间戳放在"cutoff 与下一条之间"，于是最终模型视图 = 最新 marker + 最近 20 条，
 * 早期 marker 不会被当成普通消息留在 tail 里。
 */
function seedTimelineAndCompactions() {
  for (let i = 0; i < 200; i += 1) {
    const content = i === 2
      ? `${FACT}。这一轮的其他内容。`
      : `第 ${Math.floor(i / 2) + 1} 轮对话消息 ${i}`;
    seedMessage(`e2e-msg-${i}`, i, content);
  }
  for (let c = 0; c < COMPACT_CUTOFFS.length; c += 1) {
    const cutoff = COMPACT_CUTOFFS[c];
    /* 该区间被压缩 ⇒ 隐藏（读路径据此从模型视图排除） */
    for (let i = 0; i < cutoff; i += 1) {
      const row = (port.__table("messages") as Array<Record<string, unknown>>).find((r) => r.id === `e2e-msg-${i}`);
      if (!row) continue;
      void port.data.execute("crud.upsert", {
        table: "messages",
        rows: [{ ...row, hidden: 1 }],
        mode: "replace",
      });
    }
    const seq = c + 1;
    const markerId = `compact-e2e-${seq}`;
    seedRow("messages", {
      id: markerId,
      session_id: SESSION,
      role: "user",
      content: `[上下文压缩] 第 ${seq} 次压缩摘要（${cutoff} 条之前的重要信息）`,
      reasoning: null,
      timestamp: 1_000 + cutoff - 0.5,
      model: null,
      status: "done",
      hidden: 0,
      metadata: JSON.stringify({
        contextEpoch: {
          epochId: markerId,
          seq,
          cutoffMessageId: `e2e-msg-${cutoff}`,
          kind: "compact",
          segmentSeq: seq,
          removedCount: cutoff,
          keptCount: 200 - cutoff,
          createdAt: 5_000 + seq,
          trigger: "auto",
        },
      }),
    });
  }
}

function makeProvider() {
  const requests: any[] = [];
  const provider = {
    id: PROVIDER_ID,
    name: "mem-e2e",
    config: { apiKey: "sk-test", models: [{ id: MODEL_ID, contextWindow: 128_000 }] },
    dynamicModels: null as any,
    isConfigured: () => true,
    async *stream() {
      yield { type: "text_delta", text: "OK" };
      yield { type: "end", finishReason: "stop" };
    },
    async complete(request: any) {
      requests.push(request);
      const text = JSON.stringify(request?.messages ?? []);
      if (!text.includes("MEMEX1_FACT")) {
        /* 没看到早期事实 ⇒ 什么也提不出来（这正是"源换回去就红"的机制） */
        return { content: "[]", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }
      return {
        content: JSON.stringify([
          {
            key: "部署前构建命令",
            content: "MEMEX1_FACT：部署前必须先跑 pnpm build --filter core。",
            tags: ["构建"],
            scope: "conversation",
            explicit: false,
          },
        ]),
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      };
    },
    async listModels() {
      return [{ id: MODEL_ID, name: "m", contextWindow: 128_000, maxOutputTokens: 4096, supportsTools: true, supportsStreaming: true }];
    },
    async fetchModelsFromServer() {
      return this.listModels();
    },
  };
  return { provider, requests };
}

function makeEngine(provider: ReturnType<typeof makeProvider>["provider"]): LLMEngine {
  const engine = new LLMEngine();
  engine.providers.register(provider as never);
  (engine as unknown as { config: { defaultProvider?: string; defaultModel?: string } }).config.defaultProvider = PROVIDER_ID;
  (engine as unknown as { config: { defaultProvider?: string; defaultModel?: string } }).config.defaultModel = MODEL_ID;
  (engine as unknown as { profileManager: unknown }).profileManager = {
    resolveSlot: () => ({ provider: PROVIDER_ID, model: MODEL_ID }),
  };
  return engine;
}

function toolCtx() {
  return {
    sessionId: SESSION,
    messageId: "e2e-tool-call",
    cwd: CWD,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as never;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memFs.clear();
  __resetJsonlCache();
  clearSessionLogCache();
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = { core: { invoke: async () => undefined } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
  saveMemory("");
  setSetting("codem-security-mode", "full");
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
  setSettingJSON(`memory-enabled-${SESSION}`, true);
  getTokenTracker().setContextWindow(128_000);
  seedRow("projects", { id: PROJECT_ROW, name: "mem-e2e", path: CWD, created_at: 1, last_accessed_at: 1 });
  seedRow("sessions", {
    id: SESSION,
    project_id: PROJECT_ROW,
    title: "mem-e2e",
    model: null,
    created_at: 1,
    last_message_at: 1,
    message_count: 0,
    pinned: 0,
  });
  await new Promise<void>((resolve) => domainEnsureLoaded("projects", resolve));
  await new Promise<void>((resolve) => domainEnsureLoaded("sessions", resolve));
  await getMemoryService().reload();
  seedTimelineAndCompactions();
});

afterEach(() => {
  setStoragePort(null);
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
  vi.restoreAllMocks();
});

describe("MEM-EXTRACT-1（端到端）：3 次压缩后，第 2 轮的事实仍能写入并被 memory_search / memory_read 召回", () => {
  it("MEM-EXTRACT-1：提取源 = 完整时间线 ⇒ 请求带早期事实 ⇒ 写入 ⇒ 工具召回", async () => {
    /* 前提：模型视图里已经没有这条事实（否则这条判据测不到"源"） */
    const view = listMessages(SESSION);
    expect(view.length, "压缩后模型视图只剩 marker + 最近 20 条").toBeLessThanOrEqual(21);
    expect(JSON.stringify(view), "前提：早期事实不在模型视图里").not.toContain("MEMEX1_FACT");
    expect(
      listTimelineMessages(SESSION).length,
      "前提：完整时间线仍保留全部消息（200 + 3 marker）",
    ).toBe(203);

    const { provider, requests } = makeProvider();
    const engine = makeEngine(provider);
    await engine.extractMemoriesFromSession(SESSION, PROJECT_ID);

    expect(requests, "必须真的发起一次提取请求").toHaveLength(1);
    const requestText = JSON.stringify(requests[0]?.messages ?? []);
    expect(requestText, "提取请求必须带第 2 轮的早期事实（源改回 listMessages 时这里红）").toContain("MEMEX1_FACT");
    expect(requestText, "也必须带最近的进展（头 10 + 尾 40 取样）").toContain("第 100 轮对话消息 198");

    /* 真实写入：条目必须真的在库里（conversation 级直接生效） */
    const svc = getMemoryService();
    const entries = svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true });
    const written = entries.find((e) => e.content.includes("MEMEX1_FACT"));
    expect(written, "提取结果必须真的写进记忆库").toBeTruthy();
    expect(written!.scope, "对话级（本判据里 conversation 默认免审批）").toBe("conversation");
    expect(written!.status ?? "active", "必须已生效（不进待批准）").not.toBe("pending");

    /* 模型面工具召回（端到端的最后一段） */
    const search = createMemorySearchTool();
    const hits = await search.execute({ query: "MEMEX1_FACT" }, toolCtx());
    expect(hits.isError, hits.output).toBe(false);
    expect(hits.output, "memory_search 必须命中这条记忆").toContain(written!.id);
    expect((hits.value as { ids: string[] }).ids, "命中 id 里必须有它").toContain(written!.id);

    const read = createMemoryReadTool();
    const full = await read.execute({ id: written!.id }, toolCtx());
    expect(full.isError, full.output).toBe(false);
    expect(full.output, "memory_read 必须能读回完整正文").toContain("pnpm build --filter core");
  });
});

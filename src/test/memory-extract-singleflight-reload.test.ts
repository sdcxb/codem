/**
 * 24 §6 的三个接缝判据：`MEM-EXTRACT-2` / `MEM-EXTRACT-4` / `RELOAD-1`。
 *
 * ## 为什么放在一个文件里
 *
 * 三条缺口都出在**同一类接缝**上：`extractMemoriesFromSession` 的并发/归属，以及
 * `MemoryService.reload()` 与"在途确认式写入"的先后关系。它们各自都能单独变红，
 * 但共用同一套夹具（fake 端口 + 真实 `LLMEngine` / `MemoryService`），放一起能少踩
 * "每个文件各自伪造一个世界"的坑。
 *
 * ## 每条判据的变异自证（把实现改坏必须变红）
 *
 * - `MEM-EXTRACT-2`：去掉单飞 Map（两条触发各发一次 provider 调用）⇒ 第一次断言 `calls === 1` 红；
 * - `MEM-EXTRACT-2`（取消）：把 `abortSignal` 从 `provider.complete(...)` 里删掉 ⇒
 *   `receivedSignal` 为 undefined / `aborted === false` 红；
 * - `MEM-EXTRACT-4`：把降级改回"拿 cwd/路径临时当 projectId"（任意 `projectIdFromCwd(...)`）⇒
 *   `entries.filter(scope === "project")` 非空 ⇒ 红；
 * - `RELOAD-1`：把 `reload()` 里的 `await this.settlePendingWrites()` 删掉（旧实现先清表再读）⇒
 *   重读后 `svc.get(A/B)` 为 undefined ⇒ 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSettingJSON } from "../core/storage/settings";
import { MemoryService, type MemoryEntry } from "../core/memory/memory";
import { LLMEngine } from "../core/llm/index";
import * as MessageStorage from "../core/storage/message";

const PROJ = "c:\\work\\single-flight";
const SESSION = "s-single-flight";

/** 12 条消息（提取的硬门槛是 ≥10 条） */
function twelveMessages() {
  return Array.from({ length: 12 }, (_, i) => ({
    id: `sf-m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `第 ${i} 条对话内容`,
  }));
}

interface TestEngine {
  engine: LLMEngine;
  /** provider.complete 收到的请求（含 abortSignal） */
  requests: any[];
}

/**
 * 造一个喂 `extractMemoriesFromSession` 的引擎：
 * - `provider.complete` 走**真实**的 `spawnForked`（不 mock 它 —— 单飞/abort 都要经过真实链路）；
 * - profileManager.resolveSlot 指向 test provider（避免落到真实设置）。
 */
function makeEngine(svc: MemoryService, complete: (request: any) => Promise<{ content: string }>): TestEngine {
  setSettingJSON(`memory-enabled-${SESSION}`, true);
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = svc;
  const requests: any[] = [];
  const provider = {
    id: "test",
    name: "test",
    isConfigured: () => true,
    listModels: async () => [],
    fetchModelsFromServer: async () => [],
    complete: async (request: any) => {
      requests.push(request);
      return complete(request);
    },
    async *stream() {
      yield { type: "text_delta", text: "x" };
      yield { type: "end", finishReason: "stop" };
    },
  };
  (engine as unknown as { providers: unknown }).providers = {
    get: () => provider,
    getAll: () => [provider],
  };
  (engine as unknown as { profileManager: unknown }).profileManager = {
    resolveSlot: () => ({ provider: "test", model: "test-model" }),
  };
  vi.spyOn(MessageStorage, "listMessages").mockReturnValue(twelveMessages() as never);
  return { engine, requests };
}

let port: FakeStoragePort;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
  saveMemory("");
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("MEM-EXTRACT-2：同一会话的提取单飞（并发触发只跑一次）", () => {
  it("MEM-EXTRACT-2：两次连续触发 ⇒ 只 1 次 provider 调用（后到者标 dirty、不追发）", async () => {
    const svc = new MemoryService();
    let calls = 0;
    let release!: (payload: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { engine } = makeEngine(svc, async () => {
      calls += 1;
      return { content: await gate };
    });

    const payload = JSON.stringify([
      { key: "并发提取", content: "并发触发只该跑一次 provider 调用（这条内容足够长，能过门槛）", scope: "conversation" },
    ]);
    const first = engine.extractMemoriesFromSession(SESSION, PROJ);
    const second = engine.extractMemoriesFromSession(SESSION, PROJ);

    /* 真实链路的第一跳是同步的（runMemoryExtractionOnce → spawnForked → provider.complete） */
    expect(calls, "第一次触发必须真的发出 provider 调用").toBe(1);
    expect(engine.isMemoryExtractionInFlight(SESSION), "在途表里必须有这个会话").toBe(true);

    release(payload);
    await Promise.all([first, second]);

    expect(calls, "两个并发触发只允许 1 次 provider 调用（旧实现是 2 次）").toBe(1);
    expect(engine.isMemoryExtractionInFlight(SESSION), "收尾后必须从在途表移除（否则会话永远卡住）").toBe(false);
    const written = svc
      .listAll({ includePending: true, includeUnscoped: true, showAllProjects: true })
      .filter((e) => e.content.includes("并发触发只该跑一次"));
    expect(written, "只写一条（不是两批重复写入）").toHaveLength(1);
  });

  it("MEM-EXTRACT-2（关闭会话）：abort 真的传进 provider.complete，且取消后不写批次", async () => {
    const svc = new MemoryService();
    let signal: AbortSignal | undefined;
    const { engine, requests } = makeEngine(
      svc,
      (request) =>
        new Promise((_resolve, reject) => {
          signal = request.abortSignal;
          request.abortSignal?.addEventListener("abort", () => reject(new Error("aborted-by-test")));
        }),
    );

    const running = engine.extractMemoriesFromSession(SESSION, PROJ);
    expect(signal, "abortSignal 必须真的传给 provider（不是只创建 controller 的摆设）").toBeTruthy();
    expect(requests.length).toBe(1);

    expect(engine.cancelMemoryExtraction(SESSION), "有在途任务时必须返回 true").toBe(true);
    expect(signal!.aborted, "取消后 signal 必须已是 aborted").toBe(true);
    await running;

    expect(engine.isMemoryExtractionInFlight(SESSION)).toBe(false);
    expect(
      svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true }),
      "被取消的提取不许留下任何条目/幽灵批次",
    ).toHaveLength(0);
    expect(svc.listBatches(), "finalizeBatch(0) 必须清掉空批次").toHaveLength(0);
  });
});

describe("MEM-EXTRACT-4：无项目身份时不得写孤儿 project 条目", () => {
  const candidate = JSON.stringify([
    { key: "无项目身份", content: "NO_PROJECT_IDENTITY 这条候选本来想写成项目级", scope: "project" },
  ]);

  it("MEM-EXTRACT-4：无 projectId ⇒ 一律 conversation（有 sessionId），且没有 project 条目", async () => {
    const svc = new MemoryService();
    const { engine } = makeEngine(svc, async () => ({ content: candidate }));
    await engine.extractMemoriesFromSession(SESSION); // 刻意不传 projectId

    const all = svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true });
    expect(
      all.filter((e) => e.scope === "project"),
      "无项目身份时**一条 project 条目都不许出现**（旧实现写 projectId:undefined 的孤儿）",
    ).toHaveLength(0);

    const entry = all.find((e) => e.content.includes("NO_PROJECT_IDENTITY")) as MemoryEntry | undefined;
    expect(entry, "内容不许丢：降级后仍要写入").toBeTruthy();
    expect(entry!.scope, "降级为对话级").toBe("conversation");
    expect(entry!.sessionId, "归属当前会话（真的能进本会话上下文）").toBe(SESSION);
    expect(entry!.projectId, "绝不拿 cwd/路径临时当 projectId").toBeUndefined();
    expect(entry!.demotedFrom, "原作用域留痕").toBe("project");
    expect(entry!.demotedReason, "降级原因与积压降级分开记").toBe("no-project-identity");
  });

  it("MEM-EXTRACT-4（反向对照）：有 projectId 时仍写 project 作用域（证明不是'永远降级'）", async () => {
    const svc = new MemoryService();
    const { engine } = makeEngine(svc, async () => ({ content: candidate }));
    await engine.extractMemoriesFromSession(SESSION, PROJ);

    const all = svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true });
    const entry = all.find((e) => e.content.includes("NO_PROJECT_IDENTITY")) as MemoryEntry | undefined;
    expect(entry, "有身份时照常写入").toBeTruthy();
    expect(entry!.scope, "有项目身份 ⇒ 项目级（不是被降级）").toBe("project");
    expect(entry!.projectId).toBe(PROJ);
    expect(entry!.demotedFrom, "没有降级就不许留降级痕迹").toBeUndefined();
  });
});

describe("RELOAD-1：reload 等所有在途写入落定，旧 payload 不会覆盖新值", () => {
  it("RELOAD-1：受控延迟端口下，reload 读到的是最新确认内容（含等待期间新排入的写）", async () => {
    /*
     * 受控延迟：第一次 `memory.set` 卡在 gate 上 —— 此时磁盘还是旧 payload（空串）。
     * 旧 `reload()` 会在这一刻清表并读盘 ⇒ 读回旧快照；新实现先等确认链落定。
     */
    const base = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
    setStoragePort(base);
    saveMemory("");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayedOnce = false;
    const data = {
      ...base.data,
      async execute(command: string, params?: Record<string, unknown>) {
        if (command === "memory.set" && !delayedOnce) {
          delayedOnce = true;
          await gate;
        }
        return base.data.execute(command, params);
      },
      async command<T = Record<string, unknown>>(cmd: string, params?: Record<string, unknown>): Promise<T> {
        return base.data.command<T>(cmd, params);
      },
    };
    const gatedPort = { ...base, data } as FakeStoragePort;
    setStoragePort(gatedPort);

    const svc = new MemoryService();
    const a = svc.add({ scope: "conversation", sessionId: SESSION, key: "旧写入 A", content: "RELOAD1_A 旧 payload 里的内容", source: "manual" });
    const b = svc.add({ scope: "conversation", sessionId: SESSION, key: "旧写入 B", content: "RELOAD1_B 旧 payload 里的内容", source: "manual" });
    expect(a.ok && b.ok).toBe(true);

    const reloading = svc.reload();
    /* 等待期间用户又改了一次（真实形态：面板/提取写入与重读并发） */
    const c = svc.add({ scope: "conversation", sessionId: SESSION, key: "新写入 C", content: "RELOAD1_C 最新确认的内容", source: "manual" });
    expect(c.ok).toBe(true);

    release();
    await reloading;
    await svc.flushPendingPersist();

    expect(svc.get(a.entry!.id), "重读后 A 必须还在（旧 reload 会把它读丢）").toBeTruthy();
    expect(svc.get(b.entry!.id), "重读后 B 必须还在").toBeTruthy();
    expect(svc.get(c.entry!.id), "等待期间新排入的 C 也必须落定后才读——不能读成旧快照").toBeTruthy();
    expect(svc.get(c.entry!.id)!.content).toContain("RELOAD1_C");

    const persisted = String((gatedPort.__table("memory")[0] as { content?: string } | undefined)?.content ?? "");
    expect(persisted, "磁盘上的权威 payload 必须是最新那份").toContain("RELOAD1_C");
    expect(persisted, "旧 payload 不许覆盖新 payload（A/B 也都要在）").toContain("RELOAD1_A");
  });
});

/**
 * 多设备同步：**记忆合并**判据（25 号文 P2）。
 *
 * ## 这组判据守的是"不静默丢"
 *
 * 跨设备同步记忆最危险的实现是"整份覆盖"：谁后写谁赢，另一台设备的条目**无声消失**。
 * 这里用**真** `MemoryService.mergeRemoteForSync`（真 `merge.ts` 判定表）走一遍
 * `sync.memory`，钉住三件事：
 *
 * 1. **不同条目 ⇒ 并集**（宿主有 Z、设备有 Y，合并后两边都在）；
 * 2. **同 id 同 rev 异内容 ⇒ 冲突副本 + 审计**（宿主的版本留着、设备的版本变成
 *    `conflictOf` 副本，`memory-conflicts` 里有一条记录）—— 一条都不能丢；
 * 3. **坏 payload ⇒ 明确拒绝**（不写库、原因回给调用方）。
 *
 * ## 变异自证
 *
 * 把 `mergeRemoteForSync` 换成"直接返回远端 payload"（覆盖语义）⇒ 判据 1、2 同时红
 * （宿主的 Z 消失、冲突副本不存在）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { createProject } from "../core/storage/project";
import { saveMemory, getSettingJSON, readMemoryFresh, setSetting } from "../core/storage/settings";
import { DEFAULT_SYNC_CONFIG, setSyncConfig } from "../core/storage/sync-engine";
import { configureSyncLocalPorts, syncNow, __resetSyncRuntimeForTests } from "../core/storage/sync-engine";
import { createHostSyncApi } from "../core/remote/gateway-sync";
import { createHostSyncPorts } from "../core/remote/gateway-sync-host";
import { gatewayRpcReply, type GatewayDataDeps } from "../core/remote/gateway-engine";
import { MEMORY_CONFLICTS_KEY } from "../core/memory/memory";

const HOST_URL = "http://host.test";

function entry(id: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    key: `key-${id}`,
    content,
    scope: "platform",
    source: "manual",
    status: "active",
    rev: 1,
    timestamp: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    order: 0,
    ...extra,
  };
}

function memoryPayload(entries: Record<string, unknown>): string {
  return JSON.stringify({
    version: 2,
    entries,
    batches: [],
    rejections: [],
    tombstones: [],
  });
}

function parsePayload(payload: string): {
  entries: Record<string, { id: string; content: string; rev: number; conflictOf?: string }>;
} {
  return JSON.parse(payload) as { entries: Record<string, { id: string; content: string; rev: number; conflictOf?: string }> };
}

function hostDeps(): GatewayDataDeps {
  return {
    listSessions: () => [],
    getSession: () => null,
    sendPrompt: async () => ({ ok: false, kind: "ENGINE_UNAVAILABLE", message: "test" }),
    cancelRun: () => ({ ok: false, kind: "RUN_NOT_FOUND", message: "test" }),
    listApprovals: () => [],
    respondApproval: () => ({ ok: false, kind: "NOT_PENDING", message: "test" }),
    workspace: {
      list: async () => ({ path: ".", entries: [] }) as never,
      read: async () => ({}) as never,
      diff: async () => ({}) as never,
      root: async () => null,
    },
    changes: {
      list: async () => ({ supported: false }) as never,
      diff: async () => ({}) as never,
    },
    sync: createHostSyncApi(createHostSyncPorts()),
  };
}

function installFetch(deps: GatewayDataDeps): { calls: string[] } {
  const calls: string[] = [];
  const fake = vi.fn(async (_input: unknown, init?: { body?: string }) => {
    const raw = String(init?.body ?? "{}");
    const request = JSON.parse(raw) as { id?: number; method?: string };
    calls.push(String(request.method ?? ""));
    const reply = await gatewayRpcReply(raw, deps, { deviceId: "dev-client" });
    return { status: 200, ok: true, json: async () => reply };
  });
  vi.stubGlobal("fetch", fake as unknown as typeof fetch);
  return { calls };
}

interface ClientMemory {
  payload: string;
  conflicts: unknown[];
}

function clientPorts(memory: ClientMemory) {
  return {
    listSessionIds: () => [] as string[],
    readEvents: () => [],
    appendEvent: () => 1,
    ensureSession: () => true,
    memory: {
      read: async () => ({ ok: true as const, payload: memory.payload, deviceId: "dev-mem", entries: 0 }),
      merge: async (payload: string) => {
        memory.payload = payload;
        return { ok: true, payload, entries: 0, conflicts: [], changed: true };
      },
      recordConflicts: async (records: readonly unknown[]) => {
        memory.conflicts.push(...records);
        return records.length;
      },
    },
  };
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort() as never);
  __resetSyncRuntimeForTests();
  createProject({ id: "proj-host", name: "host", path: "C:\\host", createdAt: 1, lastAccessedAt: 1 });
  setSetting("codem-device-id", "dev-client");
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSyncRuntimeForTests();
  configureSyncLocalPorts(null);
});

describe("多设备同步：记忆合并", () => {
  it("MEM-SYNC-1: 不同条目并集 + 同 id 同 rev 异内容 ⇒ 冲突副本与审计，两边都不丢", async () => {
    // 宿主现有：X（宿主版本）、Z；设备有：X（设备版本）、Y
    saveMemory(memoryPayload({ X: entry("X", "宿主版本"), Z: entry("Z", "只有宿主有") }));
    const deps = hostDeps();
    const { calls } = installFetch(deps);
    const memory: ClientMemory = {
      payload: memoryPayload({ X: entry("X", "设备版本"), Y: entry("Y", "只有设备有") }),
      conflicts: [],
    };
    configureSyncLocalPorts(clientPorts(memory) as never);
    setSyncConfig({
      ...DEFAULT_SYNC_CONFIG,
      backend: "gateway",
      gatewayUrl: HOST_URL,
      direction: "both",
      autoSync: false,
      syncMemory: true,
    });

    const result = await syncNow();
    expect(result.error).toBeUndefined();
    expect(calls).toContain("sync.memory");
    expect(result.memoryOk).toBe(true);
    expect(result.conflicts).toBeGreaterThanOrEqual(1);

    // 宿主：并集（Y 进来了，Z 还在）
    const hostRead = await readMemoryFresh();
    expect(hostRead.ok).toBe(true);
    const hostEntries = parsePayload(hostRead.data ?? "").entries;
    expect(hostEntries.Y?.content).toBe("只有设备有");
    expect(hostEntries.Z?.content).toBe("只有宿主有");
    // 冲突：宿主的版本留着（rev 抬到 2），设备的版本成了副本
    expect(hostEntries.X?.content).toBe("宿主版本");
    expect(hostEntries.X?.rev).toBeGreaterThan(1);
    const copy = Object.values(hostEntries).find((e) => e.conflictOf === "X");
    expect(copy, "冲突副本必须存在（否则设备那一版就被静默覆盖了）").toBeTruthy();
    expect(copy?.content).toBe("设备版本");

    // 审计：`memory-conflicts` 里有一条 edit-edit
    const audit = getSettingJSON<{ records?: Array<{ id: string; kind: string }> }>(MEMORY_CONFLICTS_KEY, {});
    const records = Array.isArray(audit) ? (audit as unknown as Array<{ id: string; kind: string }>) : audit.records ?? [];
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0].id).toBe("X");
    expect(records[0].kind).toBe("edit-edit");

    // 客户端：收到的是宿主合并结果（Y、Z、X 的副本都在），并把冲突审计带回来了
    const clientEntries = parsePayload(memory.payload).entries;
    expect(clientEntries.Y?.content).toBe("只有设备有");
    expect(clientEntries.Z?.content).toBe("只有宿主有");
    expect(Object.values(clientEntries).some((e) => e.conflictOf === "X")).toBe(true);
    expect(memory.conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it("MEM-SYNC-2: 坏 payload ⇒ 明确拒绝（不写库、原因可见）", async () => {
    saveMemory(memoryPayload({ X: entry("X", "宿主版本") }));
    const deps = hostDeps();
    installFetch(deps);
    const memory: ClientMemory = { payload: "{不是 JSON", conflicts: [] };
    configureSyncLocalPorts(clientPorts(memory) as never);
    setSyncConfig({
      ...DEFAULT_SYNC_CONFIG,
      backend: "gateway",
      gatewayUrl: HOST_URL,
      direction: "both",
      autoSync: false,
      syncMemory: true,
    });

    const result = await syncNow();
    expect(result.memoryOk).toBe(false);
    expect(result.error ?? "").toMatch(/记忆/);
    // 宿主那份一个字节都没被改
    const hostRead = await readMemoryFresh();
    expect(parsePayload(hostRead.data ?? "").entries.X?.content).toBe("宿主版本");
    // 客户端也没被假成功覆盖
    expect(memory.payload).toBe("{不是 JSON");
  });

  it("MEM-SYNC-3: 空 payload 也拒绝（避免把对端记忆清空）", async () => {
    saveMemory(memoryPayload({ X: entry("X", "宿主版本") }));
    const deps = hostDeps();
    installFetch(deps);
    const reply = await gatewayRpcReply(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sync.memory", params: { deviceId: "dev-client", payload: "   " } }),
      deps,
      { deviceId: "dev-client" },
    );
    expect((reply.error as { data: { kind: string } }).data.kind).toBe("INVALID_PARAMS");
    const hostRead = await readMemoryFresh();
    expect(parsePayload(hostRead.data ?? "").entries.X?.content).toBe("宿主版本");
  });
});

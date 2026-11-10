/**
 * 多设备同步：**项目级 ACL**（任务 B）。
 *
 * ## 这组判据守什么
 *
 * 修前：网关只放行「已配对设备」，`deviceId` 只用来防"替别的设备写事件" —— 任何配对的
 * 设备都能拉到**所有项目**的会话、也能把事件推到**任何项目**的会话里。项目隔离只存在于
 * 用户脑子里。
 *
 * 修后：`sync.pull` / `sync.push` / `sync.snapshot` 都带 `projectIds`（空 = 全部），
 * 宿主按 `projectIdOfSession` 过滤；范围外的会话不返回/拒收，**没有项目映射的会话在
 * ACL 非空时也拒绝**（fail-closed：不知道归属就不放行），结果里的 `filteredSessions`
 * 如实计数。
 *
 * ## 变异自证
 *
 * - 忽略 allowlist（宿主不过滤）⇒ ACL-1 / ACL-2 / ACL-3 全红；
 * - 没有项目映射时放行 ⇒ ACL-1b 红（推给不存在会话/空项目）；
 * - 客户端不传 `projectIds` ⇒ ACL-4 红（推 B 项目事件会被宿主收下）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { getEventLog } from "../core/storage/event-log";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import { createMessage } from "../core/storage/message";
import { getSettingJSON, setSetting } from "../core/storage/settings";
import {
  DEFAULT_SYNC_CONFIG,
  __resetSyncRuntimeForTests,
  configureSyncLocalPorts,
  getSyncState,
  setSyncConfig,
  syncNow,
  type SyncConfig,
  type SyncLocalEvent,
  type SyncLocalPorts,
} from "../core/storage/sync-engine";
import { createHostSyncApi } from "../core/remote/gateway-sync";
import { HOST_SYNC_JOURNAL_KEY } from "../core/remote/gateway-sync";
import { createHostSyncPorts } from "../core/remote/gateway-sync-host";
import { gatewayRpcReply, type GatewayDataDeps } from "../core/remote/gateway-engine";
import type { Message } from "../store";

const HOST_URL = "http://host.test";

function seedProjectsAndSessions(): void {
  createProject({ id: "proj-a", name: "项目 A", path: "C:\\a", createdAt: 1, lastAccessedAt: 1 });
  createProject({ id: "proj-b", name: "项目 B", path: "C:\\b", createdAt: 1, lastAccessedAt: 1 });
  for (const [id, projectId] of [["sess-a", "proj-a"], ["sess-b", "proj-b"]] as const) {
    createSession({
      id,
      projectId,
      title: id,
      createdAt: 1,
      lastMessageAt: 1,
      messageCount: 0,
    });
  }
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

function rpc(
  body: Record<string, unknown>,
  deps: GatewayDataDeps,
  deviceId: string,
): Promise<Record<string, unknown>> {
  return gatewayRpcReply(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), deps, { deviceId });
}

function pushBody(params: {
  deviceId: string;
  sessionId: string;
  n?: number;
  projectIds?: string[];
}): Record<string, unknown> {
  const n = params.n ?? 1;
  return {
    method: "sync.push",
    params: {
      deviceId: params.deviceId,
      ...(params.projectIds ? { projectIds: params.projectIds } : {}),
      events: [
        {
          eventId: `${params.deviceId}:${params.sessionId}:${n}`,
          deviceId: params.deviceId,
          sessionId: params.sessionId,
          type: "user_message",
          payload: { text: `事件 ${n}` },
          timestamp: 1_700_000_000_000 + n,
        },
      ],
    },
  };
}

type PushReply = { accepted: number; filteredSessions: number; rejected: Array<{ reason: string }> };
type PullReply = { events: Array<{ sessionId: string }>; filteredSessions: number; resetRequired?: boolean };
type SnapshotReply = { messages: Array<{ id: string }>; filteredSessions: number; total: number };

function journalSessions(): string[] {
  const raw = getSettingJSON<{ entries?: Array<{ sessionId?: string }> }>(HOST_SYNC_JOURNAL_KEY, {});
  return (raw.entries ?? []).map((entry) => String(entry.sessionId ?? ""));
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort() as never);
  __resetSyncRuntimeForTests();
  configureSyncLocalPorts(null);
  setSetting("codem-device-id", "dev-client");
  seedProjectsAndSessions();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSyncRuntimeForTests();
  configureSyncLocalPorts(null);
});

describe("任务 B：宿主按项目 allowlist 过滤", () => {
  it("ACL-1: 只允许项目 A ⇒ 推 B 被拒（project-forbidden）、A 收下", async () => {
    const deps = hostDeps();
    const a = (await rpc(pushBody({ deviceId: "dev-x", sessionId: "sess-a", projectIds: ["proj-a"] }), deps, "dev-x"))
      .result as PushReply;
    expect(a.accepted).toBe(1);
    expect(a.filteredSessions).toBe(0);

    const b = (await rpc(pushBody({ deviceId: "dev-x", sessionId: "sess-b", projectIds: ["proj-a"] }), deps, "dev-x"))
      .result as PushReply;
    expect(b.accepted).toBe(0);
    expect(b.filteredSessions).toBe(1);
    expect(b.rejected[0]?.reason).toBe("project-forbidden");

    // 宿主事件日志里只有 A 项目那一条被写入（拒收的东西一个字节都没落）
    expect(getEventLog().readFrom("sess-a", 0)).toHaveLength(1);
    expect(getEventLog().readFrom("sess-b", 0)).toHaveLength(0);
    expect(journalSessions()).toEqual(["sess-a"]);
  });

  it("ACL-1b: 没有项目映射的会话在 ACL 非空时 fail-closed（推给未知会话也被拒）", async () => {
    const deps = hostDeps();
    const reply = (
      await rpc(
        {
          method: "sync.push",
          params: {
            deviceId: "dev-x",
            projectIds: ["proj-a"],
            events: [
              {
                eventId: "dev-x:sess-unknown:1",
                deviceId: "dev-x",
                sessionId: "sess-unknown",
                type: "user_message",
                payload: { text: "无项目映射" },
                timestamp: 1_700_000_000_100,
              },
            ],
          },
        },
        deps,
        "dev-x",
      )
    ).result as PushReply;
    expect(reply.accepted).toBe(0);
    expect(reply.rejected[0]?.reason).toBe("project-forbidden");
    expect(reply.filteredSessions).toBe(1);
    expect(journalSessions()).toEqual([]);
  });

  it("ACL-2: pull 只返回 allowlist 里的会话，filteredSessions 如实计数；空 allowlist = 全部", async () => {
    const deps = hostDeps();
    // 宿主先收下两个项目各一条（不带范围 = 全部）
    await rpc(pushBody({ deviceId: "dev-host", sessionId: "sess-a" }), deps, "dev-host");
    await rpc(pushBody({ deviceId: "dev-host", sessionId: "sess-b", n: 2 }), deps, "dev-host");

    const scoped = (
      await rpc(
        { method: "sync.pull", params: { deviceId: "dev-a", sinceSeq: 0, projectIds: ["proj-a"] } },
        deps,
        "dev-a",
      )
    ).result as PullReply;
    expect(scoped.resetRequired).toBe(false);
    expect(scoped.events.map((e) => e.sessionId)).toEqual(["sess-a"]);
    expect(scoped.filteredSessions).toBe(1);

    // 换一本账（同一个 deps 读的是同一份设置；清掉账本才能从 0 再拉一次）
    setSetting(HOST_SYNC_JOURNAL_KEY, "");
    await rpc(pushBody({ deviceId: "dev-host", sessionId: "sess-a" }), deps, "dev-host");
    await rpc(pushBody({ deviceId: "dev-host", sessionId: "sess-b", n: 2 }), deps, "dev-host");

    const all = (
      await rpc(
        { method: "sync.pull", params: { deviceId: "dev-b", sinceSeq: 0, projectIds: [] } },
        deps,
        "dev-b",
      )
    ).result as PullReply;
    expect(all.events.map((e) => e.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
    expect(all.filteredSessions).toBe(0);
  });

  it("ACL-3: sync.snapshot 也按 allowlist 过滤（范围外回空 + filteredSessions:1）", async () => {
    const deps = hostDeps();
    const messageA: Message = { id: "msg-a", role: "user", content: "A 的内容", timestamp: 1_700_000_000_001 };
    const messageB: Message = { id: "msg-b", role: "assistant", content: "B 的内容", timestamp: 1_700_000_000_002 };
    createMessage(messageA, "sess-a");
    createMessage(messageB, "sess-b");

    const denied = (
      await rpc(
        {
          method: "sync.snapshot",
          params: { deviceId: "dev-a", sessionId: "sess-b", projectIds: ["proj-a"] },
        },
        deps,
        "dev-a",
      )
    ).result as SnapshotReply;
    expect(denied.filteredSessions).toBe(1);
    expect(denied.messages).toEqual([]);
    expect(denied.total).toBe(0);

    const allowed = (
      await rpc(
        {
          method: "sync.snapshot",
          params: { deviceId: "dev-a", sessionId: "sess-a", projectIds: ["proj-a"] },
        },
        deps,
        "dev-a",
      )
    ).result as SnapshotReply;
    expect(allowed.filteredSessions).toBe(0);
    expect(allowed.messages.map((m) => m.id)).toEqual(["msg-a"]);
  });
});

// ========== 客户端：配置里的 allowlist 真的会传到请求里 ==========

interface ClientStore {
  sessions: Set<string>;
  events: Map<string, SyncLocalEvent[]>;
  seq: number;
}

function createClientStore(withA: boolean, withB: boolean): ClientStore {
  const store: ClientStore = { sessions: new Set(), events: new Map(), seq: 0 };
  for (const id of [withA ? "sess-a" : "", withB ? "sess-b" : ""]) {
    if (!id) continue;
    store.sessions.add(id);
    const event: SyncLocalEvent = {
      seq: ++store.seq,
      sessionId: id,
      type: "user_message",
      payload: { text: `来自客户端的 ${id}` },
      timestamp: 1_700_000_000_500 + store.seq,
    };
    store.events.set(id, [event]);
  }
  return store;
}

function clientPorts(store: ClientStore, projectOf: Record<string, string>): SyncLocalPorts {
  return {
    listSessionIds: () => [...store.events.keys()],
    readEvents: (sessionId, fromSeq) => (store.events.get(sessionId) ?? []).filter((e) => e.seq >= fromSeq),
    appendEvent: (sessionId, _type, _payload) => {
      store.sessions.add(sessionId);
      const event: SyncLocalEvent = { seq: ++store.seq, sessionId, type: "user_message", payload: {}, timestamp: Date.now() };
      const list = store.events.get(sessionId) ?? [];
      list.push(event);
      store.events.set(sessionId, list);
      return event.seq;
    },
    ensureSession: (sessionId) => {
      store.sessions.add(sessionId);
      return true;
    },
    projectIdOfSession: (sessionId) => projectOf[sessionId] ?? null,
    memory: {
      read: async () => ({ ok: true as const, payload: "", deviceId: "dev-client", entries: 0 }),
      merge: async (payload: string) => ({ ok: true, payload, entries: 0, conflicts: [], changed: false }),
      recordConflicts: async () => 0,
    },
  };
}

function gatewayConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    ...DEFAULT_SYNC_CONFIG,
    backend: "gateway",
    gatewayUrl: HOST_URL,
    autoSync: false,
    direction: "both",
    syncMemory: false,
    ...overrides,
  };
}

function installFetch(deps: GatewayDataDeps): { calls: string[] } {
  const calls: string[] = [];
  const fake = vi.fn(async (_input: unknown, init?: { body?: string }) => {
    const raw = String(init?.body ?? "{}");
    const method = (JSON.parse(raw) as { method?: string }).method ?? "";
    calls.push(method);
    const reply = await gatewayRpcReply(raw, deps, { deviceId: "dev-client" });
    return { status: 200, ok: true, json: async () => reply };
  });
  vi.stubGlobal("fetch", fake as unknown as typeof fetch);
  return { calls };
}

describe("任务 B：客户端 allowlist（配置 → 协议 → 宿主）", () => {
  it("ACL-4: 客户端设置只允许项目 A ⇒ 推 B 不再发出、拉 B 收不到，且状态里能看到过滤计数", async () => {
    const deps = hostDeps();
    // 宿主先有两项目各一条事件（来自另一台设备）
    await rpc(pushBody({ deviceId: "dev-host", sessionId: "sess-a", n: 10 }), deps, "dev-host");
    await rpc(pushBody({ deviceId: "dev-host", sessionId: "sess-b", n: 11 }), deps, "dev-host");
    installFetch(deps);

    // 1) 拉：只允许 A
    configureSyncLocalPorts(
      clientPorts(createClientStore(false, false), { "sess-a": "proj-a", "sess-b": "proj-b" }),
    );
    setSyncConfig(gatewayConfig({ direction: "pull", projectIds: ["proj-a"] }));
    const pulled = await syncNow();
    expect(pulled.error).toBeUndefined();
    expect(pulled.pulled).toBe(1);
    expect(getSyncState().lastFilteredSessions).toBe(1);

    // 2) 推：本机有 A、B 两个会话，只允许 A ⇒ 只能推 1 条，B 被本地筛掉
    const store = createClientStore(true, true);
    configureSyncLocalPorts(clientPorts(store, { "sess-a": "proj-a", "sess-b": "proj-b" }));
    setSetting("codem-sync-state", "");
    setSyncConfig(gatewayConfig({ direction: "push", projectIds: ["proj-a"] }));
    const pushed = await syncNow();
    expect(pushed.error).toBeUndefined();
    expect(pushed.pushed).toBe(1);
    expect(getSyncState().lastProjectSkipped).toBe(1);

    // 宿主账本里：B 项目只有 dev-host 那一条（客户端那条从未到达）
    const bEvents = getEventLog().readFrom("sess-b", 0);
    expect(bEvents).toHaveLength(1);
    expect((bEvents[0].payload as Record<string, unknown>).__sync).toMatchObject({ deviceId: "dev-host" });
  });
});

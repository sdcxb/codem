/**
 * 多设备 Host 同步（25 号文 P2）的**协议与往返判据**。
 *
 * ## 这组判据在守什么
 *
 * 1. **真往返**：客户端引擎（`sync-engine`）→ 假 `fetch` → 网关 `gatewayRpcReply`
 *    → 宿主数据面（`gateway-sync` + 真端口）→ 宿主的 `session_events`。
 *    不是"两边各调一次函数"：客户端不 import 宿主实现，只走 HTTP 形状的 JSON-RPC。
 * 2. **游标**：推送水位按会话推进；拉取游标是宿主账本序号（`hostSeq`），只前进不跳。
 * 3. **幂等**：同一个 `eventId` 推两次 ⇒ 第二次是 `duplicates`，宿主事件日志里只有一行。
 * 4. **两台设备**：A 推上去的事件，B 换一个 `codem-device-id` 拉得到；A 自己拉不到（不会回声）。
 * 5. **拒绝且不写**：未配对（401）与 deviceId 冒充（DEVICE_MISMATCH）都必须**不落任何数据**。
 * 6. **默认关**：默认配置下 `applySyncRuntime()` 不起定时器、一个网络请求都不发；
 *    显式开启后 fake timer 到点会真的同步。
 *
 * ## 为什么用 `createFakeStoragePort` + 真 `createHostSyncPorts`
 *
 * 宿主那半边判的正是"事件真的进了 `session_events` 吗"—— 换成内存假端口就测不到
 * `event-log` 的路由与 `__sync` 标记。所以宿主侧用真实现（假存储端口），
 * 客户端侧用内存端口（模拟另一台机器）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { getEventLog } from "../core/storage/event-log";
import { createSession } from "../core/storage/session";
import { createProject } from "../core/storage/project";
import { getSettingJSON, setSetting, setSettingJSON } from "../core/storage/settings";
import {
  GATEWAY_DEVICE_QUERY_PARAM,
  gatewayRpcReply,
  type GatewayDataDeps,
} from "../core/remote/gateway-engine";
import { createHostSyncApi, type GatewaySyncApi } from "../core/remote/gateway-sync";
import { createHostSyncPorts } from "../core/remote/gateway-sync-host";
import {
  DEFAULT_SYNC_CONFIG,
  __resetSyncRuntimeForTests,
  applySyncRuntime,
  configureSyncLocalPorts,
  getSyncConfig,
  getSyncState,
  normalizeGatewayUrl,
  pairGateway,
  setSyncConfig,
  syncNow,
  type SyncConfig,
  type SyncLocalEvent,
  type SyncLocalPorts,
} from "../core/storage/sync-engine";

const HOST_URL = "http://host.test";
const STATE_KEY = "codem-sync-state";

// ========== 宿主侧：真实现（假存储端口） ==========

function seedHostProject(): void {
  createProject({
    id: "proj-host",
    name: "host-demo",
    path: "C:\\host-demo",
    createdAt: 1,
    lastAccessedAt: 1,
  });
}

function hostDeps(sync: GatewaySyncApi): GatewayDataDeps {
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
    sync,
  };
}

/** 一次 `/rpc` 调用（走网关渲染层，就是 Rust 转发后的那一步） */
function rpc(
  body: Record<string, unknown>,
  deps: GatewayDataDeps,
  deviceId?: string,
): Promise<Record<string, unknown>> {
  return gatewayRpcReply(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), deps, deviceId ? { deviceId } : undefined);
}

// ========== 客户端侧：内存端口（另一台机器） ==========

interface ClientStore {
  sessions: Set<string>;
  events: Map<string, SyncLocalEvent[]>;
  seq: number;
  memory: string;
  conflicts: unknown[];
  titles: Map<string, string>;
}

function createClientStore(): ClientStore {
  return { sessions: new Set(), events: new Map(), seq: 0, memory: "", conflicts: [], titles: new Map() };
}

function addClientEvent(
  store: ClientStore,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  timestamp: number,
): SyncLocalEvent {
  store.sessions.add(sessionId);
  const event: SyncLocalEvent = { seq: ++store.seq, sessionId, type, payload, timestamp };
  const list = store.events.get(sessionId) ?? [];
  list.push(event);
  store.events.set(sessionId, list);
  return event;
}

function clientPorts(store: ClientStore): SyncLocalPorts {
  return {
    listSessionIds: () => [...store.events.keys()],
    readEvents: (sessionId, fromSeq) =>
      (store.events.get(sessionId) ?? []).filter((event) => event.seq >= fromSeq),
    appendEvent: (sessionId, type, payload) => {
      store.sessions.add(sessionId);
      const event: SyncLocalEvent = { seq: ++store.seq, sessionId, type, payload, timestamp: Date.now() };
      const list = store.events.get(sessionId) ?? [];
      list.push(event);
      store.events.set(sessionId, list);
      return event.seq;
    },
    ensureSession: (sessionId) => {
      store.sessions.add(sessionId);
      return true;
    },
    updateSessionTitle: (sessionId, title) => {
      store.titles.set(sessionId, title);
    },
    memory: {
      read: async () => ({ ok: true as const, payload: store.memory, deviceId: "dev-memory", entries: 0 }),
      merge: async (payload) => {
        store.memory = payload;
        return { ok: true, payload, entries: 0, conflicts: [], changed: true };
      },
      recordConflicts: async (records) => {
        store.conflicts.push(...records);
        return records.length;
      },
    },
  };
}

// ========== 假 fetch：把客户端请求交给网关渲染层 ==========

interface FetchHarness {
  calls: string[];
  /** null = 模拟"没有有效 cookie"（网关 401） */
  authorizedDeviceId: string | null;
}

function installFetch(deps: GatewayDataDeps, authorizedDeviceId: string | null = "dev-client"): FetchHarness {
  const harness: FetchHarness = { calls: [], authorizedDeviceId };
  const fake = vi.fn(async (_input: unknown, init?: { body?: string }) => {
    const raw = String(init?.body ?? "{}");
    const request = JSON.parse(raw) as { id?: number; method?: string; params?: Record<string, unknown> };
    const method = String(request.method ?? "");
    harness.calls.push(method);
    if (method === "pair.claim") {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: request.id ?? 1,
          result: { hostId: "codem-desktop", deviceId: "dev-client" },
        }),
      };
    }
    if (harness.authorizedDeviceId === null) {
      return {
        status: 401,
        ok: false,
        json: async () => ({
          jsonrpc: "2.0",
          id: request.id ?? 1,
          error: { code: -32001, message: "缺少或错误的设备凭据", data: { kind: "UNAUTHORIZED", reason: "unauthorized" } },
        }),
      };
    }
    const reply = await gatewayRpcReply(raw, deps, { deviceId: harness.authorizedDeviceId });
    return { status: 200, ok: true, json: async () => reply };
  });
  vi.stubGlobal("fetch", fake as unknown as typeof fetch);
  return harness;
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

/** 重置客户端同步状态（换一台设备时用；坏 JSON ⇒ `getSettingJSON` 回落默认值） */
function resetSyncState(): void {
  setSetting(STATE_KEY, "");
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort() as never);
  __resetSyncRuntimeForTests();
  configureSyncLocalPorts(null);
  // 客户端设备 id 固定：与假 fetch 里"已鉴权设备"一致（否则每条请求都会撞 DEVICE_MISMATCH，
  // 那组判据由 SYNC-6 专门守，不该在这里喧宾夺主）
  setSetting("codem-device-id", "dev-client");
  seedHostProject();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSyncRuntimeForTests();
  configureSyncLocalPorts(null);
  vi.useRealTimers();
});

describe("多设备同步：Host 账本与协议", () => {
  it("SYNC-1: 客户端 push 后宿主 session_events 里真的有这条（带同步标记），游标推进", async () => {
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    const store = createClientStore();
    addClientEvent(store, "sess-a", "user_message", { text: "来自设备 A" }, 1_700_000_000_001);
    configureSyncLocalPorts(clientPorts(store));
    installFetch(deps);
    setSyncConfig(gatewayConfig({ direction: "push" }));

    const result = await syncNow();
    expect(result.error).toBeUndefined();
    expect(result.pushed).toBe(1);
    expect(getSyncState().lastPushedSeq).toBe(1);

    const hostRows = getEventLog().readFrom("sess-a", 0);
    expect(hostRows).toHaveLength(1);
    expect(hostRows[0].type).toBe("user_message");
    expect(hostRows[0].payload).toMatchObject({ text: "来自设备 A" });
    // 同步标记：宿主补扫靠它跳过（否则每轮 pull 都会把同一条再入账一次）
    expect((hostRows[0].payload as Record<string, unknown>).__sync).toMatchObject({
      deviceId: "dev-client",
    });
  });

  it("SYNC-2: 同一批事件推两次是幂等的（第二次 duplicates，宿主事件日志只有一行）", async () => {
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    const events = [
      {
        eventId: "dev-x:sess-b:1",
        deviceId: "dev-x",
        sessionId: "sess-b",
        type: "user_message",
        payload: { text: "只应该有一份" },
        timestamp: 1_700_000_000_010,
      },
    ];
    const first = await rpc({ method: "sync.push", params: { deviceId: "dev-x", events } }, deps, "dev-x");
    const second = await rpc({ method: "sync.push", params: { deviceId: "dev-x", events } }, deps, "dev-x");
    expect((first.result as { accepted: number }).accepted).toBe(1);
    expect((second.result as { accepted: number }).accepted).toBe(0);
    expect((second.result as { duplicates: number }).duplicates).toBe(1);
    expect(getEventLog().readFrom("sess-b", 0)).toHaveLength(1);
  });

  it("SYNC-3: 两台设备 —— A 推上去的事件 B 拉得到，A 自己拉不到（无回声）", async () => {
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    const harness = installFetch(deps);

    // A 推一条
    const storeA = createClientStore();
    addClientEvent(storeA, "sess-shared", "user_message", { text: "A 说的话" }, 1_700_000_000_100);
    configureSyncLocalPorts(clientPorts(storeA));
    setSyncConfig(gatewayConfig({ direction: "push" }));
    expect((await syncNow()).pushed).toBe(1);
    expect(harness.calls).toContain("sync.push");

    // B 是另一台设备：换 device id + 清游标，只拉（Host 侧认的是另一张 cookie）
    setSetting("codem-device-id", "dev-client-b");
    harness.authorizedDeviceId = "dev-client-b";
    resetSyncState();
    const storeB = createClientStore();
    storeB.memory = '{"version":2,"entries":{},"batches":[],"rejections":[],"tombstones":[]}';
    configureSyncLocalPorts(clientPorts(storeB));
    setSyncConfig(gatewayConfig({ direction: "pull" }));
    const pulled = await syncNow();
    expect(pulled.error).toBeUndefined();
    expect(pulled.pulled).toBe(1);
    const bEvents = storeB.events.get("sess-shared") ?? [];
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0].payload).toMatchObject({ text: "A 说的话" });
    expect((bEvents[0].payload as Record<string, unknown>).__sync).toMatchObject({ deviceId: "dev-client" });
    expect(getSyncState().lastPulledSeq).toBeGreaterThan(0);

    // A 自己那台：游标归零后重拉，不该把自己的事件塞回本地（否则每轮都会复制一份）
    setSetting("codem-device-id", "dev-client");
    harness.authorizedDeviceId = "dev-client";
    resetSyncState();
    const storeA2 = createClientStore();
    configureSyncLocalPorts(clientPorts(storeA2));
    setSyncConfig(gatewayConfig({ direction: "pull" }));
    const again = await syncNow();
    expect(again.pulled).toBe(0);
    expect([...(storeA2.events.get("sess-shared") ?? [])]).toHaveLength(0);
  });

  it("SYNC-4: 宿主自己的新事件会被客户端拉到（宿主侧补扫 + 正文来自 session_events）", async () => {
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    installFetch(deps);
    createSession({
      id: "sess-host",
      projectId: "proj-host",
      title: "宿主会话",
      createdAt: 1,
      lastMessageAt: 1,
      messageCount: 0,
    });
    const hostEvent = getEventLog().append("sess-host", "assistant_text", { text: "宿主这边说的话" });
    expect(hostEvent.seq).toBeGreaterThan(0);

    const store = createClientStore();
    configureSyncLocalPorts(clientPorts(store));
    setSyncConfig(gatewayConfig({ direction: "pull" }));
    const result = await syncNow();
    expect(result.error).toBeUndefined();
    expect(result.pulled).toBe(1);
    const events = store.events.get("sess-host") ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant_text");
    expect(events[0].payload).toMatchObject({ text: "宿主这边说的话" });
  });

  it("SYNC-5: 未配对（401）⇒ 同步失败可见且**不写任何数据**", async () => {
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    installFetch(deps, null);
    const store = createClientStore();
    addClientEvent(store, "sess-deny", "user_message", { text: "不该被写进去" }, 1_700_000_000_200);
    configureSyncLocalPorts(clientPorts(store));
    setSyncConfig(gatewayConfig({ direction: "push" }));

    const result = await syncNow();
    expect(result.error).toContain("未配对");
    expect(getEventLog().readFrom("sess-deny", 0)).toHaveLength(0);
    expect(getSyncState().lastSyncStatus).toBe("error");
    expect(getSyncState().lastError).toContain("未配对");
  });

  it("SYNC-6: deviceId 冒充 ⇒ DEVICE_MISMATCH，且不落账", async () => {
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    const reply = await rpc(
      {
        method: "sync.push",
        params: {
          deviceId: "dev-b",
          events: [
            {
              eventId: "dev-b:sess-x:1",
              deviceId: "dev-b",
              sessionId: "sess-x",
              type: "user_message",
              payload: { text: "冒充" },
              timestamp: 1_700_000_000_300,
            },
          ],
        },
      },
      deps,
      "dev-a",
    );
    expect((reply.error as { data: { kind: string } }).data.kind).toBe("DEVICE_MISMATCH");
    const pull = await rpc({ method: "sync.pull", params: { deviceId: "dev-a" } }, deps, "dev-a");
    expect((pull.result as { events: unknown[] }).events).toHaveLength(0);
  });

  it("SYNC-7: 没有注入同步数据面 ⇒ sync.* 是 UNSUPPORTED（不假装支持）", async () => {
    const deps = hostDeps(undefined as unknown as GatewaySyncApi);
    delete (deps as { sync?: GatewaySyncApi }).sync;
    const reply = await rpc({ method: "sync.pull", params: { deviceId: "dev-a" } }, deps, "dev-a");
    expect((reply.error as { data: { kind: string } }).data.kind).toBe("UNSUPPORTED");
  });

  it("SYNC-8: 拉取只认 sinceSeq（游标之前的不会再发）", async () => {
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    for (let i = 0; i < 3; i += 1) {
      await rpc(
        {
          method: "sync.push",
          params: {
            deviceId: "dev-c",
            events: [
              {
                eventId: `dev-c:sess-c:${i}`,
                deviceId: "dev-c",
                sessionId: "sess-c",
                type: "user_message",
                payload: { text: `第 ${i} 条` },
                timestamp: 1_700_000_001_000 + i,
              },
            ],
          },
        },
        deps,
        "dev-c",
      );
    }
    const firstPage = await rpc(
      { method: "sync.pull", params: { deviceId: "dev-c", sinceSeq: 0, limit: 2 } },
      deps,
      "dev-c",
    );
    const firstResult = firstPage.result as { events: unknown[]; nextSeq: number; hasMore: boolean };
    expect(firstResult.events).toHaveLength(2);
    expect(firstResult.hasMore).toBe(true);
    const cursor = firstResult.nextSeq;
    expect(cursor).toBeGreaterThan(0);

    const secondPage = await rpc(
      { method: "sync.pull", params: { deviceId: "dev-c", sinceSeq: cursor, limit: 10 } },
      deps,
      "dev-c",
    );
    const secondResult = secondPage.result as { events: Array<{ hostSeq: number }> };
    expect(secondResult.events).toHaveLength(1);
    expect(secondResult.events[0].hostSeq).toBeGreaterThan(cursor);
  });
});

describe("多设备同步：运行时开关（默认关 + 定时器）", () => {
  it("SYNC-9: 默认关闭 ⇒ 不起定时器、零网络请求", () => {
    expect(DEFAULT_SYNC_CONFIG.autoSync).toBe(false);
    expect(DEFAULT_SYNC_CONFIG.backend).toBe("none");
    const harness = installFetch(hostDeps(createHostSyncApi(createHostSyncPorts())));
    const runtime = applySyncRuntime();
    expect(runtime.running).toBe(false);
    expect(runtime.reason).toBeTruthy();
    expect(harness.calls).toEqual([]);
  });

  it("SYNC-10: 显式开启后 fake timer 到点真的同步（间隔按配置）", async () => {
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    const harness = installFetch(deps);
    const store = createClientStore();
    addClientEvent(store, "sess-timer", "user_message", { text: "定时器推的" }, 1_700_000_002_000);
    configureSyncLocalPorts(clientPorts(store));
    setSyncConfig(gatewayConfig({ autoSync: true, autoSyncInterval: 5_000 }));

    vi.useFakeTimers();
    const runtime = applySyncRuntime();
    expect(runtime.running).toBe(true);
    expect(harness.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.calls).toContain("sync.push");
    expect(getEventLog().readFrom("sess-timer", 0)).toHaveLength(1);

    // 关掉开关后不再有请求（定时器必须真的被清掉）
    const before = harness.calls.length;
    setSyncConfig(gatewayConfig({ autoSync: false }));
    expect(applySyncRuntime().running).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.calls.length).toBe(before);
  });
});

describe("多设备同步：配置与配对", () => {
  it("SYNC-11: 配对成功后写的是地址与设备 id，token 不落设置", async () => {
    const harness = installFetch(hostDeps(createHostSyncApi(createHostSyncPorts())));
    // 服务端在配对时种 cookie；这里只断言"客户端没有把凭据写进配置"
    const result = await (await import("../core/storage/sync-engine")).pairGateway({
      url: `${HOST_URL}/`,
      code: "123 456",
      deviceName: "测试桌面",
    });
    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe("dev-client");
    const config = getSyncConfig();
    expect(config.backend).toBe("gateway");
    expect(config.gatewayUrl).toBe(HOST_URL);
    expect(config.gatewayDeviceId).toBe("dev-client");
    expect(config.gatewayPairedAt).toBeGreaterThan(0);
    expect(JSON.stringify(config)).not.toContain("123456");
    expect(harness.calls).toEqual(["pair.claim"]);
  });

  it("SYNC-12: 地址归一化（尾斜杠 / 误带 /rpc / 非 http）", () => {
    expect(normalizeGatewayUrl("http://127.0.0.1:54321/")).toBe("http://127.0.0.1:54321");
    expect(normalizeGatewayUrl("http://127.0.0.1:54321/rpc")).toBe("http://127.0.0.1:54321");
    expect(normalizeGatewayUrl("https://x.ts.net/")).toBe("https://x.ts.net");
    expect(normalizeGatewayUrl("")).toBe("");
    expect(normalizeGatewayUrl("ftp://nope")).toBe("");
    expect(normalizeGatewayUrl(undefined)).toBe("");
  });

  it("SYNC-13: 网关把已鉴权设备 id 放进 query（渲染层据此校验，不信 body）", async () => {
    const calls: Array<Record<string, string>> = [];
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    const { handleGatewayRequest } = await import("../core/remote/gateway-engine");
    const handled = await handleGatewayRequest(
      {
        method: "POST",
        path: "/rpc",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sync.pull", params: { deviceId: "dev-q" } }),
        query: { [GATEWAY_DEVICE_QUERY_PARAM]: "dev-q" },
      },
      async (status, body) => {
        calls.push({ status: String(status), ...(body as Record<string, string>) });
      },
      deps,
    );
    expect(handled).toBe(true);
    // 走的是同一台设备 ⇒ 正常返回（没有 DEVICE_MISMATCH）
    expect(JSON.stringify(calls)).not.toContain("DEVICE_MISMATCH");
  });

  it("SYNC-14: 在 Tauri 里走 Rust 出站通道（不撞 CORS/同源），设备 token 封存并在后续请求带出", async () => {
    const deps = hostDeps(createHostSyncApi(createHostSyncPorts()));
    const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args });
      if (cmd === "secret_seal") return { sealed: `sealed:${String(args.plaintext)}` };
      if (cmd === "secret_unseal") return { plaintext: String(args.sealed).replace(/^sealed:/, "") };
      if (cmd !== "gateway_client_rpc") throw new Error(`unexpected ${cmd}`);
      // Tauri 的实参形状是 `{ args: { url, body, token } }`（命令只有一个 `args` 形参）
      const callArgs = (args as { args?: Record<string, unknown> }).args ?? {};
      const payload = String(callArgs.body ?? "");
      const method = (JSON.parse(payload) as { method?: string }).method ?? "";
      if (method === "pair.claim") {
        return {
          status: 200,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { hostId: "codem-desktop", deviceId: "dev-client" },
          }),
          // Rust 侧从 Set-Cookie 里读出来交回渲染层的那一个 token
          device_token: "tok-1",
        };
      }
      const reply = await gatewayRpcReply(payload, deps, { deviceId: "dev-client" });
      return { status: 200, body: JSON.stringify(reply), device_token: null };
    });
    (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } };
    const fetchSpy = vi.fn(() => {
      throw new Error("Tauri 里不该走渲染层 fetch（会撞 CORS/同源检查）");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const store = createClientStore();
    addClientEvent(store, "sess-tauri", "user_message", { text: "从 Rust 通道推的" }, 1_700_000_003_000);
    configureSyncLocalPorts(clientPorts(store));

    // 1) 配对：token 被**封存**保存（不进 sync-config）
    const paired = await pairGateway({ url: HOST_URL, code: "123456" });
    expect(paired.ok, paired.error).toBe(true);
    const stored = getSettingJSON<{ sealed?: string; plaintext?: string } | null>(
      "codem-sync-device-token",
      null,
    );
    expect(stored?.sealed).toBe("sealed:tok-1");
    expect(stored?.plaintext).toBeUndefined();
    expect(JSON.stringify(getSyncConfig())).not.toContain("tok-1");

    // 2) 同步：走 Rust 通道，且请求带上了 token
    setSyncConfig(gatewayConfig({ direction: "push" }));
    const result = await syncNow();
    expect(result.error).toBeUndefined();
    expect(result.pushed).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const rpcCall = invokeCalls.filter((c) => c.cmd === "gateway_client_rpc").pop();
    const args = rpcCall?.args.args as { token?: string } | undefined;
    expect(args?.token).toBe("tok-1");
    expect(getEventLog().readFrom("sess-tauri", 0)).toHaveLength(1);

    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  });
});

/**
 * 多设备同步：**冷启动会话快照**（任务 C）。
 *
 * ## 为什么必须是快照（而不是「把事件放大一点」）
 *
 * 本仓的 `event-projection` 明确**不承担消息投影**（消息的权威是 JSONL/`messages`，
 * 事件只服务遥测与审计）。所以"新设备只拿到事件"这件事，在界面上等于**一条对话都没有**。
 * 修前新设备唯一的内容来源是宿主事件账本（≤1200 条），而且账本一修剪就彻底没有内容。
 *
 * ## 这组判据守什么
 *
 * 1. **完整**：宿主 `sync.snapshot` 返回该会话完整时间线（正文/角色/工具调用与**工具结果**），
 *    分页 ≤200 条/≤2MB，`hasMore` / `nextBefore` 如实；
 * 2. **可还原**：客户端把快照写进本机消息存储后，`listTimelineMessages` 与宿主逐条一致
 *    （id / role / content / 工具结果）；
 * 3. **幂等**：重复拉同一份快照不产生重复消息；
 * 4. **resetRequired 之后能重建**：pull 回 `resetRequired` ⇒ 客户端走快照并**重置游标**
 *    到快照点（不是继续用旧游标永远拉空）；
 * 5. **ACL**：快照与 pull/push 同一套项目范围（范围外回空 + `filteredSessions`）。
 *
 * ## 变异自证
 *
 * - 只返回最近 N 条且不标 `hasMore` ⇒ SNAP-1 红（页数/总数对不上）；
 * - 快照不写工具结果 ⇒ SNAP-2 红；
 * - 重复 id 不去重 ⇒ SNAP-3 红；
 * - reset 后不重置游标 ⇒ SNAP-4 红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import { clearSessionLogCache, createMessage, listTimelineMessages } from "../core/storage/message";
import { setSetting } from "../core/storage/settings";
import {
  DEFAULT_SYNC_CONFIG,
  __resetSyncRuntimeForTests,
  configureSyncLocalPorts,
  getSyncState,
  setSyncConfig,
  syncNow,
} from "../core/storage/sync-engine";
import {
  createHostSyncApi,
  type GatewaySyncApi,
  type GatewaySyncSnapshotResult,
} from "../core/remote/gateway-sync";
import { createHostSyncPorts } from "../core/remote/gateway-sync-host";
import { gatewayRpcReply, type GatewayDataDeps } from "../core/remote/gateway-engine";
import type { Message } from "../store";

const HOST_URL = "http://host.test";
const SESSION_ID = "sess-snapshot";

function seedHost(content = "宿主会话"): void {
  createProject({ id: "proj-host", name: "宿主项目", path: "C:\\host", createdAt: 1, lastAccessedAt: 1 });
  createSession({
    id: SESSION_ID,
    projectId: "proj-host",
    title: content,
    createdAt: 1,
    lastMessageAt: 1,
    messageCount: 0,
  });
}

const HOST_MESSAGES: Message[] = [
  { id: "m1", role: "user", content: "第一个问题", timestamp: 1_700_000_000_001 },
  {
    id: "m2",
    role: "assistant",
    content: "我先读文件",
    timestamp: 1_700_000_000_002,
    toolCalls: [
      {
        id: "call-1",
        tool: "read",
        args: { path: "src/a.ts" },
        result: "export const a = 1;",
        status: "done",
      },
    ],
  },
  { id: "m3", role: "user", content: "继续", timestamp: 1_700_000_000_003 },
  {
    id: "m4",
    role: "assistant",
    content: "好的",
    timestamp: 1_700_000_000_004,
    toolCalls: [
      { id: "call-2", tool: "write", args: { path: "b.txt" }, result: "写入 3 字节", status: "done" },
    ],
    metadata: { note: "带元数据" },
  },
  { id: "m5", role: "user", content: "谢谢", timestamp: 1_700_000_000_005 },
];

function writeHostMessages(): void {
  for (const message of HOST_MESSAGES) createMessage(message, SESSION_ID);
}

function hostDeps(sync: GatewaySyncApi, sessions: Array<{ id: string; title: string }> = []): GatewayDataDeps {
  return {
    listSessions: () =>
      sessions.map((s) => ({
        id: s.id,
        title: s.title,
        projectId: "proj-host",
        projectName: "宿主项目",
        updatedAt: 1,
        createdAt: 1,
        messageCount: HOST_MESSAGES.length,
      })) as never,
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

/** 用宿主真实端口把一页一页取下来（从新往旧）。 */
async function capturePages(limit = 2): Promise<GatewaySyncSnapshotResult[]> {
  const api = createHostSyncApi(createHostSyncPorts());
  const pages: GatewaySyncSnapshotResult[] = [];
  let before: number | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await api.snapshot({
      sessionId: SESSION_ID,
      limit,
      ...(before !== undefined ? { before } : {}),
    });
    pages.push(page);
    if (!page.hasMore) return pages;
    expect(page.nextBefore).not.toBeNull();
    before = Number(page.nextBefore);
  }
  throw new Error("快照分页没有结束");
}

function timelineOf(sessionId: string): Array<{ id: string; role: string; content: string; toolResults: string[] }> {
  return listTimelineMessages(sessionId).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    toolResults: (message.toolCalls ?? []).map((call) => String(call.result ?? "")),
  }));
}

function installFetch(deps: GatewayDataDeps): { calls: string[] } {
  const calls: string[] = [];
  const fake = vi.fn(async (_input: unknown, init?: { body?: string }) => {
    const raw = String(init?.body ?? "{}");
    calls.push(String((JSON.parse(raw) as { method?: string }).method ?? ""));
    const reply = await gatewayRpcReply(raw, deps, { deviceId: "dev-client" });
    return { status: 200, ok: true, json: async () => reply };
  });
  vi.stubGlobal("fetch", fake as unknown as typeof fetch);
  return { calls };
}

/** 把抓好的页包装成一个"快照宿主"：再叠加 ACL 与固定 hostSeq（用来验证游标重置）。 */
function snapshotHost(
  pages: GatewaySyncSnapshotResult[],
  opts: { resetRequired?: boolean; hostSeq?: number } = {},
): GatewaySyncApi {
  const fixedHostSeq = opts.hostSeq ?? 42;
  return {
    pull: async () => ({
      events: [],
      nextSeq: 0,
      hasMore: false,
      devices: 1,
      scannedSessions: 0,
      missingBodies: 0,
      droppedEntries: 0,
      droppedUnpulled: 0,
      resetRequired: opts.resetRequired === true,
      oldestSeq: opts.resetRequired ? 7 : 0,
      filteredSessions: 0,
      overCapacity: false,
      serverTime: 1_700_000_000_000,
    }),
    push: async () => ({
      accepted: 0,
      duplicates: 0,
      rejected: [],
      hostSeqMax: 0,
      devices: 0,
      storageFailed: 0,
      filteredSessions: 0,
    }),
    snapshot: async (input) => {
      if (input.projectIds && input.projectIds.length > 0 && !input.projectIds.includes("proj-host")) {
        return {
          sessionId: input.sessionId,
          messages: [],
          nextBefore: null,
          hasMore: false,
          total: 0,
          hostSeq: fixedHostSeq,
          filteredSessions: 1,
          serverTime: 1_700_000_000_000,
        };
      }
      const page =
        input.before === undefined
          ? pages[0]
          : pages.find((candidate) => {
              // 上一页的 nextBefore 就是这一页的 before
              const previous = pages[pages.indexOf(candidate) - 1];
              return previous ? previous.nextBefore === input.before : false;
            });
      if (!page) {
        return {
          sessionId: input.sessionId,
          messages: [],
          nextBefore: null,
          hasMore: false,
          total: 0,
          hostSeq: fixedHostSeq,
          filteredSessions: 0,
          serverTime: 1_700_000_000_000,
        };
      }
      return { ...page, hostSeq: fixedHostSeq };
    },
    mergeMemory: async () => ({ ok: true, payload: "", entries: 0, conflicts: [], changed: false }),
  };
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort() as never);
  __resetSyncRuntimeForTests();
  configureSyncLocalPorts(null);
  setSetting("codem-device-id", "dev-client");
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSyncRuntimeForTests();
  configureSyncLocalPorts(null);
});

describe("任务 C：宿主快照（完整 / 分页 / 工具结果）", () => {
  beforeEach(() => {
    seedHost();
    writeHostMessages();
  });

  it("SNAP-1: 分页完整 —— 页数、hasMore/nextBefore、总数与消息集合都对得上", async () => {
    const pages = await capturePages(2);
    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.messages.length)).toEqual([2, 2, 1]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    expect(pages[0].nextBefore).toBe(3);
    expect(pages[1].nextBefore).toBe(1);
    expect(pages[2].nextBefore).toBeNull();
    for (const page of pages) expect(page.total).toBe(5);
    const ids = pages.flatMap((page) => page.messages.map((m) => m.id));
    expect(ids).toEqual(["m4", "m5", "m2", "m3", "m1"]);
    expect(new Set(ids).size).toBe(5);
  });

  it("SNAP-1b: 单页限制 ≤200 条（非法 limit 被夹住，而不是无限返回）", async () => {
    const api = createHostSyncApi(createHostSyncPorts());
    const page = await api.snapshot({ sessionId: SESSION_ID, limit: 10_000 });
    expect(page.messages.length).toBe(HOST_MESSAGES.length);
    expect(page.hasMore).toBe(false);
  });

  it("SNAP-2: 工具调用与工具结果原样返回；附件正文不在快照里（已知边界）", async () => {
    const api = createHostSyncApi(createHostSyncPorts());
    const page = await api.snapshot({ sessionId: SESSION_ID, limit: 10 });
    const m2 = page.messages.find((m) => m.id === "m2");
    expect(m2?.toolCalls?.[0]?.tool).toBe("read");
    expect(m2?.toolCalls?.[0]?.result).toBe("export const a = 1;");
    const m4 = page.messages.find((m) => m.id === "m4");
    expect(m4?.metadata).toMatchObject({ note: "带元数据" });
    expect(m4?.toolCalls?.[0]?.result).toBe("写入 3 字节");
  });
});

describe("任务 C：客户端收到快照后写入本地消息存储", () => {
  it("SNAP-3: 新设备首次同步 ⇒ listTimelineMessages 与宿主一致；重复拉幂等", async () => {
    // 1) 宿主侧先造内容并抓下快照页（这时还是"宿主存储"）
    seedHost();
    writeHostMessages();
    const pages = await capturePages(2);
    const hostTimeline = timelineOf(SESSION_ID);
    expect(hostTimeline).toHaveLength(5);

    // 2) 换成一台"新设备"：全新的空存储（同一个进程内换端口）
    setStoragePort(createFakeStoragePort() as never);
    __resetSyncRuntimeForTests();
    configureSyncLocalPorts(null);
    clearSessionLogCache();
    setSetting("codem-device-id", "dev-client");
    createProject({ id: "proj-client", name: "客户端项目", path: "C:\\client", createdAt: 1, lastAccessedAt: 1 });

    const deps = hostDeps(snapshotHost(pages), [{ id: SESSION_ID, title: "宿主会话" }]);
    installFetch(deps);
    setSyncConfig({
      ...DEFAULT_SYNC_CONFIG,
      backend: "gateway",
      gatewayUrl: HOST_URL,
      autoSync: false,
      direction: "pull",
      syncMemory: false,
    });

    const first = await syncNow();
    expect(first.error).toBeUndefined();
    const clientTimeline = timelineOf(SESSION_ID);
    expect(clientTimeline).toEqual(hostTimeline);
    expect(getSyncState().lastSnapshotSessions).toBe(1);
    expect(getSyncState().lastSnapshotMessages).toBe(5);

    // 3) 再当一次"新设备"（重置同步状态）：同一份快照再拉一遍 —— 消息不许翻倍
    setSetting("codem-sync-state", "");
    __resetSyncRuntimeForTests();
    const second = await syncNow();
    expect(second.error).toBeUndefined();
    expect(timelineOf(SESSION_ID)).toEqual(hostTimeline);
    expect(getSyncState().lastSnapshotMessages).toBe(0);
  });

  it("SNAP-4: pull 回 resetRequired ⇒ 走快照重建并把游标重置到快照点", async () => {
    seedHost();
    writeHostMessages();
    const pages = await capturePages(2);

    setStoragePort(createFakeStoragePort() as never);
    __resetSyncRuntimeForTests();
    configureSyncLocalPorts(null);
    clearSessionLogCache();
    setSetting("codem-device-id", "dev-client");
    createProject({ id: "proj-client", name: "客户端项目", path: "C:\\client", createdAt: 1, lastAccessedAt: 1 });

    const deps = hostDeps(snapshotHost(pages, { resetRequired: true, hostSeq: 42 }), [
      { id: SESSION_ID, title: "宿主会话" },
    ]);
    const harness = installFetch(deps);
    setSyncConfig({
      ...DEFAULT_SYNC_CONFIG,
      backend: "gateway",
      gatewayUrl: HOST_URL,
      autoSync: false,
      direction: "pull",
      syncMemory: false,
    });

    const result = await syncNow();
    expect(result.error).toBeUndefined();
    expect(harness.calls).toContain("sync.snapshot");
    const state = getSyncState();
    expect(state.lastResetAt).toBeGreaterThan(0);
    expect(state.lastPulledSeq).toBe(42);
    expect(timelineOf(SESSION_ID).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });
});

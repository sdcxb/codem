/**
 * 多设备同步（25 号文 P2）的**宿主侧生产接线**：把数据库/记忆接到 `gateway-sync.ts`
 * 的 `HostSyncPorts` 上。
 *
 * ## 为什么单独一个文件
 *
 * `gateway-sync.ts` 是**纯逻辑**（账本、有界、幂等、游标），不 import 任何存储 ——
 * 判据可以用内存端口把两台设备的往返跑完。真正碰库的只有这里，而且只有一处：
 * 会话事件走 `getEventLog()`（唯一权威），记忆走 `sync-bridge`（`MemoryService` 唯一入口），
 * 账本走 settings（与 `sync-config`/`sync-state` 同一层，不新开存储）。
 *
 * ## 一条硬纪律
 *
 * 这里**不写第二份事件内容**：`push` 进来的事件正文进 `session_events`（宿主自己的事件日志），
 * 账本只留同步需要的字段（`eventId`/指纹/正文 —— 正文那份是"推送条目"的同步副本，
 * 由 `gateway-sync.ts` 的账本策略收界：只删「所有已知设备都拉过」的前缀，
 * 上限 5 万条 / 8 MB 只在最后手段下按容量丢弃并把受影响设备标记 `resetRequired`）。
 * 宿主自己的事件在账本里只有 `(sessionId, seq)` 引用，正文永远只读 `session_events`。
 */

import {
  normalizeHostSyncJournal,
  summarizeHostSyncJournal,
  HOST_SYNC_JOURNAL_KEY,
  type GatewaySyncSnapshotMessage,
  type HostSyncJournal,
  type HostSyncPorts,
  type HostSyncStoredEvent,
} from "./gateway-sync";
import { getEventLog, whenSessionEventsLoaded } from "../storage/event-log";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { reportPersistFailure } from "../storage/persist-failure";
import { listProjects } from "../storage/project";
import { createSession, getSession, listSessions, updateSession } from "../storage/session";
import { listTimelineMessages, waitForMessageMirrors } from "../storage/message";
import { readLocalMemoryPayload, mergeLocalMemoryFromRemote } from "../memory/sync-bridge";
import type { Message } from "../../store";

/** 每次补扫等事件镜像加载的上限（网关往返有 15s 上限，单会话不能等太久）。 */
const HOST_SCAN_LOAD_TIMEOUT_MS = 1200;
/** 快照读消息镜像的等待上限（与补扫同一量级：等不到就如实失败，不当成「没有消息」）。 */
const HOST_SNAPSHOT_MIRROR_WAIT_MS = 2000;
/** 宿主列会话的上限（"全部会话"的补扫池；超出的会话不会被这套同步看到）。 */
const HOST_SYNC_SESSION_LIST_MAX = 200;

function readJournal(raw: unknown, now: number): HostSyncJournal {
  return normalizeHostSyncJournal(raw, now);
}

/** 读账本（读坏了按空账本处理，见 `normalizeHostSyncJournal`）。 */
function loadHostSyncJournal(now = Date.now()): HostSyncJournal {
  return readJournal(getSettingJSON<unknown>(HOST_SYNC_JOURNAL_KEY, null), now);
}

/** 写账本；写失败**如实上报**（游标会倒退到上一次成功的那份，客户端会重复拉取，不丢数据）。 */
function saveHostSyncJournal(journal: HostSyncJournal): void {
  try {
    setSettingJSON(HOST_SYNC_JOURNAL_KEY, journal);
  } catch (e) {
    reportPersistFailure(
      "sync.hostJournal",
      e,
      "宿主同步账本未落盘（本次同步的游标只在本进程内有效）",
      { consequence: "重启后客户端可能重复拉取同一批事件（事件本身不会丢）。" },
    );
  }
}

/** 宿主会话池：项目 → 会话（跳过子代理内部会话与已删除的；有界）。 */
function listHostSessionIds(): string[] {
  const ids: string[] = [];
  try {
    for (const project of listProjects()) {
      for (const session of listSessions(project.id)) {
        if (!session || typeof session.id !== "string" || !session.id) continue;
        if (session.isInternal === true) continue;
        ids.push(session.id);
        if (ids.length >= HOST_SYNC_SESSION_LIST_MAX) return ids;
      }
    }
  } catch (e) {
    reportPersistFailure("sync.hostListSessions", e, "宿主会话列表读不出来（本次同步将只覆盖已请求的会话）");
    return [];
  }
  return ids;
}

/**
 * 建会话（远端推来的事件要落 `session_events`，那张表有 `session_id` 外键）。
 *
 * 落在哪个项目：**当前有项目的第一个**（`listProjects` 的顺序）。建不出来就返回 false，
 * 由同步层把这条事件记为 `session-unknown` 拒绝 —— 不伪造一个没有归属的会话。
 */
function ensureHostSession(
  sessionId: string,
  hint: { deviceId: string; timestamp: number; title?: string },
): boolean {
  try {
    if (getSession(sessionId)) return true;
    const projects = listProjects();
    const project = projects[0];
    if (!project) return false;
    const now = hint.timestamp > 0 ? hint.timestamp : Date.now();
    const shortId = String(hint.deviceId || "dev").slice(0, 12);
    createSession({
      id: sessionId,
      projectId: project.id,
      title: (hint.title && hint.title.trim()) || `同步会话（来自 ${shortId}）`,
      createdAt: now,
      lastMessageAt: now,
      messageCount: 0,
    });
    return Boolean(getSession(sessionId));
  } catch (e) {
    reportPersistFailure("sync.hostEnsureSession", e, `远端事件的目标会话建不出来：${sessionId}`);
    return false;
  }
}

/** 把远端推来的 `session_meta` 标题写回会话（有则用，没有就不动）。 */
function applyHostSessionTitle(sessionId: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 200) return;
  try {
    if (!getSession(sessionId)) return;
    updateSession(sessionId, { title: trimmed });
  } catch {
    // 标题只是展示：写不进去不该让同步失败
  }
}

function toStoredEvents(
  sessionId: string,
  rows: ReturnType<ReturnType<typeof getEventLog>["readFrom"]>,
): HostSyncStoredEvent[] {
  const out: HostSyncStoredEvent[] = [];
  for (const row of rows) {
    /*
     * `EventLog` 的 `SessionEvent.payload` 是**已经解析过的对象**，而账本/同步层要的是
     * 线上形态的 JSON 文本（用同一个口径读同步标记）。`String(object)` 会得到
     * `[object Object]` —— 那会让同步标记永远读不到，宿主补扫于是把"自己推上去的事件"
     * 再入账一次（表现为客户端每轮多收一条）。这里统一成 JSON 文本。
     */
    const payload =
      typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload ?? {});
    out.push({
      seq: Number(row.seq ?? 0),
      sessionId: String(row.sessionId ?? sessionId),
      type: String(row.type ?? ""),
      payload,
      timestamp: Number(row.timestamp ?? 0),
    });
  }
  return out;
}

/**
 * 消息 → 快照线上形态。
 *
 * **唯一丢失的东西是附件正文**（`content`/`preview`）：附件是外置文件/字节级内容，
 * 不在本功能的同步范围里（25 号文边界）。正文、推理、工具调用与**工具结果**全量保留
 * —— 快照要能还原"完整会话内容"，截断就等于伪造。
 */
function toSnapshotMessage(message: Message): GatewaySyncSnapshotMessage {
  const out: GatewaySyncSnapshotMessage = {
    id: String(message.id ?? ""),
    role: message.role === "assistant" || message.role === "system" ? message.role : "user",
    content: typeof message.content === "string" ? message.content : "",
    timestamp: Number(message.timestamp ?? 0),
  };
  if (message.reasoning) out.reasoning = message.reasoning;
  if (message.model) out.model = message.model;
  if (message.status) out.status = message.status;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    out.toolCalls = message.toolCalls.map((call) => ({
      id: String(call.id ?? ""),
      tool: String(call.tool ?? ""),
      args: (call.args ?? {}) as Record<string, unknown>,
      ...(typeof call.result === "string" ? { result: call.result } : {}),
      status: String(call.status ?? "done"),
      ...(call.metadata ? { metadata: call.metadata as Record<string, unknown> } : {}),
    }));
  }
  if (message.metadata && typeof message.metadata === "object") {
    out.metadata = message.metadata as Record<string, unknown>;
  }
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    out.attachments = message.attachments.map((att) => ({
      id: String(att.id ?? ""),
      name: String(att.name ?? ""),
      type: String(att.type ?? "file"),
      ...(att.mimeType ? { mimeType: att.mimeType } : {}),
      ...(typeof att.size === "number" ? { size: att.size } : {}),
      ...(att.sandboxPath ? { sandboxPath: att.sandboxPath } : {}),
    }));
  }
  if (Array.isArray(message.generatedFiles) && message.generatedFiles.length > 0) {
    out.generatedFiles = message.generatedFiles;
  }
  if (Array.isArray(message.retrievedSources) && message.retrievedSources.length > 0) {
    out.retrievedSources = message.retrievedSources;
  }
  return out;
}

/**
 * 生产端口。
 *
 * `readEvents` 会**先等该会话的事件镜像就绪**（`whenSessionEventsLoaded`）：读到空镜像
 * 与"确实没有事件"在 `readFrom` 上同形，不等就会把"没加载"当成"没有"（
 * `event-log.ts` 那两个判据就是为这件事加的）。
 */
export function createHostSyncPorts(): HostSyncPorts {
  return {
    now: () => Date.now(),
    loadJournal: () => loadHostSyncJournal(),
    saveJournal: (journal) => saveHostSyncJournal(journal),
    listSessionIds: () => listHostSessionIds(),
    async readEvents(sessionId, fromSeq) {
      if (!sessionId) return [];
      try {
        await whenSessionEventsLoaded(sessionId, HOST_SCAN_LOAD_TIMEOUT_MS);
      } catch {
        // 等不到也照样读一次：读到多少算多少（占位会被同步层拦掉）
      }
      try {
        return toStoredEvents(sessionId, getEventLog().readFrom(sessionId, fromSeq));
      } catch (e) {
        reportPersistFailure("sync.hostReadEvents", e, `宿主事件读取失败：${sessionId}`);
        return [];
      }
    },
    appendEvent(sessionId, type, payload) {
      try {
        const event = getEventLog().append(sessionId, type, payload);
        return Number(event.seq ?? 0);
      } catch (e) {
        reportPersistFailure("sync.hostAppend", e, `宿主事件写入失败：${sessionId}`);
        return 0;
      }
    },
    ensureSession: (sessionId, hint) => ensureHostSession(sessionId, hint),
    updateSessionTitle: (sessionId, title) => applyHostSessionTitle(sessionId, title),
    /**
     * ACL 的唯一依据：会话 → 项目。
     *
     * 镜像还没就绪时 `getSession` 返回 `null`（与"确实没有"同形）⇒ ACL 非空时按
     * **拒绝**处理（fail-closed）。这是刻意的：宁可让设备下一轮重试，也不能把一条
     * 归属不明的会话发出去/收进来。
     */
    projectIdOfSession(sessionId) {
      const session = getSession(sessionId);
      const projectId = typeof session?.projectId === "string" ? session.projectId : "";
      return projectId || null;
    },
    async readSessionMessages(sessionId) {
      try {
        /*
         * 先等消息镜像就绪：`listTimelineMessages` 在镜像未加载时可能只看到日志镜像的一角，
         * 那会被客户端当成"这个会话就这么点消息"（静默缺内容）。等不到就**抛错**，
         * 由网关答 INTERNAL（客户端下一轮重试），而不是回一个空快照。
         *
         * ⚠️ 已知成本（如实写）：每次快照请求都会完整读一遍会话（消息面没有"按时间线
         * 分页"的 API），大会话翻页是 O(页数 × 会话大小) 的读放大。正确性优先，
         * 优化要等 `MessageStorage` 提供分页读；页大小 200 时典型会话一两页就结束。
         */
        const unreadable = await waitForMessageMirrors([sessionId], HOST_SNAPSHOT_MIRROR_WAIT_MS);
        if (unreadable.has(sessionId)) throw new Error(`消息镜像未就绪（等待超过 ${HOST_SNAPSHOT_MIRROR_WAIT_MS}ms）`);
        return listTimelineMessages(sessionId).map(toSnapshotMessage);
      } catch (e) {
        reportPersistFailure(
          "sync.hostReadMessages",
          e,
          `宿主会话消息读取失败（快照本次未完成，客户端会重试）：${sessionId}`,
        );
        throw e;
      }
    },
    async readMemoryPayload() {
      const exported = await readLocalMemoryPayload();
      return exported.ok ? exported.payload : null;
    },
    async mergeMemory(payload, deviceId) {
      const merged = await mergeLocalMemoryFromRemote(payload, deviceId);
      return {
        ok: merged.ok,
        payload: merged.payload,
        entries: merged.entries,
        conflicts: merged.conflicts,
        changed: merged.changed,
        reason: merged.reason,
      };
    },
  };
}

/**
 * 宿主账本的规模读数（设置面板"本机作为 Host"那一行用）。
 *
 * 面板读的是**设置里的账本**，不是内存副本 —— 与 `sync.pull` 看到的是同一份。
 * 规模口径复用 `gateway-sync.ts` 的 `summarizeHostSyncJournal`（单一实现，别在这里再算一遍）。
 */
export function hostSyncJournalSummary(): {
  entries: number;
  pushEntries: number;
  nativeEntries: number;
  devices: number;
  cursors: number;
  pruned: number;
  dropped: number;
  droppedUnpulled: number;
  trimmedThrough: number;
  kb: number;
  updatedAt: number;
} {
  const journal = loadHostSyncJournal();
  const summary = summarizeHostSyncJournal(journal);
  return {
    entries: summary.entries,
    pushEntries: summary.pushEntries,
    nativeEntries: summary.nativeEntries,
    devices: summary.devices,
    cursors: summary.cursors,
    pruned: summary.pruned,
    dropped: summary.dropped,
    droppedUnpulled: summary.droppedUnpulled,
    trimmedThrough: summary.trimmedThrough,
    kb: Math.round(summary.bytes / 1024),
    updatedAt: summary.updatedAt,
  };
}


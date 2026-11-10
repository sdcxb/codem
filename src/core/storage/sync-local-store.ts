/**
 * 多设备同步（25 号文 P2）的**本机端口实现**：把会话事件、会话表、记忆接到
 * `sync-engine.ts` 的 `SyncLocalPorts` 上。
 *
 * ## 为什么单独一个文件、并且**只能被动态 import**
 *
 * 这里连着的三样东西都很重：`event-log`（镜像/端口）、`session`（它静态 import
 * `message.ts`，230 KB）、`memory`（构造就建索引）。而"没开同步的用户"不该为同步付
 * 任何启动成本 —— 所以 `sync-engine` 用 `await import("./sync-local-store")` 懒加载本文件，
 * 只有真的点「立即同步」或定时器到点时才付这份钱。
 *
 * ## 一条边界：事件镜像没加载时**不假装没有事件**
 *
 * `eventLog.readFrom` 对"没加载完"与"确实没有"是**同一个返回值**（空数组，见
 * `event-log.ts` 里那两个判据）。所以推送前对"从没推过的会话"给一次有界的加载等待
 * （{@link LOCAL_WAIT_LOADED_MS}），等不到就**跳过这个会话**（水位不动，下一轮再来）——
 * 绝不把空数组当成"这些会话没有历史"而推进水位（那会永久漏掉它们）。
 *
 * ## 快照写入：走消息的**权威路径**
 *
 * 宿主快照来的消息必须经 `createMessage`（权威 JSONL 先写、SQLite 索引随后），
 * 否则"只写索引"的那份内容在索引重建/损坏后凭空消失。按 id 幂等：同一份快照重复拉
 * 不会产生两条消息（判据 `SNAP-3`）。
 */

import type { SyncLocalEvent, SyncLocalPorts } from "./sync-engine";
import type { GatewaySyncSnapshotMessage } from "../remote/gateway-sync";
import { getEventLog, whenSessionEventsLoaded } from "./event-log";
import { listProjects } from "./project";
import { createSession, getSession, listSessions, updateSession } from "./session";
import { createMessage, listTimelineMessages } from "./message";
import type { Message, MessageAttachment, ToolCall } from "../../store";
import {
  readLocalMemoryPayload,
  mergeLocalMemoryFromRemote,
  recordRemoteMemoryConflicts,
} from "../memory/sync-bridge";

/** 本机会话池上限（与宿主侧同一量级：超出部分这套同步看不到）。 */
export const LOCAL_SYNC_SESSION_LIST_MAX = 200;
/** 首次推送某会话时等事件镜像加载的上限。 */
const LOCAL_WAIT_LOADED_MS = 600;

function listLocalSessionIds(): string[] {
  const ids: string[] = [];
  try {
    for (const project of listProjects()) {
      for (const session of listSessions(project.id)) {
        if (!session?.id) continue;
        if (session.isInternal === true) continue;
        ids.push(session.id);
        if (ids.length >= LOCAL_SYNC_SESSION_LIST_MAX) return ids;
      }
    }
  } catch {
    // 项目/会话读不出来（端口未就绪）⇒ 空集合；推送会跳过并把"未加载"计数报给上层
    return [];
  }
  return ids;
}

function ensureLocalSession(
  sessionId: string,
  hint: { deviceId: string; timestamp: number; title?: string },
): boolean {
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
}

/**
 * 快照消息 → 本机 `Message`（附件只有元数据；工具结果原样保留）。
 *
 * 为什么不直接 `as Message`：快照来自网络，`role`/`status`/附件 `type` 这些联合类型的
 * 取值必须收敛到本机认识的那几个；否则写进去的是一条"索引能存、界面渲染会炸"的消息。
 */
function snapshotMessageToMessage(raw: GatewaySyncSnapshotMessage): Message {
  const role = raw.role === "assistant" || raw.role === "system" ? raw.role : "user";
  const status =
    raw.status === "pending" || raw.status === "streaming" || raw.status === "error" || raw.status === "done"
      ? raw.status
      : undefined;
  const toolCalls: ToolCall[] | undefined = Array.isArray(raw.toolCalls)
    ? raw.toolCalls
        .filter((call) => call && typeof call.id === "string" && call.id)
        .map((call) => ({
          id: call.id,
          tool: String(call.tool ?? ""),
          args: (call.args ?? {}) as Record<string, unknown>,
          ...(typeof call.result === "string" ? { result: call.result } : {}),
          status:
            call.status === "pending" || call.status === "running" || call.status === "error"
              ? call.status
              : "done",
          ...(call.metadata ? { metadata: call.metadata as Record<string, unknown> } : {}),
        }))
    : undefined;
  const attachments: MessageAttachment[] | undefined = Array.isArray(raw.attachments)
    ? raw.attachments
        .filter((att) => att && typeof att.id === "string" && att.id)
        .map((att) => {
          const type =
            att.type === "image" || att.type === "code" || att.type === "url" || att.type === "video" || att.type === "audio"
              ? att.type
              : "file";
          return {
            id: att.id,
            name: String(att.name ?? ""),
            type,
            ...(att.mimeType ? { mimeType: att.mimeType } : {}),
            ...(typeof att.size === "number" ? { size: att.size } : {}),
            ...(att.sandboxPath ? { sandboxPath: att.sandboxPath } : {}),
          };
        })
    : undefined;
  return {
    id: raw.id,
    role,
    content: typeof raw.content === "string" ? raw.content : "",
    timestamp: Number(raw.timestamp) || Date.now(),
    ...(raw.reasoning ? { reasoning: raw.reasoning } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(status ? { status } : {}),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(Array.isArray(raw.generatedFiles) && raw.generatedFiles.length > 0
      ? { generatedFiles: raw.generatedFiles }
      : {}),
    ...(Array.isArray(raw.retrievedSources) && raw.retrievedSources.length > 0
      ? { retrievedSources: raw.retrievedSources as Message["retrievedSources"] }
      : {}),
  };
}

/** 本机端口实现（判据可替换成内存实现，见 `configureSyncLocalPorts`）。 */
export function createLocalSyncPorts(): SyncLocalPorts {
  /**
   * 快照写入的幂等索引（每会话一份；首次写前从完整时间线建一次）。
   *
   * 为什么不用 `getMessage(id)` 逐条查：那要过镜像/日志两条读路径，而且镜像里不含工具调用；
   * `listTimelineMessages` 一次给全（快照本来就是"重建整会话"，这份读不额外制造放大）。
   */
  const knownMessageIds = new Map<string, Set<string>>();
  const knownIds = (sessionId: string): Set<string> => {
    const cached = knownMessageIds.get(sessionId);
    if (cached) return cached;
    const set = new Set<string>();
    try {
      for (const message of listTimelineMessages(sessionId)) set.add(message.id);
    } catch {
      // 读不到就当没有：createMessage 有索引兜底，重复写入由下面的 set 记录
    }
    knownMessageIds.set(sessionId, set);
    return set;
  };

  return {
    listSessionIds: () => listLocalSessionIds(),
    readEvents(sessionId: string, fromSeq: number): SyncLocalEvent[] {
      try {
        return getEventLog()
          .readFrom(sessionId, fromSeq)
          .map((event) => ({
            seq: Number(event.seq ?? 0),
            sessionId: String(event.sessionId ?? sessionId),
            type: String(event.type ?? ""),
            payload: (event.payload ?? {}) as Record<string, unknown>,
            timestamp: Number(event.timestamp ?? 0),
          }));
      } catch {
        return [];
      }
    },
    appendEvent(sessionId, type, payload) {
      try {
        return Number(getEventLog().append(sessionId, type, payload).seq ?? 0);
      } catch {
        return 0;
      }
    },
    ensureSession: (sessionId, hint) => ensureLocalSession(sessionId, hint),
    updateSessionTitle(sessionId, title) {
      const trimmed = String(title ?? "").trim();
      if (!trimmed || trimmed.length > 200) return;
      try {
        if (!getSession(sessionId)) return;
        updateSession(sessionId, { title: trimmed });
      } catch {
        // 标题只是展示：写不进去不该让同步失败
      }
    },
    /** 项目范围的本地侧：推送前先筛掉范围外会话（宿主仍会再按 ACL 校验一次） */
    projectIdOfSession(sessionId: string): string | null {
      const projectId = getSession(sessionId)?.projectId;
      return typeof projectId === "string" && projectId ? projectId : null;
    },
    /**
     * 写快照消息：**按 id 幂等**（已存在就跳过），走 `createMessage`（权威 JSONL + 查询索引）。
     *
     * 为什么必须走 `createMessage`：消息的权威副本是追加日志、索引只是可重建查询面；
     * 另写一条"只进索引"的路会让重启/重建索引后快照内容凭空消失。
     */
    writeSnapshotMessages(sessionId, messages) {
      const known = knownIds(sessionId);
      let written = 0;
      let skipped = 0;
      for (const raw of messages) {
        if (!raw || typeof raw.id !== "string" || !raw.id) {
          skipped += 1;
          continue;
        }
        if (known.has(raw.id)) {
          skipped += 1;
          continue;
        }
        createMessage(snapshotMessageToMessage(raw), sessionId);
        known.add(raw.id);
        written += 1;
      }
      return { written, skipped };
    },
    async waitLoaded(sessionId: string) {
      try {
        await whenSessionEventsLoaded(sessionId, LOCAL_WAIT_LOADED_MS);
      } catch {
        // 等不到也没关系：上层会跳过这个会话（水位不动）
      }
    },
    memory: {
      read: () => readLocalMemoryPayload(),
      merge: (payload, remoteDeviceId) => mergeLocalMemoryFromRemote(payload, remoteDeviceId),
      recordConflicts: (records) => recordRemoteMemoryConflicts(records),
    },
  };
}

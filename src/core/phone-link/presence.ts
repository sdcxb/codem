/**
 * 多端在场感知（阶段 4.3）—— 谁正在看、谁正在答。
 *
 * ## 为什么需要
 *
 * 阶段 0 把审批做成了**一张共用的表**：手机、微信、桌面都是回答方，谁先答谁生效。
 * 但那张表**没有告诉任何一方"还有别人在看"** —— 于是：
 * - 桌面上卡片静静地躺着，用户不知道手机上其实已经弹出来了；
 * - 手机上点"允许"时，可能桌面刚刚点过，只能得到一句"已被处理"。
 *
 * 在场感知就是把这件事说清楚：**有谁在场、各自最后活跃在什么时候**。
 *
 * ## 身份从哪来（不能由客户端自称）
 *
 * 远端身份来自 **Rust 侧 cookie 鉴权后**的设备 id（`phone/mod.rs` 的
 * `auth_device` → `proxy_to_ts` 的 `deviceId`）。客户端**不能**在请求体里
 * 声称自己是谁 —— 那是冒充的入口。
 *
 * 桌面的身份是恒定的（`desktop`）：它就是宿主进程本身，不需要证明。
 *
 * ## 过期
 *
 * 远端每发一次请求就刷新一次"最后活跃"。超过 TTL 就视为**已离开** ——
 * 否则用户关了手机页面之后，桌面会一直显示"手机正在查看"，
 * 而那种假在线会直接误导他对"谁可能已经答过"的判断。
 */
import { emitPhoneEvent } from "./event-stream";

/** 远端多久没动静就算离开了。手机约每 10 秒一次长轮询，30 秒足够覆盖抖动。 */
export const REMOTE_TTL_MS = 30_000;

export interface RemotePeer {
  /** 已配对设备的 id（来自 cookie 鉴权，非客户端自称） */
  deviceId: string;
  ip: string;
  lastSeenMs: number;
  /** 它最后在看的会话（有的话）—— 审批场景下这一条最有用 */
  sessionId?: string;
}

export interface PresenceView {
  /** 桌面永远在场（它就是宿主） */
  desktop: true;
  remotes: RemotePeer[];
  /** 便于界面直接判断"有没有别人在看" */
  remoteCount: number;
}

const remotes = new Map<string, RemotePeer>();

/** 记一次远端活跃。返回**在场集合是否发生了变化**（用于决定要不要推事件）。 */
export function noteRemoteSeen(deviceId: string, ip: string, sessionId?: string): boolean {
  if (!deviceId) return false;
  const now = Date.now();
  const prev = remotes.get(deviceId);
  const changed =
    !prev ||
    prev.ip !== (ip || "") ||
    (prev.sessionId ?? "") !== (sessionId ?? "") ||
    // 从"已过期"重新回到在场，也算变化（界面要重新显示它）
    now - prev.lastSeenMs > REMOTE_TTL_MS;
  remotes.set(deviceId, {
    deviceId,
    ip: ip || "",
    lastSeenMs: now,
    ...(sessionId ? { sessionId } : {}),
  });
  return changed;
}

/** 清掉过期远端。返回是否清掉了东西。 */
export function pruneRemotes(now: number = Date.now()): boolean {
  let removed = false;
  for (const [id, p] of [...remotes]) {
    if (now - p.lastSeenMs > REMOTE_TTL_MS) {
      remotes.delete(id);
      removed = true;
    }
  }
  return removed;
}

/** 当前在场视图（读的时候顺手清理过期项——不清理就会显示假在线）。 */
export function getPresence(now: number = Date.now()): PresenceView {
  pruneRemotes(now);
  const list = [...remotes.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  return { desktop: true, remotes: list, remoteCount: list.length };
}

/**
 * 在场变化时推一条事件。
 *
 * 为什么不在 `noteRemoteSeen` 里直接推：那条路径每次请求都会走，
 * 每次都推会把事件流刷满（而长轮询的唤醒是有代价的 —— 客户端会立刻回一轮取数）。
 * 只有**集合真的变了**才通知。
 */
export function publishPresenceIfChanged(changed: boolean, sessionId?: string): void {
  if (changed) emitPhoneEvent("presence", sessionId, { changed: true });
}

/** 测试用：清空。 */
export function __resetPresenceForTests(): void {
  remotes.clear();
}

/** 测试用：直接塞一个远端（不经过 noteRemoteSeen 的"变化"判定）。 */
export function __seedRemoteForTests(p: RemotePeer): void {
  remotes.set(p.deviceId, p);
}

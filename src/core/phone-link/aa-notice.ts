/**
 * 通知 / 交互模型（阶段 R4）—— 完全按它 `dsh` 适配层的形状。
 *
 * 主要依据：它插件侧的 `host/dsh-runtime/approvals.ts`（DSH 的审批 → 通知映射）
 * 与 `host/dsh-runtime/identity.ts`（标识派生）。
 *
 * ## 为什么值得按它的形状来，而不是沿用我们阶段 0 的样子
 *
 * 我们阶段 0 的审批是 `{requestId, tool, input, status: open|resolved|closed|expired, action: allow|deny}`。
 * 能用，但它**缺少三样多端协调必需的东西**：
 *
 * 1. **`responding` 这个中间态**。我们只有"待处理/已处理"。
 *    多端场景下"有人点了、但结果还没落地"是一个**必须可见**的状态 ——
 *    否则第二个端会以为还能点，点完才发现"已被处理"。
 * 2. **`blocking`**：这条通知**卡住了什么**（会话/某次工具调用/整个运行时）。
 *    没有它，界面只知道自己"有一条待办"，不知道"因为这个，那个会话现在动不了"。
 * 3. **`revision`**：每次状态变化自增。多端靠它判断"我看到的这条是不是过时了"。
 *
 * ## 三个必须照抄的行为（都是防"并发下出错"的）
 *
 * 1. **`await` 之后要再查一次状态**（`approvals.ts:78`）。
 *    可见性判断要 await I/O，这期间**另一个端可能已经决定了** ——
 *    不复查就会出现"两端都报告自己成功"。
 * 2. **下发失败要回滚状态**（`approvals.ts:84-86`）：从 `responding` 退回 `open`，
 *    而不是停在"已响应"（那会让这一条**永远没人能再答**）。
 * 3. **回合结束时把待处理项置为 `expired`**（`approvals.ts:90-95`）。
 *    否则回合都结束了，卡片还挂着，用户点下去只会得到"已失效"。
 */

// 标识派生（`platformSessionId` / `aaItemId`）用的 sha256 来自 `aa-protocol-ids.ts`
// —— 那边是实现处，这里只按它的 `identity.ts` 组装。
import { sha256Hex } from "./aa-protocol-ids";

/** 它的八态（`protocol.py:22-31`）。DSH 适配层实际用到其中五个。 */
export const NOTICE_STATUSES = [
  "open",
  "responding",
  "response_accepted",
  "resolving",
  "resolved",
  "expired",
  "cancelled",
  "failed",
] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export function isPendingStatus(s: string): boolean {
  return s === "open" || s === "responding" || s === "response_accepted" || s === "resolving";
}
export function isTerminalStatus(s: string): boolean {
  return s === "resolved" || s === "expired" || s === "cancelled" || s === "failed";
}

/** 已落定项的历史上限（`approvals.ts:60`）。 */
export const CLOSED_HISTORY_LIMIT = 128;

// ---------------- 标识（对应它的 identity.ts）----------------

/** `sess_dsh_<sha256(namespace:dsh:externalId)[:24]>`，或去掉已有前缀。 */
export function platformSessionId(namespace: string, externalId: string): string {
  const prefix = `aa_${sha256HexLocal(namespace).slice(0, 16)}_`;
  if (externalId.startsWith(prefix) && /^[\w-]{1,128}$/.test(externalId.slice(prefix.length))) {
    return externalId.slice(prefix.length);
  }
  return `sess_dsh_${sha256HexLocal(`${namespace}:dsh:${externalId}`).slice(0, 24)}`;
}

/** `dsh_<sha256hex(externalId \0 kind \0 businessId)>` —— 与 Rust 侧同一语义。 */
export function aaItemId(externalId: string, kind: string, businessId: string): string {
  return `dsh_${sha256HexLocal(`${externalId}\u0000${kind}\u0000${businessId}`)}`;
}

/** 本地 sha256 十六进制。用自己那份同步实现（见 aa-protocol-ids.ts 的理由）。 */
const sha256HexLocal = sha256Hex;

// ---------------- 审批 → 通知的映射（对应 approvals.ts:66-77）----------------

/** 我们的审批视图里、投影成通知所需要的那几个字段。 */
export interface ApprovalLike {
  requestId: string;
  tool: string;
  reason?: string;
  callId?: string;
  status: string;
  revision?: number;
}

/** 它的动作 id。**不是** `allow`/`deny` —— 照抄（`approvals.ts:71-72`）。 */
export const REMOTE_ACTION_ALLOW = "allow-once";
export const REMOTE_ACTION_REJECT = "reject";

/** 它的错误码（`approvals.ts:75,78,85`）。 */
export const CODE_NOT_PENDING = "dsh_approval_not_pending";
export const CODE_INVALID_ACTION = "dsh_approval_invalid_action";
export const CODE_UNAVAILABLE = "dsh_approval_unavailable";

export const MSG_NOT_PENDING = "这个权限请求已处理或已失效。";
export const MSG_INVALID_ACTION = "未知的批准操作。";
export const MSG_UNAVAILABLE = "DSH 未接收批准结果，请稍后重试。";

/** 把远端动作 id 映射成我们的内部动作。**不认识就返回 null，不猜。** */
export function remoteActionToInternal(actionId: string): "allow" | "deny" | null {
  if (actionId === REMOTE_ACTION_ALLOW) return "allow";
  if (actionId === REMOTE_ACTION_REJECT) return "deny";
  return null;
}

/** 它的通知形状（`ProtocolNotice` 的 DSH 子集）。 */
export interface AaNotice {
  noticeId: string;
  sessionId: string;
  runtime: "dsh";
  type: "interaction";
  interactionType: "approval";
  title: string;
  message: string;
  severity: "warning";
  status: string;
  revision: number;
  responseRequired: boolean;
  blocking: { scope: "session"; targetId: string } | null;
  source: { runtime: "dsh"; component: string };
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  actions: Array<{ actionId: string; label: string; style: string }>;
}

/**
 * 把一条审批投影成通知 —— 逐字段对齐 `approvals.ts:66-77`。
 *
 * `platformId` 是 `platformSessionId(namespace, externalId)` 的结果。
 */
export function noticeFromApproval(entry: ApprovalLike, platformId: string): AaNotice {
  const pending = isPendingStatus(entry.status);
  return {
    noticeId: aaItemId(platformId, "approval", entry.requestId),
    sessionId: platformId,
    runtime: "dsh",
    type: "interaction",
    interactionType: "approval",
    title: `请求批准：${entry.tool}`,
    // 它给的缺省文案明确写了"允许**仅对本次请求**生效"——这句是安全承诺，不能省
    message: entry.reason ?? "此操作需要你的批准。允许仅对本次请求生效。",
    severity: "warning",
    status: entry.status,
    revision: entry.revision ?? 1,
    responseRequired: pending,
    // 只在待处理时才算"卡住"；已落定的通知不该继续阻塞
    blocking: pending ? { scope: "session", targetId: platformId } : null,
    source: { runtime: "dsh", component: "dsh.approval" },
    context: {
      toolName: entry.tool,
      ...(entry.callId ? { callId: entry.callId } : {}),
    },
    metadata: { eventId: entry.requestId },
    actions: pending
      ? [
          { actionId: REMOTE_ACTION_ALLOW, label: "允许一次", style: "primary" },
          { actionId: REMOTE_ACTION_REJECT, label: "拒绝", style: "secondary" },
        ]
      : [],
  };
}

/** 待处理项的数量（界面用它决定"有没有东西卡着"）。 */
export function countPending(entries: ApprovalLike[]): number {
  return entries.filter((e) => isPendingStatus(e.status)).length;
}

/**
 * 收敛历史：已落定的只保留最近 `limit` 条，**待处理的一条都不能丢**。
 *
 * 这是 `approvals.ts:60` 的行为。反过来说：如果实现成"按插入顺序丢最旧的"，
 * 就可能把一条**还没人处理**的丢掉 —— 那会让卡片凭空消失、而回合永远等下去。
 */
export function trimClosedHistory<T extends { status: string }>(
  entries: T[],
  limit = CLOSED_HISTORY_LIMIT,
): T[] {
  const closed = entries.filter((e) => !isPendingStatus(e.status));
  if (closed.length <= limit) return entries;
  const drop = new Set(closed.slice(0, closed.length - limit));
  return entries.filter((e) => !drop.has(e));
}

/**
 * 回合结束时的收敛：把该会话**仍待处理**的审批置为 `expired`。
 *
 * 对应它的 `observe()`（`approvals.ts:90-95`）。不这么做的话，
 * 回合都结束了卡片还挂着，用户点下去只会得到"已失效"。
 */
export function expirePendingForTurnEnd<T extends { status: string }>(entries: T[]): {
  changed: T[];
  expiredCount: number;
} {
  let expiredCount = 0;
  const changed = entries.map((e) => {
    if (!isPendingStatus(e.status)) return e;
    expiredCount++;
    return { ...e, status: "expired", withdrawn: true } as T & { withdrawn?: boolean };
  });
  return { changed, expiredCount };
}

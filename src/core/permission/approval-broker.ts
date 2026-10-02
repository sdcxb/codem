/**
 * 审批代理（approval broker）—— 让**远端**（手机 / 微信 / 以后的中继）能回答"要权限吗"。
 *
 * ## 病：远端发起的回合里，需要批准的工具被**静默拒绝**
 *
 * 三条路径对"要权限怎么办"的处理完全不同：
 *
 * | 路径 | 谁来回答 | 代码 |
 * |---|---|---|
 * | 桌面前台 | 桌面 DecisionTray | `App.tsx:3291-3300` 把请求塞进 `pendingPermissions` |
 * | **手机** | **没有人** → 落到 `executor.ts:368-374` 的缺省：full 放行，否则**自动拒绝** | `phone-link.ts:223-280` 没传回调 |
 * | **微信** | 同上的自动拒绝 | `wechat-bridge.ts:665` 注释自认：「full→放行；否则自动拒绝」 |
 *
 * 后果：手机/微信上发一句"帮我改一下这个文件"，如果那次编辑需要批准，
 * 工具**被静默否掉**，用户看到的现象是"任务莫名没做"——而不是"它在等你点同意"。
 *
 * ## 这个模块做什么
 *
 * 一个**进程内**的待批表：谁先回答谁生效，回答**只生效一次**，回合结束/中止时
 * 未回答的一律按**拒绝**收尾。桌面与远端都是它的回答方 —— 也就是
 * 「手机不在时桌面也能答」这条不靠额外机制，而是因为它本来就共用一张表。
 *
 * ## 设计取舍（逐条都有对比对象）
 *
 * 对标 DSH 的 `approvals.ts`（`@agents-anywhere/dsh-bridge-next`，插件源码
 * `src/host/dsh-runtime/approvals.ts`），它的这几条我**照抄**，因为都是踩过坑的形状：
 *
 * 1. **只给两个动作**：`allow-once` / `reject`。**不给"总是允许"** ——
 *    DSH 的类头一行就是契约：*a grant always applies once*（`approvals.ts:14`）。
 *    远端在网络上，给"永久放行"的按钮风险远大于收益；桌面本地仍可 `alwaysAllow`。
 * 2. **状态机而不是布尔**：`open → responding → resolved`，另加 `closed` / `expired`。
 *    有中间态才能表达"正在被另一个回答方处理"（DSH `approvals.ts:9-11`）。
 * 3. **决定前要再检查一次状态**：DSH 的原话是
 *    「Visibility awaits I/O; another client may have decided in the meantime.」
 *    （`approvals.ts:81-82`）—— 多回答方场景下这是**必须**的。
 *    我们这里 `answer()` 全程同步（JS 单线程），提交本身就是原子的，不引入 await。
 * 4. **回合结束即失效**：DSH 在 `turn/end` 时把仍 pending 的标成 `expired`
 *    （`approvals.ts:94-99`）。我们换成 `closeSession()`，由调用方在回合收尾时调。
 * 5. **历史条目有界**：DSH 只保留最近 128 条非 pending（`approvals.ts:48-49`）。
 *
 * 这几条我**不照抄**，理由是它与我们的既有约定冲突：
 *
 * - **DSH 没有超时**（等用户），我们**也没有**：`permission.ts:239-243` 明确写了
 *   「NO time-based timeout. The user may take as long as they need.」
 *   上一版实现过 5 分钟超时并因此被删掉。所以这里同样**不设超时**；
 *   悬空由**调用方**在回合收尾时 `closeSession()` 收口（手机路径本来就有
 *   `TURN_TIMEOUT_MS` + `cancelSessionExecution`，见 `phone-link.ts:251-257`）。
 * - DSH 把审批经官方 `pending request` 回填给 Agent。我们是**自己 hold 住 Promise**，
 *   因为 `agentic-loop.ts:987-1002` 就是 `await onPermissionRequest(request)` 的形状，
 *   直接复用比再包一层适配器更少出错。
 *
 * ## 与 `PermissionManager` 的关系（别搞混）
 *
 * `core/permission/permission.ts` 的 `PermissionManager` 管的是**规则求值**
 * （`evaluate(tool, resource)` → allow/deny/ask）与"总是允许"记忆；
 * 本模块管的是**ask 之后那一次交互**的投递与收口。前者决定"要不要问"，
 * 后者决定"谁来答、答完算不算数"。
 */
import type { PermissionRequest, PermissionResult } from "./permission";

/** 待批项的状态。`responding` 是"已被某个回答方受理、尚未落地"。 */
export type ApprovalStatus = "open" | "resolved" | "closed" | "expired";

/** 谁在等这个批准 / 谁回答了它。用于界面措辞与日志，**不用于鉴权**。 */
export type ApprovalParty = "desktop" | "phone" | "wechat" | "relay";

/** `answerApproval()` 的失败原因（机器可读）。 */
export type ApprovalFailureCode = "approval_not_pending" | "approval_invalid_action";

export type ApprovalAnswer =
  | { ok: true; requestId: string; action: "allow" | "deny"; decidedBy: ApprovalParty }
  | { ok: false; code: ApprovalFailureCode; message: string };

/** 远端与桌面共用的待批项视图。 */
export interface ApprovalView {
  requestId: string;
  sessionId: string;
  tool: string;
  resource?: string;
  /**
   * **已消毒**的入参：短字段原样、长字段截断（见 `sanitizeApprovalInput`）。
   *
   * 为什么是对象而不是一段文本：桌面要复用既有的 `PermissionDialog`，
   * 而它按 `request.input` 自己算描述与风险等级（`PermissionDialog.tsx:80-81`）；
   * 手机只需要一段可显示的文本。存一份**有界结构**，两边都能用。
   */
  input: Record<string, unknown>;
  /** 给用户看的一段文本（由 `input` 渲染而来） */
  preview: string;
  /** 发起的路径（手机发起的回合 origin 就是 phone） */
  origin: ApprovalParty;
  status: ApprovalStatus;
  createdAt: number;
  /** 已经有人回答过时带上，便于另一回答方显示"已被桌面处理" */
  decidedBy?: ApprovalParty;
  decidedAction?: "allow" | "deny";
  /** 只有 `open` 才该显示按钮（与 DSH `approvals.ts:69-72` 同一判据） */
  responseRequired: boolean;
}

/** 单字段摘录上限（长文本字段）。 */
export const APPROVAL_TEXT_EXCERPT_CHARS = 800;
/** 单字段摘录上限（普通字段）。 */
export const APPROVAL_FIELD_MAX_CHARS = 300;
/** 整份预览/入参的字符上限。 */
export const APPROVAL_PREVIEW_MAX_CHARS = 2000;
/** 已决定条目的保留上限（对齐 DSH `approvals.ts:48-49` 的 128）。 */
export const DECIDED_HISTORY_LIMIT = 128;

interface Entry {
  requestId: string;
  sessionId: string;
  tool: string;
  resource?: string;
  /** **已消毒**的入参（见 `sanitizeApprovalInput`）——有界，可以长期持有 */
  input: Record<string, unknown>;
  origin: ApprovalParty;
  status: ApprovalStatus;
  createdAt: number;
  decide: (result: PermissionResult) => void;
  decidedBy?: ApprovalParty;
  decidedAction?: "allow" | "deny";
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let revisionCounter = 0;

function bump(): void {
  revisionCounter++;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 单个订阅者失败不影响其它订阅者，也不影响审批本身 */
    }
  }
}

/** 当前版本号（供 React `useSyncExternalStore` 一类订阅方判断"变了没有"）。 */
export function approvalRevision(): number {
  return revisionCounter;
}

/** 订阅待批表变化（返回退订函数）。 */
export function subscribeApprovals(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 展示顺序：**已确认存在的字段**都要在这里出现。
 *
 * ⚠️ 第一版只列了短字段，把 `content` / `new_string` 这类长字段漏在外面，
 * 于是 `write` 的预览只剩一行路径 —— 用户完全无法判断"要往里写什么"，
 * 而审批的全部意义就是让他判断该不该做。这条是被用例（AB-7）当场抓住的。
 */
const ORDERED_KEYS = [
  "path",
  "file_path",
  "notebook_path",
  "pattern",
  "query",
  "url",
  "target",
  "workdir",
  "cwd",
  "old_string",
  "new_string",
  "content",
  "text",
  "body",
];
/** 经常很长、需要单独摘录的字段 */
const LONG_KEYS = new Set(["content", "new_string", "old_string", "text", "body"]);

/**
 * 把工具入参**消毒**成一份有界副本（截断处一律注明原长）。
 *
 * ## 为什么必须消毒，以及为什么存对象而不是一段文本
 *
 * - **不能原样留着**：`write` 的 `content`、`edit` 的 `new_string` 动辄几 MB。
 *   留在待批表里等于让一次审批变成一次内存驻留。
 * - **不能只存一段文本**：桌面要复用既有的 `PermissionDialog`，
 *   而它按 `request.input` 自己算描述与风险等级（`PermissionDialog.tsx:80-81`）。
 *   存一份**有界结构**，手机（渲染成文本）与桌面（喂给对话框）都能用；
 *   存两份会分叉，存原始入参会吃内存。
 *
 * 幂等：对已消毒的对象再调一次不会继续变短（值已在限内）。
 */
export function sanitizeApprovalInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const obj = input && typeof input === "object" ? input : {};
  const out: Record<string, unknown> = {};
  let used = 0;

  const clip = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, max)}…（共 ${value.length} 字符，此处显示前 ${max} 字符）`;

  const put = (key: string, value: string, cap: number): boolean => {
    const text = clip(value, cap);
    if (used + text.length > APPROVAL_PREVIEW_MAX_CHARS) return false;
    out[key] = text;
    used += text.length;
    return true;
  };

  // command 排最前：bash 家族的判据就是命令本身
  if (typeof obj.command === "string" && obj.command.trim()) {
    put("command", obj.command.trim(), 600);
  }
  for (const key of ORDERED_KEYS) {
    const v = obj[key];
    if (typeof v !== "string" || !v) continue;
    if (!put(key, v, LONG_KEYS.has(key) ? APPROVAL_TEXT_EXCERPT_CHARS : APPROVAL_FIELD_MAX_CHARS)) break;
  }
  return out;
}

/**
 * 把入参渲染成**给用户看的一段文本**（手机端用）。
 *
 * 入参可以是原始的，也可以是 `sanitizeApprovalInput` 的结果（幂等，见上）。
 */
export function summarizeApprovalInput(input: Record<string, unknown> | undefined): string {
  const sanitized = sanitizeApprovalInput(input);
  const keys = Object.keys(sanitized);
  if (keys.length > 0) {
    const text = keys.map((k) => `${k}: ${String(sanitized[k])}`).join("\n");
    return text.length <= APPROVAL_PREVIEW_MAX_CHARS
      ? text
      : `${text.slice(0, APPROVAL_PREVIEW_MAX_CHARS)}…（预览已截断，共 ${text.length} 字符，请在电脑上核对全文）`;
  }
  /**
   * 没有任何已知字段 ⇒ 退到 JSON。
   * 注意这里用的是**原始**入参：消毒只保留已知字段，自定义工具的 `foo` 会被它丢掉，
   * 而那种情况下用户更需要看到点什么。
   */
  const obj = input && typeof input === "object" ? input : {};
  let json = "";
  try {
    json = JSON.stringify(obj, null, 2);
  } catch {
    // 循环引用等不可序列化的入参：如实说，而不是给个空串
    return "（入参无法序列化以便预览）";
  }
  if (!json || json === "{}") return "（本次调用没有参数）";
  return json.length <= APPROVAL_PREVIEW_MAX_CHARS
    ? json
    : `${json.slice(0, APPROVAL_PREVIEW_MAX_CHARS)}…（预览已截断，共 ${json.length} 字符，请在电脑上核对全文）`;
}

/**
 * 登记一个待批请求（**内部**：生产请用 `requestApproval`，它保证预览被算出来）。
 *
 * @param request 引擎给的权限请求（`agentic-loop.ts:989-996` 的形状）
 * @param origin  哪个路径发起的（手机 / 微信 / 桌面 / 中继）
 */
function registerApproval(
  request: PermissionRequest,
  origin: ApprovalParty,
  input: Record<string, unknown>,
): { requestId: string; promise: Promise<PermissionResult> } {
  const requestId = request.id;
  const promise = new Promise<PermissionResult>((resolve) => {
    entries.set(requestId, {
      requestId,
      sessionId: request.sessionId,
      tool: request.tool,
      ...(request.resource ? { resource: request.resource } : {}),
      input,
      origin,
      status: "open",
      createdAt: request.timestamp || Date.now(),
      decide: resolve,
    });
  });
  trimDecided();
  bump();
  return { requestId, promise };
}

/** 一条待批项是否仍在等待回答。 */
function pending(entry: Entry): boolean {
  return entry.status === "open";
}

/**
 * 回答一个待批请求。**只生效一次**。
 *
 * 失败码的含义（调用方应当把它们如实显示给用户，而不是当成成功）：
 * - `approval_not_pending`：找不到、已被处理、或已过期 —— 这正是"第二个回答方点了按钮"
 *   应得的答复（DSH 同款，`approvals.ts:78-79`）。
 * - `approval_invalid_action`：动作名不在 `allow` / `deny` 里。
 *
 * ⚠️ **刻意不支持"总是允许"**：`alwaysAllow` 一律为 false。远端在网络上，
 * 一个"以后都别问我"的按钮会让后面所有同类操作永久放行，而用户可能只是想在手机上
 * 快速点过这一步。桌面本地路径不受影响（它自己走 `pendingPermissions`）。
 */
export function answerApproval(
  requestId: string,
  action: "allow" | "deny",
  decidedBy: ApprovalParty,
): ApprovalAnswer {
  if (action !== "allow" && action !== "deny") {
    return { ok: false, code: "approval_invalid_action", message: "未知的批准操作。" };
  }
  const entry = entries.get(requestId);
  if (!entry || entry.status !== "open") {
    return {
      ok: false,
      code: "approval_not_pending",
      message: "这个权限请求已处理或已失效。",
    };
  }
  entry.status = "resolved";
  entry.decidedBy = decidedBy;
  entry.decidedAction = action;
  entry.decide(
    action === "allow"
      ? { requestId, action: "allow", alwaysAllow: false }
      : { requestId, action: "deny", alwaysAllow: false },
  );
  trimDecided();
  bump();
  return { ok: true, requestId, action, decidedBy };
}

/** 把一条内部记录转成对外视图（**唯一**转换点，防止两处形状分叉）。 */
function toView(entry: Entry): ApprovalView {
  return {
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    tool: entry.tool,
    ...(entry.resource ? { resource: entry.resource } : {}),
    input: entry.input,
    preview: summarizeApprovalInput(entry.input),
    origin: entry.origin,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(entry.decidedBy ? { decidedBy: entry.decidedBy } : {}),
    ...(entry.decidedAction ? { decidedAction: entry.decidedAction } : {}),
    responseRequired: entry.status === "open",
  };
}

/** 读待批项（默认只给仍在等待的那些；`includeDecided` 用于让界面显示"已被处理"）。 */
export function listApprovals(opts?: {
  sessionId?: string;
  includeDecided?: boolean;
  limit?: number;
}): ApprovalView[] {
  const sessionId = opts?.sessionId;
  const includeDecided = opts?.includeDecided === true;
  const limit = Math.max(1, Math.min(1000, opts?.limit ?? 200));
  const out: ApprovalView[] = [];
  for (const entry of entries.values()) {
    if (sessionId && entry.sessionId !== sessionId) continue;
    if (!includeDecided && !pending(entry)) continue;
    out.push(toView(entry));
  }
  return out.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
}

/** 读单条（桌面在为某个 id 渲染对话框时用）。 */
export function getApproval(requestId: string): ApprovalView | null {
  const entry = entries.get(requestId);
  return entry ? toView(entry) : null;
}

/**
 * 收尾某个会话的待批项（回合结束 / 被中止 / 被取消）。
 *
 * **一律按拒绝收尾**：这是 fail-closed。回合都不在了，"批准"没有任何意义，
 * 而放行一个没人看过的写操作是这里最坏的失败模式。
 *
 * @returns 被收尾的条数
 */
export function closeSessionApprovals(
  sessionId: string,
  reason: "turn_end" | "aborted" | "cancelled" = "turn_end",
): number {
  let closed = 0;
  for (const entry of entries.values()) {
    if (entry.sessionId !== sessionId || !pending(entry)) continue;
    entry.status = reason === "turn_end" ? "closed" : "expired";
    entry.decidedBy = entry.decidedBy ?? entry.origin;
    entry.decidedAction = "deny";
    entry.decide({ requestId: entry.requestId, action: "deny", alwaysAllow: false });
    closed++;
  }
  if (closed > 0) {
    trimDecided();
    bump();
  }
  return closed;
}

/** 收尾**所有**待批项（进程级收口：引擎销毁 / 全局取消）。 */
export function closeAllApprovals(reason: "aborted" | "cancelled" = "cancelled"): number {
  let closed = 0;
  for (const entry of entries.values()) {
    if (!pending(entry)) continue;
    entry.status = "expired";
    entry.decidedBy = entry.decidedBy ?? entry.origin;
    entry.decidedAction = "deny";
    entry.decide({ requestId: entry.requestId, action: "deny", alwaysAllow: false });
    closed++;
  }
  if (closed > 0) {
    trimDecided();
    bump();
  }
  return closed;
}

/** 只保留最近 `DECIDED_HISTORY_LIMIT` 条已决定的（防止长会话把表撑爆）。 */
function trimDecided(): void {
  const decided: Entry[] = [];
  for (const entry of entries.values()) if (!pending(entry)) decided.push(entry);
  const excess = decided.length - DECIDED_HISTORY_LIMIT;
  if (excess <= 0) return;
  decided.sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of decided.slice(0, excess)) entries.delete(entry.requestId);
}

/**
 * 待批项的**对外唯一入口**：登记请求并返回给引擎等待的 Promise。
 *
 * 它是 `registerApproval` 的薄封装，存在的意义是把**入参消毒钉在唯一一处** ——
 * 否则每个调用点各写一份截断逻辑，迟早分叉（本仓栽过多次"同一件事两处实现"）。
 * `registerApproval` 因此**不导出**。
 */
export function requestApproval(
  request: PermissionRequest,
  origin: ApprovalParty,
): Promise<PermissionResult> {
  const input = sanitizeApprovalInput(request.input);
  return registerApproval(request, origin, input).promise;
}

/** 测试用：清空（生产代码不该调它）。 */
export function __resetApprovalsForTests(): void {
  entries.clear();
  listeners.clear();
  revisionCounter = 0;
}

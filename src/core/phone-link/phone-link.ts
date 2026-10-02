/**
 * Phone Link — ①手机连接（dsh-phone 对标）的 WebView TS 引擎半层
 *
 * Rust（src-tauri/src/phone/）提供 LAN HTTP 地基：配对门卫（token URL + cookie）、
 * 静态手机页、把 /api/* 请求经事件 phone-request 代理上来；本模块：
 *   - 路由 phone-request → 真实数据（DB/引擎/桌面状态）→ invoke phone_respond
 *   - GET  /api/status                → 桌面当前项目/会话
 *   - GET  /api/sessions              → 全部项目会话（按最后消息倒序）
 *   - GET  /api/sessions/<id>/messages?limit=N → 会话消息
 *   - POST /api/chat {sessionId,text} → executeSessionTurn 驱动该会话一轮（手机续聊桌面会话）
 *   - POST /api/chat/new {text}       → 在当前项目开新会话并跑一轮
 *   - 监听 phone-state/phone-paired → 本地 CustomEvent（桌面设置卡 UI）
 *
 * 诚实标注：本模块不编造数据——所有内容来自 Codem 自身存储/引擎；手机端与
 * 桌面端看到的是同一会话、同一历史。明文 HTTP + LAN cookie 为 MVP 安全水位。
 */
import * as ProjectStorage from "../storage/project";
import * as SessionStorage from "../storage/session";
import * as MessageStorage from "../storage/message";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { useProjectStore } from "../store";
import { getLLMEngine } from "../llm";
import { executeSessionTurn, isSessionExecuting, cancelSessionExecution } from "../session";
/**
 * 第 122 轮阶段 0.1：手机端发起的回合**必须能回答权限请求**。
 *
 * 在此之前这里没传 `onPermissionRequest`，于是落到 `executor.ts:368-374` 的缺省策略
 * （full 放行，否则**自动拒绝**）：手机上发一句"帮我改一下这个文件"，
 * 需要批准的工具被**静默否掉**，用户看到的是"任务莫名没做"。
 *
 * 现在挂上审批代理：请求进待批表，手机页面弹卡片，**桌面也能答**（同一张表）。
 */
import { requestApproval, closeSessionApprovals, listApprovals, answerApproval, subscribeApprovals, approvalRevision } from "../permission/approval-broker";
/**
 * 阶段 2：事件流（把"轮询"换成"推"）。
 *
 * 手机页面原来每 2.6 秒打三个请求（messages / approvals / run）——
 * 在中继那条路上这是**跨网络的三次往返**。现在改成一次长轮询：
 * 只有真的变了才回数据，没变化时一个字节的数据都不发。
 */
import {
  emitPhoneEvent,
  waitPhoneEvents,
  eventsSince,
  EVENT_WAIT_DEFAULT_MS,
} from "./event-stream";
/** 阶段 4：多端在场感知 + 远端改模型/权限档。 */
import { noteRemoteSeen, getPresence, publishPresenceIfChanged } from "./presence";
import { verdictForRemoteSecurityChange, isLoosening } from "./remote-selections";
// 阶段 R4：按它的形状产出通知（与阶段 0 的审批读**同一份**状态，不搞两个真相）
import { noticeFromApproval, remoteActionToInternal, platformSessionId } from "./aa-notice";
// 阶段 R3'：它的选择标识（`dsh:model:` / `dsh:permission:`）—— 目录里附上、选择时解析
import { modelSelectionId, permissionSelectionId, decodeModelSelection, decodePermissionSelection } from "./dsh-selection-id";
import { resolveProviderForModel } from "../model-config";
import { MIMO_MODELS, getConfiguredApiModels } from "../model-config";
import { SECURITY_MODES, getEffectiveSecurityMode, setProjectSecurityMode, setGlobalSecurityMode } from "../permission/security-mode";

// ========== 类型与常量 ==========

export interface PhoneBridgeSettings {
  /** 应用启动时自动开启 LAN 服务（默认开）。 */
  autoStart?: boolean;
}

const KEY_SETTINGS = "codem-phone-link";
const MAX_SESSIONS = 300;
const TURN_TIMEOUT_MS = 8 * 60 * 1000;

export interface PhoneProxyRequest {
  reqId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
  /**
   * 阶段 4.3：**已经过 Rust 侧 cookie 鉴权**的设备身份。
   *
   * 由 `phone/mod.rs` 在 `auth_device` 之后填进来 —— 客户端**不能**自己声称，
   * 否则任何拿到 cookie 的人都能冒充另一台设备。
   */
  deviceId?: string | null;
  deviceIp?: string | null;
}

// ========== 设置 ==========

export function getPhoneSettings(): PhoneBridgeSettings {
  try {
    const s = getSettingJSON<Partial<PhoneBridgeSettings>>(KEY_SETTINGS, {});
    return { autoStart: s.autoStart !== false };
  } catch {
    return { autoStart: true };
  }
}

export function savePhoneSettings(patch: Partial<PhoneBridgeSettings>): void {
  const cur = getPhoneSettings();
  setSettingJSON(KEY_SETTINGS, { ...cur, ...patch });
}

// ========== 纯函数（可单测）==========

export type PhoneRoute =
  | { type: "status" }
  | { type: "sessions" }
  | { type: "messages"; sessionId: string }
  | { type: "chat" }
  | { type: "chat_new" }
  | { type: "chat_cancel" }
  | { type: "run"; sessionId: string }
  | { type: "approvals" }
  | { type: "approval_answer"; requestId: string }
  | { type: "events" }
  | { type: "presence" }
  | { type: "notices" }
  | { type: "catalog" }
  | { type: "selections" }
  | null;

/** 解析 Rust 代理上来的 path（不含 query）。limit 由调用方从 query 读取。 */
export function parsePhonePath(path: string): PhoneRoute {
  if (!path.startsWith("/api/")) return null;
  const rest = path.slice(4); // 去掉 "/api"
  if (rest === "/status") return { type: "status" };
  if (rest === "/sessions") return { type: "sessions" };
  if (rest === "/chat") return { type: "chat" };
  if (rest === "/chat/new") return { type: "chat_new" };
  if (rest === "/chat/cancel") return { type: "chat_cancel" };
  if (rest === "/approvals") return { type: "approvals" };
  if (rest === "/events") return { type: "events" };
  if (rest === "/presence") return { type: "presence" };
  if (rest === "/notices") return { type: "notices" };
  if (rest === "/catalog") return { type: "catalog" };
  if (rest === "/selections") return { type: "selections" };
  const m = /^\/sessions\/([^/]+)\/messages$/.exec(rest);
  if (m) {
    return { type: "messages", sessionId: m[1] };
  }
  const r = /^\/sessions\/([^/]+)\/run$/.exec(rest);
  if (r) {
    return { type: "run", sessionId: r[1] };
  }
  const a = /^\/approvals\/([^/]+)$/.exec(rest);
  if (a) {
    return { type: "approval_answer", requestId: a[1] };
  }
  return null;
}

export interface PhoneSessionView {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  updatedAt: number;
  createdAt: number;
  messageCount: number;
}

/** 手机上一条工具调用的**摘要**（不搬全文，见 `mapMessages`）。 */
export interface PhoneToolCallView {
  tool: string;
  status: string;
  /** 参数摘要（如命令 / 路径），有上限 */
  brief?: string;
  /** 结果摘要，有上限 */
  resultBrief?: string;
}

export interface PhoneMessageView {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /**
   * 阶段 0.4：工具调用摘要。
   *
   * 此前手机只拿到 `role/content/timestamp` —— 于是用户在手机上看会话，
   * 完全不知道 agent 干了什么：调了哪些工具、改过哪些文件、哪一步失败了。
   * 而这恰恰是"这个 agent 在干什么"的全部信息。
   */
  toolCalls?: PhoneToolCallView[];
  /** 阶段 0.4：思维链。**默认不在列表里返回**（见 `mapMessages` 的 `withReasoning`） */
  reasoning?: string;
  /** 本会话产生的文件（供手机看到"改了哪些文件"） */
  generatedFiles?: string[];
}

/** 工具调用摘要里各字段的字符上限（手机屏幕小，也不该为一次列表拉几百 KB）。 */
export const PHONE_TOOL_BRIEF_MAX_CHARS = 300;
/** 单条消息返回的工具调用条数上限。 */
export const PHONE_TOOL_CALLS_MAX = 20;
/** assistant 正文在手机视图里的字符上限。 */
export const PHONE_CONTENT_MAX_CHARS = 4000;
/** 思维链在手机视图里的字符上限。 */
export const PHONE_REASONING_MAX_CHARS = 1500;

function clipForPhone(text: string, max: number): string {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…（共 ${s.length} 字符）`;
}

/** 工具调用的参数摘要：优先给人看"干了什么"，而不是整包 JSON。 */
export function briefToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return clipForPhone(args, PHONE_TOOL_BRIEF_MAX_CHARS);
  const obj = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "target"]) {
    const v = obj?.[key];
    if (typeof v === "string" && v) return clipForPhone(v, PHONE_TOOL_BRIEF_MAX_CHARS);
  }
  try {
    return clipForPhone(JSON.stringify(obj), PHONE_TOOL_BRIEF_MAX_CHARS);
  } catch {
    return "";
  }
}

/**
 * 会话消息 → 手机视图（含 assistant 内容清理）。
 *
 * @param withReasoning 是否带上思维链。**默认 false**：
 *   一次 `limit=80` 的消息列表若每条都带思维链，响应会大一个量级，
 *   而多数时候用户只是想看对话。手机可以按需再要（见路由）。
 */
export function mapMessages(
  msgs: Array<{
    id: string;
    role: string;
    content?: string | null;
    timestamp: number;
    reasoning?: string | null;
    toolCalls?: Array<{ tool?: string; args?: unknown; result?: string; status?: string }>;
    generatedFiles?: string[];
  }>,
  withReasoning = false,
): PhoneMessageView[] {
  return msgs.map((m) => {
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls.slice(0, PHONE_TOOL_CALLS_MAX) : [];
    const toolCalls: PhoneToolCallView[] = calls.map((tc) => ({
      tool: String(tc?.tool ?? "(未知工具)"),
      status: String(tc?.status ?? ""),
      ...(briefToolArgs(tc?.args) ? { brief: briefToolArgs(tc?.args) } : {}),
      ...(tc?.result ? { resultBrief: clipForPhone(String(tc.result), PHONE_TOOL_BRIEF_MAX_CHARS) } : {}),
    }));
    return {
      id: m.id,
      role: (m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "assistant") as PhoneMessageView["role"],
      content: clipForPhone(cleanContent(m.content || ""), PHONE_CONTENT_MAX_CHARS),
      timestamp: m.timestamp,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(withReasoning && m.reasoning ? { reasoning: clipForPhone(m.reasoning, PHONE_REASONING_MAX_CHARS) } : {}),
      ...(Array.isArray(m.generatedFiles) && m.generatedFiles.length > 0 ? { generatedFiles: m.generatedFiles.slice(0, 20) } : {}),
    };
  });
}

/** 清掉 system-reminder 噪音，供手机端展示。 */
export function cleanContent(text: string): string {
  return (text || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

/** 全部项目会话拍平并倒序（真实数据，不编造）。
 *  内部项目（微信 ClawBot 工作区 wx-workspace）不进入手机列表——微信会话由
 *  微信通道自己管理（审计 P11）。 */
export function flattenSessions(): PhoneSessionView[] {
  const projects = ProjectStorage.listProjects().filter((p) => p.id !== "wx-workspace");
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  const out: PhoneSessionView[] = [];
  for (const p of projects) {
    for (const s of SessionStorage.listSessions(p.id)) {
      out.push({
        id: s.id,
        title: s.title || "(无标题)",
        projectId: p.id,
        projectName: nameOf.get(p.id) || "",
        updatedAt: s.lastMessageAt || s.createdAt,
        createdAt: s.createdAt,
        messageCount: s.messageCount || 0,
      });
    }
  }
  // 另含全局会话（projectId ""，种子项目行 id="" 存在）
  for (const s of SessionStorage.listSessions("")) {
    out.push({
      id: s.id,
      title: s.title || "(无标题)",
      projectId: "",
      projectName: "",
      updatedAt: s.lastMessageAt || s.createdAt,
      createdAt: s.createdAt,
      messageCount: s.messageCount || 0,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, MAX_SESSIONS);
}

// ========== 请求路由（引擎半层）==========

async function invokePhoneRespond(reqId: string, status: number, body: unknown): Promise<void> {
  try {
    const invoke = (window as any).__TAURI__?.core?.invoke;
    if (!invoke) return;
    await invoke("phone_respond", {
      reqId,
      status,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  } catch (e) {
    console.warn("[phone-link] respond failed:", e);
  }
}

let defaultCwdPromise: Promise<string> | null = null;
function defaultWorkspacePath(): Promise<string> {
  if (!defaultCwdPromise) {
    defaultCwdPromise = (async () => {
      try {
        const invoke = (window as any).__TAURI__?.core?.invoke;
        if (invoke) {
          const p = await invoke("get_default_cwd");
          if (typeof p === "string" && p) return p;
        }
      } catch { /* fallthrough */ }
      return "";
    })();
  }
  return defaultCwdPromise;
}

async function cwdForSession(sessionId: string): Promise<string> {
  const row = SessionStorage.getSession(sessionId);
  if (!row) return "";
  if (row.worktreePath) return row.worktreePath;
  const proj = ProjectStorage.getProject(row.projectId);
  if (proj?.path) return proj.path;
  return defaultWorkspacePath();
}

/**
 * 把"回合没能跑起来"写进会话（第 84 波）。
 *
 * 背景：`POST /api/chat` 是**先回 202 再后台跑**（完整 agent 回合可能几分钟，远超 Rust 代理的
 * 15s 超时），所以手机端只能靠轮询 messages 拿结果。原来前置校验失败（引擎未就绪 / 会话不存在 /
 * 无工作区 / 会话忙）只 `console.warn` —— **手机端看到"已发送、处理中"，然后永远没有回复**，
 * 而桌面上连一条错误都没有（这些失败发生在 executor 之前，executor 的落库覆盖不到）。
 *
 * 现在统一落一条 system/error 消息：手机上刷新就能看到"为什么没反应"。
 */
function noteTurnFailure(sessionId: string, reason: string): void {
  try {
    MessageStorage.createMessage({
      id: `phone-err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "system",
      content: `[手机端回合未启动] ${reason}`,
      timestamp: Date.now(),
      status: "error",
    }, sessionId);
  } catch (e) {
    console.warn("[phone-link] 写入失败提示失败（会话可能不存在）:", e);
  }
  console.warn(`[phone-link] 回合未启动（${sessionId}）：${reason}`);
}

/** 手机续聊桌面会话 / 开新会话并跑一轮（真实引擎回合）。 */
async function runAgentTurn(sessionId: string, text: string): Promise<{ ok: boolean; error?: string; noted?: boolean }> {
  const engine = getLLMEngine();
  if (!engine) {
    const reason = "引擎未就绪（LLM provider 未注册）";
    noteTurnFailure(sessionId, reason);
    return { ok: false, error: reason, noted: true };
  }
  if (isSessionExecuting(sessionId)) {
    const reason = "该会话正在处理中，请稍候再发";
    noteTurnFailure(sessionId, reason);
    return { ok: false, error: reason, noted: true };
  }
  const cwd = await cwdForSession(sessionId);
  if (!cwd) {
    const reason = "会话没有可用的工作区（项目路径为空，且没有默认目录）";
    noteTurnFailure(sessionId, reason);
    return { ok: false, error: reason, noted: true };
  }
  const row = SessionStorage.getSession(sessionId);
  if (!row) {
    const reason = `会话不存在：${sessionId}`;
    noteTurnFailure(sessionId, reason);
    return { ok: false, error: reason, noted: true };
  }
  SessionStorage.updateSession(sessionId, {
    lastMessageAt: Date.now(),
    messageCount: (row.messageCount || 0) + 1,
  });
  // 阶段 2：回合开始就推一条 —— 手机上的"进行中"状态条立刻出现，
  // 不用等下一次轮询（跨网络下那一等就是好几秒）。
  emitPhoneEvent("run", sessionId, { running: true, label: "正在处理" });
  // P8：整轮兜底超时（race 保证不把调用方/队列挂死在不产事件的回合）
  const timeout = setTimeout(() => {
    cancelSessionExecution(sessionId);
  }, TURN_TIMEOUT_MS);
  const timeoutRace = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("处理超时（长时间无响应，已中止）")), TURN_TIMEOUT_MS + 1500),
  );
  try {
    const res = await Promise.race([
      executeSessionTurn({
        sessionId,
        message: text,
        cwd,
        engine,
        /**
         * 阶段 0.1：权限请求交给审批代理，手机页面可以点「允许一次 / 拒绝」。
         * `origin: "phone"` 只用于界面措辞（"手机发起的回合在等批准"），不用于鉴权。
         */
        onPermissionRequest: (request) => {
          // 阶段 2：审批请求也要**推**给手机（否则用户要等到下一次轮询才看到卡片）
          const p = requestApproval(request, "phone");
          emitPhoneEvent("approval", sessionId, { requestId: request.id, tool: request.tool });
          return p;
        },
      }),
      timeoutRace,
    ]);
    if (!res.success) {
      /**
       * 第 84 波（审计修正）：这里原来返回 `{ ok: true, error }` —— **把失败改写成成功**，
       * 于是调用方（微信/手机）与日志都当它跑完了，手机端只能看到"[处理完成（无文本输出）]"。
       * 现在如实返回失败；executor 已经写过错误消息，所以 marked 记 true（不再重复写）。
       */
      return { ok: false, error: res.error || "回合失败（详见会话内的错误消息）", noted: true };
    }
    return { ok: true };
  } catch (err: any) {
    const reason = String(err?.message || err);
    // 超时/异常路径：executor 可能还没来得及落库 → 这里补一条，保证手机端看得见
    noteTurnFailure(sessionId, reason);
    return { ok: false, error: reason, noted: true };
  } finally {
    clearTimeout(timeout);
    /**
     * 阶段 0.1：**回合收尾必须收口待批项**。
     *
     * 审批代理刻意**不设超时**（与 `permission.ts:239-243` 的既有约定一致：
     * 用户在电脑前可以慢慢看）。但"不设超时"在远端会变成"手机没在看就永远挂着" ——
     * 所以由**调用方**在回合结束时收口，未回答的一律按**拒绝**（fail-closed）。
     *
     * 放在 `finally`：成功、失败、超时三条路都要收。成功时通常没有待批项，
     * 真有一条（竞态）也必须拒掉 —— 放行一个没人看过的写操作是最坏的失败模式。
     */
    closeSessionApprovals(sessionId, "turn_end");
    /**
     * 阶段 2：回合结束也要推一条 —— 手机上的"停止/进行中"状态条靠它收起。
     * 放在收口**之后**，这样客户端收到时看到的已经是最终状态（不会先看到
     * "回合结束"再看到一张还在的审批卡片）。
     */
    emitPhoneEvent("run", sessionId, { running: false });
  }
}

async function handleProxyRequest(req: PhoneProxyRequest): Promise<void> {
  const route = parsePhonePath(req.path);
  if (!route) {
    await invokePhoneRespond(req.reqId, 404, { error: "not_found" });
    return;
  }
  switch (route.type) {
    case "status": {
      const st = useProjectStore.getState();
      await invokePhoneRespond(req.reqId, 200, {
        ok: true,
        desktop: {
          project: st.currentProject ? { name: st.currentProject.name } : null,
          session: st.currentSession ? { id: st.currentSession.id, title: st.currentSession.title } : null,
        },
      });
      return;
    }
    case "sessions": {
      await invokePhoneRespond(req.reqId, 200, { ok: true, sessions: flattenSessions() });
      return;
    }
    case "messages": {
      try {
        const rawLimit = parseInt(String(req.query?.limit ?? "80"), 10);
        const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 80));
        /**
         * 阶段 0.4：思维链**按需**返回（`?reasoning=1`）。
         * 默认不带：80 条消息各带一段思维链会让响应大一个量级，
         * 而多数时候用户只是想看对话。
         */
        const withReasoning = req.query?.reasoning === "1" || req.query?.reasoning === "true";
        const msgs = MessageStorage.listMessages(route.sessionId, limit);
        await invokePhoneRespond(req.reqId, 200, { ok: true, messages: mapMessages(msgs, withReasoning) });
      } catch (e: any) {
        await invokePhoneRespond(req.reqId, 404, { error: String(e?.message || e) });
      }
      return;
    }
    case "chat": {
      let body: any = {};
      try { body = JSON.parse(req.body || "{}"); } catch { /* ignore */ }
      const sessionId = String(body.sessionId || "").trim();
      const text = String(body.text || "").trim();
      if (!sessionId || !text) {
        await invokePhoneRespond(req.reqId, 400, { error: "sessionId 与 text 必填" });
        return;
      }
      if (isSessionExecuting(sessionId)) {
        await invokePhoneRespond(req.reqId, 409, { error: "该会话正在处理中，请稍候" });
        return;
      }
      // F1：先回 202（已接受）再后台跑回合——完整 agent 回合可能数分钟，
      // 远超 Rust 代理 15s 超时；结果经手机端轮询 messages 可见，失败写库。
      await invokePhoneRespond(req.reqId, 202, { accepted: true, sessionId, note: "回合在桌面端后台执行，请轮询 /api/sessions/<id>/messages 查看结果" });
      void runAgentTurn(sessionId, text).then((res) => {
        // 失败已经写进会话（runAgentTurn 内部保证）；这里只留日志，绝不静默
        if (!res.ok) console.warn("[phone-link] chat turn failed:", res.error);
      });
      return;
    }
    case "chat_new": {
      let body: any = {};
      try { body = JSON.parse(req.body || "{}"); } catch { /* ignore */ }
      const text = String(body.text || "").trim();
      if (!text) {
        await invokePhoneRespond(req.reqId, 400, { error: "text 必填" });
        return;
      }
      // 在当前项目开新会话（无项目 → 全局会话）
      const st = useProjectStore.getState();
      const project = st.currentProject;
      const now = Date.now();
      const sessionId = `ph-${now.toString(36)}-${Math.random().toString(36).substr(2, 6)}`;
      SessionStorage.createSession({
        id: sessionId,
        projectId: project?.id || "",
        title: "手机新对话",
        createdAt: now,
        lastMessageAt: now,
        messageCount: 0,
      });
      // 同 chat：先 202 再后台执行
      await invokePhoneRespond(req.reqId, 202, { accepted: true, sessionId, note: "回合在桌面端后台执行，请轮询 /api/sessions/<id>/messages 查看结果" });
      void runAgentTurn(sessionId, text).then((res) => {
        if (!res.ok) console.warn("[phone-link] chat_new turn failed:", res.error);
      });
      return;
    }
    /**
     * 阶段 0.2：手机发起**中断**。
     *
     * 在此之前手机上发现跑偏了**没有任何办法停下来** —— 只能等 `TURN_TIMEOUT_MS`
     * （8 分钟）兜底超时。长回合里这 8 分钟是实打实的浪费与风险。
     *
     * `cancelSessionExecution` 走的是既有路径（`executor.ts:780-785`：abort controller），
     * 前台/后台共用 —— 与桌面端的取消是同一个动作，不引入第二套中断机制。
     */
    case "chat_cancel": {
      if (req.method !== "POST") {
        await invokePhoneRespond(req.reqId, 405, { error: "method_not_allowed" });
        return;
      }
      let body: any = {};
      try { body = JSON.parse(req.body || "{}"); } catch { /* ignore */ }
      const sessionId = String(body.sessionId || "").trim();
      if (!sessionId) {
        await invokePhoneRespond(req.reqId, 400, { error: "sessionId 必填" });
        return;
      }
      const wasRunning = isSessionExecuting(sessionId);
      cancelSessionExecution(sessionId);
      /**
       * 顺手收口这个会话的待批项：已经决定要停了，还挂着一个待批准没有意义，
       * 而且它会一直占着卡片。按拒绝收尾（fail-closed，与回合收尾同一取向）。
       */
      const closed = closeSessionApprovals(sessionId, "cancelled");
      await invokePhoneRespond(req.reqId, 200, { ok: true, wasRunning, closedApprovals: closed });
      return;
    }
    /**
     * 阶段 0.3：手机读"这一轮在干什么"。
     *
     * 此前手机只知道"我发过消息"和"消息里多了几条" —— 中间那段（在思考 / 在调工具 /
     * 在等批准）完全不可见，用户看到的就是一个静止的界面，然后忽然冒出一段结果。
     */
    case "run": {
      const sessionId = route.sessionId;
      const running = isSessionExecuting(sessionId);
      const approvals = listApprovals({ sessionId });
      const label = !running
        ? ""
        : approvals.length > 0
          ? "正在等待你的批准"
          : "助手处理中";
      await invokePhoneRespond(req.reqId, 200, {
        ok: true,
        run: {
          running,
          label,
          pendingApprovals: approvals.length,
        },
      });
      return;
    }
    /**
     * 阶段 2：事件流（长轮询）。
     *
     * `since` = 客户端已经处理到哪了（检查点）；`wait` = 最多挂多久。
     * 有变化立刻回，没变化到点回空。`reset: true` 表示检查点已失效，
     * 客户端必须**丢掉本地状态整批重取**（不许从现有缓冲里拼凑）。
     */
    case "events": {
      const since = parseInt(String(req.query?.since ?? "0"), 10);
      const sessionId = req.query?.sessionId || undefined;
      const rawWait = parseInt(String(req.query?.wait ?? String(EVENT_WAIT_DEFAULT_MS)), 10);
      const wait = Number.isFinite(rawWait) ? rawWait : EVENT_WAIT_DEFAULT_MS;
      // 有人订阅就顺手登记"这个会话要盯"（探测层据此决定看什么）
      noteWatched(sessionId);
      /**
       * 阶段 4.3：长轮询是**最可靠的在场信号** —— 手机只要在看着，
       * 就会每 10 秒挂一次。用它来维持在场，比另做一个心跳更省事也更准。
       */
      const changed = noteRemoteSeen(req.deviceId || "", req.deviceIp || "", sessionId);
      publishPresenceIfChanged(changed, sessionId);
      const batch = await waitPhoneEvents(
        Number.isFinite(since) ? since : 0,
        sessionId,
        wait,
      );
      await invokePhoneRespond(req.reqId, 200, { ok: true, ...batch });
      return;
    }
    /**
     * 阶段 4.1/4.2：远端读"能选什么、当前是什么"。
     *
     * 与 DSH 的 `catalog.listModels` + `listPermissions` 对应。
     * 我们把两个目录**合成一个**请求：手机打开选择面板时要的就是这两样，
     * 分两次请求在跨网络下只是多一次往返。
     */
    case "catalog": {
      const sessionId = req.query?.sessionId || "";
      const row = sessionId ? SessionStorage.getSession(sessionId) : null;
      const projectId = row?.projectId || useProjectStore.getState().currentProject?.id || "";
      const project = projectId ? ProjectStorage.getProject?.(projectId) : null;
      const projectPath = project?.path || "";
      // 手机侧的模型来自"当前执行模式"下的目录（与桌面聊天框同一个来源）
      const mode = (row as any)?.executionMode === "api" ? "api" : "cli";
      const models = mode === "cli" ? MIMO_MODELS : getConfiguredApiModels();
      await invokePhoneRespond(req.reqId, 200, {
        ok: true,
        catalog: {
          mode,
          /**
           * 阶段 R3'：给每个模型附上**它的** selectionId（`dsh:model:...`）。
           *
           * 远端（按它的词汇）会把这个 id 回传给我们，所以必须能算、
           * 也必须与解码侧对得上（`decodeModelSelection`）。
           *
           * provider 取不到时**不编一个**：宁可不给 `selectionId`
           * （那样远端就不会把这一项当成"可选"），也不发一个 `["","m",null]`
           * 这种谁也解不出来的东西。
           */
          models: models.map((m) => {
            const provider = (() => {
              try { return resolveProviderForModel(m.id) || ""; } catch { return ""; }
            })();
            return {
              id: m.id,
              name: m.name,
              ...(provider
                ? { selectionId: modelSelectionId({ provider, model: m.id }) }
                : {}),
            };
          }),
          currentModel: row?.model ?? null,
          security: {
            mode: getEffectiveSecurityMode(projectPath || undefined),
            // 远端只能收紧 ⇒ 把"能不能改"的判定**在服务端**给出，
            // 界面据此显示哪些档位可选（而不是让界面自己猜规则）
            options: SECURITY_MODES.map((s) => ({
              id: s.mode,
              label: s.label_zh,
              labelEn: s.label_en,
              description: s.desc_zh,
              descriptionEn: s.desc_en,
              icon: s.icon,
              // 阶段 R3'：它的权限档 selectionId（`dsh:permission:...`）
              selectionId: permissionSelectionId(s.mode),
              remoteAllowed: !isLoosening(getEffectiveSecurityMode(projectPath || undefined), s.mode),
            })),
            scope: projectPath ? "project" : "global",
          },
        },
      });
      return;
    }
    /**
     * 阶段 4.1/4.2：远端按会话改模型 / 收紧权限档。
     *
     * 模型随便改；权限档**只能收紧** —— 理由见 `remote-selections.ts`
     * （远端能放宽权限 = 能自己取消对自己的监督，那会让阶段 0 的整套审批失效）。
     */
    case "selections": {
      if (req.method !== "POST") {
        await invokePhoneRespond(req.reqId, 405, { error: "method_not_allowed" });
        return;
      }
      let body: any = {};
      try { body = JSON.parse(req.body || "{}"); } catch { /* ignore */ }
      const sessionId = String(body.sessionId || "").trim();
      if (!sessionId) {
        await invokePhoneRespond(req.reqId, 400, { error: "sessionId 必填" });
        return;
      }
      const row = SessionStorage.getSession(sessionId);
      if (!row) {
        await invokePhoneRespond(req.reqId, 404, { error: `会话不存在：${sessionId}` });
        return;
      }
      const projectId = row.projectId || useProjectStore.getState().currentProject?.id || "";
      const projectPath = (projectId ? ProjectStorage.getProject?.(projectId)?.path : "") || "";

      const applied: Record<string, unknown> = {};
      // ---- 模型 ----
      if (typeof body.model === "string" && body.model) {
        /**
         * 阶段 R3'：模型这一项接受**两种**写法——
         * 我们自己的模型 id，或**它的** `dsh:model:...` selectionId。
         *
         * 复刻那条路上的远端只会给后者（`selections.ts` 的 `parseSelections`
         * 要求值必须先解得出来）。这里解出 `(provider, model, effort)`，
         * 用其中的 `model` 去目录里查；`effort` 我们目前**没有**对应概念，
         * 所以**不假装**用上它（解出来了但不用，比悄悄丢掉一个字段更诚实）。
         */
        let modelId = body.model;
        if (modelId.startsWith("dsh:model:")) {
          try {
            modelId = decodeModelSelection(modelId).model;
          } catch (e: any) {
            await invokePhoneRespond(req.reqId, 400, {
              error: `无法解析这个 selectionId：${e?.message ?? e}`,
              code: "model_selection_invalid",
            });
            return;
          }
        }
        const mode = (row as any).executionMode === "api" ? "api" : "cli";
        const allowed = (mode === "cli" ? MIMO_MODELS : getConfiguredApiModels()).some((m) => m.id === modelId);
        if (!allowed) {
          await invokePhoneRespond(req.reqId, 400, {
            error: `这个模型不在当前目录里：${modelId}`,
            code: "model_not_in_catalog",
          });
          return;
        }
        SessionStorage.updateSession(sessionId, { model: modelId });
        applied.model = modelId;
      }
      // ---- 权限档（单向）----
      if (typeof body.securityMode === "string" && body.securityMode) {
        /**
         * 同样接受两种写法。注意 `dsh:permission:` 的解码会**顺带**拒绝
         * `custom`/空白/CRLF（那是它在 `selections.ts:38` 的规则）——
         * 也就是说"解得出"本身就完成了一次校验。
         */
        let nextMode = body.securityMode;
        if (nextMode.startsWith("dsh:permission:")) {
          try {
            nextMode = decodePermissionSelection(nextMode);
          } catch (e: any) {
            await invokePhoneRespond(req.reqId, 400, {
              error: `无法解析这个 selectionId：${e?.message ?? e}`,
              code: "permission_selection_invalid",
            });
            return;
          }
        }
        const current = getEffectiveSecurityMode(projectPath || undefined);
        const verdict = verdictForRemoteSecurityChange(current, nextMode);
        if (!verdict.ok) {
          // 如实拒绝 + 说清怎么办（不是含糊地说"不允许"）
          await invokePhoneRespond(req.reqId, 403, {
            ok: false,
            code: verdict.code,
            message: verdict.message,
            current,
          });
          return;
        }
        if (projectPath) setProjectSecurityMode(projectPath, nextMode as any);
        else setGlobalSecurityMode(nextMode as any);
        applied.securityMode = nextMode;
        applied.securityScope = projectPath ? "project" : "global";
      }
      await invokePhoneRespond(req.reqId, 200, { ok: true, applied });
      // 选择变了 ⇒ 推一条（另一个回答方/另一台设备的界面立刻跟上）
      emitPhoneEvent("run", sessionId, { selectionsChanged: true });
      return;
    }
    /**
     * 阶段 4.3：多端在场（谁在看、谁在答）。
     *
     * 审批是一张**共用**的表，所以"还有别人在看"这件事必须可见 ——
     * 否则用户会以为只有自己在看，或者在"已被处理"时不知道为什么。
     */
    case "presence": {
      await invokePhoneRespond(req.reqId, 200, { ok: true, presence: getPresence() });
      return;
    }
    /**
     * 阶段 0.1：手机读待批权限请求。
     * `?sessionId=` 可选；带上 `includeDecided=1` 能看到"已被桌面处理"的（界面据此收起按钮）。
     */
    /**
     * 阶段 R4：按**它的**形状返回通知（`ProtocolNotice` 的 DSH 子集）。
     *
     * 与 `/api/approvals` 并存而不是替换：那条是我们自己的形状（阶段 0 就在用，
     * 有判据钉着），这条是**复刻它**的那条路。两者读的是**同一份**状态
     * （`listApprovals`），所以不会出现"两个真相" —— 这一点很要紧。
     */
    case "notices": {
      const sessionId = req.query?.sessionId || undefined;
      const namespace = req.query?.namespace || "codem";
      const platformId = platformSessionId(namespace, sessionId || "default");
      const entries = listApprovals({ sessionId, includeDecided: true });
      await invokePhoneRespond(req.reqId, 200, {
        ok: true,
        revision: approvalRevision(),
        notices: entries.map((a) =>
          noticeFromApproval(
            {
              requestId: a.requestId,
              tool: a.tool,
              /**
               * 字段对映（不是照抄名字）：
               * - 它的 `reason` = "给用户看的那段话" ⇒ 我们的 `preview`
               *   （我们的 `preview` 由**已消毒**的 input 渲染而来，有长度上限）
               * - 它的 `callId` 是工具调用链上的 id，我们目前没有这个概念 ⇒ 不传
               *   （`context` 里就**不会**出现这个键，而不是出现一个 null）
               */
              ...(a.preview ? { reason: a.preview } : {}),
              status: a.status,
              revision: a.revision,
            },
            platformId,
          ),
        ),
      });
      return;
    }
    case "approvals": {
      const sessionId = req.query?.sessionId || undefined;
      const includeDecided = req.query?.includeDecided === "1" || req.query?.includeDecided === "true";
      await invokePhoneRespond(req.reqId, 200, {
        ok: true,
        approvals: listApprovals({ sessionId, includeDecided }),
      });
      return;
    }
    /**
     * 阶段 0.1：手机回答一个权限请求。
     * 体是 `{ action: "allow" | "deny" }`；**只生效一次**（第二次会拿到
     * `approval_not_pending`，且不会改写已有结果 —— 见 `approval-broker.ts`）。
     */
    case "approval_answer": {
      if (req.method !== "POST") {
        await invokePhoneRespond(req.reqId, 405, { error: "method_not_allowed" });
        return;
      }
      let body: any = {};
      try { body = JSON.parse(req.body || "{}"); } catch { /* ignore */ }
      const rawAction = String(body.action || "");
      /**
       * 阶段 R4：接受**两套**动作词汇，但都要显式映射：
       * - 我们自己的 `allow` / `deny`（手机页面用）
       * - 它的 `allow-once` / `reject`（复刻那条路上的远端）
       *
       * 不认识的**一律拒绝**（不猜、不做"看起来像 allow 就算 allow"的模糊匹配）。
       */
      const action = rawAction === "allow" || rawAction === "deny"
        ? (rawAction as "allow" | "deny")
        : remoteActionToInternal(rawAction);
      if (!action) {
        await invokePhoneRespond(req.reqId, 400, {
          error: "action 必须是 allow/deny（本地）或 allow-once/reject（远端）",
        });
        return;
      }
      const out = answerApproval(route.requestId, action, "phone");
      // 阶段 2：回答完要推一条，让**另一个**回答方（桌面）的卡片立刻收起。
      // 不推的话，桌面那张卡片要等到下一次用户交互才会消失 —— 而它看起来
      // 还"可以点"，点了只会拿到"已被处理"。
      if (out.ok) {
        const view = listApprovals({ includeDecided: true }).find((a) => a.requestId === route.requestId);
        emitPhoneEvent("approval", view?.sessionId, { requestId: route.requestId, answered: action });
      }
      // 失败码如实回给手机（界面据此显示"这个请求已被处理或已失效"，而不是假装成功）
      await invokePhoneRespond(req.reqId, out.ok ? 200 : 409, out);
      return;
    }
    default:
      await invokePhoneRespond(req.reqId, 404, { error: "not_found" });
  }
}

// ========== 阶段 2：变化探测（把轮询从"跨网络"挪到"进程内"）==========

/**
 * 桌面侧的**变化探测**。
 *
 * ## 为什么要有这一层
 *
 * 事件流要能推，前提是"有人知道变了"。最直接的做法是去 hook 每一处写消息的地方
 * （`MessageStorage.createMessage` 等），但那要改动很多既有代码，而且**漏一处就永久漏推**
 * （那种缺陷表现为"手机上某类变化永远不刷新"，极难归因）。
 *
 * 折中方案：在**进程内**每秒看一眼"手机正在看的那个会话"变没变。
 * - 代价：桌面每秒做一次内存读取（几乎免费）；
 * - 收益：手机**跨网络的轮询彻底消失**，只在真的变了时才收数据。
 *
 * 这正是把轮询成本从"网络往返"降到"内存比对"。缺点是探测粒度是 1 秒
 * （变化最迟 1 秒后可见），对"看会话"这个场景完全够用。
 *
 * ## 只看"有人正在看"的东西
 *
 * `watched` 里只登记最近被订阅过的会话（30 秒内），没有订阅者时
 * 这个定时器什么都不做 —— 不能因为"手机曾经连过"就一直空转。
 */
interface WatchState {
  /** sessionId → 上一次的签名 */
  sigs: Map<string, string>;
  /** sessionId → 最近一次被订阅的时刻 */
  watched: Map<string, number>;
  timer: ReturnType<typeof setInterval> | null;
  /** 会话列表的签名 */
  listSig: string;
}

const watch: WatchState = { sigs: new Map(), watched: new Map(), timer: null, listSig: "" };
/** 一个会话被订阅后，我们盯它多久（用户关了页面就不再盯）。 */
const WATCH_TTL_MS = 30_000;

/** 会话消息的**廉价签名**：条数 + 最后一条的 id/时间。 */
function messagesSig(sessionId: string): string {
  try {
    const msgs = MessageStorage.listMessages(sessionId, 1);
    const last = msgs && msgs.length > 0 ? msgs[msgs.length - 1] : null;
    // 注意：listMessages(id, limit) 的语义是"最近 limit 条"，
    // 这里只要最后一条即可 —— 用它 + 会话行上的 messageCount 一起判断
    const row = SessionStorage.getSession(sessionId);
    return `${row?.messageCount ?? 0}:${last?.id ?? ""}:${last?.timestamp ?? 0}`;
  } catch {
    return "";
  }
}

function sessionsSig(): string {
  try {
    const list = flattenSessions();
    // 只取"会影响列表显示"的字段，避免把无关变化也算成变化
    return list.map((s) => `${s.id}:${s.updatedAt}:${s.messageCount}`).join("|");
  } catch {
    return "";
  }
}

function tickWatch(): void {
  const now = Date.now();
  // 过期的会话不再盯
  for (const [sid, at] of [...watch.watched]) {
    if (now - at > WATCH_TTL_MS) {
      watch.watched.delete(sid);
      watch.sigs.delete(sid);
    }
  }
  for (const sid of watch.watched.keys()) {
    const sig = messagesSig(sid);
    const prev = watch.sigs.get(sid);
    if (prev === undefined) {
      watch.sigs.set(sid, sig); // 首次登记不算变化（否则会推一条假的）
      continue;
    }
    if (sig !== prev) {
      watch.sigs.set(sid, sig);
      emitPhoneEvent("messages", sid);
    }
  }
  // 会话列表：只要有订阅者就盯
  if (watch.watched.size > 0) {
    const ls = sessionsSig();
    if (watch.listSig === "") watch.listSig = ls;
    else if (ls !== watch.listSig) {
      watch.listSig = ls;
      emitPhoneEvent("sessions");
    }
  }
}

function ensureWatcher(): void {
  if (watch.timer || typeof setInterval === "undefined") return;
  watch.timer = setInterval(tickWatch, 1000);
}

/** 登记"有人在看这个会话"（由事件路由调用）。 */
function noteWatched(sessionId: string | undefined): void {
  if (!sessionId) return;
  watch.watched.set(sessionId, Date.now());
  ensureWatcher();
}

/** 测试用：清空探测状态。 */
export function __resetWatchForTests(): void {
  if (watch.timer) clearInterval(watch.timer);
  watch.timer = null;
  watch.sigs.clear();
  watch.watched.clear();
  watch.listSig = "";
}

/** 测试用：手动跑一轮探测。 */
export function __tickWatchForTests(): void {
  tickWatch();
}

/** 测试用：当前在盯的会话。 */
export function __watchedForTests(): string[] {
  return [...watch.watched.keys()];
}

// ========== 状态缓存 / 事件 ==========

export interface PhoneStateView {
  running: boolean;
  port: number;
  lan_ip: string;
  url?: string | null;
  pair_url?: string | null;
  /**
   * 第 122 轮阶段 1：局域网侧**只有 HTTPS**。
   *
   * 保留这个字段是为了界面能**如实**显示协议，而不是靠拼接字符串猜。
   * 它取的是 Rust 侧真值（`https: true`），不是"我们觉得应该是 https"。
   */
  https?: boolean;
  /** CA 指纹（大写 hex，冒号分隔）—— 用户要在手机上**带外核对**的那串字 */
  ca_fingerprint?: string;
  /** CA 证书下载地址（手机安装用） */
  ca_url?: string | null;
  pairing?: {
    active: boolean;
    expires_at_ms: number;
    decided?: boolean | null;
    waiting: boolean;
  } | null;
  devices: Array<{ id: string; ip: string; paired_at_ms: number; last_seen_ms: number }>;
}

export const EVT_STATE = "codem:phone-state";
export const EVT_PAIRED = "codem:phone-paired";

/**
 * 出站 connector（远程中继）的状态视图 —— 第 122 轮 §11D。
 *
 * 字段与 Rust 侧 `connector::snapshot` 一一对应；`serverUrl` / `connectorId`
 * **如实透传**，界面不许自己编（用户要靠 connectorId 在中继上认出这台机器）。
 */
export interface RelayStateView {
  running: boolean;
  connected: boolean;
  serverUrl: string;
  connectorId: string;
  lastError: string | null;
  lastBeatMs: number;
  requestsServed: number;
  errors: number;
  reconnects: number;
  reconnectSeconds: number;
}

/** 连接阶段（界面据此措辞；**不许**在没连上时说"已连接"）。 */
export type RelayPhase = "stopped" | "connecting" | "connected" | "error";

export function normalizeRelay(raw: any): RelayStateView {
  return {
    running: raw?.running === true,
    connected: raw?.connected === true,
    serverUrl: raw?.serverUrl || "",
    connectorId: raw?.connectorId || "",
    lastError: raw?.lastError ?? null,
    lastBeatMs: raw?.lastBeatMs || 0,
    requestsServed: raw?.requestsServed || 0,
    errors: raw?.errors || 0,
    reconnects: raw?.reconnects || 0,
    reconnectSeconds: raw?.reconnectSeconds || 3,
  };
}

/**
 * 把若干字段压成一个**互斥**的阶段。
 *
 * 判据顺序不是随便定的：
 * 1. `!running` ⇒ `stopped`（用户关掉了，此时计数都无意义）
 * 2. `connected` ⇒ `connected`（**只有真连上才敢这么说**）
 * 3. 有 `lastError` ⇒ `error`（连不上**且**有原因，必须如实显示原因）
 * 4. 剩下的才是 `connecting`（在跑、没连上、也还没有错误 = 正在重连）
 *
 * 第 3 条排在第 4 条之前是有意的：**"正在连接"与"上次报错了"必须分开**，
 * 否则用户看不到失败原因，只会觉得一直在转圈。
 */
export function relayPhase(r: RelayStateView): RelayPhase {
  if (!r.running) return "stopped";
  if (r.connected) return "connected";
  if (r.lastError) return "error";
  return "connecting";
}

let stateCache: PhoneStateView = { running: false, port: 0, lan_ip: "", devices: [] };
export function getPhoneStateCache(): PhoneStateView {
  return stateCache;
}

export function normalizeState(raw: any): PhoneStateView {
  return {
    running: !!raw?.running,
    port: raw?.port || 0,
    lan_ip: raw?.lan_ip || "",
    url: raw?.url ?? null,
    pair_url: raw?.pair_url ?? null,
    // 阶段 1 的三个新字段：**原样透传**，不在这里编默认值 ——
    // 界面据此显示"HTTPS + 指纹"，而"缺字段"应当是可见的（显示为空），
    // 不该被一个看起来合理的默认值掩盖。
    https: raw?.https === true,
    ca_fingerprint: raw?.ca_fingerprint || "",
    ca_url: raw?.ca_url ?? null,
    pairing: raw?.pairing ?? null,
    devices: Array.isArray(raw?.devices) ? raw.devices : [],
  };
}

let bridgeStarted = false;
export function startPhoneLink(): () => void {
  if (bridgeStarted) return () => {};
  bridgeStarted = true;

  const tauri: any = (window as any).__TAURI__;
  if (!tauri?.event?.listen || !tauri?.core?.invoke) {
    bridgeStarted = false;
    return () => {};
  }
  const listen = tauri.event.listen.bind(tauri.event);
  const invoke = tauri.core.invoke.bind(tauri.core);
  /**
   * 阶段 2：把**审批代理**的变化也接进事件流。
   *
   * 覆盖"桌面回答的"那一半：手机上的审批卡片要立刻收起。
   * （手机自己回答的那一半在路由里单独推，因为那里还知道是哪个会话。）
   * 刻意**不判断"是谁改的"** —— 让客户端以服务端状态为准更简单也更准。
   */
  const offApprovals = subscribeApprovals(() => {
    emitPhoneEvent("approval", undefined, { changed: true });
  });
  const unlisteners: Array<() => void> = [];
  const fire = (name: string, detail: unknown) => {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch { /* noop */ }
  };
  const on = (evt: string, h: (payload: any) => void) => {
    try {
      listen(evt, (e: any) => h(e.payload)).then((un: () => void) => unlisteners.push(un)).catch(() => {});
    } catch { /* noop */ }
  };

  on("phone-state", (p) => {
    stateCache = normalizeState(p);
    fire(EVT_STATE, stateCache);
  });
  on("phone-paired", (p) => fire(EVT_PAIRED, p));
  on("phone-request", (p: any) => {
    if (p?.reqId) {
      handleProxyRequest({
        reqId: p.reqId,
        method: p.method || "GET",
        path: p.path || "/",
        query: p.query || {},
        body: p.body || "",
        // 阶段 4.3：设备身份来自 Rust 侧鉴权结果（不是客户端自称）
        deviceId: p.deviceId ?? null,
        deviceIp: p.deviceIp ?? null,
      }).catch((e) => console.warn("[phone-link] handle failed:", e));
    }
  });

  // 启动即同步一次状态；autoStart → 拉起 LAN 服务（幂等）
  invoke("phone_status").then((st: any) => {
    stateCache = normalizeState(st);
    fire(EVT_STATE, stateCache);
  }).catch(() => {});
  if (getPhoneSettings().autoStart) {
    invoke("phone_start").then((st: any) => {
      stateCache = normalizeState(st);
      fire(EVT_STATE, stateCache);
    }).catch(() => {});
  }

  return () => {
    bridgeStarted = false;
    // 阶段 2：退订审批变化 + 停掉变化探测（否则定时器会活过 bridge 的生存期）
    try { offApprovals(); } catch { /* noop */ }
    __resetWatchForTests();
    unlisteners.forEach((u) => {
      try { u(); } catch { /* noop */ }
    });
    unlisteners.length = 0;
  };
}

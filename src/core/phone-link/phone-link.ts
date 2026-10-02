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
import { requestApproval, closeSessionApprovals, listApprovals, answerApproval } from "../permission/approval-broker";

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
        onPermissionRequest: (request) => requestApproval(request, "phone"),
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
     * 阶段 0.1：手机读待批权限请求。
     * `?sessionId=` 可选；带上 `includeDecided=1` 能看到"已被桌面处理"的（界面据此收起按钮）。
     */
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
      const action = String(body.action || "");
      if (action !== "allow" && action !== "deny") {
        await invokePhoneRespond(req.reqId, 400, { error: "action 必须是 allow 或 deny" });
        return;
      }
      const out = answerApproval(route.requestId, action, "phone");
      // 失败码如实回给手机（界面据此显示"这个请求已被处理或已失效"，而不是假装成功）
      await invokePhoneRespond(req.reqId, out.ok ? 200 : 409, out);
      return;
    }
    default:
      await invokePhoneRespond(req.reqId, 404, { error: "not_found" });
  }
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
    unlisteners.forEach((u) => {
      try { u(); } catch { /* noop */ }
    });
    unlisteners.length = 0;
  };
}

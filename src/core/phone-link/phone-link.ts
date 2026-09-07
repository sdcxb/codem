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
  | null;

/** 解析 Rust 代理上来的 path（不含 query）。limit 由调用方从 query 读取。 */
export function parsePhonePath(path: string): PhoneRoute {
  if (!path.startsWith("/api/")) return null;
  const rest = path.slice(4); // 去掉 "/api"
  if (rest === "/status") return { type: "status" };
  if (rest === "/sessions") return { type: "sessions" };
  if (rest === "/chat") return { type: "chat" };
  if (rest === "/chat/new") return { type: "chat_new" };
  const m = /^\/sessions\/([^/]+)\/messages$/.exec(rest);
  if (m) {
    return { type: "messages", sessionId: m[1] };
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

export interface PhoneMessageView {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
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

/** 会话消息 → 手机视图（含 assistant 内容清理）。 */
export function mapMessages(msgs: Array<{ id: string; role: string; content?: string | null; timestamp: number }>): PhoneMessageView[] {
  return msgs.map((m) => ({
    id: m.id,
    role: (m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "assistant") as PhoneMessageView["role"],
    content: cleanContent(m.content || ""),
    timestamp: m.timestamp,
  }));
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

/** 手机续聊桌面会话 / 开新会话并跑一轮（真实引擎回合）。 */
async function runAgentTurn(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const engine = getLLMEngine();
  if (!engine) return { ok: false, error: "引擎未就绪" };
  if (isSessionExecuting(sessionId)) return { ok: false, error: "该会话正在处理中，请稍候" };
  const cwd = await cwdForSession(sessionId);
  if (!cwd) return { ok: false, error: "会话无工作区" };
  const row = SessionStorage.getSession(sessionId);
  if (!row) return { ok: false, error: "会话不存在" };
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
      executeSessionTurn({ sessionId, message: text, cwd, engine }),
      timeoutRace,
    ]);
    if (!res.success) {
      // 引擎报错也要让手机端能看到——executor 已写 error 消息进库。
      return { ok: true, error: res.error || undefined };
    }
    return { ok: true };
  } catch (err: any) {
    console.warn("[phone-link] turn error:", err);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(timeout);
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
        const msgs = MessageStorage.listMessages(route.sessionId, limit);
        await invokePhoneRespond(req.reqId, 200, { ok: true, messages: mapMessages(msgs) });
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
      await invokePhoneRespond(req.reqId, 202, { accepted: true, sessionId });
      void runAgentTurn(sessionId, text).then((res) => {
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
      await invokePhoneRespond(req.reqId, 202, { accepted: true, sessionId });
      void runAgentTurn(sessionId, text).then((res) => {
        if (!res.ok) console.warn("[phone-link] chat_new turn failed:", res.error);
      });
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

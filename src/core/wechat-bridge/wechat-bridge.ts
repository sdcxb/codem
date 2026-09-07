/**
 * WeChat Bridge — 微信 ClawBot（iLink 协议）Codem 引擎桥（实现线 A 的 TS 半层）
 *
 * Rust 侧（src-tauri/src/ilink/）负责传输：登录状态机 / getupdates 长轮询 /
 * 发送 / 会话文件 / 配额记账，对外暴露 ilink_* commands + ilink-* events。
 * 本模块负责"引擎半层"：
 *   - 监听 ilink-inbound（+ ilink_status 挂载前缓冲兜底，按 message_id 去重）
 *   - peer → Codem 持久会话映射（sessions 行先行，FK 约束；历史只依赖 messages 表）
 *   - 命令短路（/help /status /new /attach /model /clear /reconnect /allow /ignore）
 *   - 白名单准入（owner=ilink_user_id 默认放行；陌生 peer → 待批准）
 *   - 经 executeSessionTurn 驱动一次 agentic turn，取回最终文本 → ilink_send_text
 *
 * 设计依据：.eac-analysis/wechat-ilink-report.md §9；headless 会话配方调研
 * （AgenticLoop 每轮 buildMessages 读 messages 表；executor 不自举会话，
 *   必须先建 sessions 行，否则 messages.session_id FK 报错）。
 *
 * 合规：10 条/24h 配额为社区实测，非官方承诺——本端依赖 Rust 软记账，
 * 发送失败（配额/网络）只在日志记录，不重试轰炸。
 */
import * as SessionStorage from "../storage/session";
import * as ProjectStorage from "../storage/project";
import { initDatabase } from "../storage/database";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { getLLMEngine } from "../llm";
import {
  executeSessionTurn,
  isSessionExecuting,
  cancelSessionExecution,
} from "../session";

// ========== 类型 ==========

export type WechatLinkState =
  | "disconnected"
  | "waiting_qr"
  | "waiting_scan"
  | "need_verify_code"
  | "connected"
  | "expired";

export interface InboundMessage {
  peer: string;
  text: string;
  message_id: string;
  create_time_ms?: number | null;
}

export interface WechatStatus {
  state: WechatLinkState;
  qrcode_url?: string | null;
  bot_id?: string;
  user_id?: string;
  expires_at_ms?: number | null;
  last_error?: string | null;
  last_inbound_at?: number | null;
  last_outbound_at?: number | null;
  inbound_count: number;
  outbound_count: number;
  peer_count: number;
  quota?: Array<{ peer: string; sent: number; window_start_ms: number }>;
  pending?: InboundMessage[];
}

/** 桥设置（SQLite settings 表，key=KEY_SETTINGS）。插件启停由插件管理器负责。 */
export interface WechatBridgeSettings {
  /** 停用开关：关掉后不响应任何微信消息（含白名单）。默认开。 */
  enabled?: boolean;
  /** 默认模型名（留空 = 引擎默认）；每 peer 可覆盖。 */
  model?: string;
  /** 默认工作区目录（留空 = 应用默认工作区）。 */
  workspacePath?: string;
}

/** peer → Codem 会话映射（重启续会话）。 */
export interface PeerEntry {
  sessionId: string;
  cwd?: string;
  model?: string;
  createdAt: number;
}

export interface PeerAccess {
  allow: string[];
  block: string[];
  pending: Array<{ peer: string; text: string; at: number }>;
}

// ========== 常量 ==========

const KEY_SETTINGS = "codem-wechat-bridge";
const KEY_PEER_MAP = "codem-wechat-peer-map";
const KEY_ACCESS = "codem-wechat-access";
/** 专用工作区项目（project 行先行，避免 FK；UI 侧可见为独立项目）。 */
const WX_PROJECT_ID = "wx-workspace";
/** 单条回复安全上限（Rust 单条 ≤2000，配额按条计——压缩成一条）【§4.2/§7.2】。 */
const REPLY_MAX = 1900;
const TURN_TIMEOUT_MS = 8 * 60 * 1000;

const COMMANDS = new Set([
  "help",
  "status",
  "new",
  "attach",
  "model",
  "clear",
  "reconnect",
  "allow",
  "ignore",
]);

// ========== 纯工具（可单测）==========

/** peer(@im.wechat) → 文件/DB 安全的会话 id 段。 */
export function sanitizePeerId(peer: string): string {
  const s = peer.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (s || "peer").slice(0, 72);
}

/** 识别命令：/name arg。未知 / 前缀按普通文本返回 null（agent 自由对话）。 */
export function parseCommand(text: string): { name: string; arg: string } | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const sp = t.indexOf(" ");
  const raw = sp === -1 ? t.slice(1) : t.slice(1, sp);
  const name = raw.toLowerCase();
  const arg = sp === -1 ? "" : t.slice(sp + 1).trim();
  if (!COMMANDS.has(name)) return null;
  return { name, arg };
}

export function truncateReply(text: string, max = REPLY_MAX): string {
  const clean = (text || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + "\n…（内容过长已截断）";
}

export function classifyPeer(access: PeerAccess, peer: string, ownerUserId: string): "owner" | "allowed" | "blocked" | "unknown" {
  if (ownerUserId && peer === ownerUserId) return "owner";
  if (access.block.includes(peer)) return "blocked";
  if (access.allow.includes(peer)) return "allowed";
  return "unknown";
}

export function addPeerToAllow(access: PeerAccess, peer: string): PeerAccess {
  return {
    allow: access.allow.includes(peer) ? access.allow : [...access.allow, peer],
    block: access.block.filter((p) => p !== peer),
    pending: access.pending.filter((p) => p.peer !== peer),
  };
}

export function blockPeer(access: PeerAccess, peer: string): PeerAccess {
  return {
    allow: access.allow.filter((p) => p !== peer),
    block: access.block.includes(peer) ? access.block : [...access.block, peer],
    pending: access.pending.filter((p) => p.peer !== peer),
  };
}

/** 陌生 peer 进入待批准（不重复）。 */
export function pendPeer(access: PeerAccess, peer: string, text: string, at: number): PeerAccess {
  if (access.pending.some((p) => p.peer === peer)) return access;
  const pending = [...access.pending, { peer, text: text.slice(0, 200), at }];
  return { ...access, pending: pending.slice(-50) };
}

// ========== 设置 / 存取 ==========

export function getSettings(): WechatBridgeSettings {
  try {
    const s = getSettingJSON<Partial<WechatBridgeSettings>>(KEY_SETTINGS, {});
    return {
      enabled: s.enabled !== false,
      model: s.model || "",
      workspacePath: s.workspacePath || "",
    };
  } catch {
    return { enabled: true, model: "", workspacePath: "" };
  }
}

export function saveSettings(patch: Partial<WechatBridgeSettings>): void {
  const cur = getSettings();
  setSettingJSON(KEY_SETTINGS, { ...cur, ...patch });
}

export function loadPeerMap(): Record<string, PeerEntry> {
  try {
    const m = getSettingJSON<Record<string, PeerEntry>>(KEY_PEER_MAP, {});
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

export function savePeerMap(map: Record<string, PeerEntry>): void {
  setSettingJSON(KEY_PEER_MAP, map);
}

export function loadAccess(): PeerAccess {
  const d: PeerAccess = { allow: [], block: [], pending: [] };
  try {
    const a = getSettingJSON<Partial<PeerAccess>>(KEY_ACCESS, {});
    return {
      allow: Array.isArray(a.allow) ? a.allow : [],
      block: Array.isArray(a.block) ? a.block : [],
      pending: Array.isArray(a.pending) ? a.pending : [],
    };
  } catch {
    return d;
  }
}

export function saveAccess(a: PeerAccess): void {
  setSettingJSON(KEY_ACCESS, a);
}

// ========== 运行态（单例；App 挂载时 startWechatBridge）==========

/** 最近状态缓存（来自 ilink-status/ilink-state）；UI 面板与桥共用。 */
let stateCache: WechatStatus = {
  state: "disconnected",
  inbound_count: 0,
  outbound_count: 0,
  peer_count: 0,
};
export function getStateCache(): WechatStatus {
  return stateCache;
}

function normalizeStatus(raw: any): WechatStatus {
  return {
    state: (raw?.state as WechatLinkState) || "disconnected",
    qrcode_url: raw?.qrcode_url ?? null,
    bot_id: raw?.bot_id || "",
    user_id: raw?.user_id || "",
    expires_at_ms: raw?.expires_at_ms ?? null,
    last_error: raw?.last_error ?? null,
    last_inbound_at: raw?.last_inbound_at ?? null,
    last_outbound_at: raw?.last_outbound_at ?? null,
    inbound_count: raw?.inbound_count || 0,
    outbound_count: raw?.outbound_count || 0,
    peer_count: raw?.peer_count || 0,
    quota: raw?.quota || [],
    pending: raw?.pending || [],
  };
}
export { normalizeStatus };

/** 本地 UI 事件名（window CustomEvent，供设置面板/任何组件订阅）。 */
export const EVT_STATE = "codem:wechat-state";
export const EVT_QR = "codem:wechat-qr";
export const EVT_NEED_VERIFY = "codem:wechat-need-verify";
export const EVT_EXPIRED = "codem:wechat-expired";

/** App 启动后调用；返回 cleanup。非 Tauri 环境自动空转（测试安全）。 */
let bridgeStarted = false;
export function startWechatBridge(): () => void {
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

  on("ilink-state", (p) => {
    stateCache = normalizeStatus(p);
    fire(EVT_STATE, stateCache);
  });
  on("ilink-qr", (p) => fire(EVT_QR, p));
  on("ilink-need-verify", (p) => fire(EVT_NEED_VERIFY, p));
  on("ilink-expired", (p) => fire(EVT_EXPIRED, p));
  on("ilink-inbound", (p: any) => {
    if (p && p.peer && p.text) {
      enqueueInbound({
        peer: p.peer,
        text: p.text,
        message_id: p.message_id || "",
        create_time_ms: p.create_time_ms ?? null,
      });
    }
  });

  // 挂载前缓冲兜底：status 会读取并清空 Rust 侧 inbound_log。
  invoke("ilink_status")
    .then((st: any) => {
      stateCache = normalizeStatus(st);
      const list: any[] = st?.pending || [];
      for (const m of list) {
        if (m?.peer && m?.text) {
          enqueueInbound({
            peer: m.peer,
            text: m.text,
            message_id: m.message_id || "",
            create_time_ms: m.create_time_ms ?? null,
          });
        }
      }
      fire(EVT_STATE, stateCache);
    })
    .catch(() => {});
  // 状态可能在 window 挂载前就绪（startup restore），先查一次进程内最新值。
  invoke("ilink_status").catch(() => {});
  return () => {
    bridgeStarted = false;
    unlisteners.forEach((u) => {
      try { u(); } catch { /* noop */ }
    });
    unlisteners.length = 0;
  };
}

// ---- 入站处理（每 peer 串行队列；跨 peer 并行）----

const seenIds = new Set<string>();
const peerQueues = new Map<string, Promise<void>>();
let lastQueueTail: Promise<void> = Promise.resolve();

function dedupeKey(m: InboundMessage): string {
  return m.message_id || `${m.peer}:${m.create_time_ms || 0}:${m.text.slice(0, 32)}`;
}

function enqueueInbound(m: InboundMessage): void {
  const key = dedupeKey(m);
  if (seenIds.has(key)) return;
  seenIds.add(key);
  if (seenIds.size > 600) {
    const first = seenIds.values().next().value;
    if (first) seenIds.delete(first);
  }
  const prev = peerQueues.get(m.peer) || lastQueueTail;
  const run = prev.then(() => processInbound(m)).catch((err) => {
    console.warn("[wechat-bridge] inbound processing error:", err);
  });
  lastQueueTail = run;
  peerQueues.set(m.peer, run);
  run.finally(() => {
    if (peerQueues.get(m.peer) === run) peerQueues.delete(m.peer);
  });
}

async function processInbound(m: InboundMessage): Promise<void> {
  const text = m.text.trim();
  if (!text) return;
  // 主开关：停用后完全不响应（含白名单与陌生人引导）。
  if (!getSettings().enabled) return;

  const access = loadAccess();
  const owner = stateCache.user_id || "";
  const kind = classifyPeer(access, m.peer, owner);

  if (kind === "blocked") return;

  if (kind === "unknown") {
    saveAccess(pendPeer(access, m.peer, text, Date.now()));
    // 入站已重置该 peer 配额窗口 → 回一条引导（占 1 条预算）。
    const guide =
      "⚠️ 该微信账号尚未获得此 Bot 的授权。\n" +
      "请 Bot 主人在 Codem 的「微信 ClawBot」设置中批准后，我才能为你工作。";
    await sendReply(m.peer, guide);
    return;
  }

  const cmd = parseCommand(text);
  if (cmd) {
    // /help /status /clear 允许白名单内成员；其余命令仅 Bot 主人。
    const ownerOnly = !["help", "status", "clear"].includes(cmd.name);
    if (ownerOnly && kind !== "owner") {
      await sendReply(m.peer, "该命令需要 Bot 主人权限。");
      return;
    }
    await runCommand(m.peer, cmd.name, cmd.arg, kind);
    return;
  }

  const reply = await runAgentTurn(m.peer, text);
  await sendReply(m.peer, reply);
}

// ---- 命令短路（与 agent 自由对话分离）----

async function runCommand(peer: string, name: string, arg: string, kind: "owner" | "allowed" | "blocked" | "unknown"): Promise<void> {
  const invoke = (window as any).__TAURI__?.core?.invoke;
  switch (name) {
    case "help":
      await sendReply(peer, describeHelp());
      break;
    case "status":
      await sendReply(peer, describeStatus(stateCache));
      break;
    case "clear":
    case "new": {
      const map = loadPeerMap();
      const prev = map[peer];
      const model = name === "new" && arg ? arg : prev?.model;
      map[peer] = await createPeerSession(peer, { cwd: prev?.cwd, model, fresh: true });
      savePeerMap(map);
      await sendReply(peer, name === "new" ? "已开启新会话。" : "已清空上下文并开启新会话。");
      break;
    }
    case "model": {
      if (!arg) {
        await sendReply(peer, "用法：/model <模型名>（下一轮起生效，开启新会话）");
        return;
      }
      const map = loadPeerMap();
      const entry = map[peer] || (await createPeerSession(peer, {}));
      map[peer] = { ...entry, model: arg };
      savePeerMap(map);
      await sendReply(peer, `已切换模型为 ${arg}（将开启新会话）。`);
      break;
    }
    case "attach": {
      if (!arg) {
        await sendReply(peer, "用法：/attach <目录>（后续任务的工作区，需主人确认）");
        return;
      }
      const map = loadPeerMap();
      const entry = map[peer] || (await createPeerSession(peer, {}));
      map[peer] = { ...entry, cwd: arg };
      savePeerMap(map);
      await sendReply(peer, `后续消息的工作区已切换到：${arg}`);
      break;
    }
    case "reconnect": {
      if (invoke) {
        try { await invoke("ilink_start_login"); } catch (e) { console.warn(e); }
      }
      await sendReply(peer, "已开始重新扫码——请在 Codem「微信 ClawBot」面板完成绑定。");
      break;
    }
    case "allow": {
      const access = addPeerToAllow(loadAccess(), peer);
      saveAccess(access);
      await sendReply(peer, "已批准该账号访问。");
      break;
    }
    case "ignore": {
      const access = blockPeer(loadAccess(), peer);
      saveAccess(access);
      // 拉黑后不再回复（直接返回）。
      return;
    }
    default:
      break;
  }
}

function describeHelp(): string {
  return (
    "可用命令：\n" +
    "/help 帮助\n" +
    "/status 状态\n" +
    "/clear 开新会话\n" +
    "/new <模型> 开新会话并换模型\n" +
    "/model <名> 切换模型\n" +
    "/attach <目录> 切换工作区\n" +
    "/reconnect 重新扫码\n" +
    "其余消息将由 Codem 助手处理。"
  );
}

function describeStatus(st: WechatStatus): string {
  const stateName: Record<string, string> = {
    disconnected: "未连接",
    waiting_qr: "等待扫码",
    waiting_scan: "等待确认",
    need_verify_code: "需要配对码",
    connected: "已连接",
    expired: "已过期",
  };
  const lines: string[] = [`连接状态：${stateName[st.state] || st.state}`];
  if (st.bot_id) lines.push(`Bot：${st.bot_id}`);
  if (st.expires_at_ms) {
    const remainH = Math.max(0, Math.round((st.expires_at_ms - Date.now()) / 3600000));
    lines.push(`剩余有效期：约 ${remainH} 小时`);
  }
  if (st.last_error) lines.push(`最近错误：${st.last_error}`);
  const peerQuota = st.quota || [];
  const mine = peerQuota.find((q) => true);
  if (mine) lines.push(`本会话已发送：${mine.sent}/10 条（24h）`);
  lines.push(`累计收发：入 ${st.inbound_count} / 出 ${st.outbound_count}`);
  return lines.join("\n");
}

// ---- 引擎驱动 ----

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

async function ensureWorkspaceProject(cwd: string): Promise<void> {
  await initDatabase();
  const now = Date.now();
  if (!ProjectStorage.getProject(WX_PROJECT_ID)) {
    ProjectStorage.createProject({
      id: WX_PROJECT_ID,
      name: "微信 ClawBot",
      path: cwd || "",
      createdAt: now,
      lastAccessedAt: now,
    });
  } else if (cwd) {
    const cur = ProjectStorage.getProject(WX_PROJECT_ID);
    if (cur && cur.path !== cwd) {
      ProjectStorage.updateProject(WX_PROJECT_ID, { path: cwd, lastAccessedAt: now });
    }
  }
}

async function createPeerSession(
  peer: string,
  opts: { cwd?: string; model?: string; fresh?: boolean } = {},
): Promise<PeerEntry> {
  const { cwd, model, fresh } = opts;
  const base = cwd || getSettings().workspacePath || (await defaultWorkspacePath());
  await ensureWorkspaceProject(base);
  const now = Date.now();
  const suffix = fresh ? `-${now.toString(36)}` : "";
  const sessionId = `wx-${sanitizePeerId(peer)}${suffix}`;
  if (!SessionStorage.getSession(sessionId)) {
    SessionStorage.createSession({
      id: sessionId,
      projectId: WX_PROJECT_ID,
      title: `微信 · ${sanitizePeerId(peer)}`,
      createdAt: now,
      lastMessageAt: now,
      messageCount: 0,
      model: model || undefined,
    });
  }
  return { sessionId, cwd: base, model: model || undefined, createdAt: now };
}

/** 取回该 peer 的会话（映射优先；无映射/失效则新建持久会话）。 */
async function ensurePeerSession(peer: string): Promise<PeerEntry> {
  const map = loadPeerMap();
  let entry = map[peer];
  if (entry && SessionStorage.getSession(entry.sessionId)) {
    return entry;
  }
  entry = await createPeerSession(peer, {
    cwd: entry?.cwd,
    model: entry?.model || getSettings().model,
  });
  map[peer] = entry;
  savePeerMap(map);
  return entry;
}

async function runAgentTurn(peer: string, text: string): Promise<string> {
  try {
    const entry = await ensurePeerSession(peer);
    const sessionId = entry.sessionId;
    const cwd = entry.cwd || "";

    if (isSessionExecuting(sessionId)) {
      return "上一条消息仍在处理中，请稍候片刻再发送。";
    }

    const engine = getLLMEngine();
    if (!engine) {
      return "助手引擎尚未就绪，请稍后再试。";
    }

    // 模型映射：写入 sessions 行（loop 读取 sessions 行做上下文/标题等；模型以引擎配置为最终依据）。
    const row = SessionStorage.getSession(sessionId);
    if (row) {
      SessionStorage.updateSession(sessionId, {
        lastMessageAt: Date.now(),
        model: row.model || entry.model || undefined,
        messageCount: row.messageCount + 1,
      });
    }

    const timeout = setTimeout(() => {
      try { cancelSessionExecution(sessionId); } catch { /* noop */ }
    }, TURN_TIMEOUT_MS);

    let result;
    try {
      result = await executeSessionTurn({
        sessionId,
        message: text,
        cwd,
        engine,
        abortSignal: undefined,
        // onPermissionRequest 缺省策略已安全：full→放行；否则自动拒绝。
      });
    } finally {
      clearTimeout(timeout);
    }

    if (result.success) {
      return truncateReply(result.output);
    }
    return `[执行失败] ${result.error || "未知错误"}`;
  } catch (err: any) {
    console.warn("[wechat-bridge] runAgentTurn error:", err);
    return "[内部错误] 处理该消息时出现异常，请稍后再试。";
  }
}

async function sendReply(peer: string, text: string): Promise<void> {
  if (!text) return;
  try {
    const invoke = (window as any).__TAURI__?.core?.invoke;
    if (!invoke) return;
    await invoke("ilink_send_text", { peer, text });
  } catch (err) {
    console.warn("[wechat-bridge] send failed (配额/网络):", err);
  }
}

// ========== UI 动作（设置面板调用）==========

/** 批准待接入的陌生 peer。 */
export function approvePendingPeer(peer: string): void {
  const access = addPeerToAllow(loadAccess(), peer);
  saveAccess(access);
}

/** 拉黑 peer。 */
export function ignorePeer(peer: string): void {
  const access = blockPeer(loadAccess(), peer);
  saveAccess(access);
}

/** 邀请一个已知 peer（当前用户）后手动新增允许项。 */
export function allowPeerByInput(peer: string): void {
  if (!peer || !peer.includes("@")) return;
  const access = addPeerToAllow(loadAccess(), peer.trim());
  saveAccess(access);
}

/** 给 owner 之外的白名单成员发测试消息（1 条预算，谨慎用）。 */
export async function sendTestMessage(peer: string, text: string): Promise<void> {
  if (!peer || !text) return;
  await sendReply(peer, text);
}

/**
 * Desktop engine bridge — AA（Agents Anywhere）远程操作桌面会话的 WebView TS 半层。
 *
 * 旧的 LAN 配对/二维码/cookie/设备列表已删除。Rust（src-tauri/src/phone/mod.rs）
 * 现在只保留**回环 bridge**：每次运行随机一个内部 token，AA connector 用它把
 * AA 服务端请求转给本模块；本模块：
 *   - 路由 remote-request → 真实数据（DB/引擎/桌面状态）→ invoke remote_respond
 *   - GET  /api/sessions              → 全部项目会话（按最后消息倒序）
 *   - GET  /api/sessions/<id>/messages?limit=N → 会话消息
 *   - POST /api/chat {sessionId,text} → executeSessionTurn 驱动该会话一轮
 *   - POST /api/chat/new {text}       → 在当前项目开新会话并跑一轮
 *   - 审批 / 目录 / 选择 / 通知等 AA 协议需要的数据面
 *
 * 另外还认领 PC 远程网关（ADR-0005）的 `/health` 与 `/rpc`：`session.list` /
 * `session.get` 读桌面现有存储，`prompt.send` / `run.cancel` 走**同一条**
 * `runAgentTurn`（→ `executeSessionTurn`）。网关没有自己的循环/库/租约：
 * 写路径只多一张 run 归属表（`gateway-runs.ts`）与结构化预检。
 *
 * 诚实标注：本模块不编造数据——所有内容来自 Codem 自身存储/引擎；AA 端与
 * 桌面端看到的是同一会话、同一历史。bridge 只绑 127.0.0.1，不对局域网暴露。
 */
import * as ProjectStorage from "../storage/project";
import * as SessionStorage from "../storage/session";
// 第 191 波：「会话 → 项目根路径」走唯一实现（本文件原来自己反查了一遍）
import { sessionProjectPath } from "../storage/session-project";
import * as MessageStorage from "../storage/message";
import { useProjectStore } from "../store";
import { runGitCommand } from "../command-api";
import { getLLMEngine } from "../llm";
import {
  executeSessionTurn,
  isSessionExecuting,
  cancelSessionExecution,
  getActiveExecutionCount,
  getConcurrencyLimit,
} from "../session";
/**
 * 第 122 轮阶段 0.1：AA 端发起的回合**必须能回答权限请求**。
 *
 * 在此之前这里没传 `onPermissionRequest`，于是落到 `executor.ts:368-374` 的缺省策略
 * （full 放行，否则**自动拒绝**）：AA 上发一句"帮我改一下这个文件"，
 * 需要批准的工具被**静默否掉**，用户看到的是"任务莫名没做"。
 *
 * 现在挂上审批代理：请求进待批表，AA 端弹卡片，**桌面也能答**（同一张表）。
 */
import { requestApproval, closeSessionApprovals, listApprovals, answerApproval, approvalRevision, subscribeApprovals } from "../permission/approval-broker";
/** 阶段 4：远端改模型/权限档。 */
import { verdictForRemoteSecurityChange, isLoosening } from "./remote-selections";
// 阶段 R4：按它的形状产出通知（与阶段 0 的审批读**同一份**状态，不搞两个真相）
import { noticeFromApproval, remoteActionToInternal, platformSessionId } from "./aa-notice";
// 阶段 R3'：它的选择标识（`dsh:model:` / `dsh:permission:`）—— 目录里附上、选择时解析
import { modelSelectionId, permissionSelectionId, decodeModelSelection, decodePermissionSelection } from "./dsh-selection-id";
import { resolveProviderForModel } from "../model-config";
import { MIMO_MODELS, getConfiguredApiModels } from "../model-config";
import { SECURITY_MODES, getEffectiveSecurityMode, setProjectSecurityMode, setGlobalSecurityMode } from "../permission/security-mode";
// PC 桌面远程网关（ADR-0005）：与 AA 共用同一条 `remote-request` 事件桥，
// 所以它在这里认领自己的路径；不在网关里的路径继续走下面的 `/api/*`。
// 数据注入保持“网关模块不 import 存储”的硬约束：这里把桌面现有读取函数交进去。
import {
  handleGatewayRequest,
  type GatewayApprovalAnswer,
  type GatewayApprovalListInput,
  type GatewayApprovalRespondInput,
  type GatewayApprovalView,
  type GatewayCancelRunInput,
  type GatewayCancelRunResult,
  type GatewaySendPromptInput,
  type GatewaySendPromptResult,
  type GatewaySessionDetail,
} from "./gateway-engine";
// M2 写路径第一批：run 归属表（纯逻辑；执行仍然只走下面的 runAgentTurn）。
import { GatewayRunRegistry } from "./gateway-runs";
// M3 文件面：桌面唯一工作区的只读数据 + 敏感审批（网关引擎只拿注入后的数据层）。
import { createGatewayWorkspace } from "./gateway-workspace";
// M3 变更面：桌面 `turn_file_changes` 与桌面 git 对象；服务实现与 Host 共用一份。
import { FileChangeStorage, queryChangesPage } from "../storage/file-change-storage";
import { FileChangeTracker } from "../environment/file-change-tracker";
import { createChangesService } from "../../../packages/host/src/changes";
import { isSensitiveReadPath } from "../../../packages/host/src/sensitive-paths";
// M2 事件/审批：事件发布只在 `executeSessionTurn` 的事件回调里产生（不双写）；
// 审批事件来自桌面审批代理的状态变化（与桌面卡片同一张表）。
import {
  ApprovalEventTracker,
  GatewayEventPublisher,
  gatewayTerminalEvent,
  mapLoopEventToGatewayEvent,
  type GatewayOutboundEvent,
} from "./gateway-events";

// ========== 类型与常量 ==========

const MAX_SESSIONS = 300;
const TURN_TIMEOUT_MS = 8 * 60 * 1000;

export interface RemoteProxyRequest {
  reqId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
}

// ========== 纯函数（可单测）==========

export type RemoteRoute =
  | { type: "status" }
  | { type: "sessions" }
  | { type: "messages"; sessionId: string }
  | { type: "chat" }
  | { type: "chat_new" }
  | { type: "chat_cancel" }
  | { type: "run"; sessionId: string }
  | { type: "approvals" }
  | { type: "approval_answer"; requestId: string }
  | { type: "notices" }
  | { type: "catalog" }
  | { type: "selections" }
  | null;

/** 解析 bridge 代理上来的 path（不含 query）。limit 由调用方从 query 读取。 */
export function parseRemotePath(path: string): RemoteRoute {
  if (!path.startsWith("/api/")) return null;
  const rest = path.slice(4); // 去掉 "/api"
  if (rest === "/status") return { type: "status" };
  if (rest === "/sessions") return { type: "sessions" };
  if (rest === "/chat") return { type: "chat" };
  if (rest === "/chat/new") return { type: "chat_new" };
  if (rest === "/chat/cancel") return { type: "chat_cancel" };
  if (rest === "/approvals") return { type: "approvals" };
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

export interface RemoteSessionView {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  updatedAt: number;
  createdAt: number;
  messageCount: number;
}

/** 手机上一条工具调用的**摘要**（不搬全文，见 `mapMessages`）。 */
export interface RemoteToolCallView {
  tool: string;
  status: string;
  /** 参数摘要（如命令 / 路径），有上限 */
  brief?: string;
  /** 结果摘要，有上限 */
  resultBrief?: string;
}

export interface RemoteMessageView {
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
  toolCalls?: RemoteToolCallView[];
  /** 阶段 0.4：思维链。**默认不在列表里返回**（见 `mapMessages` 的 `withReasoning`） */
  reasoning?: string;
  /** 本会话产生的文件（供手机看到"改了哪些文件"） */
  generatedFiles?: string[];
}

/** 工具调用摘要里各字段的字符上限（手机屏幕小，也不该为一次列表拉几百 KB）。 */
export const REMOTE_TOOL_BRIEF_MAX_CHARS = 300;
/** 单条消息返回的工具调用条数上限。 */
export const REMOTE_TOOL_CALLS_MAX = 20;
/** assistant 正文在手机视图里的字符上限。 */
export const REMOTE_CONTENT_MAX_CHARS = 4000;
/** 思维链在手机视图里的字符上限。 */
export const REMOTE_REASONING_MAX_CHARS = 1500;

function clipForPhone(text: string, max: number): string {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…（共 ${s.length} 字符）`;
}

/** 工具调用的参数摘要：优先给人看"干了什么"，而不是整包 JSON。 */
export function briefToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return clipForPhone(args, REMOTE_TOOL_BRIEF_MAX_CHARS);
  const obj = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "target"]) {
    const v = obj?.[key];
    if (typeof v === "string" && v) return clipForPhone(v, REMOTE_TOOL_BRIEF_MAX_CHARS);
  }
  try {
    return clipForPhone(JSON.stringify(obj), REMOTE_TOOL_BRIEF_MAX_CHARS);
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
): RemoteMessageView[] {
  return msgs.map((m) => {
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls.slice(0, REMOTE_TOOL_CALLS_MAX) : [];
    const toolCalls: RemoteToolCallView[] = calls.map((tc) => ({
      tool: String(tc?.tool ?? "(未知工具)"),
      status: String(tc?.status ?? ""),
      ...(briefToolArgs(tc?.args) ? { brief: briefToolArgs(tc?.args) } : {}),
      ...(tc?.result ? { resultBrief: clipForPhone(String(tc.result), REMOTE_TOOL_BRIEF_MAX_CHARS) } : {}),
    }));
    return {
      id: m.id,
      role: (m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "assistant") as RemoteMessageView["role"],
      content: clipForPhone(cleanContent(m.content || ""), REMOTE_CONTENT_MAX_CHARS),
      timestamp: m.timestamp,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(withReasoning && m.reasoning ? { reasoning: clipForPhone(m.reasoning, REMOTE_REASONING_MAX_CHARS) } : {}),
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
export function flattenSessions(): RemoteSessionView[] {
  const projects = ProjectStorage.listProjects().filter((p) => p.id !== "wx-workspace");
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  const out: RemoteSessionView[] = [];
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

/**
 * 会话消息的**唯一同步读取点**（AA 与桌面网关共用）。
 *
 * 为什么抽出来：仓库有「数据层之外不许再加同步整会话读」的冻结基线
 * （`no-sync-mirror-reads`）。新增 `session.get` 不能再加第二个 `listMessages(`
 * 调用点；两边都走这里，基线保持 1。
 */
function readRemoteMessages(sessionId: string, limit: number, withReasoning = false) {
  return mapMessages(MessageStorage.listMessages(sessionId, limit), withReasoning);
}

/**
 * M1 网关的 `session.get` 数据：**读桌面现有存储**，不建第二份库。
 *
 * 复用列表投影（项目名/消息数）与消息手机的裁剪规则；只读，不写任何东西。
 */
function gatewaySessionDetail(sessionId: string, limit: number): GatewaySessionDetail | null {
  const session = flattenSessions().find((s) => s.id === sessionId);
  if (!session) return null;
  const messages = readRemoteMessages(sessionId, limit, false).map((m) => ({
    ...m,
  }));
  /**
   * 运行态：只报**网关自己的** run。
   *
   * 手机刷新页面/事件流重连后，`runId` 只存在于内存里 —— 没有这一条，
   * 界面就再也拿不到"停止"所需的 id（而那次运行可能还在跑）。桌面/AA 前台回合
   * 不在这张归属表里，如实报 null，而不是编一个点了必失败的 runId。
   */
  const run = gatewayRuns.activeForSession(sessionId);
  return {
    session,
    messages,
    hasMore: false,
    run: run ? { runId: run.runId, state: run.state } : null,
  };
}

// ========== M2 事件发布 ==========

/**
 * 调用 Rust 的 `gateway_publish_event`（**唯一**发布入口）。
 *
 * 每次调用都是独立 IPC，所以真正发出去之前必须先过 `GatewayEventPublisher`
 * 的串行队列 —— 否则 `tool.end` 可能抢在 `tool.start` 前面（手机永久"运行中"）。
 */
function invokeGatewayPublish(event: GatewayOutboundEvent): Promise<unknown> {
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) {
    // 非 Tauri（Node 测试/纯浏览器）没有事件桥：明确失败，由发布器报一次。
    return Promise.reject(new Error("not in tauri"));
  }
  return invoke("gateway_publish_event", {
    sessionId: event.sessionId,
    eventType: event.type,
    payload: event.payload,
    ...(event.runId ? { runId: event.runId } : {}),
  });
}

/** 进程内唯一的网关事件发布器（串行、失败可见）。 */
const gatewayEvents = new GatewayEventPublisher(invokeGatewayPublish);

/** 审批表 → 事件的比较器（进程内唯一；见 `gateway-events.ts`）。 */
const gatewayApprovalEvents = new ApprovalEventTracker();

function publishGatewayRunTerminal(
  sessionId: string,
  runId: string,
  state: string,
  error?: string,
): void {
  gatewayEvents.publish(gatewayTerminalEvent(sessionId, runId, state, error));
}

// ========== M2 审批 RPC ==========

/** `approval.list`：读桌面**同一张**待批表（桌面弹窗/AA/微信/网关共用）。 */
function gatewayListApprovals(input: GatewayApprovalListInput): GatewayApprovalView[] {
  /*
   * 文件读取审批是**网关本地**的两阶段表（sessionId:""），不注册进桌面代理：
   * 它没有等待中的 Promise，注册进去只会多一张没主儿的卡。按会话过滤时它不属于
   * 任何会话，因此不出现；不带会话时才合并给手机（headless 客户端用它答复）。
   */
  const workspacePending = input.sessionId ? [] : gatewayWorkspace.listPendingApprovals();
  return [
    ...workspacePending,
    ...listApprovals({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      includeDecided: input.includeDecided === true,
    }),
  ];
}

/**
 * `approval.respond`：走桌面既有 `answerApproval()`。
 *
 * 一次性、只生效一次、回合收尾 fail-closed —— 全部由代理保证，网关不复制这些
 * 规则。`decidedBy: "phone"` 只用于界面措辞（不是鉴权）。
 */
function gatewayRespondApproval(input: GatewayApprovalRespondInput): GatewayApprovalAnswer {
  /*
   * 先看网关本地的文件读取审批：命中就由它裁决，**不再**问桌面代理
   * （按"谁登记谁裁决"分流，避免一个答复同时改两张表）。未命中才走代理。
   */
  const fileApproval = gatewayWorkspace.respondApproval(input.approvalId, input.decision);
  if (fileApproval.handled) {
    if (!fileApproval.ok) {
      return { ok: false, kind: "NOT_PENDING", message: fileApproval.message };
    }
    return {
      ok: true,
      approvalId: input.approvalId,
      decision: input.decision,
      decidedBy: "phone",
    };
  }
  const out = answerApproval(input.approvalId, input.decision, "phone");
  if (!out.ok) {
    return {
      ok: false,
      kind: out.code === "approval_not_pending" ? "NOT_PENDING" : "INVALID_ACTION",
      message: out.message,
    };
  }
  return {
    ok: true,
    approvalId: out.requestId,
    decision: out.action,
    decidedBy: out.decidedBy,
  };
}

// ========== M2 写路径第一批：网关 run 归属 + 回合预检 ==========

/**
 * 网关 run 归属表（进程内、纯内存）。
 *
 * 它回答"这次 `runId` 是谁的、还在不在跑"，**不**执行任何东西：
 * 执行只走下面的 `runAgentTurn` → `executeSessionTurn`（桌面唯一循环）。
 */
const gatewayRuns = new GatewayRunRegistry();

/** 桌面注入给文件面的 Tauri invoke（非 Tauri 环境明确失败，不静默返回空数据）。 */
function invokeDesktopCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    return Promise.reject(new Error("not in tauri"));
  }
  return invoke(cmd, args) as Promise<T>;
}

/**
 * M3 文件面（进程内唯一）。
 *
 * 数据只有桌面当前项目这一份；Rust 侧 `gateway_workspace_*` 负责**无条件**工作区边界，
 * 本实例负责敏感审批、git 参数与协议形状。没有第二套工作区/缓存/文件副本。
 */
const gatewayWorkspace = createGatewayWorkspace({
  invoke: invokeDesktopCommand,
  // 走桌面唯一 git 通道（argv、不经 shell）；10s 给渲染/IPC 留出余量（Rust 代理上限 15s）。
  runGit: (cwd, args) => runGitCommand(cwd, args, { timeoutMs: 10_000 }),
  currentProjectPath: () => useProjectStore.getState().currentProject?.path ?? null,
  defaultWorkspacePath,
});

/**
 * M3 变更面（进程内唯一）：`session.changes` / `session.change.diff`。
 *
 * 数据只有桌面这一份：`turn_file_changes`（`FileChangeStorage`，与桌面
 * `FileChangesList` 同一个查询原语）+ 会话工作区里的 git 对象。没有第二份记录、
 * 没有网关缓存。
 *
 * `workspaceFor` **按会话**取：网关的 `session.list` 是全项目的，worktree 会话的
 * cwd 也不是项目根；若固定用"当前项目"去 `cat-file`，别的项目的记录会被误报成
 * "对象已被清理"。取不到（项目被移动/删除）时服务如实 `supported=false`。
 */
const gatewayChanges = createChangesService({
  /*
   * 可见性必须与 `session.list` / `session.get` 同一份投影：`SessionStorage.getSession`
   * 会连内部项目（`wx-workspace`，列表里刻意排除）也答"存在" —— 那会让知道会话 id 的
   * 客户端读到未列出的会话的变更记录。`flattenSessions` 是网关会话列表的唯一来源。
   */
  sessionExists: async (id) => flattenSessions().some((s) => s.id === id),
  queryPage: (sid, offset, limit) => queryChangesPage(sid, offset, limit),
  getById: (id) => FileChangeStorage.getByIdAsync(id),
  workspaceFor: async (sid) => (await cwdForSession(sid)) || null,
  isGitWorkspace: (workspace) => FileChangeTracker.isGitWorkspace(workspace),
  runGit: (workspace, args) => runGitCommand(workspace, args, { timeoutMs: 10_000 }),
  /*
   * 远程端不是"本机"：敏感文件（.env / 私钥 / .git/config）不能借变更记录的
   * 单文件 diff 成为内容出口。这里硬拒绝（协议没有 approvalId，弹审批就是半套）。
   */
  isSensitivePath: isSensitiveReadPath,
});

/**
 * 一轮远程回合的结构化预检（AA 与网关共用）。
 *
 * 为什么抽出来：AA 路径原本是一串 `if (...) { noteTurnFailure(...); return {...} }`，
 * 返回值只有一句中文。网关的 `prompt.send` 需要**分类**（`BUSY` / `RUN_OWNED` /
 * `NO_WORKSPACE` …）才能让手机给出可行动的提示；两边各写一遍判定必然漂移。
 * 这里只回答"能不能跑"，不写库、不改会话。
 */
type RemoteTurnPreflight =
  | { ok: true; engine: ReturnType<typeof getLLMEngine>; cwd: string }
  | {
      ok: false;
      code: "ENGINE_UNAVAILABLE" | "BUSY" | "NO_WORKSPACE" | "NOT_FOUND";
      message: string;
    };

async function preflightRemoteTurn(sessionId: string): Promise<RemoteTurnPreflight> {
  const engine = getLLMEngine();
  if (!engine) {
    return { ok: false, code: "ENGINE_UNAVAILABLE", message: "引擎未就绪（LLM provider 未注册）" };
  }
  if (isSessionExecuting(sessionId)) {
    return { ok: false, code: "BUSY", message: "该会话正在处理中，请稍候再发" };
  }
  const cwd = await cwdForSession(sessionId);
  if (!cwd) {
    return {
      ok: false,
      code: "NO_WORKSPACE",
      message: "会话没有可用的工作区（项目路径为空，且没有默认目录）",
    };
  }
  const row = SessionStorage.getSession(sessionId);
  if (!row) {
    return { ok: false, code: "NOT_FOUND", message: `会话不存在：${sessionId}` };
  }
  return { ok: true, engine, cwd };
}

/**
 * 机器级并发上限判定（纯函数）。
 *
 * `getConcurrencyLimit()` 是"8 核以下 1 / 8–15 核 2 / 16 核以上 3、≤4GB 一律 1"
 * （`executor.ts`），它只描述机器能同时跑几个回合；**谁**能占用这些名额是调用方
 * 的策略。AA 路径没有查过它，网关不延续这个缺口 —— 否则手机能一次压满整台机器。
 *
 * 返回 `null` = 放行；否则返回给手机看的原因。
 * 上限值不可信（NaN/0/负数）时按 1 处理：宁可少跑一轮，也不在"上限算不出来"时
 * 让远程把机器打满。
 */
export function gatewayConcurrencyRejection(active: number, limit: number): string | null {
  const cap = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : 1;
  return active >= cap ? `本机并发上限（${cap}）已满，请等当前回合结束后再发` : null;
}

/**
 * 网关 `prompt.send`：受理一次远程回合。
 *
 * 复用 `runAgentTurn`（AA 的同一条写路径：`executeSessionTurn` + 审批代理 + 8 分钟
 * 兜底超时），所以这里**没有**第二套循环/审批/超时。本函数只做三件网关特有的事：
 *
 * 1. **机器级并发上限**：AA 路径没查过 `getConcurrencyLimit()`（只查单会话），
 *    网关不延续这个缺口 —— 否则手机能一次压满整台机器；
 * 2. **结构化预检**：失败要在受理之前返回（手机据此显示原因，而不是"已发送然后没动静"）；
 * 3. **run 归属**：`runId ↔ sessionId/clientId/requestId`，`run.cancel` 靠它判断
 *    能不能停、是不是别人的。
 *
 * ⚠️ 从 `isSessionExecuting` 到 `runAgentTurn(...)` 之间**不许再插 await**：
 * 这段时间必须与 `executeSessionTurn` 的登记（`runAgentTurn` 的同步前段）连成一个
 * 原子块。一旦让出事件循环，桌面就可能在这条缝里发起同一会话的回合 —— 那时
 * `executeSessionTurn` 会拒绝，而手机已经拿到 `runId`。
 */
async function gatewaySendPrompt(input: GatewaySendPromptInput): Promise<GatewaySendPromptResult> {
  const { sessionId, text } = input;
  const clientId = input.clientId ?? "";

  /**
   * 幂等键必须**先于**忙预检回答。
   *
   * 手机可能在拿到应答前断线重发同一条 `requestId`：这时会话里正在跑的就是它自己，
   * 若先做忙判定会得到 `BUSY` —— 用户看到"发送失败"，而桌面其实在跑他的上一条。
   */
  const dedup = gatewayRuns.findByRequestId({
    sessionId,
    clientId,
    requestId: input.requestId,
  });
  if (dedup) {
    return {
      ok: true,
      runId: dedup.runId,
      sessionId: dedup.sessionId,
      deduplicated: true,
    };
  }

  const pre = await preflightRemoteTurn(sessionId);
  if (!pre.ok) {
    return { ok: false, kind: pre.code, message: pre.message };
  }

  // ---- 从这里开始：同步完成（见函数头注释）----
  // 机器上限：放在会话级预检之后，这样"这个会话正忙"不会被报成"本机并发满了"。
  const busyLimit = gatewayConcurrencyRejection(getActiveExecutionCount(), getConcurrencyLimit());
  if (busyLimit) {
    return { ok: false, kind: "BUSY_LIMIT", message: busyLimit };
  }
  if (isSessionExecuting(sessionId)) {
    return { ok: false, kind: "BUSY", message: "该会话正在处理中，请稍候再发" };
  }
  const claim = gatewayRuns.claim({ sessionId, clientId, requestId: input.requestId });
  if (!claim.ok) {
    if (claim.code === "RUN_OWNED") {
      return {
        ok: false,
        kind: "RUN_OWNED",
        message: `该会话正在被另一台设备（${claim.active?.clientId || "未知设备"}）的远程回合占用；请在那台设备上停止，或等它结束`,
      };
    }
    return {
      ok: false,
      kind: "BUSY",
      message: "该会话已有一个远程回合在进行中；请先停止它，或等它结束",
    };
  }
  if (claim.deduplicated) {
    // 同一个 requestId 的重发：拿回同一个 runId，**不再启动**第二次执行。
    return {
      ok: true,
      runId: claim.run.runId,
      sessionId: claim.run.sessionId,
      deduplicated: true,
    };
  }

  const runId = claim.run.runId;
  /*
   * `run.started` 必须**先于**这一轮的任何循环事件进入队列（队列保证顺序）。
   * 手机在受理应答之外也能从事件流知道"这次 run 真的开始了"（重连补发时尤其重要）。
   */
  gatewayEvents.publish({
    sessionId,
    type: "run.started",
    payload: { state: "running" },
    runId,
  });
  const turn = runAgentTurn(sessionId, text, {
    /**
     * 循环事件的**唯一**出口：executor 把 `engine.process` 的每条事件交给这里，
     * 映射后进发布队列。这里不写库、不判状态 —— 只是投影给手机。
     */
    onLoopEvent: (event) => {
      const mapped = mapLoopEventToGatewayEvent(event, { sessionId, runId });
      if (mapped) gatewayEvents.publish(mapped);
    },
  });
  void turn.then(
    (result) => {
      // 终态在 `finish()` 之后取：取消过的 run 会落成 `cancelled`（而不是 failed）。
      const settled = gatewayRuns.finish(runId, result.ok ? "finished" : "failed");
      publishGatewayRunTerminal(
        sessionId,
        runId,
        settled?.state ?? (result.ok ? "finished" : "failed"),
        result.ok ? undefined : result.error,
      );
    },
    (err) => {
      // runAgentTurn 自己会 catch；能走到这里说明连预检/落库都抛了 —— 如实记账，不吞。
      const settled = gatewayRuns.finish(runId, "failed");
      publishGatewayRunTerminal(sessionId, runId, settled?.state ?? "failed", String(err));
      console.warn("[remote-engine] gateway turn crashed:", err);
    },
  );
  return { ok: true, runId, sessionId };
}

/**
 * 网关 `run.cancel`：停一次**网关发起**的运行。
 *
 * 为什么桌面发起的回合一律 `RUN_NOT_FOUND` 而不是"也帮你停"：
 * `cancelSessionExecution` 对前台回合是空操作（`executor.ts` 明说登记表里的
 * controller 只是"忙碌标记"，真正的中止走 `abortControllersRef` + `engine.abortSession`）。
 * 假装取消成功，手机上会显示"已停止"而桌面还在跑。
 *
 * 为什么取消要连 `closeSessionApprovals` 一起做：中止只 abort controller，
 * 而循环可能正 `await onPermissionRequest(...)` —— 那个 Promise 不 resolve，
 * 回合就结束不了（AA 的 `/api/chat/cancel` 正是同一处置）。
 */
function gatewayCancelRun(input: GatewayCancelRunInput): GatewayCancelRunResult {
  const out = gatewayRuns.requestCancel({ runId: input.runId, clientId: input.clientId });
  if (!out.ok) {
    if (out.code === "RUN_NOT_FOUND") {
      return {
        ok: false,
        kind: "RUN_NOT_FOUND",
        message: `没有这个网关运行（${input.runId}）：可能已经结束，或那次回合由桌面发起 —— 桌面回合只能在桌面停止`,
      };
    }
    return {
      ok: false,
      kind: "RUN_OWNED",
      message: `这次运行由另一台设备（${out.run?.clientId || "未知设备"}）发起，请在那台设备上停止`,
    };
  }
  if (out.cancelled) {
    const { sessionId } = out.run;
    cancelSessionExecution(sessionId);
    closeSessionApprovals(sessionId, "cancelled");
  }
  return {
    ok: true,
    runId: out.run.runId,
    sessionId: out.run.sessionId,
    cancelled: out.cancelled,
    state: out.run.state,
  };
}

async function invokeRemoteRespond(reqId: string, status: number, body: unknown): Promise<void> {
  try {
    const invoke = (window as any).__TAURI__?.core?.invoke;
    if (!invoke) return;
    await invoke("remote_respond", {
      reqId,
      status,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  } catch (e) {
    console.warn("[remote-engine] respond failed:", e);
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
  /*
   * ⚠️ 顺序是刻意的：这里回答的是「这个会话该在**哪个目录**跑」——
   * worktree 会话就该在 worktree 里跑，所以 `worktreePath` 优先。
   * （「这个会话属于**哪个项目**」是另一个问题，唯一实现是 `sessionProjectPath`，
   * 第 191 波把"按登记表取项目根"这半并到了那里，避免同一事实两处反查。）
   */
  if (row.worktreePath) return row.worktreePath;
  return sessionProjectPath(sessionId) ?? defaultWorkspacePath();
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
    console.warn("[remote-engine] 写入失败提示失败（会话可能不存在）:", e);
  }
  console.warn(`[remote-engine] 回合未启动（${sessionId}）：${reason}`);
}

/** 手机续聊桌面会话 / 开新会话并跑一轮（真实引擎回合）。 */
async function runAgentTurn(
  sessionId: string,
  text: string,
  opts?: {
    /**
     * 循环事件观察者（**只观察**，不参与写入）。目前只有网关路径传它：
     * 事件映射后由 `gatewayEvents` 发布到 `/events`。AA/微信不传。
     */
    onLoopEvent?: (event: Parameters<typeof mapLoopEventToGatewayEvent>[0]) => void;
  },
): Promise<{ ok: boolean; error?: string; noted?: boolean }> {
  const pre = await preflightRemoteTurn(sessionId);
  if (!pre.ok) {
    // AA 端只能轮询 messages：前置失败必须落一条原因，否则手机看到的是"发了没反应"。
    // （网关路径在调用前已经预检过，走到这里说明是竞态；落一条同样如实。）
    noteTurnFailure(sessionId, pre.message);
    return { ok: false, error: pre.message, noted: true };
  }
  const { engine, cwd } = pre;
  SessionStorage.updateSession(sessionId, {
    lastMessageAt: Date.now(),
    // ⚠️ 第 191 波：不许写 `messageCount`（引擎在 messages.upsert_index 里 bump 那一列；
    // 渲染侧再写一次就是第二个写入者，会让这个会话长期多算 1 条。见 App.tsx 同款说明）
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
         * 阶段 0.1：权限请求交给审批代理，AA 端可以点「允许一次 / 拒绝」。
         * `origin: "phone"` 只用于界面措辞（"手机发起的回合在等批准"），不用于鉴权。
         */
        onPermissionRequest: (request) => requestApproval(request, "phone"),
        /**
         * M2：循环事件只投影给**观察者**（网关 `/events`）。不写第二份日志，
         * 消息与事件日志仍由 executor 的既有分支写（单一写入者）。
         */
        ...(opts?.onLoopEvent ? { onEvent: opts.onLoopEvent } : {}),
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

async function handleRemoteRequest(req: RemoteProxyRequest): Promise<void> {
  /**
   * PC 远程网关（ADR-0005）：Rust 网关与 AA bridge 共用同一条 `remote-request`
   * 事件桥，所以先让它认领自己的路径（`/health` 与 `/rpc`）。认领了就返回，
   * 不再落到下面的 `/api/*` —— 否则网关的 `/health` 会被这里按 404 答掉。
   *
   * M2 写路径第一批：`prompt.send` / `run.cancel` 也在这里注入。执行的仍然是
   * 下面 AA 用的那个 `runAgentTurn`（→ `executeSessionTurn`），**没有**第二套循环。
   */
  if (
    await handleGatewayRequest(
      req,
      (status, body) => invokeRemoteRespond(req.reqId, status, body),
      {
        listSessions: flattenSessions,
        getSession: gatewaySessionDetail,
        sendPrompt: gatewaySendPrompt,
        cancelRun: gatewayCancelRun,
        listApprovals: gatewayListApprovals,
        respondApproval: gatewayRespondApproval,
        workspace: {
          list: gatewayWorkspace.list,
          read: gatewayWorkspace.read,
          diff: gatewayWorkspace.diff,
          root: gatewayWorkspace.root,
        },
        changes: gatewayChanges,
      },
    )
  ) {
    return;
  }
  const route = parseRemotePath(req.path);
  if (!route) {
    await invokeRemoteRespond(req.reqId, 404, { error: "not_found" });
    return;
  }
  switch (route.type) {
    case "status": {
      const st = useProjectStore.getState();
      await invokeRemoteRespond(req.reqId, 200, {
        ok: true,
        desktop: {
          project: st.currentProject ? { name: st.currentProject.name } : null,
          session: st.currentSession ? { id: st.currentSession.id, title: st.currentSession.title } : null,
        },
      });
      return;
    }
    case "sessions": {
      await invokeRemoteRespond(req.reqId, 200, { ok: true, sessions: flattenSessions() });
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
        const msgs = readRemoteMessages(route.sessionId, limit, withReasoning);
        await invokeRemoteRespond(req.reqId, 200, { ok: true, messages: msgs });
      } catch (e: any) {
        await invokeRemoteRespond(req.reqId, 404, { error: String(e?.message || e) });
      }
      return;
    }
    case "chat": {
      let body: any = {};
      try { body = JSON.parse(req.body || "{}"); } catch { /* ignore */ }
      const sessionId = String(body.sessionId || "").trim();
      const text = String(body.text || "").trim();
      if (!sessionId || !text) {
        await invokeRemoteRespond(req.reqId, 400, { error: "sessionId 与 text 必填" });
        return;
      }
      if (isSessionExecuting(sessionId)) {
        await invokeRemoteRespond(req.reqId, 409, { error: "该会话正在处理中，请稍候" });
        return;
      }
      // F1：先回 202（已接受）再后台跑回合——完整 agent 回合可能数分钟，
      // 远超 Rust 代理 15s 超时；结果经手机端轮询 messages 可见，失败写库。
      await invokeRemoteRespond(req.reqId, 202, { accepted: true, sessionId, note: "回合在桌面端后台执行，请轮询 /api/sessions/<id>/messages 查看结果" });
      void runAgentTurn(sessionId, text).then((res) => {
        // 失败已经写进会话（runAgentTurn 内部保证）；这里只留日志，绝不静默
        if (!res.ok) console.warn("[remote-engine] chat turn failed:", res.error);
      });
      return;
    }
    case "chat_new": {
      let body: any = {};
      try { body = JSON.parse(req.body || "{}"); } catch { /* ignore */ }
      const text = String(body.text || "").trim();
      if (!text) {
        await invokeRemoteRespond(req.reqId, 400, { error: "text 必填" });
        return;
      }
      // 在当前项目开新会话（无项目 → 全局会话）
      const st = useProjectStore.getState();
      const project = st.currentProject;
      const now = Date.now();
      /**
       * 阶段 R5：**它指定 sessionId**（`SessionCreateParams.sessionId`），
       * 我们原来是自己生成一个 —— 那会让调用方按它给的 id 去查却查不到
       * （真实的协议不一致，不是风格问题）。
       *
       * 所以：给了就用给的（并做基本校验），没给才自己生成。
       */
      const requested = String(body.sessionId || "").trim();
      if (requested && !/^[\w.-]{1,128}$/.test(requested)) {
        await invokeRemoteRespond(req.reqId, 400, {
          error: "sessionId 只允许字母数字与 . _ -，长度 1..128",
          code: "invalid_session_id",
        });
        return;
      }
      const sessionId = requested || `ph-${now.toString(36)}-${Math.random().toString(36).substr(2, 6)}`;
      SessionStorage.createSession({
        id: sessionId,
        projectId: project?.id || "",
        title: String(body.title || "").trim() || "手机新对话",
        createdAt: now,
        lastMessageAt: now,
        messageCount: 0,
      });
      // 同 chat：先 202 再后台执行
      await invokeRemoteRespond(req.reqId, 202, { accepted: true, sessionId, note: "回合在桌面端后台执行，请轮询 /api/sessions/<id>/messages 查看结果" });
      void runAgentTurn(sessionId, text).then((res) => {
        if (!res.ok) console.warn("[remote-engine] chat_new turn failed:", res.error);
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
        await invokeRemoteRespond(req.reqId, 405, { error: "method_not_allowed" });
        return;
      }
      let body: any = {};
      try { body = JSON.parse(req.body || "{}"); } catch { /* ignore */ }
      const sessionId = String(body.sessionId || "").trim();
      if (!sessionId) {
        await invokeRemoteRespond(req.reqId, 400, { error: "sessionId 必填" });
        return;
      }
      const wasRunning = isSessionExecuting(sessionId);
      cancelSessionExecution(sessionId);
      /**
       * 顺手收口这个会话的待批项：已经决定要停了，还挂着一个待批准没有意义，
       * 而且它会一直占着卡片。按拒绝收尾（fail-closed，与回合收尾同一取向）。
       */
      const closed = closeSessionApprovals(sessionId, "cancelled");
      await invokeRemoteRespond(req.reqId, 200, { ok: true, wasRunning, closedApprovals: closed });
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
      await invokeRemoteRespond(req.reqId, 200, {
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
      await invokeRemoteRespond(req.reqId, 200, {
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
        await invokeRemoteRespond(req.reqId, 405, { error: "method_not_allowed" });
        return;
      }
      let body: any = {};
      try { body = JSON.parse(req.body || "{}"); } catch { /* ignore */ }
      const sessionId = String(body.sessionId || "").trim();
      if (!sessionId) {
        await invokeRemoteRespond(req.reqId, 400, { error: "sessionId 必填" });
        return;
      }
      const row = SessionStorage.getSession(sessionId);
      if (!row) {
        await invokeRemoteRespond(req.reqId, 404, { error: `会话不存在：${sessionId}` });
        return;
      }
      const projectId = row.projectId || useProjectStore.getState().currentProject?.id || "";
      /*
       * 第 191 波：项目根路径走唯一实现（原来这里自己反查了一遍 `getProject(...).path`）。
       * 语义与旧写法一致：会话有登记项目 ⇒ 用它的项目根；会话**没有**项目 ⇒ 才回落到当前项目。
       */
      const projectPath =
        sessionProjectPath(sessionId) || (row.projectId ? "" : useProjectStore.getState().currentProject?.path || "");

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
            await invokeRemoteRespond(req.reqId, 400, {
              error: `无法解析这个 selectionId：${e?.message ?? e}`,
              code: "model_selection_invalid",
            });
            return;
          }
        }
        const mode = (row as any).executionMode === "api" ? "api" : "cli";
        const allowed = (mode === "cli" ? MIMO_MODELS : getConfiguredApiModels()).some((m) => m.id === modelId);
        if (!allowed) {
          await invokeRemoteRespond(req.reqId, 400, {
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
            await invokeRemoteRespond(req.reqId, 400, {
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
          await invokeRemoteRespond(req.reqId, 403, {
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
      await invokeRemoteRespond(req.reqId, 200, { ok: true, applied });
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
      await invokeRemoteRespond(req.reqId, 200, {
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
      await invokeRemoteRespond(req.reqId, 200, {
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
        await invokeRemoteRespond(req.reqId, 405, { error: "method_not_allowed" });
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
        await invokeRemoteRespond(req.reqId, 400, {
          error: "action 必须是 allow/deny（本地）或 allow-once/reject（远端）",
        });
        return;
      }
      const out = answerApproval(route.requestId, action, "phone");
      // 失败码如实回给 AA 端（界面据此显示"这个请求已被处理或已失效"，而不是假装成功）
      await invokeRemoteRespond(req.reqId, out.ok ? 200 : 409, out);
      return;
    }
    default:
      await invokeRemoteRespond(req.reqId, 404, { error: "not_found" });
  }
}

// ========== 事件桥 ==========

let engineStarted = false;

/**
 * 启动桌面引擎桥（幂等）：监听 Rust 回环 bridge 的 `remote-request`，
 * 路由到真实存储/引擎，再用 `remote_respond` 回给 AA connector。
 *
 * 没有配对/状态/自动启动：bridge 由 Rust 在应用启动时拉起，只绑 127.0.0.1。
 */
export function startRemoteEngine(): () => void {
  if (engineStarted) return () => {};
  engineStarted = true;

  const tauri: any = (window as any).__TAURI__;
  if (!tauri?.event?.listen || !tauri?.core?.invoke) {
    engineStarted = false;
    return () => {};
  }
  const listen = tauri.event.listen.bind(tauri.event);
  const unlisteners: Array<() => void> = [];

  /**
   * M2：审批代理的每次变化 → `approval.requested` / `approval.resolved` 事件。
   *
   * 为什么订阅代理而不是包 `onPermissionRequest`：代理是**所有**回答方共用的唯一
   * 状态（桌面弹窗、手机、微信、回合收尾 fail-closed）。订阅它，任何一方动了表，
   * 另一方的界面都会同步；包回调只能覆盖"请求产生"这一个方向。
   *
   * 先做一次 diff（把启动前就挂着的待批项发出去），再订阅后续变化。
   */
  const publishApprovalChanges = (): void => {
    try {
      for (const event of gatewayApprovalEvents.diff(
        listApprovals({ includeDecided: true }),
      )) {
        gatewayEvents.publish(event);
      }
    } catch (e) {
      console.warn("[remote-engine] approval event diff failed:", e);
    }
  };
  publishApprovalChanges();
  const unsubscribeApprovals = subscribeApprovals(publishApprovalChanges);
  unlisteners.push(unsubscribeApprovals);

  try {
    listen("remote-request", (e: any) => {
      const p = e?.payload;
      if (!p?.reqId) return;
      void handleRemoteRequest({
        reqId: p.reqId,
        method: p.method || "GET",
        path: p.path || "/",
        query: p.query || {},
        body: p.body || "",
      }).catch((err) => console.warn("[remote-engine] handle failed:", err));
    }).then((un: () => void) => unlisteners.push(un)).catch(() => {});
  } catch { /* non-tauri */ }

  return () => {
    engineStarted = false;
    unlisteners.forEach((u) => { try { u(); } catch { /* noop */ } });
    unlisteners.length = 0;
  };
}

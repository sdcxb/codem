/**
 * PC 桌面远程网关（ADR-0005）的渲染层半层。
 *
 * Rust 侧（`src-tauri/src/phone/gateway`）绑 127.0.0.1 的**随机端口**，负责：
 *   - 静态共享 UI（`packages/host/web` 的 index/ui.js/ui.css）；
 *   - 6 位一次性配对码 + HttpOnly cookie；
 *   - `/rpc` 的鉴权与精确方法白名单；
 *   - `/events` 的 SSE 广播与 `Last-Event-ID` 续传（见 `gateway/events.rs`）。
 *
 * 本模块只处理已经通过 Rust 鉴权的 `/rpc` 请求，数据与执行由调用方注入：
 *   - `session.list` → 桌面现有 `ProjectStorage` / `SessionStorage`（`flattenSessions`）；
 *   - `session.get`  → 桌面现有 `MessageStorage`，并附上网关 run 的实时状态；
 *   - `prompt.send`  → 桌面现有 Agent 循环（`executeSessionTurn`，**不新建循环**）；
 *   - `run.cancel`   → 桌面现有 `cancelSessionExecution` + 审批收口；
 *   - `approval.*`   → 桌面现有审批代理（`approval-broker`，与桌面 UI 同一张表）；
 *   - `workspace.*`  → 桌面当前项目（只读；边界在 Rust，敏感审批见 `gateway-workspace.ts`）；
 *   - `session.changes` / `session.change.diff` → 桌面 `turn_file_changes` + 桌面 git
 *     （数据注入见 `desktop-engine.ts`；网关不建第二份记录）。
 *
 * 结构上的硬约束：本文件**不 import** `../llm` / `../session` / `../storage`，
 * 所以按构造不可能在这里跑第二套 Agent 循环或绕过桌面存储直读库
 * （判据：`src/test/remote-gateway-skeleton.test.ts` 的 GW-5）。
 *
 * ## 当前能力（M3 文件面 + 变更面）
 *
 * 13 个方法：4 个只读会话 + `prompt.send` / `run.cancel` + `approval.list` /
 * `approval.respond` + `workspace.list` / `workspace.read` / `workspace.diff` +
 * `session.changes` / `session.change.diff`。
 * 事件流 `/events` 不是 RPC 方法，因此不出现在 capabilities 的两张表里
 * （判据 GW-W9 钉住这条形状）。
 * **仍未开放**：`run.guidance`、`session.create`、`attachment.put` —— 共享 UI 按
 * capabilities 隐藏这些入口，网关层也拒绝（不依赖界面自觉）。
 */

import type {
  SessionChangeDiffResult,
  SessionChangesResult,
  WorkspaceDiffResult,
  WorkspaceListResult,
  WorkspaceReadResult,
} from "../../../packages/protocol/src/index";

/** 网关在 body 里自报的服务名（排障时用来确认连的是桌面网关，而不是 Host sidecar）。 */
export const GATEWAY_SERVICE_NAME = "codem-gateway";

/** 与 Rust `gateway/mod.rs` 的 `GATEWAY_HOST_ID` 对齐。 */
export const GATEWAY_HOST_ID = "codem-desktop";

export const GATEWAY_HEALTH_PATH = "/health";
export const GATEWAY_RPC_PATH = "/rpc";

/** 网关当前开放的方法白名单（与 Rust `RPC_ALLOWED_METHODS` 一一对应）。 */
export const GATEWAY_RPC_METHODS = [
  "host.hello",
  "host.diagnostics",
  "session.list",
  "session.get",
  "session.create",
  "project.list",
  "project.create",
  "prompt.send",
  "run.cancel",
  "approval.list",
  "approval.respond",
  "workspace.list",
  "workspace.read",
  "workspace.diff",
  "session.changes",
  "session.change.diff",
] as const;

/** 协议里有、但网关**还没实现**的方法（如实列给共享 UI，不画假按钮）。 */
export const GATEWAY_UNSUPPORTED_METHODS = [
  "run.guidance",
  "plugins.list",
  "attachment.put",
] as const;

type GatewayRpcMethod = (typeof GATEWAY_RPC_METHODS)[number];

export type GatewayRoute = { type: "health" } | { type: "rpc" } | null;

/** 路径 → 路由。网关只认 `/health` 与 `/rpc`；其余返回 null（AA 的 `/api/*` 不受影响）。 */
export function parseGatewayPath(path: string): GatewayRoute {
  if (path === GATEWAY_HEALTH_PATH) return { type: "health" };
  if (path === GATEWAY_RPC_PATH) return { type: "rpc" };
  return null;
}

export interface GatewayReply {
  status: number;
  body: unknown;
}

/**
 * 纯函数：`GET /health` 的应答（不做 I/O）。
 *
 * 返回 `null` = "这不是网关的 health 路径"，调用方**不要**应答。
 */
export function gatewayReply(method: string, path: string): GatewayReply | null {
  if (path !== GATEWAY_HEALTH_PATH) return null;
  if (method !== "GET") {
    return {
      status: 405,
      body: { error: "method_not_allowed", message: "GET /health only" },
    };
  }
  return { status: 200, body: { ok: true, service: GATEWAY_SERVICE_NAME } };
}

// ========== 数据注入契约（由 desktop-engine 提供） ==========

export interface GatewaySessionSummary {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  updatedAt?: number;
  createdAt?: number;
  messageCount?: number;
  lastMessageAt?: number;
}

/**
 * 项目投影（`project.list` / `project.create` 的唯一形状）。
 *
 * 不含沙箱/安全设置：手机只用来"选一个项目"，多带的字段既没用也会变成第二份状态。
 */
export interface GatewayProjectSummary {
  id: string;
  name: string;
  path: string;
  pinned: boolean;
  lastAccessedAt: number;
}

/**
 * 远程**建**（项目/会话）的结果：失败是**具名失败**，不是异常上抛。
 *
 * 为什么不用 throw：网关的边界只做形状与错误码映射；`desktop-engine` 里的检查
 * （路径不存在/重复/沙箱外）本来就是"可预期的拒绝"，用返回值把原因带全，
 * 才不会在手机端退化成一句"操作失败"。
 */
export type GatewayCreateFailure = {
  ok: false;
  code: "INVALID_PARAMS" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";
  message: string;
  hint?: string;
};
export type GatewayCreateOutcome<T> = { ok: true; value: T } | GatewayCreateFailure;

export interface GatewaySessionDetail {
  session: GatewaySessionSummary;
  messages: Array<Record<string, unknown>>;
  hasMore?: boolean;
  /**
   * 该会话当前是否有**网关发起**的 run（手机刷新/重连后据此恢复"停止"按钮）。
   *
   * 只报网关自己的 run：桌面/AA 前台回合不在这张归属表里，报一个假的 runId
   * 会让 `run.cancel` 100% 失败（见 `gateway-runs.ts` 的归属规则）。
   */
  run?: { runId: string; state: string } | null;
}

/**
 * 桌面审批代理投影（网关只认这个形状，不 import permission 模块）。
 *
 * 与 `approval-broker.ts` 的 `ApprovalView` 结构兼容；`approval.list` 的应答与
 * `approval.requested` 事件都走 `toGatewayApprovalItem()` **同一个**映射函数，
 * 避免"列表里的卡片"和"推过来的卡片"字段不一致。
 */
export interface GatewayApprovalView {
  requestId: string;
  sessionId: string;
  tool: string;
  preview: string;
  input: Record<string, unknown>;
  status: string;
  revision: number;
  /** 已决定时由代理填（`allow`/`deny`）；待批时缺省。 */
  decidedAction?: "allow" | "deny";
  /** 谁决定的（`desktop`/`phone`/…，只用于界面措辞，不是鉴权）。 */
  decidedBy?: string;
}

/** 手机可渲染的审批项（与 `packages/ui` 的 `ApprovalItem` 对齐，多带状态/版本）。 */
export interface GatewayApprovalItem {
  approvalId: string;
  tool: string;
  summary: string;
  details?: Record<string, unknown>;
  status: string;
  revision: number;
}

/** 审批视图 → 协议项（**唯一**映射点）。 */
export function toGatewayApprovalItem(view: GatewayApprovalView): GatewayApprovalItem {
  return {
    approvalId: view.requestId,
    tool: view.tool,
    summary: view.preview,
    details: view.input,
    status: view.status,
    revision: view.revision,
  };
}

/**
 * 桌面存储 + 执行的投影。**函数由调用方注入**，网关模块不直接 import storage/llm。
 *
 * `sendPrompt` / `cancelRun` / `listApprovals` / `respondApproval` 是 M2 的写与
 * 审批路径：网关只做字段校验、错误映射与 JSON-RPC 形状，真正的执行、归属判断与
 * 审批裁决都在 `desktop-engine`（复用桌面唯一循环与唯一审批代理）。
 */
export interface GatewayDataDeps {
  listSessions: () => GatewaySessionSummary[];
  getSession: (sessionId: string, limit: number) => GatewaySessionDetail | null;
  sendPrompt: (input: GatewaySendPromptInput) => Promise<GatewaySendPromptResult>;
  cancelRun: (input: GatewayCancelRunInput) => GatewayCancelRunResult;
  listApprovals: (input: GatewayApprovalListInput) => GatewayApprovalView[];
  respondApproval: (input: GatewayApprovalRespondInput) => GatewayApprovalAnswer;
  /**
   * 桌面工作区文件面（M3）。必须注入：数据只有一份（桌面当前项目），
   * 边界与敏感审批在 `gateway-workspace.ts`，网关引擎只做形状与错误码。
   */
  workspace: GatewayWorkspaceApi;
  /**
   * 桌面变更记录（M3 变更面）。数据只有桌面 `turn_file_changes` 这一份，
   * 按会话工作区取 git 对象；接线见 `desktop-engine.ts`。
   */
  changes: GatewayChangesApi;
  /**
   * 项目面（B1）。数据只有 `projects` 表这一份；**不**在网关侧再存一份项目。
   *
   * 做成可选是为了让既有测试 harness 只注入它们关心的依赖：缺哪个方法，
   * `host.hello` 的能力清单就**不**报它（不出现点了必失败的按钮），
   * 生产接线在 `desktop-engine.ts` 里永远三个都给。
   */
  listProjects?: () => GatewayProjectSummary[];
  createProject?: (input: { name: string; path: string }) => Promise<GatewayCreateOutcome<GatewayProjectSummary>>;
  createSession?: (input: { title?: string; projectId?: string }) => Promise<GatewayCreateOutcome<GatewaySessionSummary>>;
}

/** 变更面注入契约（生产接线见 `desktop-engine.ts`）。 */
export interface GatewayChangesApi {
  list(sessionId: string, offset: number, limit: number): Promise<SessionChangesResult>;
  diff(sessionId: string, changeId: string, path: string): Promise<SessionChangeDiffResult>;
}

/** 文件面注入契约（生产实现见 `gateway-workspace.ts`）。 */
export interface GatewayWorkspaceApi {
  list(path: string): Promise<WorkspaceListResult>;
  read(path: string, offset: number, limit: number, approvalId?: string): Promise<WorkspaceReadResult>;
  diff(path: string, base: string, approvalId?: string): Promise<WorkspaceDiffResult>;
  /** 当前数据根（只用于 `host.diagnostics`；解析失败返回 null）。 */
  root(): Promise<string | null>;
}

/** `approval.list` 的入参（已校验）。 */
export interface GatewayApprovalListInput {
  /** 只列这个会话的；缺省 = 全部（手机可能还没选中会话）。 */
  sessionId?: string;
  /** true = 连已被桌面/手机处理过的也列（界面据此收起按钮）。 */
  includeDecided?: boolean;
}

/** `approval.respond` 的入参（已校验）。 */
export interface GatewayApprovalRespondInput {
  approvalId: string;
  decision: "allow" | "deny";
}

/**
 * `approval.respond` 的结果。
 *
 * `NOT_PENDING` 是**真实且常见**的失败：请求已被桌面处理、已过期、或已随回合
 * 收口（fail-closed）。手机界面据此收起卡片，而不是假装点成功了。
 */
export type GatewayApprovalAnswer =
  | { ok: true; approvalId: string; decision: "allow" | "deny"; decidedBy: string }
  | { ok: false; kind: "NOT_PENDING" | "INVALID_ACTION"; message: string };

/** `prompt.send` 的入参（已校验）。 */
export interface GatewaySendPromptInput {
  sessionId: string;
  text: string;
  /** 幂等键：同一会话 + 同一 clientId 下重发返回同一个 runId */
  requestId?: string;
  /** 发起方自述标识（**不是**鉴权，见 `gateway-runs.ts`） */
  clientId?: string;
}

/**
 * `prompt.send` 的失败分类。
 *
 * 每一项都对应手机端**能据此行动**的文案：
 * - `BUSY`：这个会话正在跑（可能是桌面，也可能是这台设备的上一条）；
 * - `RUN_OWNED`：这个会话正在被**另一台设备**的网关 run 占用（去那台设备停，或等）；
 * - `BUSY_LIMIT`：本机并发上限已满（换一个会话或等一个结束）；
 * - `NOT_FOUND`：会话不存在；
 * - `NO_WORKSPACE`：会话没有可用工作目录；
 * - `ENGINE_UNAVAILABLE`：桌面引擎未就绪。
 */
type GatewaySendPromptFailure =
  | "BUSY"
  | "RUN_OWNED"
  | "BUSY_LIMIT"
  | "NOT_FOUND"
  | "NO_WORKSPACE"
  | "ENGINE_UNAVAILABLE";
export type GatewaySendPromptResult =
  | {
      ok: true;
      runId: string;
      sessionId: string;
      /** true = 同一条 requestId 的重发，没有产生第二次执行 */
      deduplicated?: boolean;
    }
  | { ok: false; kind: GatewaySendPromptFailure; message: string };

export interface GatewayCancelRunInput {
  runId: string;
  /** 发起方自述标识（只有发起者能取消自己那次运行） */
  clientId?: string;
}

export type GatewayCancelRunResult =
  | {
      ok: true;
      runId: string;
      sessionId: string;
      /** false = 那次运行已经结束，没有可取消的东西（不是错误） */
      cancelled: boolean;
      state: string;
    }
  | { ok: false; kind: "RUN_NOT_FOUND" | "RUN_OWNED"; message: string };

/** 网关自定义 JSON-RPC 错误码（-32000 段留给实现方）。 */
const RPC_CODES = {
  invalidParams: -32602,
  notFound: -32003,
  conflict: -32004,
  unsupported: -32006,
  approvalRequired: -32008,
  busy: -32011,
  runOwned: -32012,
  busyLimit: -32013,
  runNotFound: -32014,
  noWorkspace: -32015,
  engineUnavailable: -32016,
  approvalNotPending: -32021,
  approvalInvalidAction: -32022,
} as const;

const SEND_FAILURE_CODES: Record<GatewaySendPromptFailure, number> = {
  BUSY: RPC_CODES.busy,
  RUN_OWNED: RPC_CODES.runOwned,
  BUSY_LIMIT: RPC_CODES.busyLimit,
  NOT_FOUND: RPC_CODES.notFound,
  NO_WORKSPACE: RPC_CODES.noWorkspace,
  ENGINE_UNAVAILABLE: RPC_CODES.engineUnavailable,
};

/** 这些失败过一会儿重试有意义（本机状态会变）；其余重试也没用。 */
const RETRYABLE_SEND_FAILURES = new Set<GatewaySendPromptFailure>([
  "BUSY",
  "RUN_OWNED",
  "BUSY_LIMIT",
]);

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 300;
const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 500;

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(n)));
}

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  kind: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data: { kind, retryable: false, ...extra },
    },
  };
}

/**
 * 能力清单的**唯一**算法：缺注入方法 ⇒ 不报支持。
 *
 * 为什么不直接返回 `GATEWAY_RPC_METHODS`：方法白名单 ≠ 这台桌面真的接得上。
 * 生产 `desktop-engine` 三个都给；测试 harness / 旧桌面缺哪个，`host.hello`
 * 就把它列进 unsupported —— 手机据此**不画**那个按钮（"点了必失败"是禁止形态）。
 */
export function gatewaySupportedMethods(
  deps: Pick<GatewayDataDeps, "listProjects" | "createProject" | "createSession">,
): string[] {
  return GATEWAY_RPC_METHODS.filter((method) => {
    if (method === "project.list") return Boolean(deps.listProjects);
    if (method === "project.create") return Boolean(deps.createProject);
    if (method === "session.create") return Boolean(deps.createSession);
    return true;
  });
}

/** 远程建的失败 → JSON-RPC 错误码（**唯一**映射点） */
function createFailureReply(id: JsonRpcId, failure: GatewayCreateFailure): Record<string, unknown> {
  switch (failure.code) {
    case "INVALID_PARAMS":
      return rpcError(id, -32602, failure.message, "INVALID_PARAMS", failure.hint ? { hint: failure.hint } : {});
    case "NOT_FOUND":
      return rpcError(id, -32003, failure.message, "NOT_FOUND", failure.hint ? { hint: failure.hint } : {});
    case "CONFLICT":
      return rpcError(id, -32004, failure.message, "CONFLICT", failure.hint ? { hint: failure.hint } : {});
    case "UNAVAILABLE":
      return rpcError(id, -32000, failure.message, "UNAVAILABLE", failure.hint ? { hint: failure.hint } : {});
  }
}

const PROJECT_NAME_MAX = 80;
const SESSION_TITLE_MAX = 200;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 只接受字符串并把两端空白去掉；其它类型一律当空（调用方据此报 INVALID_PARAMS）。 */
function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readInteger(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * 文件面失败 → JSON-RPC 错误。
 *
 * `APPROVAL_REQUIRED` 必须走 `data.details` **再套一层**：共享 UI 的
 * `HostRpcError` 读的是 `error.data.details`，而 `SensitiveApprovalRequiredDetails`
 * 本身就是那个 details 对象（见 `packages/protocol/src/index.ts`）。
 */
function workspaceErrorReply(
  id: JsonRpcId,
  e: unknown,
): Record<string, unknown> {
  const failure = e as { kind?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const kind = typeof failure?.kind === "string" ? failure.kind : "";
  const message = typeof failure?.message === "string" ? failure.message : "读取桌面工作区失败";
  const hint = typeof failure?.hint === "string" && failure.hint ? { hint: failure.hint } : {};
  switch (kind) {    case "INVALID_PARAMS":
      return rpcError(id, RPC_CODES.invalidParams, message, kind, hint);
    case "NOT_FOUND":
      return rpcError(id, RPC_CODES.notFound, message, kind, hint);
    case "APPROVAL_REQUIRED":
      return rpcError(id, RPC_CODES.approvalRequired, message, kind, {
        ...hint,
        ...(failure.details !== undefined ? { details: failure.details } : {}),
      });
    case "CONFLICT":
      return rpcError(id, RPC_CODES.conflict, message, kind, { ...hint, retryable: true });
    default:
      // 未知异常（包括未预期的 IPC 失败）不回显原文：它可能带 OS 绝对路径。
      return rpcError(id, -32603, "读取桌面工作区失败", "INTERNAL", hint);
  }
}

/**
 * 变更面失败 → JSON-RPC 错误。
 *
 * 业务错误来自共享的 `createChangesService`（`HostError`），只有
 * `INVALID_PARAMS` / `NOT_FOUND` / `INTERNAL` 三种；没有审批分支。
 * 未知异常不回显原文：它可能带 OS 绝对路径。
 */
function changesErrorReply(id: JsonRpcId, e: unknown): Record<string, unknown> {
  const failure = e as { kind?: unknown; message?: unknown; hint?: unknown };
  const kind = typeof failure?.kind === "string" ? failure.kind : "";
  const message = typeof failure?.message === "string" ? failure.message : "读取桌面变更记录失败";
  const hint = typeof failure?.hint === "string" && failure.hint ? { hint: failure.hint } : {};
  switch (kind) {
    case "INVALID_PARAMS":
      return rpcError(id, RPC_CODES.invalidParams, message, kind, hint);
    case "NOT_FOUND":
      return rpcError(id, RPC_CODES.notFound, message, kind, hint);
    case "CONFLICT":
      return rpcError(id, RPC_CODES.conflict, message, kind, { ...hint, retryable: true });
    default:
      return rpcError(id, -32603, "读取桌面变更记录失败", "INTERNAL", hint);
  }
}

/**
 * 处理一条已经通过 Rust 鉴权的 `/rpc` body。
 *
 * 永远返回 JSON-RPC 应答（HTTP 状态由 Rust 决定，这里不碰 HTTP）。
 * 白名单之外的（含还没实现的写方法）返回 `UNSUPPORTED`，不会触碰桌面数据/引擎。
 */
export async function gatewayRpcReply(
  body: string,
  deps: GatewayDataDeps,
): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return rpcError(null, -32700, "JSON 解析失败", "PARSE_ERROR");
  }
  const request = asObject(payload);
  if (!request) {
    return rpcError(null, -32600, "只接受单个 JSON-RPC 对象", "INVALID_REQUEST");
  }
  const rawId = request.id;
  const id: JsonRpcId =
    typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  const method = request.method;
  if (typeof method !== "string" || !method) {
    return rpcError(id, -32600, "缺少 method", "INVALID_REQUEST");
  }
  const params = asObject(request.params) ?? {};

  try {
    switch (method) {
      case "host.hello": {
        const version = Number(params.protocolVersion);
        if (version !== 1) {
          return rpcError(id, -32002, "协议版本不匹配", "VERSION_MISMATCH", {
            hint: "M1 共享 UI 只支持 protocolVersion=1",
          });
        }
        const supported = gatewaySupportedMethods(deps);
        return rpcResult(id, {
          hostId: GATEWAY_HOST_ID,
          auth: { kind: "device", deviceId: "desktop-gateway", deviceName: "PC 桌面" },
          capabilities: {
            supported,
            unsupported: [
              ...GATEWAY_UNSUPPORTED_METHODS,
              ...GATEWAY_RPC_METHODS.filter((m) => !supported.includes(m)),
            ],
          },
        });
      }
      case "host.diagnostics":
        return rpcResult(id, {
          hostId: GATEWAY_HOST_ID,
          desktop: true,
          /**
           * 写路径第一批已开放（`prompt.send` / `run.cancel`），所以**不是**只读网关。
           *
           * 精确能力看 `host.hello.capabilities` —— 这里只报"这台网关是不是纯只读"，
           * 不再维护第二份方法清单（两份清单必然漂移，M1 只读标记就是这么变成假话的）。
           */
          readOnly: false,
          sessions: deps.listSessions().length,
          /*
           * 手机需要知道"文件页签看的是哪个根"（跨项目时尤其重要）。
           * 只放诊断、不放进 hello：hello 是能力握手，不该带盘符。
           */
          workspaceRoot: await deps.workspace.root().catch(() => null),
        });
      case "session.list": {
        const limit = clampLimit(params.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const all = deps.listSessions();
        return rpcResult(id, {
          items: all.slice(0, limit),
          hasMore: all.length > limit,
        });
      }
      case "session.get": {
        const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
        if (!sessionId) {
          return rpcError(id, -32602, "sessionId 必填", "INVALID_PARAMS");
        }
        const limit = clampLimit(params.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
        const got = deps.getSession(sessionId, limit);
        if (!got) {
          return rpcError(id, -32003, `会话不存在：${sessionId}`, "NOT_FOUND");
        }
        return rpcResult(id, {
          session: got.session,
          messages: got.messages,
          hasMore: got.hasMore === true,
          /**
           * 刷新/重连后的运行态恢复：没有这一条，页面重新打开时手机看不到
           * "这个会话正在跑"，也就没有"停止"按钮（runId 只存在于上一次内存里）。
           */
          run: got.run ?? null,
        });
      }
      case "project.list": {
        if (!deps.listProjects) {
          return rpcError(id, -32006, "该桌面版本未开放项目列表", "UNSUPPORTED");
        }
        const limit = clampLimit(params.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
        const all = deps.listProjects();
        return rpcResult(id, { items: all.slice(0, limit), hasMore: all.length > limit });
      }
      case "project.create": {
        if (!deps.createProject) {
          return rpcError(id, -32006, "该桌面版本未开放远程新建项目", "UNSUPPORTED");
        }
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (!name || name.length > PROJECT_NAME_MAX) {
          return rpcError(id, -32602, `name 必填且不超过 ${PROJECT_NAME_MAX} 字`, "INVALID_PARAMS");
        }
        const path = typeof params.path === "string" ? params.path.trim() : "";
        if (!path) {
          return rpcError(id, -32602, "path 必填（绝对路径）", "INVALID_PARAMS");
        }
        const outcome = await deps.createProject({ name, path });
        return outcome.ok ? rpcResult(id, { project: outcome.value }) : createFailureReply(id, outcome);
      }
      case "session.create": {
        if (!deps.createSession) {
          return rpcError(id, -32006, "该桌面版本未开放远程新建会话", "UNSUPPORTED");
        }
        const rawTitle = typeof params.title === "string" ? params.title.trim() : "";
        if (rawTitle.length > SESSION_TITLE_MAX) {
          return rpcError(id, -32602, `title 不超过 ${SESSION_TITLE_MAX} 字`, "INVALID_PARAMS");
        }
        const rawProjectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
        const outcome = await deps.createSession({
          ...(rawTitle ? { title: rawTitle } : {}),
          ...(rawProjectId ? { projectId: rawProjectId } : {}),
        });
        return outcome.ok ? rpcResult(id, { session: outcome.value }) : createFailureReply(id, outcome);
      }
      case "prompt.send": {
        /**
         * 手机发一句话 → 桌面跑一轮（**受理语义**）。
         *
         * 为什么必须立即返回 `{runId}`：完整 Agent 回合可能几分钟，而 Rust 网关
         * → 渲染层的往返有 15s 上限（`phone/mod.rs` 的 `PROXY_TIMEOUT`）。等回合跑完
         * 再答 = 手机必超时、且网关不知道这次到底有没有开始。AA 的 `/api/chat`
         * 早就踩过这个坑（先 202 再后台跑），这里用同一个口径：**先受理，结果看会话**。
         */
        const sessionId = readString(params.sessionId);
        if (!sessionId) {
          return rpcError(id, RPC_CODES.invalidParams, "sessionId 必填", "INVALID_PARAMS");
        }
        const text = readString(params.text);
        if (!text) {
          return rpcError(
            id,
            RPC_CODES.invalidParams,
            "text 必填（不能是空白）",
            "INVALID_PARAMS",
          );
        }
        const attachmentIds = params.attachmentIds;
        if (attachmentIds !== undefined && !Array.isArray(attachmentIds)) {
          return rpcError(
            id,
            RPC_CODES.invalidParams,
            "attachmentIds 必须是数组",
            "INVALID_PARAMS",
          );
        }
        if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
          /**
           * 附件方法根本没实现。**在这里如实拒绝**，而不是收下 id 然后悄悄丢掉：
           * 那会让用户以为文件发出去了（共享 UI 侧也已按能力位隐藏附件入口）。
           */
          return rpcError(
            id,
            RPC_CODES.unsupported,
            "网关未开放附件（attachment.put 未实现）",
            "UNSUPPORTED",
            { method: "attachment.put" },
          );
        }
        const sent = await deps.sendPrompt({
          sessionId,
          text,
          requestId: readString(params.requestId) || undefined,
          clientId: readString(params.clientId) || undefined,
        });
        if (!sent.ok) {
          return rpcError(id, SEND_FAILURE_CODES[sent.kind], sent.message, sent.kind, {
            ...(RETRYABLE_SEND_FAILURES.has(sent.kind) ? { retryable: true } : {}),
          });
        }
        if (!sent.runId) {
          // 注入方违约（没有 runId 就无法取消/归属）：如实报内部错误，不编一个 id。
          return rpcError(id, -32603, "网关没有拿到 runId", "INTERNAL");
        }
        return rpcResult(id, {
          runId: sent.runId,
          sessionId: sent.sessionId || sessionId,
          ...(sent.deduplicated ? { deduplicated: true } : {}),
        });
      }
      case "run.cancel": {
        /**
         * 手机停一次**网关发起**的运行。
         *
         * `requestId` 在这里**不用**：取消本身就是幂等的（同一次运行取消两次，
         * 第二次得到 `cancelled:false`），再造一套幂等键只会多一个真相。
         *
         * 桌面发起的回合**不在**网关的归属表里 ⇒ `RUN_NOT_FOUND`。这是刻意的：
         * `cancelSessionExecution` 对前台回合的空 controller 是空操作（那只是"忙碌标记"），
         * 假装取消成功会让手机界面显示"已停止"而桌面还在跑。
         */
        const runId = readString(params.runId);
        if (!runId) {
          return rpcError(id, RPC_CODES.invalidParams, "runId 必填", "INVALID_PARAMS");
        }
        const cancelled = deps.cancelRun({
          runId,
          clientId: readString(params.clientId) || undefined,
        });
        if (!cancelled.ok) {
          return rpcError(
            id,
            cancelled.kind === "RUN_NOT_FOUND" ? RPC_CODES.runNotFound : RPC_CODES.runOwned,
            cancelled.message,
            cancelled.kind,
          );
        }
        return rpcResult(id, {
          runId: cancelled.runId,
          sessionId: cancelled.sessionId,
          cancelled: cancelled.cancelled,
          state: cancelled.state,
        });
      }
      case "approval.list": {
        /**
         * 手机读**桌面待批表**（`approval-broker`）。与桌面弹窗、AA/微信读到的是
         * 同一张表 —— 不是网关另存一份，所以"桌面已处理"在手机上立刻消失。
         */
        const sessionId = readString(params.sessionId) || undefined;
        if (params.sessionId !== undefined && !sessionId) {
          return rpcError(
            id,
            RPC_CODES.invalidParams,
            "sessionId 必须是非空字符串（不传表示全部会话）",
            "INVALID_PARAMS",
          );
        }
        const includeDecided = params.includeDecided === true;
        const approvals = deps
          .listApprovals({ ...(sessionId ? { sessionId } : {}), includeDecided })
          .map(toGatewayApprovalItem);
        return rpcResult(id, { approvals });
      }
      case "approval.respond": {
        /**
         * 手机回答一次审批。答复走桌面既有 `answerApproval()`：
         * **只生效一次**、回合收尾一律按拒绝收口、桌面界面同步刷新。
         *
         * 这里**不**接受"总是允许"：远端一次性授权是代理层的硬约定
         * （见 `approval-broker.ts` 文件头），网关不另开一个口子。
         */
        const approvalId = readString(params.approvalId);
        if (!approvalId) {
          return rpcError(id, RPC_CODES.invalidParams, "approvalId 必填", "INVALID_PARAMS");
        }
        const decision = params.decision;
        if (decision !== "allow" && decision !== "deny") {
          return rpcError(
            id,
            RPC_CODES.invalidParams,
            "decision 必须是 allow 或 deny",
            "INVALID_PARAMS",
          );
        }
        const answer = deps.respondApproval({ approvalId, decision });
        if (!answer.ok) {
          return rpcError(
            id,
            answer.kind === "NOT_PENDING"
              ? RPC_CODES.approvalNotPending
              : RPC_CODES.approvalInvalidAction,
            answer.message,
            answer.kind,
          );
        }
        return rpcResult(id, {
          approvalId: answer.approvalId,
          decision: answer.decision,
          decidedBy: answer.decidedBy,
        });
      }
      case "workspace.list": {
        /**
         * 列桌面**当前项目**的一层目录。
         *
         * 路径归一化/越界判定/符号链接跳过都在 Rust（唯一边界）；这里只校验
         * JSON 参数类型并交给注入的数据层。`sessionId` 不存在：M3 的根就是
         * 桌面当前项目（手机选别的项目会话时文件页签仍显示桌面项目 —— 这是
         * M3 的已知限制，`host.diagnostics.workspaceRoot` 会如实报出当前根）。
         */
        const rawPath = params.path === undefined ? "." : params.path;
        if (typeof rawPath !== "string") {
          return rpcError(id, RPC_CODES.invalidParams, "path 必须是字符串", "INVALID_PARAMS");
        }
        try {
          return rpcResult(id, await deps.workspace.list(rawPath));
        } catch (e) {
          return workspaceErrorReply(id, e);
        }
      }
      case "workspace.read": {
        if (typeof params.path !== "string") {
          return rpcError(id, RPC_CODES.invalidParams, "path 必填（字符串）", "INVALID_PARAMS");
        }
        const offset = Math.max(0, readInteger(params.offset, 0));
        const limit = Math.min(2_000_000, Math.max(1, readInteger(params.limit, 200_000)));
        const approvalId =
          params.approvalId === undefined
            ? undefined
            : typeof params.approvalId === "string"
              ? params.approvalId
              : null;
        if (approvalId === null) {
          return rpcError(id, RPC_CODES.invalidParams, "approvalId 必须是字符串", "INVALID_PARAMS");
        }
        try {
          return rpcResult(
            id,
            await deps.workspace.read(params.path, offset, limit, approvalId || undefined),
          );
        } catch (e) {
          return workspaceErrorReply(id, e);
        }
      }
      case "workspace.diff": {
        if (typeof params.path !== "string") {
          return rpcError(id, RPC_CODES.invalidParams, "path 必填（字符串）", "INVALID_PARAMS");
        }
        const base = params.base === undefined ? "HEAD" : params.base;
        if (typeof base !== "string") {
          return rpcError(id, RPC_CODES.invalidParams, "base 必须是字符串", "INVALID_PARAMS");
        }
        const approvalId =
          params.approvalId === undefined
            ? undefined
            : typeof params.approvalId === "string"
              ? params.approvalId
              : null;
        if (approvalId === null) {
          return rpcError(id, RPC_CODES.invalidParams, "approvalId 必须是字符串", "INVALID_PARAMS");
        }
        try {
          return rpcResult(
            id,
            await deps.workspace.diff(params.path, base, approvalId || undefined),
          );
        } catch (e) {
          return workspaceErrorReply(id, e);
        }
      }
      case "session.changes": {
        /**
         * 桌面**当前会话**的文件变更记录（`turn_file_changes`）。
         *
         * 与 Host 共用 `createChangesService`，但数据由桌面注入（见
         * `desktop-engine.ts`）：桌面库、桌面会话工作区的 git 对象 —— 没有
         * "网关自己那一份记录"。`supported:false` 是结果（非 git / 对象被清理），
         * 不是错误；只有未知会话/非法参数才走 JSON-RPC 错误。
         */
        const sessionId = readString(params.sessionId);
        if (!sessionId) {
          return rpcError(id, RPC_CODES.invalidParams, "sessionId 必填", "INVALID_PARAMS");
        }
        if (sessionId.length > 256) {
          return rpcError(id, RPC_CODES.invalidParams, "sessionId 过长（>256）", "INVALID_PARAMS");
        }
        const offset = Math.min(1_000_000, Math.max(0, readInteger(params.offset, 0)));
        const limit = Math.min(50, Math.max(1, readInteger(params.limit, 20)));
        try {
          return rpcResult(id, await deps.changes.list(sessionId, offset, limit));
        } catch (e) {
          return changesErrorReply(id, e);
        }
      }
      case "session.change.diff": {
        const sessionId = readString(params.sessionId);
        const changeId = readString(params.changeId);
        if (!sessionId) {
          return rpcError(id, RPC_CODES.invalidParams, "sessionId 必填", "INVALID_PARAMS");
        }
        if (sessionId.length > 256) {
          return rpcError(id, RPC_CODES.invalidParams, "sessionId 过长（>256）", "INVALID_PARAMS");
        }
        if (!changeId) {
          return rpcError(id, RPC_CODES.invalidParams, "changeId 必填", "INVALID_PARAMS");
        }
        if (changeId.length > 256) {
          return rpcError(id, RPC_CODES.invalidParams, "changeId 过长（>256）", "INVALID_PARAMS");
        }
        /*
         * path 不 trim：文件名可以有前导/尾随空格，而 `createChangesService` 要拿它
         * 与记录里的清单做精确比较。只做类型/长度检查，归一化交给数据层。
         */
        if (typeof params.path !== "string" || params.path.length === 0) {
          return rpcError(id, RPC_CODES.invalidParams, "path 必填（字符串）", "INVALID_PARAMS");
        }
        if (params.path.length > 1_024) {
          return rpcError(id, RPC_CODES.invalidParams, "path 过长（>1024）", "INVALID_PARAMS");
        }
        try {
          return rpcResult(id, await deps.changes.diff(sessionId, changeId, params.path));
        } catch (e) {
          return changesErrorReply(id, e);
        }
      }
      default:
        return rpcError(
          id,
          RPC_CODES.unsupported,
          "网关未开放该方法（M3 开放只读会话 + 写 + 审批 + 工作区文件 + 变更记录，共 13 条）",
          "UNSUPPORTED",
          { method },
        );
    }
  } catch (e) {
    return rpcError(id, -32603, String((e as Error)?.message ?? e), "INTERNAL", {
      retryable: true,
    });
  }
}

/**
 * 处理一条来自 Rust 网关的请求。
 *
 * @param deps 桌面的存储/执行投影（生产由 `desktop-engine` 注入）
 * @returns `true` = 已应答（调用方不要再走 `/api/*` 路由）；`false` = 不是网关路径
 */
export async function handleGatewayRequest(
  req: { method: string; path: string; body?: string },
  respond: (status: number, body: unknown) => Promise<void>,
  deps?: GatewayDataDeps,
): Promise<boolean> {
  const route = parseGatewayPath(req.path);
  if (!route) return false;

  if (route.type === "health") {
    const reply = gatewayReply(req.method, req.path);
    if (!reply) return false;
    await respond(reply.status, reply.body);
    return true;
  }

  if (req.method !== "POST") {
    await respond(405, { error: "method_not_allowed", message: "POST /rpc only" });
    return true;
  }
  if (!deps) {
    await respond(500, rpcError(null, -32603, "网关数据层未装配", "INTERNAL"));
    return true;
  }
  await respond(200, await gatewayRpcReply(req.body ?? "", deps));
  return true;
}

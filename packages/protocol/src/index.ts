/**
 * `@codem/protocol` —— Host ⇄ 客户端（桌面 / 手机 WebView / PWA）的**唯一**线上契约。
 *
 * ## 为什么单独成包（而不是塞进 src/core）
 *
 * 这份契约有**三个**消费者，且它们都不该互相 import：
 *
 * 1. `packages/host`（Node 常驻服务，PC 与 Android PRoot 里同一份代码）；
 * 2. 桌面渲染进程（Tauri WebView，走 Transport 抽象）；
 * 3. 手机 WebView / PWA（同一套 React 资源，走 HTTP/WS）。
 *
 * 契约一旦分叉，症状是"桌面能用的方法手机 404"或"事件字段名不一致导致静默空白"——
 * 这类缺陷在单机版本里不存在，在远程版本里必然出现。所以把它做成**零依赖的纯类型模块**：
 * 不 import React、不 import Node、不 import Tauri，任何一端都能引。
 *
 * ## 分层（两层，别混）
 *
 * ```text
 * 客户端 ──JSON-RPC 2.0 over WS/HTTP──▶ codem-host ──NDJSON(command/params)──▶ codem-db serve
 * ```
 *
 * - **上层**（本文件）：面向"会话/提示/审批/文件预览"的语义方法，可以按产品演进；
 * - **下层**（`codem-db serve`）：仓储命令（`messages.list` 等），与渲染侧 `rust-port.ts`
 *   共用同一套解包代码，**不允许**在产品演进中改形状。
 *
 * 把两层分开的理由：手机端永远不该拿到"仓储命令"这层（那是索引细节，不是产品语义），
 * 而 Host 内部换存储实现（未来若换引擎）不应该影响任何客户端。
 *
 * ## 三个硬约定
 *
 * 1. **`requestId` 幂等**：`prompt.send` / `run.cancel` / `approval.respond` 必须带
 *    `requestId`。网络重试、手机断线重连、WS 重发都可能把同一条消息送达两次；
 *    Host 侧按 `requestId` 记忆结果（有界 TTL），重复请求返回**同一个结果**，
 *    而不是再跑一轮（"发一句话跑了两次"是最贵的缺陷）。
 * 2. **`eventSeq` 续传**：事件序号**单调递增且跨重连续用**。客户端带 `sinceSeq`
 *    订阅时，Host 先补发 `(sinceSeq, now]` 的缺口再转直播；客户端据此实现"断线不丢事件"。
 *    序号来源是 `session_events.seq`（AUTOINCREMENT，天然单调），不是内存计数器 ——
 *    后者在 Host 重启后归零，会让客户端误判"没有缺口"。
 * 3. **版本协商**：`host.hello` 必带 `protocolVersion`。Host 只接受 `[MIN_CLIENT_VERSION, PROTOCOL_VERSION]`；
 *    不匹配时回 `VERSION_MISMATCH` 并要求升级**客户端**（而不是让 Host 兼容未知字段）。
 *    理由：手机 APK 与桌面 exe 的更新节奏不同步，静默兼容会变成"两个版本各有一套半对的行为"。
 */

/** 当前协议版本。**只在破坏性变更时 +1**；加可选字段不升版本。 */
export const PROTOCOL_VERSION = 1;

/** Host 仍能服务的最低客户端版本（低于它必须升级客户端）。 */
export const MIN_CLIENT_VERSION = 1;

export type JsonRpcId = string | number;

// ========== JSON-RPC 2.0 信封 ==========

export interface RpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface RpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

/** 应用级错误种类 —— 客户端按它决定"重试 / 提示 / 升级 / 降级"，**不要解析 message 文本**。 */
export type HostErrorKind =
  | "PARSE_ERROR"
  | "INVALID_REQUEST"
  | "METHOD_NOT_FOUND"
  | "INVALID_PARAMS"
  | "UNAUTHORIZED"
  | "VERSION_MISMATCH"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LEASE_HELD"
  | "UNSUPPORTED"
  | "BUSY"
  /**
   * 敏感读取待审批：客户端必须先用 `approval.respond` 答复，再带 `approvalId` 重试。
   *
   * 为什么不复用 `UNAUTHORIZED` / `CONFLICT`：
   * - `UNAUTHORIZED` 会被客户端当成"凭据失效"直接踢回配对门（`host-client.ts` 的既有分支）；
   * - `CONFLICT` 的语义是"状态冲突、可重试"，而这里要的是"**先让用户拍板**"。
   * 老客户端不认识这个 kind 时会落到通用错误分支：只显示错误、**不返回正文**（fail-closed）。
   */
  | "APPROVAL_REQUIRED"
  | "INTERNAL";

export interface HostErrorData {
  kind: HostErrorKind;
  /** 是否值得原样重试（幂等方法才有意义） */
  retryable?: boolean;
  /** 给人看的下一步建议（与 codem-db 的 `hint` 同一口径） */
  hint?: string;
  details?: unknown;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  /** 解析失败时为 null（无法把错误配回请求） */
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: HostErrorData;
  };
}

export interface RpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: P;
}

/**
 * JSON-RPC 标准码 + 本协议的应用码扩展（-32001…-32008）。
 *
 * 刻意复用标准错误码段（-32700…-32603）：任何现成的 JSON-RPC 客户端库都能正确分类，
 * 不需要我们教它"这是错误还是结果"。
 */
export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
  VERSION_MISMATCH: -32002,
  NOT_FOUND: -32003,
  CONFLICT: -32004,
  LEASE_HELD: -32005,
  UNSUPPORTED: -32006,
  BUSY: -32007,
  APPROVAL_REQUIRED: -32008,
} as const satisfies Record<HostErrorKind, number>;

/** 方法名常量。字符串字面量也允许（便于灰度），但客户端代码应引这里。 */
export const METHODS = {
  hello: "host.hello",
  status: "host.status",
  diagnostics: "host.diagnostics",
  sessionList: "session.list",
  sessionCreate: "session.create",
  sessionGet: "session.get",
  sessionWatch: "session.watch",
  leaseTakeover: "host.lease.takeover",
  promptSend: "prompt.send",
  runCancel: "run.cancel",
  runGuidance: "run.guidance",
  runStatus: "run.status",
  approvalList: "approval.list",
  approvalRespond: "approval.respond",
  workspaceRead: "workspace.read",
  workspaceList: "workspace.list",
  pluginsList: "plugins.list",
  workspaceDiff: "workspace.diff",
  sessionChanges: "session.changes",
  sessionChangeDiff: "session.change.diff",
  attachmentPut: "attachment.put",
  /** 一次性配对：生成码 / 兑换 / 列表 / 撤销（D-7） */
  pairStart: "pair.start",
  pairClaim: "pair.claim",
  pairList: "pair.list",
  pairRevoke: "pair.revoke",
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClose: "terminal.close",
} as const;

/** 服务端推送的方法名 */
export const NOTIFICATIONS = {
  sessionEvent: "session.event",
  approvalRequested: "approval.requested",
  runState: "run.state",
  heartbeat: "host.heartbeat",
  /**
   * 撤销事件：设备令牌被桌面撤销后，Host 主动断开该设备的事件流并推一条它。
   *
   * 为什么需要它：SSE 断线本身无法区分"网络抖了"和"我被撤销了"，客户端若照常重连，
   * 只会拿到 401 且没有可解释的原因。这个通知让 UI 能立刻回到配对门。
   */
  authRevoked: "host.auth.revoked",
} as const;

// ========== 能力面（诚实声明：没实现的方法要能被客户端灰掉） ==========

/**
 * Host 能力清单。
 *
 * 为什么要显式列 `unsupported`：手机 UI 是**同一套**组件，功能矩阵靠能力位驱动。
 * 如果只有"支持列表"，客户端只能靠"调用失败再提示"来发现缺口 —— 那是把产品缺陷
 * 当成运行期异常处理（用户看到的是"点了没反应"）。
 */
export interface HostCapabilities {
  supported: string[];
  unsupported: string[];
}

// ========== host.hello ==========

export interface ClientInfo {
  name: string;
  version: string;
  platform: "windows" | "macos" | "linux" | "android" | "ios" | "web" | "unknown";
}

export interface LeaseInfo {
  holder: "none" | "local" | "remote";
  clientId?: string;
  deviceName?: string;
  expiresAt?: number;
}

export interface LeaseTakeoverParams {
  clientId: string;
  deviceName?: string;
  /** 第一次不传（只拿 needsConfirmation），确认后才传 true */
  confirm?: boolean;
}

export interface LeaseTakeoverResult {
  granted: boolean;
  needsConfirmation: boolean;
  lease: LeaseInfo;
  previousHolder?: string;
}

export interface HelloParams {
  protocolVersion: number;
  client: ClientInfo;
  /**
   * 静态访问令牌（`CODEM_HOST_TOKEN`）的旧字段。设备凭据**不在这里**：
   * 它由 `pair.claim` 通过 `Set-Cookie` 下发（HttpOnly），浏览器同源请求
   * （含 EventSource）自动携带；客户端拿不到、也不需要明文。
   */
  token?: string;
  /** 设备自报的名字（配对页显示用；服务端不信任它做鉴权） */
  deviceName?: string;
  /** 是否认领单写者租约；只读观察者/诊断工具必须不传（否则会把 UI 的租约抢走） */
  claim?: boolean;
}

export interface HelloResult {
  server: {
    name: "codem-host";
    version: string;
    protocolVersion: number;
    minClientVersion: number;
  };
  /** Host 身份（配对/多主机列表用；不是密钥） */
  hostId: string;
  /** 数据根（诊断用；远程模式下**不**下发给非 loopback 客户端） */
  dataHome?: string;
  capabilities: HostCapabilities;
  /** 单写者租约：拿到租约的客户端才能发 prompt（见 ADR-0003） */
  lease: LeaseInfo;
  /** 本次 hello 是否获得/续期了租约（false = 他人持有，需走 takeover 二次确认） */
  leaseGranted?: boolean;
  /**
   * 本次请求的认证身份（只给客户端显示"本机 / 固定令牌 / 已配对为 xxx"）。
   *
   * **绝不含 token / hash**：这是身份描述，不是凭据。缺省 = 服务端没有鉴权信息
   * （旧 Host），客户端应把它当成"不知道"，而不是"未鉴权"。
   */
  auth?: HelloAuthInfo;
}

export interface HelloAuthInfo {
  kind: "local" | "static" | "device";
  /** kind=device 时：设备 id（不是密钥） */
  deviceId?: string;
  /** kind=device 时：配对时自报的设备名（仅显示用） */
  deviceName?: string;
}

// ========== 一次性配对（D-7） ==========

/**
 * 配对凭据模型（**只有一套凭据**）：
 *
 * - 配对码：6 位数字，只在 Host 内存、5 分钟、单次；桌面/本机生成；
 * - 设备凭据：32 字节随机数（64 hex），`pair.claim` 成功时**只**以 `Set-Cookie` 下发
 *   （HttpOnly / SameSite=Strict / 可 Secure / 必须带 Max-Age），浏览器同源请求自动携带；
 *   `pair.claim` 的 JSON 结果里**没有** token，页面 JS 读不到，URL 里也不会出现。
 *
 * 服务端只存凭据的 sha256；`pair.list` / `host.hello.auth` **永不回传** token。
 * 静态访问令牌（`CODEM_HOST_TOKEN`）是另一条 break-glass 路径：Bearer，`/events`
 * 额外兼容 `?token=`（EventSource 不能带 header）。
 */
export type PairDevicePlatform = "android" | "ios" | "web" | "desktop" | "unknown";

export interface PairDeviceView {
  /** `dev-<8 hex>`；只用于撤销/显示，不是凭据 */
  id: string;
  /** 配对时自报的名字（清洗后最长 64；空则默认"我的手机"） */
  name: string;
  platform: PairDevicePlatform;
  createdAt: number;
  lastSeenAt: number;
}

export interface PairStartResult {
  /** 6 位数字；**只在生成时出现一次**，后续 `pair.list` 不会再返回它 */
  code: string;
  expiresAt: number;
  ttlMs: number;
}

export interface PairClaimParams {
  /** 6 位数字（允许中间有空格/连字符，Host 归一化后校验） */
  code: string;
  deviceName?: string;
  platform?: PairDevicePlatform;
}

export interface PairClaimResult {
  hostId: string;
  deviceId: string;
  device: PairDeviceView;
}

export interface PairListResult {
  devices: PairDeviceView[];
  /** 非秘密提示（例如凭据文件损坏 ⇒ 设备已清空，需要重新配对） */
  warning?: string;
}

export interface PairRevokeParams {
  deviceId: string;
}

export interface PairRevokeResult {
  /** 未知 id 返回 false（幂等，不泄密） */
  revoked: boolean;
}

// ========== 会话 ==========

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  model?: string | null;
  /** 是否正在跑（Host 内存态；重启后为 false —— 不要用它判断历史） */
  running?: boolean;
}

export interface MessageView {
  /** role=tool 时对应的调用 id（用于把工具行配回工具名） */
  toolCallId?: string | null;
  /** 工具行附带的元数据（如 {toolName}）；存储层原样返回 */
  metadata?: Record<string, unknown> | null;
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  reasoning?: string;
  timestamp: number;
  model?: string | null;
  status?: string;
  /** 压缩/裁剪标记（0 = 可见）。完整历史与模型视图的区别靠它，不靠删行。 */
  hidden?: number;
  trimmed?: number;
  toolCalls?: Array<{ id: string; tool: string; status?: string; args?: unknown; result?: unknown }>;
}

export interface SessionListParams {
  projectId?: string;
  offset?: number;
  limit?: number;
}
export interface SessionCreateParams {
  title?: string;
}
export interface SessionCreateResult {
  session: SessionSummary;
}
export interface SessionListResult {
  items: SessionSummary[];
  hasMore: boolean;
}

export interface SessionGetParams {
  sessionId: string;
  offset?: number;
  limit?: number;
  /** true = 只要可见消息（模型视图）；false/缺省 = 完整时间线 */
  visibleOnly?: boolean;
}
export interface SessionGetResult {
  session: SessionSummary;
  messages: MessageView[];
  hasMore: boolean;
  /** 当前事件水位（客户端把它记为 `sinceSeq` 起点） */
  eventSeq: number;
}

export interface SessionWatchParams {
  sessionId: string;
  /** 只补发大于它的序号；缺省 = 只要直播（不补发） */
  sinceSeq?: number;
}
export interface SessionWatchResult {
  subscriptionId: string;
  /** 实际补发的起点（Host 可能因保留窗口而抬高它 —— 客户端必须如实显示"缺口"） */
  fromSeq: number;
  /** 补发是否被截断（true 时客户端应重新拉 `session.get` 做全量对齐） */
  truncated: boolean;
}

/** 会话事件类型（客户端渲染只依赖这些，不依赖 Host 内部 LoopEvent 名称） */
export type SessionEventType =
  | "run.started"
  | "run.finished"
  | "run.failed"
  | "run.cancelled"
  | "assistant.text"
  | "assistant.reasoning"
  | "tool.start"
  | "tool.end"
  | "tool.error"
  | "usage"
  | "approval.requested"
  | "log";

export interface SessionEvent {
  sessionId: string;
  /** 单调递增；跨重连续用（来源见文件头） */
  seq: number;
  type: SessionEventType;
  runId?: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

// ========== 提示 / 运行 ==========

export interface PromptSendParams {
  /** 发起的客户端标识（有租约时必须与持有者一致；不传表示旧客户端，仅记录警告） */
  clientId?: string;
  sessionId: string;
  /** 幂等键（见文件头第 1 条）。客户端应为每次"用户动作"生成新值，重试复用旧值。 */
  requestId: string;
  text: string;
  attachmentIds?: string[];
}
export interface PromptSendResult {
  accepted: true;
  runId: string;
  /** 受理时的事件水位（客户端可用它校验自己没漏） */
  eventSeq: number;
}

export interface RunGuidanceParams {
  runId: string;
  /** 运行中的纠偏/补充指令；下一轮迭代注入，不另起 run */
  text: string;
}

export interface RunGuidanceResult {
  accepted: true;
}

export interface RunCancelParams {
  runId: string;
  requestId: string;
}
export interface RunCancelResult {
  runId: string;
  cancelled: boolean;
  /** 已经结束的运行返回 false —— 这不是错误（取消是"尽力而为"，不是事务） */
  alreadyFinished?: boolean;
}

export type RunState = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export interface RunStatus {
  runId: string;
  sessionId: string;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  error?: string;
  toolCalls?: number;
}

/**
 * 诊断快照（桌面「诊断」面板与 Spike 共用）。
 *
 * 为什么把它放进协议而不是"本地日志"：远程模式下的故障（手机发不出、工具不执行）
 * 往往**只能从 PC 侧看出来**；没有一个可远程读的诊断面，排查就只能靠远程桌面。
 */
export interface HostDiagnostics {
  hostId: string;
  version: string;
  protocolVersion: number;
  uptimeMs: number;
  dataHome: string;
  workspaceRoot: string;
  /**
   * 本次 Host 的工作区是否就是**桌面当前项目**（Phase 1 C）。
   *
   * 只有桌面 Rust 以显式项目路径拉起 Host 时才为 true（`--workspace-shared`）；
   * Android 本机 Host / 开发机手跑缺省。客户端**不得**用"有 workspaceRoot"推断
   * "与桌面同一份" —— Android 的 /opt/app/web 也是工作区，那样会显示一句假话。
   */
  workspaceSharedWithDesktop?: boolean;
  seq: number;
  runs: RunStatus[];
  /** 最近一次"本该写却没写"的失败（宿主侧持久化通道） */
  persistFailures: Array<{ area: string; message: string; at: number }>;
  /**
   * 指定会话的存储探针（远程排查"消息发出去了但库里没有"时用）。
   *
   * 为什么把它放进协议：这个故障形态在真机上是**静默**的（事件流正常、界面正常），
   * 唯一能区分"没写"和"写了但读不到"的方式就是直接读索引计数与域镜像。
   */
  sessionProbe?: {
    sessionId: string;
    domainRow: string | null;
    messageCount: number;
    /** 模型会看到的消息角色序列（诊断「写了但读不到」的唯一直接读数） */
    visibleRoles?: string[];
  };
}

// ========== 审批 ==========

export interface ApprovalRequestView {
  approvalId: string;
  sessionId: string;
  runId?: string;
  /** 工具名（`write_file` / `bash` …） */
  tool: string;
  /** 给人看的摘要（不含文件正文） */
  summary: string;
  /** 结构化细节（diff 摘要、命令文本等） */
  details?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
}

export interface ApprovalRespondParams {
  approvalId: string;
  requestId: string;
  decision: "allow" | "deny";
  /** 用户补充说明（会回给模型；`deny` 时建议填写） */
  note?: string;
}

// ========== 工作区（只读预览 / diff） ==========

export interface WorkspaceReadParams {
  /** **相对项目根**的路径；绝对路径与 `..` 一律拒绝（安全边界，见 ADR-0003） */
  path: string;
  offset?: number;
  limit?: number;
  /**
   * 上一次 `APPROVAL_REQUIRED` 返回的审批 ID（用户已批准后重试用）。
   *
   * 一次性：Host 消费后立即失效；路径/范围变化必须重新走审批。
   */
  approvalId?: string;
}
export interface WorkspaceEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

export interface WorkspaceListParams {
  /** 相对项目根的目录；省略 = 根 */
  path?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
}

export interface PluginsListResult {
  items: PluginInfo[];
}

export interface WorkspaceListResult {
  path: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceReadResult {
  path: string;
  size: number;
  truncated: boolean;
  text: string;
  encoding: "utf8" | "binary";
}

export interface WorkspaceDiffParams {
  path: string;
  /** git 基线（缺省 HEAD） */
  base?: string;
  /** 同 `WorkspaceReadParams.approvalId`：批准后带同一个 ID 重试（一次性） */
  approvalId?: string;
}
export interface WorkspaceDiffResult {
  path: string;
  diff: string;
  /** false = 当前 Host 不具备 diff 能力（客户端应隐藏入口，而不是显示空 diff） */
  supported: boolean;
  /**
   * 给人看的原因：`supported=false` 时解释为什么（不是 git 仓库 / 未跟踪的二进制
   * 新文件 …），`supported=true` 时说明内容被截断。
   *
   * 缺席 = "没有更具体的原因"，客户端必须使用自己的默认文案，**不要**把
   * `supported=false` 一律解释成"不是 git 仓库"——那是另一种假事实。
   */
  reason?: string;
}

/**
 * `APPROVAL_REQUIRED` 的 `error.data.details`（敏感读取审批）。
 *
 * 客户端用它渲染卡片：**只有路径/规则/原因**，永远没有文件正文。
 * 用户批准后，把 `approvalId` 原样带回同一个 RPC 重试。
 */
export interface SensitiveApprovalRequiredDetails {
  approvalRequired: true;
  approvalId: string;
  tool: "read" | "grep" | "workspace.read" | "workspace.diff";
  /** 一句话摘要（含路径与"批准后发给模型"） */
  summary: string;
  details: {
    /** 工作区相对路径（绝不显示绝对路径） */
    path?: string;
    rule?: string;
    label?: string;
    reason?: string;
    risk?: "low" | "medium" | "high";
    /** grep/diff：命中清单（最多 10 条） */
    files?: string[];
    fileCount?: number;
    /** grep：命中清单被截断（还有更多文件没列出） */
    truncated?: boolean;
    /** diff 的 git 基线 */
    base?: string;
    scope: "shared-desktop-workspace";
    notice: string;
    [key: string]: unknown;
  };
  /** 审批过期时间（毫秒时间戳）；过期后必须重新发起 */
  expiresAt: number;
}

// ========== 文件变更（只读；按"有改动的迭代"一条记录） ==========

/** 一条文件变更记录里的单个文件（`git diff --name-status` 的投影） */
export interface ChangedFileView {
  /** 相对工作区（posix 分隔符） */
  path: string;
  /** `git --name-status` 首字母：M/A/D/R/T…（原样下发，不归一化） */
  status: string;
  /** 缺席 = **不知道**（二进制 / 未跟踪 / 旧记录）—— 客户端必须显示 `—`，不许填 0 */
  additions?: number;
  deletions?: number;
}

/**
 * 一条"有改动的迭代"记录。
 *
 * 记录边界是**迭代**（`AgenticLoop` 每轮 `FileChangeTracker.finalize()` 一次），
 * 不是用户回合。`turnIndex` 每个 prompt 从 1 重开 ⇒ 只能当标签，不能当排序/分组键。
 */
export interface TurnChangesView {
  /** `turn_file_changes.id`（取 diff 的键；也是将来回滚的键） */
  changeId: string;
  /** 助手行 id ⇒ 手机可把卡片挂到对应消息下 */
  messageId: string;
  /** 迭代序号（每个 prompt 从 1 重开；仅标签） */
  turnIndex: number;
  createdAt: number;
  /** 存储里的原始状态：`completed` / `reverted` / `pending_review`（只读展示） */
  status: string;
  brief?: string;
  /** `before_tree`/`after_tree` 都在 ⇒ 才能按文件取 diff（客户端据此隐藏入口） */
  treesAvailable: boolean;
  files: ChangedFileView[];
  /** `changed_files` JSON 损坏（不是"没有改动"） */
  filesParseError?: true;
  /** 只对**有 numstat** 的文件求和；一个都没有则整个字段缺席（显示 `+— −—`） */
  totals?: { additions: number; deletions: number };
}

export interface SessionChangesParams {
  sessionId: string;
  /** 默认 0 */
  offset?: number;
  /** 1..50，默认 20 */
  limit?: number;
}

export interface SessionChangesResult {
  items: TurnChangesView[];
  /** 来自引擎 `has_more`，不是 `items.length === limit` 猜的 */
  hasMore: boolean;
  /** false = 该 Host/工作区不具备记录能力（非 git 仓库 / 没有 git） */
  supported: boolean;
  reason?: string;
}

export interface SessionChangeDiffParams {
  sessionId: string;
  changeId: string;
  /** 必须出现在该记录的 `changed_files` 里（Host 侧校验，不接受任意路径） */
  path: string;
}

export interface SessionChangeDiffResult {
  path: string;
  status: string;
  /** 统一 diff（`git diff <before> <after> -- <path>`）；`supported=false` 时为空串 */
  patch: string;
  /** 超过 200 KB 被截断 */
  truncated: boolean;
  /** false = 记录缺 before/after 快照（老记录/被清理）⇒ 不是"没有改动" */
  supported: boolean;
  reason?: string;
}

// ========== 附件 ==========

export interface AttachmentPutParams {
  name: string;
  mimeType: string;
  /** base64（手机相册/文件选择器给的就是这个形态；不要 multipart，WebView 里更难） */
  base64: string;
}
export interface AttachmentPutResult {
  attachmentId: string;
  bytes: number;
  /** 落在数据根的相对路径（不返回绝对路径：远程客户端不需要知道 PC 的盘符） */
  path: string;
}

// ========== 终端（阶段 5；未实现前必须显式 UNSUPPORTED） ==========

export interface TerminalOpenParams {
  cwd?: string;
  cols?: number;
  rows?: number;
}
export interface TerminalOpenResult {
  terminalId: string;
}
export interface TerminalWriteParams {
  terminalId: string;
  data: string;
}
export interface TerminalCloseParams {
  terminalId: string;
}

// ========== 方法表（编译期把"方法名 → 参数/结果"钉住） ==========

export interface MethodMap {
  [METHODS.hello]: { params: HelloParams; result: HelloResult };
  [METHODS.status]: { params: Record<string, never>; result: RunStatus[] };
  [METHODS.diagnostics]: { params: { sessionId?: string }; result: HostDiagnostics };
  [METHODS.sessionList]: { params: SessionListParams; result: SessionListResult };
  [METHODS.sessionCreate]: { params: SessionCreateParams; result: SessionCreateResult };
  [METHODS.sessionGet]: { params: SessionGetParams; result: SessionGetResult };
  [METHODS.sessionWatch]: { params: SessionWatchParams; result: SessionWatchResult };
  [METHODS.leaseTakeover]: { params: LeaseTakeoverParams; result: LeaseTakeoverResult };
  [METHODS.promptSend]: { params: PromptSendParams; result: PromptSendResult };
  [METHODS.runCancel]: { params: RunCancelParams; result: RunCancelResult };
  [METHODS.runGuidance]: { params: RunGuidanceParams; result: RunGuidanceResult };
  [METHODS.runStatus]: { params: { runId: string }; result: RunStatus };
  [METHODS.approvalList]: { params: { sessionId?: string }; result: { items: ApprovalRequestView[] } };
  [METHODS.approvalRespond]: { params: ApprovalRespondParams; result: { ok: true } };
  [METHODS.workspaceRead]: { params: WorkspaceReadParams; result: WorkspaceReadResult };
  [METHODS.workspaceList]: { params: WorkspaceListParams; result: WorkspaceListResult };
  [METHODS.pluginsList]: { params: Record<string, never>; result: PluginsListResult };
  [METHODS.workspaceDiff]: { params: WorkspaceDiffParams; result: WorkspaceDiffResult };
  [METHODS.sessionChanges]: { params: SessionChangesParams; result: SessionChangesResult };
  [METHODS.sessionChangeDiff]: { params: SessionChangeDiffParams; result: SessionChangeDiffResult };
  [METHODS.attachmentPut]: { params: AttachmentPutParams; result: AttachmentPutResult };
  [METHODS.pairStart]: { params: Record<string, never>; result: PairStartResult };
  [METHODS.pairClaim]: { params: PairClaimParams; result: PairClaimResult };
  [METHODS.pairList]: { params: Record<string, never>; result: PairListResult };
  [METHODS.pairRevoke]: { params: PairRevokeParams; result: PairRevokeResult };
  [METHODS.terminalOpen]: { params: TerminalOpenParams; result: TerminalOpenResult };
  [METHODS.terminalWrite]: { params: TerminalWriteParams; result: { ok: true } };
  [METHODS.terminalResize]: { params: { terminalId: string; cols: number; rows: number }; result: { ok: true } };
  [METHODS.terminalClose]: { params: TerminalCloseParams; result: { ok: true } };
}

export type MethodName = keyof MethodMap;

// ========== 参数取值的运行时校验（零依赖；Host 侧唯一入口） ==========

/**
 * 校验失败必须**明确**（`INVALID_PARAMS` + 哪个字段），不能静默兜底。
 *
 * 这条与 `codem-db` 的参数纪律一致（"类型不对就报错，不做静默强转"）：
 * 远程协议上静默兜底会变成"手机发错了字段，PC 上看起来一切正常但什么都没发生"。
 */
export class ProtocolValidationError extends Error {
  readonly field: string;
  constructor(field: string, why: string) {
    super(`参数 ${field} ${why}`);
    this.name = "ProtocolValidationError";
    this.field = field;
  }
}

export function asObject(value: unknown, field = "params"): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError(field, "必须是对象");
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, field: string, opts: { maxLength?: number } = {}): string {
  if (typeof value !== "string") throw new ProtocolValidationError(field, "必须是字符串");
  const max = opts.maxLength ?? 1024 * 1024;
  if (value.length > max) throw new ProtocolValidationError(field, `超过上限 ${max} 字符`);
  return value;
}

export function asOptionalString(value: unknown, field: string, maxLength?: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field, { maxLength });
}

export function asInt(value: unknown, field: string, opts: { min?: number; max?: number; fallback?: number } = {}): number {
  if (value === undefined || value === null) {
    if (opts.fallback !== undefined) return opts.fallback;
    throw new ProtocolValidationError(field, "必须是整数");
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ProtocolValidationError(field, "必须是整数");
  }
  if (opts.min !== undefined && value < opts.min) throw new ProtocolValidationError(field, `不能小于 ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) throw new ProtocolValidationError(field, `不能大于 ${opts.max}`);
  return value;
}

export function asBoolean(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new ProtocolValidationError(field, "必须是布尔值");
  return value;
}

/** 协议版本协商：唯一判定点（不要在 Host 的每个方法里各判一遍） */
export function checkProtocolVersion(clientVersion: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(clientVersion)) return { ok: false, reason: "protocolVersion 必须是整数" };
  if (clientVersion < MIN_CLIENT_VERSION) {
    return {
      ok: false,
      reason: `客户端协议版本 ${clientVersion} 低于最低支持版本 ${MIN_CLIENT_VERSION}：请升级客户端`,
    };
  }
  if (clientVersion > PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `客户端协议版本 ${clientVersion} 高于 Host 支持的 ${PROTOCOL_VERSION}：请升级桌面端/ Host`,
    };
  }
  return { ok: true };
}

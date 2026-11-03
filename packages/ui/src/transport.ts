/**
 * 共享 UI 的**传输抽象**（阶段 2 的核心）。
 *
 * 目标：同一套组件既能跑在桌面（直连本地 store），也能跑在手机/远程（走 Host 的 JSON-RPC + SSE），
 * 而组件本身**不知道**自己在哪种形态下工作。差异只由**能力位**表达（见 `capabilitiesFor`）。
 *
 * 三条纪律：
 * 1. 传输只暴露"会话/消息/运行"这一层，不泄露 HTTP/SSE 细节；
 * 2. `subscribe` 必须返回取消函数（组件卸载要能断开，否则换会话会泄漏监听）；
 * 3. 能力位是**数据**，不是 `if (isMobile)` —— 否则又会分裂出两套行为。
 */

import type { HostClient, HostEvent } from "./host-client";
import type { ApprovalItem } from "./approval-card";
import type { MessageRow } from "./session-view";
import type {
  SessionChangeDiffResult,
  SessionChangesResult,
} from "../../protocol/src/index";

export interface TransportSessionSummary {
  id: string;
  title: string;
  messageCount?: number;
  lastMessageAt?: number;
}

export interface TransportSession {
  title: string;
  messages: MessageRow[];
  /**
   * 网关/Host 附带的**实时运行态**（可选）。
   *
   * `runId` 只存在于内存里：页面重开/事件流重连后，没有它「停止」按钮就没有目标。
   * 旧 Host 不返回该字段 ⇒ 保持 `undefined`（不是"没有在跑"）。
   */
  run?: { runId?: string; state?: string } | null;
}

const CLIENT_KEY = "codem.clientId";

/** 本装置的稳定标识：租约/多设备区分用；换浏览器/清存储会变（届时重新 hello 即可） */
export function getClientId(): string {
  if (typeof localStorage === "undefined") return "codem-ui";
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = "client-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

const TOKEN_KEY = "codem.hostToken";

/**
 * 读取本地保存的**静态访问令牌**（`CODEM_HOST_TOKEN`）。
 *
 * UI 已经不再提供手填入口（手机只走一次性配对码）；这里保留读取是为了兼容升级前
 * 存过的静态令牌，并让上层在发现它无效时能清掉 localStorage。设备凭据不经过 JS：
 * `pair.claim` 由 Host 以 HttpOnly `Set-Cookie` 下发，同源请求（含 EventSource）自动携带，
 * 页面读不到也不需要读。
 */
export function resolveHostToken(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * 抹掉地址栏里的 `?token=`：**只删，不读，不保存**。
 *
 * 旧链接（以及迁移前存过设备 token 的页面）可能把凭据带进 URL。它留在地址栏就会
 * 进浏览历史 / 分享 / 代理日志；而旧的设备凭据现在也不再被接受，吸收它只会制造
 * "看起来保存了、实际每次 401"的假象。
 */
export function stripLegacyTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.toString());
  } catch {
    /* 地址不可解析 ⇒ 没有可清理的 token */
  }
}

/** 清除本地静态令牌（撤销/401 后回配对门时调用；升级前的旧值也由这里清掉）。 */
export function clearHostToken(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * 本机（`local-auth`）凭据：**只存 sessionStorage，不进 localStorage**。
 *
 * 为什么不是 localStorage：它每次 Host 启动都会变，存久了只会留下一条永远无效的凭据
 * （还会让"重启后到底该用哪份"变得可疑）。sessionStorage 随标签页存活，
 * 刚好覆盖"Activity 重建 / 页面 reload"，进程结束就没了。
 *
 * 值本身只用于两件事：RPC 的 `Authorization: Bearer`，以及换一次 SSE 用的 HttpOnly cookie。
 * 永远不写进 URL、不进日志、不进任何报告。
 */
const LOCAL_AUTH_KEY = "codem.localAuth";

/** fragment 里的参数名：Android 外壳加载 `http://127.0.0.1:<port>/#token=<64hex>` */
const LOCAL_AUTH_FRAGMENT_PARAM = "token";

/** 本机凭据形态（外壳用 SecureRandom 生成 32 字节 → 64 位小写 hex） */
const LOCAL_AUTH_RE = /^[0-9a-f]{64}$/;

function sessionStore(): Storage | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/**
 * 从地址栏 fragment 读本机凭据，并**立刻抹掉它**（同步，在 React 挂载之前调用）。
 *
 * 三个明确的行为：
 * 1. 只认 `#token=<64hex>`；无效值不返回，但**照样抹掉**（留着也没有意义，还会残留在地址栏）；
 * 2. 不碰其它 hash（例如 `#section`）：只在这个 fragment 真的带了 `token` 参数时才清理；
 * 3. 保留 `pathname + search`：Android 深链上的 `?open=` / `?selftest=1` 不能被吞掉。
 *
 * 不打印、不上报：调用方拿到的值只许进 sessionStorage / Authorization 头。
 */
export function takeLocalAuthFromFragment(): string {
  if (typeof window === "undefined") return "";
  let token = "";
  try {
    const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    if (!raw) return "";
    const params = new URLSearchParams(raw);
    if (!params.has(LOCAL_AUTH_FRAGMENT_PARAM)) return "";
    token = params.get(LOCAL_AUTH_FRAGMENT_PARAM) ?? "";
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  } catch {
    return "";
  }
  return LOCAL_AUTH_RE.test(token) ? token : "";
}

/** 读取本会话保存的本机凭据；没有/畸形返回空串。 */
export function readStoredLocalAuth(): string {
  const store = sessionStore();
  if (!store) return "";
  try {
    const value = store.getItem(LOCAL_AUTH_KEY) ?? "";
    return LOCAL_AUTH_RE.test(value) ? value : "";
  } catch {
    return "";
  }
}

/** 保存本机凭据（**不写 localStorage**、不写日志）。 */
export function saveLocalAuth(token: string): void {
  const store = sessionStore();
  if (!store || !LOCAL_AUTH_RE.test(token)) return;
  try {
    store.setItem(LOCAL_AUTH_KEY, token);
  } catch {
    /* 隐私模式/配额：拿不到存储就退化为"只在本次页面生命周期里用" */
  }
}

/** 清除本机凭据（引导被拒或 Host 重启后旧值已失效时调用）。 */
export function clearLocalAuth(): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.removeItem(LOCAL_AUTH_KEY);
  } catch {
    /* 同上 */
  }
}

/** 本机引导的结果：`unsupported` 是"旧 Host 没有这个端点"，不是错误。 */
export type LocalAuthBootstrap = "ok" | "unsupported" | "rejected" | "unreachable";

/**
 * 用本机凭据换一个 HttpOnly cookie（**只为 SSE**）。
 *
 * 为什么需要这一步：`EventSource` 不能带 header，若把凭据拼进 `?token=` 就回到
 * "长期凭据进 URL"的老问题（WebView 历史 / 代理日志 / 诊断快照）。
 * 换来的 cookie 是同源自动携带的，`/events` 因此不需要任何 URL 凭据。
 *
 * RPC 仍然走 Bearer：cookie 只是 SSE 的通道，不是唯一凭据。
 */
export async function bootstrapLocalAuth(
  token: string,
  fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args),
): Promise<LocalAuthBootstrap> {
  if (!LOCAL_AUTH_RE.test(token)) return "rejected";
  try {
    const res = await fetchImpl("/local-auth", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 204) return "ok";
    if (res.status === 401 || res.status === 403) return "rejected";
    // 404/405：旧 Host 或非 local-auth 形态（页面照常渲染，RPC 用 Bearer 即可）
    return "unsupported";
  } catch {
    return "unreachable";
  }
}

/** 判断这台 Host 是否处于 `local-auth` 模式（用于"没有凭据"时给出正确提示）。 */
export type LocalAuthProbe = "local-auth" | "other" | "unknown";

/**
 * 探测 Host 是否要求本机凭据（**不带任何凭据**）。
 *
 * `local-auth` 模式下 `/local-auth` 是已知端点、缺凭据必回 401；
 * 其它模式回 404/405（旧 Host 也一样）。这样"页面没有 fragment、也没有 sessionStorage"
 * 时能区分"该显示本机凭据缺失"还是"该走配对门"，而不用新增协议方法。
 */
export async function probeLocalAuthMode(
  fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args),
): Promise<LocalAuthProbe> {
  try {
    const res = await fetchImpl("/local-auth", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) return "local-auth";
    return "other";
  } catch {
    return "unknown";
  }
}

export interface TransportAuthInfo {
  kind: "local" | "static" | "device";
  deviceId?: string;
  deviceName?: string;
}

export interface TransportCapabilities {
  supported: string[];
  unsupported: string[];
}

export interface SessionTransport {
  /** 握手（远程会校验协议版本与 token；本地直接返回） */
  hello(): Promise<{ hostId: string; auth?: TransportAuthInfo; capabilities?: TransportCapabilities }>;
  listSessions(): Promise<TransportSessionSummary[]>;
  getSession(sessionId: string): Promise<TransportSession>;
  send(sessionId: string, text: string, requestId: string, attachmentIds?: string[]): Promise<{ runId: string }>;
  cancel(runId: string, requestId: string): Promise<void>;
  /** 只读连接/能力信息（Host 提供；只读/本地实现可省略） */
  hostInfo?(): Promise<{
    hostId: string;
    supported: string[];
    unsupported: string[];
    seq?: number;
    runs?: number;
    workspaceRoot?: string;
    /** Host 的工作区是否就是桌面当前项目（只有桌面 Host 会报 true） */
    workspaceSharedWithDesktop?: boolean;
    /** 本次连接的认证身份（只用于显示；不含 token/hash） */
    auth?: TransportAuthInfo;
  }>;
  /** 运行中引导（steer）：远程由 Host 提供；只读/本地实现可省略 */
  guidance?(runId: string, text: string): Promise<void>;
  /** 答复审批（远程由 Host 提供；只读/本地未接线的实现可以省略） */
  respondApproval?(approvalId: string, decision: "allow" | "deny", requestId: string, note?: string): Promise<void>;
  /**
   * 读当前待批项（网关/Host 都从**桌面同一张表**读）。
   *
   * 为什么单独要有它：事件流只推送"变化"，页面打开时已经挂着的审批不会再有
   * `approval.requested`。没有这一次读取，手机上就永远看不到"正在等你批准"。
   */
  listApprovals?(): Promise<ApprovalItem[]>;
  /** 新建会话（远程由 Host 提供；只读/本地未接线的实现可以省略） */
  createSession?(title?: string): Promise<TransportSessionSummary>;
  /** 列工作区目录（远程由 Host 提供；只读/本地实现可省略） */
  listWorkspace?(path?: string): Promise<{ path: string; entries: Array<{ name: string; type: "file" | "dir"; size?: number }> }>;
  /**
   * 读工作区文件（只读预览；远程由 Host 提供）。
   *
   * `approvalId`：共享桌面工作区里读敏感文件时，Host 首次返回 `APPROVAL_REQUIRED`，
   * 客户端让用户确认后带同一个 id 重试（一次性）。普通文件不需要。
   */
  readWorkspace?(path: string, offset?: number, limit?: number, approvalId?: string): Promise<{ path: string; size: number; truncated: boolean; text: string; encoding?: "utf8" | "binary" }>;
  /** 只读插件列表（远程由 Host 提供） */
  listPlugins?(): Promise<{ items: Array<{ id: string; name: string; version: string }> }>;
  /** 上传附件（远程由 Host 提供） */
  putAttachment?(name: string, mimeType: string, base64: string): Promise<{ attachmentId: string; bytes: number; path: string }>;
  /** 只读 diff（工作区不是 git 仓库时 supported=false）；`approvalId` 语义同 `readWorkspace` */
  diffWorkspace?(path: string, base?: string, approvalId?: string): Promise<{ path: string; diff: string; supported: boolean; reason?: string }>;
  /**
   * 只读文件变更列表（按"有改动的迭代"一条记录；`created_at DESC` 分页）。
   *
   * Host 首版只提供 `session.changes` / `session.change.diff` 两个只读方法；
   * 没有回滚、没有 checks、没有实时事件 —— 客户端据此隐藏入口，而不是画一个
   * 点了没反应的按钮。
   */
  sessionChanges?(sessionId: string, offset?: number, limit?: number): Promise<SessionChangesResult>;
  /** 单文件 diff（统一 patch，200KB 封顶；记录缺 tree 时 supported=false） */
  sessionChangeDiff?(sessionId: string, changeId: string, path: string): Promise<SessionChangeDiffResult>;
  /** 订阅会话事件；返回取消函数 */
  subscribe(sessionId: string, listener: (event: HostEvent) => void): () => void;
}

/** 远程传输：把 `HostClient` 翻译成 `SessionTransport` */
export function remoteTransport(client: HostClient): SessionTransport {
  return {
    async hello() {
      const clientId = getClientId();
      const result = await client.rpc<{
        hostId: string;
        auth?: TransportAuthInfo;
        capabilities?: TransportCapabilities;
      }>("host.hello", {
        protocolVersion: 1,
        client: { name: "codem-ui", version: "0.0.0", platform: "web" },
        deviceName: clientId,
        claim: true,
      });
      // 把服务器认定的身份与能力带回去：上层据此决定写入口（不是靠宿主注入标记）
      return {
        hostId: result.hostId,
        ...(result.auth ? { auth: result.auth } : {}),
        ...(result.capabilities
          ? {
              capabilities: {
                supported: Array.isArray(result.capabilities.supported)
                  ? result.capabilities.supported.filter((m): m is string => typeof m === "string")
                  : [],
                unsupported: Array.isArray(result.capabilities.unsupported)
                  ? result.capabilities.unsupported.filter((m): m is string => typeof m === "string")
                  : [],
              },
            }
          : {}),
      };
    },
    async listSessions() {
      const page = await client.rpc<{ items: TransportSessionSummary[] }>("session.list", { limit: 50 });
      return page.items ?? [];
    },
    async createSession(title) {
      const got = await client.rpc<{ session: { id: string; title: string; lastMessageAt?: number } }>("session.create", { title });
      return { id: got.session.id, title: got.session.title, messageCount: 0, lastMessageAt: got.session.lastMessageAt ?? Date.now() };
    },
    async getSession(sessionId) {
      const got = await client.rpc<{
        session: { title?: string };
        messages: Array<MessageRow & { toolCallId?: string | null }>;
        run?: { runId?: string; state?: string } | null;
      }>("session.get", { sessionId });
      return {
        title: got.session?.title ?? "",
        messages: got.messages ?? [],
        // 运行态原样透传（旧 Host 没有这个字段时保持 undefined）
        ...(got.run !== undefined ? { run: got.run } : {}),
      };
    },
    async send(sessionId, text, requestId, attachmentIds = []) {
      return client.rpc<{ runId: string }>("prompt.send", { sessionId, text, requestId, clientId: getClientId(), attachmentIds });
    },
    async listPlugins() {
      return client.rpc("plugins.list", {});
    },
    async putAttachment(name, mimeType, base64) {
      return client.rpc("attachment.put", { name, mimeType, base64 });
    },
    async listWorkspace(path = ".") {
      return client.rpc("workspace.list", { path });
    },
    async readWorkspace(path, offset = 0, limit = 200_000, approvalId) {
      return client.rpc("workspace.read", { path, offset, limit, ...(approvalId ? { approvalId } : {}) });
    },
    async hostInfo() {
      const hello = await client.rpc<{
        hostId: string;
        capabilities?: { supported?: string[]; unsupported?: string[] };
        auth?: TransportAuthInfo;
      }>("host.hello", {
        protocolVersion: 1,
        client: { name: "codem-ui", version: "0.0.0", platform: "web" },
        deviceName: getClientId(),
        // 只读观察者**不认领租约**（协议约定）：信息面板打开一次就抢走手机/桌面的写权限，
        // 症状是"看一眼连接信息，发消息就提示被其它设备占用"。
        claim: false,
      });
      const diag = await client
        .rpc<{ seq?: number; runs?: unknown[]; workspaceRoot?: string; workspaceSharedWithDesktop?: boolean }>("host.diagnostics", {})
        .catch(() => ({}) as { seq?: number; runs?: unknown[]; workspaceRoot?: string; workspaceSharedWithDesktop?: boolean });
      return {
        hostId: hello.hostId,
        supported: hello.capabilities?.supported ?? [],
        unsupported: hello.capabilities?.unsupported ?? [],
        seq: diag.seq,
        runs: Array.isArray(diag.runs) ? diag.runs.length : undefined,
        workspaceRoot: diag.workspaceRoot,
        ...(diag.workspaceSharedWithDesktop === true ? { workspaceSharedWithDesktop: true } : {}),
        ...(hello.auth ? { auth: hello.auth } : {}),
      };
    },
    async diffWorkspace(path, base = "HEAD", approvalId) {
      return client.rpc("workspace.diff", { path, base, ...(approvalId ? { approvalId } : {}) });
    },
    async sessionChanges(sessionId, offset = 0, limit = 20) {
      return client.rpc<SessionChangesResult>("session.changes", { sessionId, offset, limit });
    },
    async sessionChangeDiff(sessionId, changeId, path) {
      return client.rpc<SessionChangeDiffResult>("session.change.diff", { sessionId, changeId, path });
    },
    async guidance(runId, text) {
      await client.rpc("run.guidance", { runId, text });
    },
    async respondApproval(approvalId, decision, requestId, note) {
      await client.rpc("approval.respond", { approvalId, decision, requestId, ...(note ? { note } : {}) });
    },
    async listApprovals() {
      const got = await client.rpc<{ approvals?: unknown }>("approval.list", {});
      return Array.isArray(got.approvals) ? (got.approvals as ApprovalItem[]) : [];
    },
    async cancel(runId, requestId) {
      /**
       * `clientId` 与 `prompt.send` 对称：网关的 run 归属只允许**发起者**取消自己那次运行。
       * 不传的话网关只能看到空串 ⇒ 每台设备的「停止」都会得到 `RUN_OWNED`，
       * 而那正是"按钮点了必失败"的形状。它只是归属/文案用的自述标识，**不是鉴权**
       * （边界仍然是配对的 HttpOnly cookie）。
       */
      await client.rpc("run.cancel", { runId, requestId, clientId: getClientId() });
    },
    subscribe(sessionId, listener) {
      const off = client.onEvent((event) => {
        if (event.sessionId === sessionId) listener(event);
      });
      client.connect(sessionId);
      return () => {
        off();
        client.close();
      };
    },
  };
}

/**
 * 本地传输：桌面把已有的 store/执行器包进来即可（**不 import 渲染侧代码**，
 * 所以这里能在 Node 测试里构造，也不会让 packages/ui 依赖整个 App）。
 */
export interface LocalTransportDeps {
  hostId: string;
  listSessions: () => Promise<TransportSessionSummary[]>;
  getSession: (sessionId: string) => Promise<TransportSession>;
  send: (sessionId: string, text: string, requestId: string) => Promise<{ runId: string }>;
  cancel: (runId: string, requestId: string) => Promise<void>;
  /** 本地事件源：桌面用 store 的订阅，逐条送给 UI */
  subscribe: (sessionId: string, listener: (event: HostEvent) => void) => () => void;
}

export function localTransport(deps: LocalTransportDeps): SessionTransport {
  return {
    hello: async () => ({ hostId: deps.hostId }),
    listSessions: () => deps.listSessions(),
    getSession: (id) => deps.getSession(id),
    send: (id, text, requestId) => deps.send(id, text, requestId),
    cancel: (runId, requestId) => deps.cancel(runId, requestId),
    subscribe: (id, listener) => deps.subscribe(id, listener),
  };
}

/** 能力位（数据，不是平台判断） */
export interface Capabilities {
  /** 能否开终端（远程第一版没有 PTY；本地有） */
  terminal: boolean;
  /** 能否审批（远程有 broker；本地也走同一套） */
  approvals: boolean;
  /** 能否改工作区（远程受项目根限制） */
  workspaceWrite: boolean;
  /**
   * 能否列"文件变更记录"（`session.changes` + `session.change.diff`）。
   *
   * 单独一位而不是从 `workspaceWrite` 推导：网关 M3 只开了只读文件面，
   * 变更记录还没开；若让第三列按"transport 有没有这个方法"猜，手机上会出现
   * 一个点开必报 UNSUPPORTED 的页签（半套 UI）。
   */
  changes: boolean;
  /** 能否附加文件 */
  attachments: boolean;
  /** 能否取消运行 */
  cancelRun: boolean;
  /** 能否新建会话 */
  createSession: boolean;
  /** 是否多设备（远程 true：需要租约提示） */
  multiDevice: boolean;
}

const ALL: Capabilities = {
  terminal: true,
  approvals: true,
  workspaceWrite: true,
  changes: true,
  attachments: true,
  cancelRun: true,
  createSession: true,
  multiDevice: false,
};

/**
 * 按传输形态给能力位。
 *
 * - `local`：桌面全功能；
 * - `remote`：远程第一版（终端/附件未实现，其余可用）；
 * - `remoteFull`：远程全部能力（阶段 5 终端落地后使用）。
 *
 * ⚠️ 真实能力请用 `capabilitiesFromMethods(host.hello.capabilities.supported)`：
 * 本函数只服务"还没有能力表"的旧 Host / 本地构造（向后兼容）。
 */
export function capabilitiesFor(kind: "local" | "remote" | "remoteFull"): Capabilities {
  if (kind === "local") return { ...ALL };
  if (kind === "remote") {
    return { ...ALL, terminal: false, attachments: false, multiDevice: true };
  }
  return { ...ALL, multiDevice: true };
}

/**
 * 服务器能力表 → 界面能力位（**唯一**判据）。
 *
 * 这是 M2 的关键一步：不再由"页面是谁发的"（Host / 网关 / 注入标记）决定写入口，
 * 而由服务器**实际开放的方法**决定。`supported` 里没有 `prompt.send` 就是只读；
 * 没有 `attachment.put` 就没有附件按钮 —— 界面与网关白名单不会各说一套。
 *
 * @param supported `host.hello.capabilities.supported`；`null` = 旧 Host 不报能力表
 *   （按远程第一版处理，保持升级兼容）。
 */
export function capabilitiesFromMethods(supported: readonly string[] | null): Capabilities {
  if (supported === null) return capabilitiesFor("remote");
  const has = (method: string): boolean => supported.includes(method);
  return {
    terminal: supported.some((method) => method.startsWith("terminal.")),
    approvals: has("approval.list") && has("approval.respond"),
    // "能不能看/改工作区"在协议里是多条方法；任何一条可用就显示文件入口，
    // 具体动作还会被各自的方法/后端拒绝（这里是入口位，不是权限位）。
    workspaceWrite: has("workspace.read") || has("workspace.list") || has("workspace.diff"),
    // 两条都开才画「变更」页签：只有列表没有单文件 diff 会是一个点不开的列表。
    changes: has("session.changes") && has("session.change.diff"),
    attachments: has("attachment.put"),
    cancelRun: has("run.cancel"),
    createSession: has("session.create"),
    multiDevice: true,
  };
}

/**
 * 写模式判据（发送框/停止/审批/事件是否可用）。
 *
 * 四个方法缺一不可：只有 `prompt.send` 而没有事件/审批时，发送框就是半套 UI
 * （发了看不到流式结果、遇到审批没人能答）。M2 的网关与 Host 都满足这四条；
 * 早期网关（只有 6 个方法）会如实退回只读。
 */
export function canWriteSessions(supported: readonly string[] | null): boolean {
  if (supported === null) return true;
  return ["prompt.send", "run.cancel", "approval.list", "approval.respond"].every((method) =>
    supported.includes(method),
  );
}

/** 组件里的统一判据（避免各处写 `caps.x === true`） */
export function can(caps: Capabilities, feature: keyof Capabilities): boolean {
  return caps[feature] === true;
}

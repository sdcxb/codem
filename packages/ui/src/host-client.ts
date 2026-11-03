/**
 * 共享 UI 的**传输客户端**（阶段 2 的第一块）。
 *
 * 目标：手机壳、未来的 `packages/ui` React 组件、桌面 2.0 的远程面板都通过**同一个**客户端
 * 说话，而不是各自写一份 `fetch` + `EventSource`。
 *
 * 契约（与 `@codem/protocol` 对齐）：
 * - 请求：`POST /rpc`，JSON-RPC 2.0；
 * - 事件：`GET /events`，SSE；`id: <seq>`、`data: {seq,sessionId,type,payload,runId,method}`；
 * - 续传：浏览器 `EventSource` 自带 `Last-Event-ID`（本客户端只记录，便于诊断）。
 *
 * 设计取舍：
 * - **不依赖 React/DOM**（可在 Node 测试里跑）——`EventSource` 由调用方注入；
 * - 错误统一成 `HostRpcError`（带 `kind`/`code`/`retryable`），UI 只需要判断 `retryable`；
 * - 断线不抛给调用方：SSE 自动重连，状态通过 `onStatus` 通知（壳据此显示"已连接/重连中"）。
 */

export interface HostEvent {
  seq: number;
  sessionId: string;
  type: string;
  payload: unknown;
  runId?: string;
  method?: string;
}

export interface EventSourceLike {
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface HostClientOptions {
  /**
   * **必须为空或与页面同源**（手机壳/远程面板都是 `""`）。
   *
   * 设备凭据是 HttpOnly cookie，只有同源请求才会自动携带；一旦跨源，
   * fetch 要 `credentials:"include"`、EventSource 要 `withCredentials:true`，
   * 服务端还要 CORS + `Access-Control-Allow-Credentials` —— 那是另一个决策。
   * 改这里之前先看 `packages/ui/src/mobile-app.tsx` 的同源不变量。
   */
  baseUrl: string;
  /**
   * **静态**访问令牌（`CODEM_HOST_TOKEN`；桌面/CLI 的 break-glass 凭据）。
   *
   * 手机 UI 已经不再提供手填入口；这里保留选项是为了兼容升级前存过的旧值
   * （以及非手机的调试/测试入口）。设备凭据**不允许**从这里进来：
   * 它只存在于 HttpOnly cookie 里，页面 JS 拿不到。
   * 静态令牌是唯一还会进 URL 的凭据（EventSource 不能带 header），
   * 这是既有的残余风险，不因 cookie 迁移而扩大。
   */
  staticToken?: string;
  /**
   * **本机**凭据（Android 外壳每次启动生成，经 URL fragment 交给页面）。
   *
   * 与 `staticToken` 的区别是**它绝不进 URL**：RPC 带 `Authorization: Bearer`，
   * 事件流靠 `/local-auth` 换来的 HttpOnly cookie（同源自动携带）。
   * 所以这里不会给 `/events` 追加 `?token=` —— 那是 `staticToken` 的历史残余面。
   */
  localAuthToken?: string;
  fetchImpl?: typeof fetch;
  /** 注入 SSE 实现（浏览器传 `(url) => new EventSource(url)`；测试传假实现） */
  eventSourceFactory?: (url: string) => EventSourceLike;
  onStatus?: (status: "connected" | "disconnected") => void;
  /**
   * 认证失效回调：`unauthorized` = 请求/连接被 401 拒绝；`revoked` = 桌面撤销了这台设备。
   *
   * 为什么不让调用方自己判断：401 既可能来自 `hello`、也可能来自任意一次 RPC 或
   * SSE 重连；把这些分支散在各个调用点，必然漏掉一种（症状是手机白屏/无限重连）。
   */
  onUnauthorized?: (reason: "unauthorized" | "revoked") => void;
}

export class HostRpcError extends Error {
  readonly kind: string;
  readonly code: number;
  readonly retryable: boolean;
  /** `error.data.details`（配对失败时是 `{ reason, retryAfterMs? }`）；可能不存在 */
  readonly details: unknown;
  /** `error.data.hint`（给人看的下一步建议） */
  readonly hint: string | undefined;
  constructor(
    message: string,
    kind: string,
    code: number,
    retryable: boolean,
    extra: { details?: unknown; hint?: string } = {},
  ) {
    super(message);
    this.name = "HostRpcError";
    this.kind = kind;
    this.code = code;
    this.retryable = retryable;
    this.details = extra.details;
    this.hint = extra.hint;
  }
}

export interface HostClient {
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** 订阅所有会话事件；返回取消函数 */
  onEvent(listener: (event: HostEvent) => void): () => void;
  /** 最近一次收到的事件序号（诊断/续传读数） */
  lastEventId(): number;
  /** 事件流连接状态 */
  status(): "connected" | "disconnected";
  /** 连接某个会话的事件流（服务端强制要求 sessionId；换会话要重新 connect） */
  connect(sessionId: string, opts?: { sinceSeq?: number }): void;
  close(): void;
}

export function createHostClient(opts: HostClientOptions): HostClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const listeners = new Set<(event: HostEvent) => void>();
  let source: EventSourceLike | null = null;
  let last = 0;
  let state: "connected" | "disconnected" = "disconnected";
  /**
   * 事件流的查询参数：**只**为静态访问令牌服务。
   *
   * 设备凭据走 HttpOnly cookie，同源 EventSource 会自动携带，永远不进 URL
   * （这正是本次迁移要消掉的那条泄露面）。本机凭据同理：它换来的 cookie 已经在
   * 浏览器里，事件流 URL 里一个字符都不该出现。
   */
  const query = opts.staticToken && !opts.localAuthToken ? `?token=${encodeURIComponent(opts.staticToken)}` : "";
  /** RPC 的 Bearer：本机凭据优先（两者不会同时出现，但优先级写清楚更可读） */
  const bearer = opts.localAuthToken?.trim() || opts.staticToken?.trim() || "";
  /** connect() 的参数也叫 opts，先把回调取出来，避免被遮蔽 */
  const onUnauthorized = opts.onUnauthorized;

  const factory =
    opts.eventSourceFactory ??
    ((url: string) => {
      const Ctor = (globalThis as { EventSource?: new (u: string) => EventSourceLike }).EventSource;
      if (!Ctor) throw new Error("当前宿主没有 EventSource：请注入 eventSourceFactory");
      return new Ctor(url);
    });

  function setStatus(next: "connected" | "disconnected"): void {
    if (state === next) return;
    state = next;
    opts.onStatus?.(next);
  }

  return {
    async rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      const res = await fetchImpl(`${base}/rpc`, {
        method: "POST",
        // 同源设备凭据是 HttpOnly cookie：显式写出来是契约，不是默认值的复述。
        // 未来若把 baseUrl 改成跨源，这一行会立刻暴露"cookie 不会跟着走"。
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            result?: T;
            error?: {
              code?: number;
              message?: string;
              data?: { kind?: string; retryable?: boolean; hint?: string; details?: unknown };
            };
          }
        | null;
      if (!body) {
        // 非 JSON 的 401/403（旧 Host、代理、或 SPA 兜底页）也必须归成"未授权"，
        // 否则 UI 会把"请配对"显示成"Host 返回了非 JSON 响应"并一直重试。
        if (res.status === 401 || res.status === 403) {
          opts.onUnauthorized?.("unauthorized");
          throw new HostRpcError("缺少或错误的凭据", "UNAUTHORIZED", res.status, false);
        }
        throw new HostRpcError("Host 返回了非 JSON 响应", "INTERNAL", res.status, true);
      }
      if (body.error) {
        const kind = body.error.data?.kind ?? (res.status === 401 ? "UNAUTHORIZED" : "INTERNAL");
        const error = new HostRpcError(
          body.error.message ?? "Host 请求失败",
          kind,
          body.error.code ?? res.status,
          body.error.data?.retryable === true,
          { details: body.error.data?.details, hint: body.error.data?.hint },
        );
        if (kind === "UNAUTHORIZED") opts.onUnauthorized?.("unauthorized");
        throw error;
      }
      return body.result as T;
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    lastEventId: () => last,
    status: () => state,

    connect(sessionId: string, opts?: { sinceSeq?: number }) {
      // 换会话 = 换事件流（服务端按 sessionId 过滤，不给就 400）
      if (source) {
        source.close();
        source = null;
      }
      const since = typeof opts?.sinceSeq === "number" && opts.sinceSeq > 0 ? `&sinceSeq=${opts.sinceSeq}` : "";
      const sep = query ? "&" : "?";
      source = factory(`${base}/events${query}${sep}sessionId=${encodeURIComponent(sessionId)}${since}`);
      source.onmessage = (msg) => {
        setStatus("connected");
        let event: HostEvent;
        try {
          event = JSON.parse(msg.data) as HostEvent;
        } catch {
          return; // 半行/心跳：忽略（不许把解析失败当成事件）
        }
        // 撤销通知没有 seq，也不能广播给会话订阅者：它只改变"这台设备还能不能连"
        if (event.type === "auth.revoked") {
          source?.close();
          source = null;
          setStatus("disconnected");
          onUnauthorized?.("revoked");
          return;
        }
        if (typeof event.seq === "number" && event.seq > last) last = event.seq;
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {
            /* 单个订阅者崩溃不许影响其它订阅者 */
          }
        }
      };
      source.onerror = () => setStatus("disconnected");
    },

    close() {
      source?.close();
      source = null;
      setStatus("disconnected");
    },
  };
}

/**
 * Host 的 HTTP 面 —— **只绑 loopback**，两件事：JSON-RPC 与事件流（SSE）。
 *
 * ## 为什么事件流用 SSE 而不是裸 WebSocket
 *
 * 1. **续传是协议要的，而 SSE 原生就有**：每条事件带 `id: <seq>`，浏览器断线重连时自动
 *    带 `Last-Event-ID`，服务端据此补发缺口 —— 正好是 `session.watch` 的 `sinceSeq` 语义。
 *    自己写 WS 就要自己实现"重连 + 缺口补齐"，而这块最容易在手机切后台时出错。
 * 2. **零依赖、零自研帧**：Node 内置 `http` 即可；WS 需要 `ws` 包或自己实现 RFC6455
 *    （掩码/分片/ping-pong/close），对要打进 APK 的运行时来说是不必要的体积与出错面。
 * 3. **穿透更稳**：Tailscale 与 Cloudflare 对 `text/event-stream` 的支持是默认的；
 *    WS 在部分代理下会被断（尤其 Cloudflare 免费层的连接上限/超时）。
 *
 * 代价：**单向**。所以请求-响应仍走 `POST /rpc`（审批、取消都是普通请求）。
 * 阶段 5 的终端需要双向字节流时，会在同一个 `Transport` 抽象下加一条 WS 通道，
 * 信封与事件模型不变（见 ADR-0003）。
 *
 * ## 安全默认（每一条都对应一种真实攻击面）
 *
 * - **只监听 127.0.0.1**：远程可达性交给 Tailscale/Cloudflare，不靠我们开 0.0.0.0；
 * - **`Origin` 校验**：本机 HTTP 服务对任何网页都可达（CSRF），所以带 `Origin` 且与
 *   请求 Host 不一致的**写请求**一律 403；
 * - **鉴权是模式化的**（D-7）：`local` 模式才允许 loopback 免鉴权；`paired` 模式
 *   （桌面 Host）**所有人**都要带设备令牌 / 静态令牌 —— 隧道客户端就在本机，
 *   `remoteAddress=127.0.0.1` 不能作为信任依据；
 * - **唯一的匿名入口是 `pair.claim`**（必须带正确的一次性码，有限速/失败计数）；
 * - **不做 CORS**：浏览器跨源读响应会被挡（我们要的就是"只有本页面能用"）。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

import type { JsonRpcId, RpcFailure } from "../../protocol/src/index";
import { METHODS, NOTIFICATIONS, RpcRequest, asInt, asObject, asString, checkProtocolVersion } from "../../protocol/src/index";

import type { HostConfig } from "./config";
import {
  clearDeviceCookie,
  clearLocalAuthCookie,
  deviceCookieName,
  isHttpsRequest,
  localAuthCookieName,
  requestCookie,
  serializeDeviceCookie,
  serializeLocalAuthCookie,
} from "./cookie";
import { HostError, toRpcFailure } from "./errors";
import { PairingError, type PairingService } from "./pairing";
import type { HostRuntime } from "./runtime";

export interface HostServerOptions {
  config: HostConfig;
  runtime: HostRuntime;
  /** 静态资源根（移动端壳页面） */
  webDir: string;
  /** 设备凭据（D-7）；由 cli 打开并负责关闭 */
  pairing: PairingService;
}

export interface RunningServer {
  /** 实际监听端口（`port: 0` 时由内核分配） */
  port: number;
  url: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * 一次请求的认证身份（**不是**凭据；可以安全地回给客户端做显示）。
 *
 * - `local`：loopback 且 Host 处于 local 模式、没有静态 token；
 * - `static`：`CODEM_HOST_TOKEN`（break-glass / CLI）；
 * - `device`：`pair.claim` 下发、由浏览器随同源请求自动携带的 HttpOnly cookie
 *   （`deviceId` 只用于撤销/显示）；
 * - `control`：桌面 Rust 注入的本机控制令牌，**只能**用于 `pair.start/list/revoke`。
 */
export type AuthContext =
  | { kind: "local" }
  | { kind: "static" }
  | { kind: "device"; deviceId: string; deviceName: string }
  | { kind: "control" };

/** `/local-auth` 的失败限速（每个 remoteAddress 每分钟最多这么多次；只计失败） */
const LOCAL_AUTH_WINDOW_MS = 60_000;
const LOCAL_AUTH_MAX_FAILURES = 20;

/** 一次 `/rpc` 的响应上下文：`pair.claim` 把 Set-Cookie 写进 `cookies`，处理完再统一写头。 */
interface RpcResponseContext {
  cookies: string[];
  /** 本次请求是否 HTTPS（决定设备 cookie 要不要加 `Secure`） */
  secure: boolean;
}

export async function startHostServer(opts: HostServerOptions): Promise<RunningServer> {
  const { config, runtime, webDir, pairing } = opts;
  /** 事件流连接 → 它的认证身份（撤销时按设备断开；关闭时统一收尾） */
  const clients = new Map<ServerResponse, AuthContext>();
  /**
   * 设备 cookie 的**完整名字**（数据根哈希；见 cookie.ts）。
   * 名字在进程内只算一次：它同时用于下发、鉴权与失效清理，三处必须完全一致。
   */
  const deviceCookie = deviceCookieName(config.dataHome);
  /** 本机（local-auth）cookie 名；同样只算一次，三种用途必须一致 */
  const localCookie = localAuthCookieName(config.dataHome);
  /** `/local-auth` 失败计数（remoteAddress → 窗口内失败次数）；只在内存里，重启即清 */
  const localAuthFailures = new Map<string, { count: number; resetAt: number }>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, hostId: runtime.hostId, pid: process.pid }));
      return;
    }

    if (url.pathname === "/local-auth") {
      handleLocalAuth(req, res);
      return;
    }

    if (url.pathname === "/events" && req.method === "GET") {
      const auth = authenticate(req, url, { allowQueryToken: true, allowControl: false });
      if (!auth) {
        unauthorized(res, staleAuthCookies(req));
        return;
      }
      streamEvents(req, res, url, auth);
      return;
    }

    if (url.pathname === "/rpc" && req.method === "POST") {
      if (!sameOrigin(req)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "跨源请求被拒绝（Host 只服务自己的页面）" }));
        return;
      }
      const auth = authenticate(req, url, { allowQueryToken: false, allowControl: true });
      if (!auth) {
        /*
         * `local-auth` 没有"匿名自举"入口：本机页面在加载前就用 fragment 里的凭据
         * 换好了 cookie/Bearer。这里直接 401，**不**放行 `pair.claim`
         * —— 该模式根本不用配对码，放行只会多一个匿名攻击面。
         */
        if (config.authMode === "local-auth") {
          unauthorized(res, staleAuthCookies(req));
          return;
        }
        /**
         * 未鉴权的 `/rpc` **只**允许 `pair.claim`（配对是唯一的自举入口）。
         *
         * 先读一个很小的 body 再判断，而不是直接 401：客户端没法在 401 响应里
         * 拿到"请先配对"之外的任何东西，而配对门必须能匿名调用 claim。
         * 批量请求里只要混入任何非 claim 方法就整体 401（不允许借批量绕过）。
         */
        const body = await readBody(req, 4 * 1024);
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          unauthorized(res, staleAuthCookies(req));
          return;
        }
        if (!isClaimOnly(payload)) {
          unauthorized(res, staleAuthCookies(req));
          return;
        }
        const out: RpcResponseContext = { cookies: [], secure: isHttpsRequest(req) };
        const reply = await dispatch(payload, null, out);
        writeJson(res, 200, reply, true, out.cookies);
        return;
      }
      const body = await readBody(req, 8 * 1024 * 1024);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        writeJson(res, 200, parseError(e), false);
        return;
      }
      const out: RpcResponseContext = { cookies: [], secure: isHttpsRequest(req) };
      const reply = Array.isArray(payload)
        ? await Promise.all(payload.map((item) => dispatch(item, auth, out)))
        : await dispatch(payload, auth, out);
      writeJson(res, 200, reply, false, out.cookies);
      return;
    }

    // 静态资源（移动端壳）
    if (req.method === "GET" || req.method === "HEAD") {
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
      const target = resolve(join(webDir, rel || "index.html"));
      if (!target.startsWith(resolve(webDir))) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      try {
        const info = await stat(target);
        if (!info.isFile()) throw new Error("not a file");
        res.writeHead(200, {
          "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        createReadStream(target).pipe(res);
      } catch {
        // SPA 兜底：未知路径回 index.html（深链接要求）
        const index = join(webDir, "index.html");
        try {
          await stat(index);
          res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
          createReadStream(index).pipe(res);
        } catch {
          res.writeHead(404);
          res.end("not found");
        }
      }
      return;
    }

    res.writeHead(405);
    res.end("method not allowed");
  }

  /**
   * `/local-auth`：用一次 Bearer 换 HttpOnly cookie（只为 SSE；RPC 仍可带 Bearer）。
   *
   * 只在 `local-auth` 模式存在：其它模式回 404，这样共享 UI 可以"探一下"区分
   * "这台 Host 要不要本机凭据"，而不用引入新的协议方法（协议版本不变）。
   *
   * 安全细节：
   * - **同源校验**：别的网页不能拿用户浏览器当跳板（即便它猜到了凭据）；
   * - 失败限速：只对失败计数（正确凭据点一次就该过），防止同机进程暴力猜；
   * - 响应体不带任何值，错误信息也不回显提交值。
   */
  function handleLocalAuth(req: IncomingMessage, res: ServerResponse): void {
    if (config.authMode !== "local-auth") {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (!sameOrigin(req)) {
      res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "跨源请求被拒绝（Host 只服务自己的页面）" }));
      return;
    }
    const key = req.socket.remoteAddress ?? "unknown";
    if (localAuthRateLimited(key)) {
      res.writeHead(429, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "尝试过于频繁" }));
      return;
    }
    const bearer = bearerOf(req);
    if (!bearer || !safeEqual(bearer, config.localAuthToken)) {
      noteLocalAuthFailure(key);
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "本机凭据无效" }));
      return;
    }
    res.writeHead(204, {
      "cache-control": "no-store",
      "set-cookie": serializeLocalAuthCookie({
        name: localCookie,
        token: config.localAuthToken,
        secure: isHttpsRequest(req),
      }),
    });
    res.end();
  }

  function localAuthRateLimited(key: string): boolean {
    const entry = localAuthFailures.get(key);
    if (!entry) return false;
    if (entry.resetAt <= Date.now()) {
      localAuthFailures.delete(key);
      return false;
    }
    return entry.count >= LOCAL_AUTH_MAX_FAILURES;
  }

  function noteLocalAuthFailure(key: string): void {
    const now = Date.now();
    const entry = localAuthFailures.get(key);
    if (!entry || entry.resetAt <= now) {
      // 只在有失败时才增条目；上限保护避免被大量伪造源地址撑爆内存
      if (localAuthFailures.size > 256) localAuthFailures.clear();
      localAuthFailures.set(key, { count: 1, resetAt: now + LOCAL_AUTH_WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  /**
   * 鉴权矩阵（D-7，设备凭据已改为 HttpOnly cookie；`local-auth` 是本机每次启动的凭据）：
   *
   * 1. `Authorization: Bearer` —— 静态令牌（`CODEM_HOST_TOKEN`）、控制令牌（仅 `/rpc`，
   *    且调用方在 dispatch 里再限 `pair.*`），以及 `local-auth` 模式下的本机凭据
   *    （RPC 用 Bearer；SSE 用下面第 2 条的 cookie）；
   * 2. `local-auth` cookie（exact name）→ 本机身份。**只在这个模式认**；
   * 3. 设备 cookie（exact name，见 cookie.ts）→ `pairing.authenticate`。
   *    `local-auth` 模式**忽略**它：旧的 400 天设备凭据不能绕过"每次启动轮换"；
   * 4. `?token=`（仅 `/events`）—— **只**认静态令牌。EventSource 不能带 header，
   *    这是静态 break-glass 凭据既有的 URL 面（本机凭据绝不进 URL）；
   * 5. loopback 免鉴权：**只在 `local` 模式且没有静态 token 时**。`paired` 模式下
   *    即使 remoteAddress 是 127.0.0.1 也必须带凭据 —— 隧道客户端就在本机。
   *
   * 顺序是有意的：无效 Bearer 不能遮蔽有效 cookie（反过来会得到"明明显式带了浏览器
   * 凭据却 401"的怪状态）；静态凭据优先于同一请求里的 cookie（CLI 想以静态身份
   * 调用时不必先清浏览器 cookie）。
   */
  function authenticate(
    req: IncomingMessage,
    url: URL,
    opts: { allowQueryToken: boolean; allowControl: boolean },
  ): AuthContext | null {
    const bearer = bearerOf(req);
    if (bearer) {
      if (config.authMode === "local-auth" && config.localAuthToken && safeEqual(bearer, config.localAuthToken)) {
        return { kind: "local" };
      }
      if (config.token && safeEqual(bearer, config.token)) return { kind: "static" };
      if (opts.allowControl && config.controlToken && safeEqual(bearer, config.controlToken)) {
        return { kind: "control" };
      }
    }
    if (config.authMode === "local-auth") {
      const localToken = requestCookie(req, localCookie);
      if (localToken && config.localAuthToken && safeEqual(localToken, config.localAuthToken)) return { kind: "local" };
    } else {
      const cookieToken = requestCookie(req, deviceCookie);
      if (cookieToken) {
        const device = pairing.authenticate(cookieToken);
        if (device) return { kind: "device", deviceId: device.id, deviceName: device.name };
      }
    }
    const query = opts.allowQueryToken ? (url.searchParams.get("token") ?? "") : "";
    if (query && config.token && safeEqual(query, config.token)) return { kind: "static" };
    if (config.authMode === "local" && !config.token && isLoopback(req)) return { kind: "local" };
    return null;
  }

  /**
   * 请求确实带了本 Host 的凭据 cookie、但鉴权失败时的清理头。
   *
   * 为什么由服务端删：HttpOnly cookie 页面 JS 删不了；撤销/重启后如果浏览器里一直留着
   * 旧凭据，用户看到的是"每次启动都转圈再失败"，而不是干净的错误页/配对门。
   * 只在"带了这个名字"时回，避免给无凭据请求平白多一个 Set-Cookie。
   */
  function staleAuthCookies(req: IncomingMessage): string[] {
    const stale: string[] = [];
    if (requestCookie(req, localCookie)) stale.push(clearLocalAuthCookie(localCookie));
    if (requestCookie(req, deviceCookie)) stale.push(clearDeviceCookie(deviceCookie));
    return stale;
  }

  function sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // 非浏览器客户端（Node/测试）没有 Origin
    try {
      const expected = req.headers.host;
      return new URL(origin).host === expected;
    } catch {
      return false;
    }
  }

  function streamEvents(req: IncomingMessage, res: ServerResponse, url: URL, auth: AuthContext): void {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "缺少 sessionId" }));
      return;
    }
    const lastEventId = req.headers["last-event-id"];
    const sinceRaw = url.searchParams.get("sinceSeq");
    const sinceSeq = lastEventId ? Number(lastEventId) : sinceRaw ? Number(sinceRaw) : undefined;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // 明确告诉反向代理不要缓冲（Cloudflare/Nginx 都认这个头）
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    clients.set(res, auth);
    const unsubscribe = runtime.subscribe(
      sessionId,
      (event) => {
        res.write(`id: ${event.seq}\n`);
        res.write(`data: ${JSON.stringify({ ...event, method: NOTIFICATIONS.sessionEvent })}\n\n`);
      },
      Number.isFinite(sinceSeq) ? sinceSeq : undefined,
    );
    const heartbeat = setInterval(() => {
      // 注释行心跳：既能保活，又不会进客户端的消息队列
      res.write(`: ping ${Date.now()}\n\n`);
    }, 20_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      clients.delete(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  /** 撤销设备：持久化成功之后，立刻断开这台设备已建立的事件流（并告诉它原因）。 */
  function disconnectDevice(deviceId: string): void {
    for (const [res, auth] of clients) {
      if (auth.kind !== "device" || auth.deviceId !== deviceId) continue;
      try {
        // 不能写 `event: auth.revoked`：命名的 SSE 事件不会触发 EventSource.onmessage，
        // 共享 UI 的 HostClient 只监听 message ⇒ 撤销不会立即回配对门（真机验收失败项）。
        res.write(
          `data: ${JSON.stringify({
            type: "auth.revoked",
            method: NOTIFICATIONS.authRevoked,
            reason: "revoked",
            timestamp: Date.now(),
          })}\n\n`,
        );
        res.end();
      } catch {
        /* 连接可能已被对端关掉；撤销本身已经持久化成功 */
      }
      clients.delete(res);
    }
  }

  async function dispatch(raw: unknown, auth: AuthContext | null, out: RpcResponseContext): Promise<unknown> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return toRpcFailure(null, new HostError("INVALID_REQUEST", "请求必须是 JSON-RPC 对象"));
    }
    const request = raw as Partial<RpcRequest>;
    const id = (request.id ?? null) as JsonRpcId | null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return toRpcFailure(id, new HostError("INVALID_REQUEST", "缺少 jsonrpc=2.0 或 method"));
    }
    try {
      const result = await call(request.method, asObject(request.params), auth, out);
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (e) {
      return toRpcFailure(id, e);
    }
  }

  async function call(
    method: string,
    params: Record<string, unknown>,
    auth: AuthContext | null,
    out: RpcResponseContext,
  ): Promise<unknown> {
    /**
     * 控制令牌的受众隔离：它只够管理配对，不能变成"本机万能钥匙"。
     * （桌面 Rust 进程持有它；渲染层与手机都拿不到。）
     */
    if (auth?.kind === "control" && !method.startsWith("pair.")) {
      throw new HostError("UNAUTHORIZED", "控制凭据只能用于配对管理", {
        hint: "手机/普通客户端请使用配对码或设备令牌",
      });
    }
    if (!auth && method !== METHODS.pairClaim) {
      throw new HostError("UNAUTHORIZED", "缺少或错误的凭据", { hint: "请先在手机上输入配对码，或使用访问令牌" });
    }
    switch (method) {
      case METHODS.hello: {
        const version = asInt(params.protocolVersion, "protocolVersion");
        const check = checkProtocolVersion(version);
        if (!check.ok) {
          throw new HostError("VERSION_MISMATCH", check.reason, { hint: "请升级客户端或桌面端" });
        }
        const clientName = asString((params.client as { name?: string } | undefined)?.name ?? "unknown", "client.name", { maxLength: 64 });
        const deviceName = asString(params.deviceName ?? clientName, "deviceName", { maxLength: 128 });
        const hello = runtime.hello(version, clientName, deviceName, params.claim === true);
        return { ...hello, ...(auth ? { auth: publicAuth(auth) } : {}) };
      }
      case METHODS.status:
        return runtime.listRuns();
      case METHODS.diagnostics:
        return runtime.diagnostics(
          params.sessionId === undefined ? undefined : asString(params.sessionId, "sessionId"),
        );
      case METHODS.sessionList: {
        const limit = asInt(params.limit, "limit", { min: 1, max: 500, fallback: 100 });
        return runtime.listSessions(limit);
      }
      case METHODS.sessionCreate: {
        const title = params.title === undefined ? undefined : asString(params.title, "title", { maxLength: 200 });
        return runtime.createSession(title);
      }
      case METHODS.sessionGet: {
        const sessionId = asString(params.sessionId, "sessionId", { maxLength: 256 });
        return runtime.getSession(sessionId, {
          offset: asInt(params.offset, "offset", { min: 0, fallback: 0 }),
          limit: asInt(params.limit, "limit", { min: 1, max: 500, fallback: 200 }),
          visibleOnly: params.visibleOnly === true,
        });
      }
      case METHODS.sessionWatch: {
        const sessionId = asString(params.sessionId, "sessionId", { maxLength: 256 });
        const since = params.sinceSeq === undefined ? undefined : asInt(params.sinceSeq, "sinceSeq", { min: 0 });
        const subscriptionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        return { subscriptionId, fromSeq: since ?? 0, truncated: false };
      }
      case METHODS.leaseTakeover: {
        const clientId = asString(params.clientId, "clientId", { maxLength: 128 });
        const deviceName = params.deviceName === undefined ? undefined : asString(params.deviceName, "deviceName", { maxLength: 128 });
        return runtime.takeoverLease(clientId, params.confirm === true, deviceName);
      }
      case METHODS.promptSend: {
        const sessionId = asString(params.sessionId, "sessionId", { maxLength: 256 });
        const text = asString(params.text, "text", { maxLength: 400_000 });
        const requestId = asString(params.requestId, "requestId", { maxLength: 128 });
        const clientId = params.clientId === undefined ? undefined : asString(params.clientId, "clientId", { maxLength: 128 });
        return runtime.sendPrompt(
          sessionId,
          text,
          requestId,
          clientId,
          Array.isArray(params.attachmentIds) ? params.attachmentIds.map(String) : [],
        );
      }
      case METHODS.runGuidance: {
        const runId = asString(params.runId, "runId", { maxLength: 128 });
        const text = asString(params.text, "text", { maxLength: 20_000 });
        return runtime.sendGuidance(runId, text);
      }
      case METHODS.runCancel: {
        const runId = asString(params.runId, "runId", { maxLength: 128 });
        const requestId = asString(params.requestId, "requestId", { maxLength: 128 });
        return runtime.cancelRun(runId, requestId);
      }
      case METHODS.runStatus:
        return runtime.runStatus(asString(params.runId, "runId", { maxLength: 128 }));
      case METHODS.approvalList: {
        const sessionId = params.sessionId === undefined ? undefined : asString(params.sessionId, "sessionId");
        return { items: runtime.listApprovals(sessionId) };
      }
      case METHODS.approvalRespond: {
        const approvalId = asString(params.approvalId, "approvalId", { maxLength: 128 });
        const decision = params.decision === "deny" ? "deny" : params.decision === "allow" ? "allow" : null;
        if (!decision) throw new HostError("INVALID_PARAMS", "decision 必须是 allow / deny");
        const requestId = asString(params.requestId, "requestId", { maxLength: 128 });
        return runtime.respondApproval(
          approvalId,
          decision,
          requestId,
          params.note === undefined ? undefined : asString(params.note, "note", { maxLength: 4000 }),
        );
      }
      case METHODS.workspaceRead: {
        const path = asString(params.path, "path", { maxLength: 1024 });
        const approvalId =
          params.approvalId === undefined
            ? undefined
            : asString(params.approvalId, "approvalId", { maxLength: 128 });
        return runtime.readWorkspaceFile(
          path,
          asInt(params.offset, "offset", { min: 0, fallback: 0 }),
          asInt(params.limit, "limit", { min: 1, max: 2_000_000, fallback: 200_000 }),
          approvalId,
        );
      }
      case METHODS.workspaceList: {
        const dir = params.path === undefined ? "." : asString(params.path, "path", { maxLength: 1024 });
        return runtime.listWorkspaceDir(dir);
      }
      case METHODS.pluginsList:
        return runtime.listPlugins();
      case METHODS.workspaceDiff: {
        const p = asString(params.path, "path", { maxLength: 1024 });
        const base = params.base === undefined ? "HEAD" : asString(params.base, "base", { maxLength: 128 });
        const approvalId =
          params.approvalId === undefined
            ? undefined
            : asString(params.approvalId, "approvalId", { maxLength: 128 });
        return runtime.diffWorkspaceFile(p, base, approvalId);
      }
      case METHODS.sessionChanges: {
        const sessionId = asString(params.sessionId, "sessionId", { maxLength: 256 });
        return runtime.listChanges(
          sessionId,
          asInt(params.offset, "offset", { min: 0, fallback: 0 }),
          asInt(params.limit, "limit", { min: 1, max: 50, fallback: 20 }),
        );
      }
      case METHODS.sessionChangeDiff: {
        const sessionId = asString(params.sessionId, "sessionId", { maxLength: 256 });
        const changeId = asString(params.changeId, "changeId", { maxLength: 256 });
        const path = asString(params.path, "path", { maxLength: 1024 });
        return runtime.diffChange(sessionId, changeId, path);
      }
      case METHODS.attachmentPut: {
        const name = asString(params.name, "name", { maxLength: 200 });
        const mimeType = asString(params.mimeType, "mimeType", { maxLength: 200 });
        const base64 = asString(params.base64, "base64", { maxLength: 16_000_000 });
        return runtime.putAttachment(name, mimeType, base64);
      }
      case METHODS.pairStart: {
        // 已鉴权（本机 / 静态令牌 / 已配对设备 / 桌面控制令牌）才能生成码
        requirePairAdmin(auth, "pair.start");
        return pairing.newCode();
      }
      case METHODS.pairClaim: {
        const code = asString(params.code, "code", { maxLength: 32 });
        const deviceName =
          params.deviceName === undefined ? undefined : asString(params.deviceName, "deviceName", { maxLength: 128 });
        const platform = params.platform === undefined ? undefined : asString(params.platform, "platform", { maxLength: 16 });
        try {
          const claimed = await pairing.claim(code, deviceName, platform);
          /**
           * 设备凭据只走 `Set-Cookie`：JSON 里不出现明文 token（页面 JS 读不到）。
           * 同一数据根的名字是稳定的，重配就是用 Set-Cookie 覆盖旧值；
           * `Secure` 由本次请求的 HTTPS 证据决定（见 cookie.ts）。
           */
          out.cookies.push(
            serializeDeviceCookie({
              name: deviceCookie,
              token: claimed.token,
              secure: out.secure,
            }),
          );
          return {
            hostId: runtime.hostId,
            deviceId: claimed.device.id,
            device: claimed.device,
          };
        } catch (e) {
          throw pairingFailureToHostError(e);
        }
      }
      case METHODS.pairList: {
        requirePairAdmin(auth, "pair.list");
        return pairing.list();
      }
      case METHODS.pairRevoke: {
        requirePairAdmin(auth, "pair.revoke");
        const deviceId = asString(params.deviceId, "deviceId", { maxLength: 64 });
        const revoked = await pairing.revoke(deviceId);
        // 先持久化（revoke 内部保证），再断已建连接：顺序反了会出现"断了但没撤销成功"
        if (revoked) disconnectDevice(deviceId);
        return { revoked };
      }
      default:
        if (method.startsWith("terminal.")) {
          throw new HostError("UNSUPPORTED", "终端能力在阶段 5 才接入", { hint: "客户端应隐藏终端入口" });
        }
        throw new HostError("METHOD_NOT_FOUND", `未知方法：${method}`);
    }
  }

  /** 配对管理（生成码 / 列设备 / 撤销）：本机、静态令牌、已配对设备、桌面控制令牌都可以。 */
  function requirePairAdmin(auth: AuthContext | null, method: string): asserts auth is AuthContext {
    // 配对管理只允许桌面控制面 / 静态 break-glass / 本机 local；
    // **已配对设备不能给自己或别人发码/撤销**（否则一台手机可接管所有设备）。
    if (!auth || auth.kind === "device") {
      throw new HostError("UNAUTHORIZED", `${method} 需要电脑控制面或静态令牌`, { hint: "请从电脑上的设置页生成配对码" });
    }
  }

  function publicAuth(auth: AuthContext): { kind: "local" | "static" | "device"; deviceId?: string; deviceName?: string } {
    if (auth.kind === "device") return { kind: "device", deviceId: auth.deviceId, deviceName: auth.deviceName };
    if (auth.kind === "static") return { kind: "static" };
    if (auth.kind === "local") return { kind: "local" };
    // control 只能调用 pair.*（call() 已拦下 hello），走到这里说明受众隔离被绕过
    throw new HostError("UNAUTHORIZED", "控制凭据不能用于会话接口");
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, config.host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    port,
    url: `http://${config.host}:${port}`,
    async close() {
      for (const res of clients.keys()) {
        try {
          res.end();
        } catch {
          /* 已断开 */
        }
      }
      clients.clear();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/** 配对失败 → 协议错误：reason 放 details（客户端按它给可行动文案），不解析 message。 */
function pairingFailureToHostError(e: unknown): unknown {
  if (!(e instanceof PairingError)) return e;
  switch (e.reason) {
    case "rate_limited":
      return new HostError("BUSY", "配对尝试过于频繁", {
        retryable: true,
        hint: "请稍后再试，或在电脑上重新生成配对码",
        details: { reason: e.reason, retryAfterMs: e.retryAfterMs ?? 0 },
      });
    case "device_limit":
      return new HostError("CONFLICT", "已配对设备达到上限", {
        hint: "请在电脑上撤销一台不再使用的设备后再配对",
        details: { reason: e.reason },
      });
    default:
      return new HostError("UNAUTHORIZED", "配对码无效或已过期", {
        hint: "请在电脑上重新生成配对码",
        details: { reason: e.reason },
      });
  }
}

/** Bearer 提取：大小写不敏感；空值/错误格式返回空串（不抛错、不 500）。 */
function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

/** 常数时间比较两段文本（避免长度/前缀泄露；用于静态与控制令牌）。 */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  return timingSafeEqual(
    createHash("sha256").update(a, "utf8").digest(),
    createHash("sha256").update(b, "utf8").digest(),
  );
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function unauthorized(res: ServerResponse, clearCookies: string[] = []): void {
  writeJson(
    res,
    401,
    toRpcFailure(
      null,
      new HostError("UNAUTHORIZED", "缺少或错误的凭据", {
        hint: "请在手机上输入配对码，或使用访问令牌",
      }),
    ),
    true,
    clearCookies,
  );
}

function writeJson(res: ServerResponse, status: number, body: unknown, noStore: boolean, cookies: string[] = []): void {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(noStore ? { "cache-control": "no-store" } : {}),
    ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
  });
  res.end(JSON.stringify(body));
}

/** 未鉴权请求只允许"整批都是 pair.claim"（批量混入其它方法必须整体拒绝）。 */
function isClaimOnly(payload: unknown): boolean {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.every(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { method?: unknown }).method === METHODS.pairClaim,
  );
}

function parseError(e: unknown): RpcFailure {
  return toRpcFailure(null, new HostError("PARSE_ERROR", `请求体不是合法 JSON：${e instanceof Error ? e.message : e}`));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new HostError("INVALID_PARAMS", `请求体超过上限 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

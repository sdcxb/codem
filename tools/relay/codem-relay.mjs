#!/usr/bin/env node
/**
 * Codem 中继（codem-relay）—— 第 122 轮「完全对标 AA 出站中继」的第 A 步。
 *
 * ## 它在整个链路里的位置
 *
 *     手机浏览器 ──HTTPS──▶ [本程序] ◀──出站长连── [Codem 桌面端的 egress connector]
 *
 * 桌面的 connector **连出来**到本程序；手机也连到本程序。
 * 桌面**不为这条路径开任何 LAN 端口** —— 这与 DSH 的 Agents Anywhere 是同一条策略
 * （见 `docs/DSH-REMOTE-CONTROL-BENCHMARK.md` §11）。
 *
 * ## 为什么是「纯隧道」
 *
 * 本程序**不认识** Codem 的会话协议：它只把手机发来的 HTTP 请求原样透给 connector，
 * 再把响应透回去。这样做有两个具体好处：
 *
 * 1. **中继上看不到会话语义** —— 比 AA 的云更保守（AA 的云端要理解并投影会话，
 *    因为手机端是它的 Web App；我们的手机页面是桌面端自己生成的，中继不需要懂）；
 * 2. **桌面侧一行都不用改** —— 路由、cookie 鉴权、配对页、审批卡片全部复用既有实现。
 *
 * ## 凭据模型（TOFU + 配对码）
 *
 * - **connectorToken**：connector 首次 `hello` 时登记，之后必须一致（像 SSH 的
 *   known_hosts）。我们**没有账号体系**，所以不引入"签发"这一步。
 * - **pairingCode**：桌面每次轮换配对二维码时把新码报给中继；手机用码换一个
 *   中继侧会话 cookie。码本身有时效（沿用桌面 5 分钟的配对 TTL）。
 *
 * ## 零依赖
 *
 * 只用 `node:http` / `node:https` / `node:crypto`。中继要能扔到任何一台 VPS 上直接跑，
 * 不该先装一堆东西 —— 这也是它不写成 Rust 二进制的原因（那要求目标机有我们的构建产物）。
 *
 * 用法：
 *   node tools/relay/codem-relay.mjs --port 8787
 *   node tools/relay/codem-relay.mjs --port 8788 --tls-cert cert.pem --tls-key key.pem
 */
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** 单帧上限 —— 与桌面侧本机服务的 8 MiB 对齐（会话列表可能不小）。 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** 中继等 connector 应答的上限。跨网络 + 回环往返，给足但不无限等。 */
export const TUNNEL_TIMEOUT_MS = 30_000;
/** 配对码时效（与桌面 PAIR_TTL_MS 的 5 分钟一致）。 */
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
/** 中继侧会话 cookie 寿命：7 天（比桌面 cookie 的 30 天短 —— 中继在公网上）。 */
export const APP_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** SSE 心跳间隔（AA 的 connector 心跳是 20s，我们注释帧用 15s，更快发现断链）。 */
export const HEARTBEAT_MS = 15_000;
/** 允许的请求体上限。 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const COOKIE_NAME = "codem_relay";

/**
 * 中继的运行时状态。
 *
 * 导出成类是为了**可测**：测试直接把 State 拿来用，不必起真端口。
 */
export class RelayState {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** connectorId → { token, streamToken, stream, pairingCode, pairingAtMs, pending, name, lastSeenMs } */
    this.connectors = new Map();
    /** app 会话 secret → { connectorId, expiresAtMs } */
    this.appSessions = new Map();
    this.reqSeq = 0;
  }

  /** connector 首次登记或校验既有 token（TOFU：首见即登记，之后必须一致）。 */
  hello({ connectorId, connectorToken, pairingCode, deviceName }) {
    if (!connectorId || !connectorToken) return { ok: false, code: "bad_request" };
    let s = this.connectors.get(connectorId);
    if (!s) {
      s = {
        token: connectorToken,
        streamToken: crypto.randomBytes(32).toString("base64url"),
        stream: null,
        pairingCode: "",
        pairingAtMs: 0,
        pending: new Map(),
        name: deviceName || "",
        lastSeenMs: this.now(),
      };
      this.connectors.set(connectorId, s);
    } else if (s.token !== connectorToken) {
      // 不复用旧 token 就拒绝：否则任何知道 connectorId 的人都能占位
      return { ok: false, code: "connector_token_mismatch" };
    }
    s.lastSeenMs = this.now();
    if (deviceName) s.name = deviceName;
    if (pairingCode) {
      s.pairingCode = String(pairingCode);
      s.pairingAtMs = this.now();
    }
    return { ok: true, streamToken: s.streamToken };
  }

  /** 校验 connector 身份（stream / response 都要用它）。 */
  auth(connectorId, streamToken) {
    const s = this.connectors.get(connectorId);
    if (!s) return null;
    if (streamToken !== s.streamToken) return null;
    s.lastSeenMs = this.now();
    return s;
  }

  /** 手机用配对码换中继会话。 */
  pair(code) {
    const c = String(code || "").trim();
    if (!c) return { ok: false, code: "bad_request" };
    for (const [connectorId, s] of this.connectors) {
      if (!s.pairingCode) continue;
      if (this.now() - s.pairingAtMs > PAIR_CODE_TTL_MS) continue;
      // 常数时间比较（配对码是入网凭据，别给时间侧信道）
      const a = Buffer.from(s.pairingCode);
      const b = Buffer.from(c);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) continue;
      const secret = crypto.randomBytes(32).toString("base64url");
      this.appSessions.set(secret, { connectorId, expiresAtMs: this.now() + APP_SESSION_TTL_MS });
      return { ok: true, secret, connectorId };
    }
    return { ok: false, code: "pair_code_invalid" };
  }

  appSession(secret) {
    if (!secret) return null;
    const s = this.appSessions.get(secret);
    if (!s) return null;
    if (s.expiresAtMs <= this.now()) {
      this.appSessions.delete(secret);
      return null;
    }
    return s;
  }

  /** 把手机请求推给 connector，并等它的应答。 */
  tunnel(connectorId, frame) {
    const s = this.connectors.get(connectorId);
    if (!s) return Promise.reject(Object.assign(new Error("connector_unknown"), { code: 404 }));
    if (!s.stream) return Promise.reject(Object.assign(new Error("connector_offline"), { code: 503 }));
    const id = `r${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(id);
        reject(Object.assign(new Error("connector_timeout"), { code: 504 }));
      }, TUNNEL_TIMEOUT_MS);
      s.pending.set(id, { resolve, reject, timer });
      try {
        s.stream.write(`event: request\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, method: "http.request", params: frame })}\n\n`);
      } catch (e) {
        clearTimeout(timer);
        s.pending.delete(id);
        reject(Object.assign(new Error("connector_write_failed"), { code: 503 }));
      }
    });
  }

  /** connector 回填应答。 */
  settle(connectorId, id, result, error) {
    const s = this.connectors.get(connectorId);
    if (!s) return false;
    const p = s.pending.get(id);
    if (!p) return false;
    s.pending.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(Object.assign(new Error(String(error.message || "connector_error")), { code: 502 }));
    else p.resolve(result);
    return true;
  }

  onlineIds() {
    return [...this.connectors.entries()].filter(([, s]) => Boolean(s.stream)).map(([id]) => id);
  }
}

// ---------------- HTTP 层 ----------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body_too_large"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function parseCookies(header) {
  const out = new Map();
  for (const kv of String(header || "").split(";")) {
    const t = kv.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out.set(t.slice(0, i).trim(), decodeURIComponent(t.slice(i + 1).trim()));
  }
  return out;
}

/**
 * 造出中继的请求处理器。
 *
 * 与 `createServer` 分开，是为了让测试能**只测路由**（用假的 req/res 或直接起真端口
 * 但不必关心 TLS 配置）。
 */
export function createHandler(state, { secure = false } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url || "/", "http://relay.invalid");
    const path = url.pathname;

    try {
      if (path === "/healthz") {
        return sendJson(res, 200, {
          ok: true,
          connectors: state.connectors.size,
          online: state.onlineIds(),
        });
      }

      if (path === "/connector/hello" && req.method === "POST") {
        let body = {};
        try {
          body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, { ok: false, code: "bad_json" });
        }
        const out = state.hello(body);
        return sendJson(res, out.ok ? 200 : 401, out);
      }

      if (path === "/connector/stream" && req.method === "GET") {
        const s = state.auth(url.searchParams.get("connectorId"), url.searchParams.get("streamToken"));
        if (!s) return sendJson(res, 401, { ok: false, code: "unauthorized" });
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        s.stream = res;
        // 心跳用**注释帧**（以冒号开头）：SSE 客户端会忽略，但连接因此保持活跃，
        // 也让"对端已经死了"能在一个心跳周期内被发现。
        const hb = setInterval(() => {
          try {
            res.write(`: hb ${Date.now()}\n\n`);
          } catch {
            /* 下一轮 close 会清理 */
          }
        }, HEARTBEAT_MS);
        const cleanup = () => {
          clearInterval(hb);
          if (s.stream === res) s.stream = null;
          for (const [, p] of s.pending) {
            clearTimeout(p.timer);
            p.reject(Object.assign(new Error("connector_disconnected"), { code: 503 }));
          }
          s.pending.clear();
        };
        /**
         * ⚠️ 必须挂在 **`res`** 上，不能挂 `req`。
         *
         * 踩过的坑：`req.on('close', cleanup)` 对一个**没有 body 的 GET** 会
         * **立刻**触发（Node 在请求流读完后就发 close，语义不是"连接断了"）——
         * 于是 connector 刚一注册就被当成"已断开"清理掉，`s.stream` 变回 null，
         * 手机请求全部拿到 503。而现象是"手机那边一直转圈、connector 侧什么都没收到"，
         * 极难从表象定位（RL-5/RL-8 两条用例就是因此挂到超时）。
         *
         * `ServerResponse` 的 close 才是"对端走了"的正确信号：这个响应我们从不 end，
         * 所以它只会在连接真正断开时触发。
         */
        res.on("close", cleanup);
        res.on("error", cleanup);
        return;
      }

      if (path === "/connector/response" && req.method === "POST") {
        let body = {};
        try {
          body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, { ok: false, code: "bad_json" });
        }
        const s = state.auth(body.connectorId, body.streamToken);
        if (!s) return sendJson(res, 401, { ok: false, code: "unauthorized" });
        const found = state.settle(body.connectorId, body.id, body.result, body.error);
        // 找不到 = 那条请求已经超时（或已被断开清理）—— **如实说**，
        // 不能默默 200，否则 connector 以为回填成功了
        return sendJson(res, found ? 200 : 410, { ok: found, code: found ? undefined : "request_gone" });
      }

      if (path === "/app/pair" && req.method === "POST") {
        let body = {};
        try {
          body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, { ok: false, code: "bad_json" });
        }
        const out = state.pair(body.code);
        if (!out.ok) return sendJson(res, 403, out);
        const cookie = [
          `${COOKIE_NAME}=${out.secret}`,
          "Path=/app",
          "HttpOnly",
          secure ? "Secure" : "",
          "SameSite=Strict",
          `Max-Age=${Math.floor(APP_SESSION_TTL_MS / 1000)}`,
        ]
          .filter(Boolean)
          .join("; ");
        return sendJson(res, 200, { ok: true, connectorId: out.connectorId }, { "set-cookie": cookie });
      }

      // ---- /app/* 隧道 ----
      if (path === "/app" || path.startsWith("/app/")) {
        const sess = state.appSession(parseCookies(req.headers.cookie).get(COOKIE_NAME));
        /**
         * 未授权时**只回一句 JSON**，不提供任何页面内容 ——
         * 中继在公网上，未配对的浏览器不该从这里读到任何东西。
         */
        if (!sess) return sendJson(res, 401, { ok: false, code: "unauthorized", hint: "请先在桌面端配对" });

        const inner = path === "/app" ? "/" : path.slice("/app".length);
        let bodyB64 = "";
        if (req.method !== "GET" && req.method !== "HEAD") {
          bodyB64 = (await readBody(req)).toString("base64");
        }
        let result;
        try {
          result = await state.tunnel(sess.connectorId, {
            method: req.method || "GET",
            path: inner,
            query: url.search || "",
            headers: { cookie: req.headers.cookie || "", "content-type": req.headers["content-type"] || "" },
            bodyB64,
          });
        } catch (e) {
          // 如实回错误码：503 = 桌面离线，504 = 桌面没应答，两者用户要做的事不同
          return sendJson(res, e.code || 502, { ok: false, code: e.message });
        }
        const status = Number(result?.status) || 502;
        const headers = {};
        for (const [k, v] of Object.entries(result?.headers || {})) {
          const lk = String(k).toLowerCase();
          // 透传 Set-Cookie（桌面侧的 codem_phone 要靠它落地），但不要 hop-by-hop 头
          if (["connection", "keep-alive", "transfer-encoding", "content-length"].includes(lk)) continue;
          headers[lk] = v;
        }
        const buf = Buffer.from(result?.bodyB64 || "", "base64");
        headers["content-length"] = buf.length;
        headers["cache-control"] = "no-store";
        res.writeHead(status, headers);
        return res.end(buf);
      }

      if (path === "/") {
        res.writeHead(302, { location: "/app/" });
        return res.end();
      }

      return sendJson(res, 404, { ok: false, code: "not_found" });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, code: "relay_error", message: String(e?.message || e) });
      else res.end();
    }
  };
}

export function createRelay({ tlsCert, tlsKey } = {}) {
  const state = new RelayState();
  const secure = Boolean(tlsCert && tlsKey);
  const handler = createHandler(state, { secure });
  const server = secure
    ? https.createServer({ cert: tlsCert, key: tlsKey }, handler)
    : http.createServer(handler);
  return { state, server, secure, handler };
}

// ---------------- CLI ----------------

/**
 * 是不是"被直接运行"（而不是被 import 进测试）。
 *
 * ⚠️ 不能用字符串拼 `file://` + argv[1] 来比：Windows 上 `import.meta.url` 是
 * `file:///C:/...`（三个斜杠），手拼成 `file://C:/...`（两个）**永不相等** ——
 * 于是脚本静默什么都不做、也不报错，`--port` 看起来"没生效"。
 * 用 `pathToFileURL` 让平台差异由 Node 自己处理。
 */
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "8787" },
      host: { type: "string", default: "0.0.0.0" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
    },
  });
  let tlsCert;
  let tlsKey;
  if (values["tls-cert"] && values["tls-key"]) {
    const fs = await import("node:fs");
    tlsCert = fs.readFileSync(values["tls-cert"]);
    tlsKey = fs.readFileSync(values["tls-key"]);
  } else {
    console.warn("[relay] 未提供 --tls-cert/--tls-key：以**明文 HTTP** 监听。");
    console.warn("[relay] 公网部署请务必放在 HTTPS 反代之后，或提供证书 —— 否则手机与桌面的流量是明文。");
  }
  const { server, secure } = createRelay({ tlsCert, tlsKey });
  const port = Number(values.port) || 8787;
  server.listen(port, values.host, () => {
    console.log(`[relay] 监听 ${secure ? "https" : "http"}://${values.host}:${port}`);
    console.log("[relay] 桌面端在「设置 → 连接手机 → 远程中继」里填入这个地址。");
  });
}

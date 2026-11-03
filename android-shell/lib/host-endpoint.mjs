/**
 * 设备内 Host 的**端点发现 + RPC**（只给 `android-shell/spike-*.mjs` 用）。
 *
 * 为什么需要这个模块：
 * - `HostSupervisor` 每次启动都让内核分配随机端口（`ServerSocket(0)`），旧脚本里的
 *   `tcp:8787` 已经不可用；
 * - 本机 Host 是 `local-auth` 模式：`/rpc` 需要**本次启动**的 64hex 凭据。凭据只在
 *   WebView 的 sessionStorage / 同源 cookie 里，所以这里用**页面上下文里的 fetch**
 *   发 RPC —— Node 侧从不读取、也不打印凭据。
 *
 * 与官方设备用例 `run-device-cases.mjs` 的关系：那边有自己的发现/鉴权实现（还要驱动
 * UI、产出证据 JSON）。本模块只服务 spike 脚本，避免改动官方 DC 脚本的语义。
 */
import crypto from "node:crypto";
import net from "node:net";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function devtoolsCandidates(sh, pkg) {
  const unix = sh("shell", "cat", "/proc/net/unix");
  const found = [...unix.matchAll(/webview_devtools_remote_(\d+)/g)].map((m) => m[1]);
  const unique = [...new Set(found)];
  const own = new Set(
    sh("shell", "pidof", pkg)
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  // 本应用进程优先；别的应用/旧进程残留的 socket 只作为候选，探测失败就跳过。
  return [...unique.filter((pid) => own.has(pid)), ...unique.filter((pid) => !own.has(pid))];
}

/**
 * 单个 WebView 的 CDP 客户端。
 *
 * `send` 解析 CDP 的 `result`；`eval` 返回 `Runtime.evaluate` 的值。
 * 只实现 spike 用到的能力，不引入依赖。
 */
export class Cdp {
  constructor(wsUrl) {
    this.url = new URL(wsUrl);
    this.id = 0;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.sock = null;
  }

  open() {
    return new Promise((resolveOpen, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const sock = net.connect(Number(this.url.port), this.url.hostname);
      this.sock = sock;
      let upgraded = false;
      sock.on("connect", () => {
        sock.write(
          `GET ${this.url.pathname} HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      sock.on("error", reject);
      sock.on("close", () => {
        for (const fn of this.pending.values()) fn({ error: { message: "websocket closed" } });
        this.pending.clear();
      });
      sock.on("data", (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!upgraded) {
          const end = this.buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = this.buf.subarray(0, end).toString();
          if (!head.includes("101")) return reject(new Error(`WS 握手失败：${head.split("\r\n")[0]}`));
          this.buf = this.buf.subarray(end + 4);
          upgraded = true;
          resolveOpen();
        }
        this.drain();
      });
    });
  }

  drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const text = this.buf.subarray(off, off + len).toString("utf8");
      this.buf = this.buf.subarray(off + len);
      try {
        const msg = JSON.parse(text);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      } catch {
        /* 半帧/心跳：忽略 */
      }
    }
  }

  send(method, params) {
    return new Promise((resolveSend, reject) => {
      const id = ++this.id;
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolveSend(msg.result)));
      const payload = Buffer.from(JSON.stringify({ id, method, params }));
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      this.sock.write(Buffer.concat([header, mask, masked]));
    });
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
    return r?.result?.value;
  }

  close() {
    try {
      this.sock?.end();
    } catch {
      /* 已断开 */
    }
    this.sock = null;
  }
}

/**
 * 一个设备内 Host 的端点。
 *
 * 典型用法：
 * ```js
 * const host = new DeviceHostEndpoint({ sh, pkg, rpcPort: 18792, cdpPort: 9336 });
 * host.clearLogcat();          // 启动 APK 之前清一次，避免读到上一轮的 READY
 * ...启动 APK...
 * await host.ensureForward();  // 发现随机端口 + adb forward + 等 /healthz
 * const hello = await host.rpc("host.hello", { ... });
 * ```
 */
export class DeviceHostEndpoint {
  constructor(opts) {
    this.sh = opts.sh;
    this.pkg = opts.pkg;
    this.rpcPort = opts.rpcPort;
    this.cdpPort = opts.cdpPort;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.port = 0;
    this.stalePort = 0;
    this.cdp = null;
    /** 只删除自己建过的 forward：避免 `adb forward --remove` 对不存在的 listener 报错刷屏 */
    this.rpcForward = false;
    this.cdpForward = false;
  }

  /** 清空 logcat：重启/重装后旧 READY 行还在，会让发现逻辑读到上一轮的端口。 */
  clearLogcat() {
    try {
      this.sh("logcat", "-c");
    } catch {
      /* 部分 ROM 不允许清 logcat：靠 stalePort 兜底 */
    }
  }

  /** 从 logcat（HostSupervisor 的 "host ready port="）或 host.log 的 READY 行读端口。 */
  discoverPort() {
    try {
      const out = this.sh("logcat", "-d", "-s", "CodemHost:I", "-v", "brief");
      const hits = [...out.matchAll(/host ready port=(\d+)/g)];
      if (hits.length) return Number(hits[hits.length - 1][1]);
    } catch {
      /* logcat 不可用：退回文件 */
    }
    try {
      // 先确认文件存在：直接 cat 会在首启/`pm clear` 后每秒打印一次 "No such file"
      this.sh("shell", "run-as", this.pkg, "test", "-f", "files/host.log");
      const out = this.sh("shell", "run-as", this.pkg, "cat", "files/host.log");
      const hits = [...out.matchAll(/"port":(\d+)/g)];
      if (hits.length) return Number(hits[hits.length - 1][1]);
    } catch {
      /* 非 debuggable 构建 / 文件还没写 */
    }
    return 0;
  }

  async waitForPort() {
    const deadline = Date.now() + this.timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const port = this.discoverPort();
        // 重启后日志里仍有旧 READY 行：必须等一个不同于旧端口的值（随机端口 ⇒ 几乎不会相同）
        if (port && port !== this.stalePort) return port;
      } catch (e) {
        last = String(e?.message ?? e);
      }
      await sleep(1000);
    }
    throw new Error(`等待超时：发现本机 Host 随机端口${last ? `（${last}）` : ""}`);
  }

  /** 建立到当前端口的 adb forward，并等 `/healthz` 匿名就绪。 */
  async ensureForward() {
    if (!this.port) this.port = await this.waitForPort();
    if (this.rpcForward) {
      try {
        this.sh("forward", "--remove", `tcp:${this.rpcPort}`);
      } catch {
        /* 没有旧 forward 时 adb 会报错，不是失败 */
      }
      this.rpcForward = false;
    }
    this.sh("forward", `tcp:${this.rpcPort}`, `tcp:${this.port}`);
    this.rpcForward = true;
    return this.waitHealth();
  }

  async waitHealth() {
    const deadline = Date.now() + 60_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.rpcPort}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return await res.json();
        last = `status=${res.status}`;
      } catch (e) {
        last = String(e?.message ?? e);
      }
      await sleep(500);
    }
    throw new Error(`等待超时：Host /healthz${last ? `（${last}）` : ""}`);
  }

  /** Host 进程换掉后（force-stop / 重启）端点与 CDP 都失效：先清空，再让后续调用重新发现。 */
  reset() {
    this.stalePort = this.port;
    this.port = 0;
    this.closeCdp();
  }

  closeCdp() {
    this.cdp?.close();
    this.cdp = null;
    if (!this.cdpForward) return;
    try {
      this.sh("forward", "--remove", `tcp:${this.cdpPort}`);
    } catch {
      /* 未建立 */
    }
    this.cdpForward = false;
  }

  /**
   * 连到本应用当前 WebView 的 CDP。
   *
   * `/proc/net/unix` 里通常不止一条 `webview_devtools_remote_*`：别的应用、旧进程残留
   * 都可能出现。先按本应用 pid 挑，再逐条 forward + 探测 `/json/list`，能列出页面才留下。
   */
  async connectCdp() {
    if (this.cdp) return this.cdp;
    await this.ensureForward();
    const deadline = Date.now() + this.timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      let candidates = [];
      try {
        candidates = devtoolsCandidates(this.sh, this.pkg);
      } catch (e) {
        last = String(e?.message ?? e);
      }
      for (const pid of candidates) {
        const socket = `webview_devtools_remote_${pid}`;
        if (this.cdpForward) {
          try {
            this.sh("forward", "--remove", `tcp:${this.cdpPort}`);
          } catch {
            /* 未建立 */
          }
          this.cdpForward = false;
        }
        try {
          this.sh("forward", `tcp:${this.cdpPort}`, `localabstract:${socket}`);
          this.cdpForward = true;
          const list = await fetchJson(`http://127.0.0.1:${this.cdpPort}/json/list`, 2000);
          const target = Array.isArray(list)
            ? (list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? list.find((t) => t.webSocketDebuggerUrl))
            : null;
          if (target?.webSocketDebuggerUrl) {
            const cdp = new Cdp(target.webSocketDebuggerUrl);
            await cdp.open();
            this.cdp = cdp;
            return cdp;
          }
        } catch (e) {
          last = String(e?.message ?? e);
        }
      }
      await sleep(1000);
    }
    throw new Error(`等待超时：WebView CDP${last ? `（${last}）` : ""}`);
  }

  /**
   * 在**页面上下文**里发 JSON-RPC。
   *
   * 为什么不用 Node 的 fetch：`local-auth` 的凭据是 HttpOnly cookie，只有页面同源请求
   * 才会自动携带；让页面发请求就不需要把凭据搬进 Node（更不会打印）。
   */
  async rpc(method, params) {
    const cdp = await this.connectCdp();
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const expression =
      `(async () => {\n` +
      `  const res = await fetch("/rpc", {\n` +
      `    method: "POST",\n` +
      `    credentials: "same-origin",\n` +
      `    headers: { "content-type": "application/json" },\n` +
      `    body: ${JSON.stringify(payload)},\n` +
      `  });\n` +
      `  return await res.json();\n` +
      `})()`;
    return cdp.eval(expression);
  }

  /** 在页面上下文里求值（spike 的 UI 操作/断言用）。 */
  async evalPage(expression) {
    const cdp = await this.connectCdp();
    return cdp.eval(expression);
  }

  close() {
    this.closeCdp();
    if (!this.rpcForward) return;
    try {
      this.sh("forward", "--remove", `tcp:${this.rpcPort}`);
    } catch {
      /* 已移除 */
    }
    this.rpcForward = false;
  }
}

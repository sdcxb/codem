#!/usr/bin/env node
/**
 * 真机操作用例（Android x86_64 模拟器）——按 `docs/architecture/ANDROID-DEVICE-TEST-CASES.md` 逐条执行。
 *
 * 操作方式：
 * - 应用级操作（安装/启动/force-stop/深链/截图/logcat）走 adb；
 * - 页面级操作（新建会话/输入/发送/审批/继续）走 **WebView CDP**（真实设备里的真实 DOM 事件），
 *   不走 RPC 代替用户点击；RPC 只用于**核对** Host 状态（会话/运行），不代替操作。
 *
 * 判据全部是「设备上真的发生了」：DOM 文本、运行状态、重启后的会话列表、崩溃缓冲。
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "";
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const apk = process.env.CODEM_SHELL_APK ?? join(here, "build", "codem-shell-x86_64.apk");
const pkg = "com.codem.remote";
const RPC_PORT = 18794;
const CDP_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/*
 * 本机 Host 现在用**随机端口 + 每次启动随机凭据**（Android 外壳生成）：
 * - 端口从 logcat / files/host.log 的 READY 行发现（都不是秘密）；
 * - 凭据只从页面 sessionStorage 读一次，用来换一个 cookie，仅存在本进程内存里。
 * **任何输出/报告都不打印凭据**（下面的日志只出现端口）。
 */
const host = { port: 0, token: "", cookie: "" };
/**
 * 上一次已知的端口：重启后 logcat / host.log 里仍然有旧的 READY 行，
 * 发现端口时必须等一个新的（随机端口 ⇒ 新旧几乎不可能相同）。
 */
let stalePort = 0;
/** WebView CDP 客户端（模块级：换取凭据要在 rpc() 里用到） */
let cdp = null;

/** 发现本机 Host 的随机端口：优先 logcat（HostSupervisor 的 "host ready port="），再退回 host.log */
function discoverHostPort() {
  try {
    const out = sh("logcat", "-d", "-s", "CodemHost:I", "-v", "brief");
    const hits = [...out.matchAll(/host ready port=(\d+)/g)];
    if (hits.length) return Number(hits[hits.length - 1][1]);
  } catch {
    /* logcat 不可用：退回文件 */
  }
  try {
    const out = sh("shell", "run-as", pkg, "cat", "files/host.log");
    const hits = [...out.matchAll(/"port":(\d+)/g)];
    if (hits.length) return Number(hits[hits.length - 1][1]);
  } catch {
    /* 非 debuggable 构建 / 文件还没写 */
  }
  return 0;
}

/** 建立（或重建）到**当前**端口的 adb forward；首次调用会等端口出现 */
async function ensureHostForward() {
  if (!host.port) {
    host.port = await waitUntil(
      async () => {
        const port = discoverHostPort();
        // 重启后日志里还有旧 READY 行：必须等到一个**不同于旧端口**的值
        return port && port !== stalePort ? port : null;
      },
      120_000,
      "发现本机 Host 随机端口",
    );
  }
  try {
    sh("forward", "--remove", `tcp:${RPC_PORT}`);
  } catch {
    /* 没有旧 forward 时 adb 会报错，不是失败 */
  }
  sh("forward", `tcp:${RPC_PORT}`, `tcp:${host.port}`);
}

/** Host 进程换掉后（force-stop / 重启）端点与凭据都失效：先清空，再让后续调用重新发现。 */
function resetHostEndpoint() {
  stalePort = host.port;
  host.port = 0;
  host.token = "";
  host.cookie = "";
}

/**
 * 用页面里的本机凭据换 cookie（只为 Node 侧核对用；页面自己用 SSE 时也走同一端点）。
 * 顺序：先确保 CDP 已连上（凭据只在 sessionStorage 里），再 POST /local-auth。
 */
async function ensureRpcAuth() {
  await ensureHostForward();
  if (host.cookie) return;
  host.token = await waitUntil(
    async () => {
      if (!cdp) return null;
      const value = await cdp.eval("sessionStorage.getItem('codem.localAuth') || ''").catch(() => "");
      return /^[0-9a-f]{64}$/.test(String(value)) ? String(value) : null;
    },
    120_000,
    "页面里的本机凭据（sessionStorage）",
  );
  const res = await fetch(`http://127.0.0.1:${RPC_PORT}/local-auth`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}` },
  });
  if (res.status !== 204) throw new Error(`/local-auth 未通过（status=${res.status}）`);
  // 只取 "name=value" 段：属性（Path/HttpOnly/…）不能当 Cookie 头发出去
  host.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!host.cookie) throw new Error("/local-auth 没有回 cookie");
}

async function rpc(method, params) {
  await ensureRpcAuth();
  const res = await fetch(`http://127.0.0.1:${RPC_PORT}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: host.cookie },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function startProvider() {
  const state = { requests: [], lastCallId: null };
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions") || req.method !== "POST") {
      res.writeHead(404).end("not found");
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* 空体 */
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      state.requests.push(messages);
      // 请求尾部还会追加合成 user（执行计划 / context / system-reminder），要跳过它们找真正的用户输入
      const realUser = [...messages]
        .reverse()
        .find(
          (m) =>
            m?.role === "user" &&
            !/^(当前执行计划|<system-reminder>|\[Context:)/.test(String(m.content ?? "")),
        );
      const userText = String(realUser?.content ?? "");
      // 协议事实：工具结果之后还会追加合成的 user 提醒，所以不能看"最后一条"。
      // 用**本次发出的 tool_call id** 是否已回传来判断，跨轮也不会误判。
      const toolDone = Boolean(state.lastCallId) && messages.some((m) => m?.tool_call_id === state.lastCallId);
      const wantsBash = /bash/i.test(userText);
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ id: "dev", model: "mock", choices: [{ index: 0, delta: { role: "assistant" } }] });
      if (/ATTACHMENT_MARKER/.test(userText)) {
        send({ id: "dev", model: "mock", choices: [{ index: 0, delta: { content: "ATTACHMENT_OK" } }] });
        send({ id: "dev", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else if (toolDone) {
        send({ id: "dev", model: "mock", choices: [{ index: 0, delta: { content: "DEVICE_DONE" } }] });
        send({ id: "dev", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else if (wantsBash) {
        send({
          id: "dev",
          model: "mock",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: (state.lastCallId = `call_bash_${Date.now()}`),
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command: "echo DEVICE_OK" }) },
                  },
                ],
              },
            },
          ],
        });
        send({ id: "dev", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({
          id: "dev",
          model: "mock",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: (state.lastCallId = `call_glob_${Date.now()}`),
                    type: "function",
                    function: { name: "glob", arguments: JSON.stringify({ pattern: "*" }) },
                  },
                ],
              },
            },
          ],
        });
        send({ id: "dev", model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((x) => server.close(x)), state }));
  });
}

/** 最小 CDP 客户端（WebView devtools 的 WebSocket） */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = new URL(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.sock = null;
  }
  static async connect() {
    const deadline = Date.now() + 120_000;
    let list = null;
    while (Date.now() < deadline) {
      try {
        list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        if (Array.isArray(list) && list[0]?.webSocketDebuggerUrl) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(1000);
    }
    if (!list?.[0]?.webSocketDebuggerUrl) throw new Error("WebView CDP 未就绪");
    const c = new Cdp(list[0].webSocketDebuggerUrl);
    await c.open();
    return c;
  }
  open() {
    return new Promise((resolvePromise, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const sock = net.connect(Number(this.wsUrl.port), this.wsUrl.hostname);
      this.sock = sock;
      let upgraded = false;
      sock.on("connect", () => {
        sock.write(
          `GET ${this.wsUrl.pathname} HTTP/1.1\r\nHost: ${this.wsUrl.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      sock.on("error", reject);
      sock.on("data", (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!upgraded) {
          const end = this.buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = this.buf.subarray(0, end).toString();
          if (!head.includes("101")) return reject(new Error(`WS 握手失败：${head.split("\r\n")[0]}`));
          this.buf = this.buf.subarray(end + 4);
          upgraded = true;
          resolvePromise();
        }
        this.drain();
      });
    });
  }
  drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
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
        /* ignore */
      }
    }
  }
  send(method, params) {
    return new Promise((resolvePromise, reject) => {
      const id = ++this.id;
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolvePromise(msg.result)));
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
    const r = await Promise.race([
      this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("CDP evaluate 超时（WebView 可能已后台/失去响应）")), 15_000)),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result?.value;
  }
}

const cases = [];
function check(id, title, ok, detail) {
  cases.push({ id, title, ok: Boolean(ok), ...(detail ? { detail } : {}) });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${id} ${title}${detail ? ` — ${detail}` : ""}\n`);
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = String(e?.message ?? e);
    }
    await sleep(700);
  }
  throw new Error(`等待超时：${label}${lastErr ? `（${lastErr}）` : ""}`);
}

/** 在页面里填输入框并点发送：等 React 把按钮变为可用再点，避免"点了但没发" */
async function typeAndSend(cdp, text) {
  await cdp.eval(
    "(() => { const t=document.querySelector('textarea'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t," +
      JSON.stringify(text) +
      "); t.dispatchEvent(new Event('input',{bubbles:true})); return t.value; })()",
  );
  await waitUntil(
    async () => await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='发送'); return Boolean(b && !b.disabled); })()"),
    10_000,
    "发送按钮可用",
  );
  await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='发送'); b.click(); return true; })()");
}

/**
 * 把 CDP 端口转发到**本应用当前 WebView** 的 devtools socket。
 *
 * `/proc/net/unix` 里通常不止一条 `webview_devtools_remote_*`（设备上别的应用也会开 WebView，
 * 旧进程被杀的残留 socket 也可能还在）。早先取第一条匹配 ⇒ 端口转到死 socket，`/json/list`
 * 一直超时（实测就踩到过：socket 1487 是别家的，本应用是 2728）。
 * 所以先按本应用进程号挑，再逐条探测，只有真的能列出页面的才留下。
 */
async function forwardCdp() {
  const unix = sh("shell", "cat", "/proc/net/unix");
  const candidates = [...unix.matchAll(/webview_devtools_remote_(\d+)/g)].map((m) => m[1]);
  if (!candidates.length) throw new Error("没有 WebView devtools socket");
  const ownPids = new Set(
    sh("shell", "pidof", pkg)
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  const ordered = [
    ...candidates.filter((pid) => ownPids.has(pid)),
    ...candidates.filter((pid) => !ownPids.has(pid)),
  ];
  for (const pid of ordered) {
    try {
      sh("forward", "--remove", `tcp:${CDP_PORT}`);
    } catch {
      /* 未建立 */
    }
    sh("forward", `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: controller.signal })).json();
      if (Array.isArray(list) && list.length) return;
    } catch {
      /* 死 socket：换下一条 */
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `没有可用的 WebView devtools socket（候选 ${candidates.join("/")}；本应用进程 ${[...ownPids].join("/") || "无"}）`,
  );
}

async function main() {
  const summary = { spike: "android-device-cases", cases };
  const provider = await startProvider();
  const mockForDevice = provider.url.replace("127.0.0.1", "10.0.2.2");
  try {
    try {
      sh("logcat", "-b", "crash", "-c");
    } catch {
      /* 旧版本可能不支持 */
    }
    // 清掉旧 logcat：否则可能发现上一轮 Host 的端口（随机端口后这条更关键）
    try {
      sh("logcat", "-c");
    } catch {
      /* 部分 ROM 不允许 */
    }
    sh("install", "-r", apk);
    /*
     * 配置类 extras（llmBase/llmModel/llmKey）现在**只在 debuggable 构建生效**
     * （release 里任意 App 都能用它们把已保存的 Key 送去自己的地址）。
     * 装错包时这里直接报清楚，而不是跑出一个"模型没配置"的假失败。
     */
    const pkgDump = sh("shell", "dumpsys", "package", pkg);
    if (!/DEBUGGABLE/.test(pkgDump)) {
      throw new Error(
        "当前安装的 APK 不是 debuggable 构建，配置类 extras 会被忽略。\n" +
          "请先：node android-shell/build.mjs --abi x86_64 --debug --out codem-shell-x86_64-debug.apk\n" +
          "再： $env:CODEM_SHELL_APK = \"$PWD\\android-shell\\build\\codem-shell-x86_64-debug.apk\"",
      );
    }
    sh("shell", "am", "force-stop", pkg);
    sh("shell", "pm", "clear", pkg);
    sh("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "llmBase", mockForDevice, "--es", "llmModel", "mock", "--ez", "webviewDebug", "true");
    await ensureHostForward();

    // DC-1 冷启动：Host 就绪（/healthz 匿名且只报 hostId/pid；端口是随机发现的）
    const health = await waitUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${RPC_PORT}/healthz`);
        const body = await res.json();
        return res.status === 200 && body?.ok ? body : null;
      } catch {
        return null;
      }
    }, 180_000, "冷启动 Host READY");
    check("DC-1", "安装后冷启动，设备内 Host 就绪（端口非 8787、随机）", Boolean(health?.hostId) && host.port !== 8787, `${health?.hostId} port=${host.port}`);

    // DC-2 共享 UI 加载
    await forwardCdp();
    cdp = await Cdp.connect();
    const title = await waitUntil(async () => {
      const t = await cdp.eval("document.title");
      return t && t.length ? t : null;
    }, 120_000, "WebView 页面加载");
    const body = await waitUntil(async () => {
      const txt = await cdp.eval("document.body.innerText");
      return String(txt).includes("新建会话") ? txt : null;
    }, 60_000, "共享 UI 渲染（新建会话入口）");
    check("DC-2", "WebView 加载共享 UI（标题 + 新建会话入口）", String(body).includes("新建会话"), `title=${title}`);

    // DC-3 页面点「新建会话」
    const before = (await rpc("session.list", {})).result?.items?.length ?? 0;
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('新建会话')); if(!b) return false; b.click(); return true; })()`);
    const sessionId = await waitUntil(async () => {
      const list = (await rpc("session.list", {})).result?.items ?? [];
      return list.length > before ? list[0]?.id : null;
    }, 30_000, "新建会话落库");
    check("DC-3", "页面点「新建会话」→ Host 真的多一条会话", Boolean(sessionId), `count ${before}→${before + 1}`);

    // DC-4 页面输入并发送，真实跑完一轮（glob 工具 + 最终文本）
    await waitUntil(async () => ((await cdp.eval("document.querySelectorAll('textarea').length")) ?? 0) > 0, 30_000, "输入框出现");
    await typeAndSend(cdp, "hello device");
    await waitUntil(async () => {
      const d = await rpc("host.diagnostics", {});
      const run = (d.result?.runs ?? []).find((r) => r.sessionId === sessionId);
      return run && run.state === "succeeded" ? run : null;
    }, 120_000, "第一轮跑完");
    // 行落库后 UI 还会 refresh 一次：等正文/工具名出现再断言，避免与刷新竞态
    const bodyAfterTurn = await waitUntil(async () => {
      const t = String(await cdp.eval("document.body.innerText"));
      return t.includes("DEVICE_DONE") && /glob/i.test(t) ? t : null;
    }, 30_000, "工具卡与最终回答出现");
    check("DC-4", "页面输入并发送 → 真跑一轮（工具卡 + 最终回答）", String(bodyAfterTurn).includes("DEVICE_DONE") && /glob/i.test(String(bodyAfterTurn)), "含 DEVICE_DONE + glob");

    // DC-5 审批卡：bash 工具 → 点「批准」→ 命令真的执行
    await waitUntil(async () => ((await cdp.eval("document.querySelectorAll('textarea').length")) ?? 0) > 0, 30_000, "输入框出现（审批轮）");
    await typeAndSend(cdp, "please run bash");
    const approvalText = await waitUntil(async () => {
      // 第 3 步：审批卡与桌面共用一张卡，根类名是 `.decision-tray`（旧手机卡 `.approval` 已删）
      const txt = await cdp.eval("document.querySelector('.decision-tray') ? document.querySelector('.decision-tray').innerText : ''");
      return txt && txt.includes("bash") ? txt : null;
    }, 60_000, "审批卡出现");
    check("DC-5a", "bash 工具触发审批卡（页面可见命令）", approvalText.includes("echo DEVICE_OK") && approvalText.includes("bash"));
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('.decision-tray button')].find(x=>x.textContent.includes('批准')); if(!b) return false; b.click(); return true; })()`);
    await waitUntil(async () => {
      const d = await rpc("host.diagnostics", {});
      const run = (d.result?.runs ?? []).find((r) => r.sessionId === sessionId);
      return run && run.state === "succeeded" ? run : null;
    }, 120_000, "审批后跑完");
    // 统一工具卡默认折叠：结果文本不再常显在 DOM，改为从 Host 落库的工具消息取真相
    const afterMsgs = (await rpc("session.get", { sessionId })).result?.messages ?? [];
    const toolText = afterMsgs.filter((m) => m.role === "tool").map((m) => String(m.content ?? "")).join("\n");
    check("DC-5b", "点「批准」→ 命令在设备工作区真的执行（exit 0）", /\(exit 0\b/.test(toolText) && !/cannot open shared object/.test(toolText));
    check("DC-5c", "审批卡在答复后消失", !(await cdp.eval("!!document.querySelector('.decision-tray')")));

    // DC-6 一键继续（不自动续跑）
    const continueVisible = await waitUntil(async () => {
      const txt = await cdp.eval("document.body.innerText");
      return String(txt).includes("继续") ? true : null;
    }, 30_000, "继续按钮出现");
    check("DC-6a", "上一轮结束后出现「继续」", Boolean(continueVisible));
    const diagBefore = await rpc("host.diagnostics", {});
    const runBefore = (diagBefore.result?.runs ?? []).find((r) => r.sessionId === sessionId);
    const prevRunId = runBefore?.runId ?? null;
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='继续'); if(!b) return false; b.click(); return true; })()`);
    const continued = await waitUntil(async () => {
      const d = await rpc("host.diagnostics", {});
      const run = (d.result?.runs ?? []).find((r) => r.sessionId === sessionId);
      return run && run.runId !== prevRunId && run.state === "succeeded" ? run : null;
    }, 120_000, "继续后跑完");
    check("DC-6b", "点「继续」才发下一轮（未自动续跑）", Boolean(continued), `${prevRunId} → ${continued?.runId}`);

    // DC-7 深链聚焦会话
    const sessions = (await rpc("session.list", {})).result?.items ?? [];
    const current = sessions.find((s) => s.id === sessionId);
    // 刻意保留旧 8787：DC-7 同时证明 MainActivity 会把升级前的 loopback 深链重写到当前随机端口。
    // 不要改成 host.port —— 那会让"旧深链仍可打开"这条兼容保证失去判据。
    sh("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "url", `http://127.0.0.1:8787/?open=${sessionId}`);
    const headerOk = await waitUntil(async () => {
      const txt = await cdp.eval("document.body.innerText");
      return String(txt).includes(String(current?.title ?? "")) ? true : null;
    }, 30_000, "深链打开会话");
    check("DC-7", "深链打开指定会话（标题可见）", Boolean(headerOk), String(current?.title ?? ""));

    const png1 = execFileSync(adb, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(here, "..", "docs", "architecture", "evidence", "device-cases-final.png"), png1);

    // DC-8 杀进程重启：数据还在（端口/凭据都会轮换 ⇒ 重新发现端口、重连 CDP、重新换 cookie）
    sh("shell", "am", "force-stop", pkg);
    await sleep(3000);
    sh("shell", "am", "start", "-n", `${pkg}/.MainActivity`, "--es", "llmBase", mockForDevice, "--es", "llmModel", "mock", "--ez", "webviewDebug", "true");
    resetHostEndpoint();
    await ensureHostForward();
    // WebView 进程也换了：devtools socket 名带 pid，必须重新 forward + 重新连接
    await forwardCdp();
    cdp = await Cdp.connect();
    const hello2 = await waitUntil(async () => {
      try {
        const r = await rpc("host.hello", { protocolVersion: 1, client: { name: "dc2", version: "0", platform: "node" } });
        return r.result?.hostId ? r.result : null;
      } catch {
        return null;
      }
    }, 180_000, "重启后 Host READY");
    const list2 = (await rpc("session.list", {})).result?.items ?? [];
    check("DC-8", "force-stop 重启后会话仍在（持久化）", list2.some((s) => s.id === sessionId), `sessions=${list2.length}`);

    // DC-14 附件：上传 → prompt 引用 → 模型收到 → 工作区落地
    const b64 = Buffer.from("ATTACHMENT_MARKER: 设备附件内容", "utf8").toString("base64");
    const put = await rpc("attachment.put", { name: "note.txt", mimeType: "text/plain", base64: b64 });
    const attSession = (await rpc("session.create", { title: "附件测试" })).result.session.id;
    const attRun = await rpc("prompt.send", {
      sessionId: attSession,
      text: "请确认附件 ATTACHMENT_MARKER",
      attachmentIds: [put.result.attachmentId],
      requestId: "att-1",
    });
    await waitUntil(async () => {
      const d = await rpc("host.diagnostics", {});
      const r = (d.result?.runs ?? []).find((x) => x.runId === attRun.result.runId);
      return r && r.state !== "running";
    }, 60_000, "附件回合结束");
    const attMsgs = (await rpc("session.get", { sessionId: attSession })).result?.messages ?? [];
    const attOk = attMsgs.some((m) => m.role === "assistant" && String(m.content).includes("ATTACHMENT_OK"));
    const wsList = await rpc("workspace.list", {});
    const copied = (wsList.result?.entries ?? []).some((e) => e.name === ".codem-attachments");
    check("DC-14", "附件上传→引用→模型收到→工作区落地", Boolean(put.result?.attachmentId) && attOk && copied, `att=${put.result?.attachmentId}`);

    // CDP 与端口已在 DC-8 重启后重新接线（这里只等页面恢复，避免再开一条重复连接）
    await waitUntil(async () => {
      const txt = await cdp.eval("document.body.innerText");
      return String(txt).includes("新建会话") || String(txt).includes("文件") ? txt : null;
    }, 120_000, "重启后页面恢复");

    // DC-11 文件浏览/预览（P1 功能在真机 UI 上可用）
    await cdp.eval("(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='文件'); if(!b) return false; b.click(); return true; })()");
    await waitUntil(async () => {
      const txt = await cdp.eval("document.body.innerText");
      return String(txt).includes("ui.js") || String(txt).includes("index.html");
    }, 30_000, "文件列表出现");
    await cdp.eval("(() => { const b=[...document.querySelectorAll('.file-browser:not(.inline) .file-entry')].find(x=>x.textContent.includes('index.html')); if(!b) return false; b.click(); return true; })()");
    const previewOk = await waitUntil(async () => {
      const txt = await cdp.eval("document.querySelector('.file-browser:not(.inline) .file-browser-preview')?.innerText ?? ''");
      return String(txt).toLowerCase().includes("<html") || String(txt).toLowerCase().includes("<!doctype") ? txt : null;
    }, 30_000, "文件预览出现");
    check("DC-11", "文件浏览 + 只读预览（设备 UI）", Boolean(previewOk));
    await cdp.eval("(() => { const b=[...document.querySelectorAll('.file-browser:not(.inline) button')].find(x=>x.textContent.trim()==='关闭'); if(b) b.click(); return true; })()");
    await sleep(500);

    // DC-12 宽屏双列：用 CDP 改视口宽度，侧栏与对话应同时可见
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const wide = await cdp.eval("JSON.stringify({sidebar:getComputedStyle(document.querySelector('.sidebar')).display,chat:getComputedStyle(document.querySelector('.chat-pane')).display})");
    summary.wide = wide;
    const w = JSON.parse(wide);
    check("DC-12", "宽屏（900px）双列：侧栏与对话同时可见", w.sidebar !== "none" && w.chat !== "none", wide);

    // DC-15 手机窄屏（599px）行为不变：未选会话看列表、聊天区不占位、没有折叠入口
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 599, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    /* 前置归位：前面的用例可能留下一个已选会话；窄屏首屏要测的是「未选会话」形态 */
    const leftSession = await cdp.eval("document.querySelector('.layout')?.classList.contains('in-session') || false");
    if (leftSession) {
      await cdp.eval("(() => { const b=document.querySelector('.back-button'); if(!b) return false; b.click(); return true; })()");
      await sleep(500);
    }
    const narrow = await cdp.eval(`(() => {
      const layout = document.querySelector('.layout');
      const sidebar = document.querySelector('.sidebar');
      const chat = document.querySelector('.chat-pane');
      const toggle = document.querySelector('.sidebar-collapse-toggle');
      return JSON.stringify({
        sidebar: sidebar ? getComputedStyle(sidebar).display : 'absent',
        chat: chat ? getComputedStyle(chat).display : 'absent',
        toggle: toggle ? getComputedStyle(toggle).display : 'absent',
        inSession: Boolean(layout && layout.classList.contains('in-session')),
      });
    })()`);
    summary.narrow = narrow;
    const nw = JSON.parse(narrow);
    check(
      "DC-15",
      "599px 窄屏行为不变：未选会话看列表、无折叠入口",
      nw.sidebar === "flex" && nw.chat === "none" && nw.toggle === "absent" && nw.inSession === false,
      narrow,
    );

    // DC-16 平板 900px：会话列表可折叠（只影响 ≥600 的侧栏，折叠不改 DOM）
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const sessionPicked = await cdp.eval("(() => { const b=document.querySelector('.session-list .session'); if(!b) return false; b.click(); return true; })()");
    await waitUntil(async () => {
      const v = await cdp.eval("document.querySelector('.layout')?.classList.contains('in-session') || false");
      return v ? true : null;
    }, 20_000, "进入会话（折叠用例前置）");
    const toggleLabel = await waitUntil(async () => {
      const v = await cdp.eval(`(() => {
        const b = document.querySelector('.sidebar-collapse-toggle');
        if (!b || getComputedStyle(b).display === 'none') return null;
        return b.textContent.trim();
      })()`);
      return v ? String(v) : null;
    }, 10_000, "平板出现折叠按钮");
    check("DC-16a", "900px 下出现「收起列表」按钮", sessionPicked === true && String(toggleLabel) === "收起列表", `${sessionPicked} ${toggleLabel}`);
    await cdp.eval("(() => { const b=document.querySelector('.sidebar-collapse-toggle'); if(!b) return false; b.click(); return true; })()");
    await waitUntil(async () => {
      const v = await cdp.eval("getComputedStyle(document.querySelector('.sidebar')).display === 'none' ? true : null");
      return v ? true : null;
    }, 10_000, "侧栏收起");
    const folded = await cdp.eval(`JSON.stringify({
      sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
      layout: document.querySelector('.layout').className,
      text: document.querySelector('.sidebar-collapse-toggle').textContent.trim(),
      listStillRendered: Boolean(document.querySelector('#session-sidebar .session-list')),
    })`);
    summary.folded = folded;
    const f = JSON.parse(folded);
    check(
      "DC-16b",
      "收起后侧栏不可见（display:none）且列表仍在 DOM（不丢滚动/搜索）",
      f.sidebar === "none" && f.layout.includes("sidebar-collapsed") && f.text === "列表" && f.listStillRendered === true,
      folded,
    );
    await cdp.eval("(() => { const b=document.querySelector('.sidebar-collapse-toggle'); if(!b) return false; b.click(); return true; })()");
    await waitUntil(async () => {
      const v = await cdp.eval("getComputedStyle(document.querySelector('.sidebar')).display !== 'none' ? true : null");
      return v ? true : null;
    }, 10_000, "侧栏恢复");
    const unfolded = await cdp.eval("JSON.stringify({sidebar:getComputedStyle(document.querySelector('.sidebar')).display,layout:document.querySelector('.layout').className})");
    summary.unfolded = unfolded;
    const uf = JSON.parse(unfolded);
    check("DC-16c", "再点「列表」恢复侧栏（类名回退）", uf.sidebar !== "none" && !uf.layout.includes("sidebar-collapsed"), unfolded);

    // DC-16d 行内会话下回到 599px：折叠按钮不可见（手机窄屏不受影响）
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 599, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const narrowSession = await cdp.eval("(() => { const t=document.querySelector('.sidebar-collapse-toggle'); const l=document.querySelector('.layout'); return JSON.stringify({toggle: t ? getComputedStyle(t).display : 'absent', inSession: Boolean(l && l.classList.contains('in-session'))}); })()");
    summary.narrowSession = narrowSession;
    const ns = JSON.parse(narrowSession);
    check("DC-16d", "599px 行内会话：折叠按钮不出现", ns.inSession === true && (ns.toggle === "none" || ns.toggle === "absent"), narrowSession);

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
    // 第三列的行与桌面文件树是同一个组件（`.file-entry`，共享包 file-tree-view.tsx）。
    // 页签断言是必须的：C 之后「隐藏面板里的行仍在 DOM」，只数行会在 diff 页签激活时**假通过**。
    const third = await cdp.eval(`JSON.stringify({
      detail: getComputedStyle(document.querySelector('.detail-pane')).display,
      rows: document.querySelectorAll('#detail-panel-files .file-entry').length,
      tab: document.querySelector('.detail-pane [role="tab"][aria-selected="true"]')?.textContent ?? '',
    })`);
    summary.third = third;
    const t3 = JSON.parse(third);
    check(
      "DC-13",
      "宽屏（1200px）三列：第三列文件预览可见且有内容，默认停在「文件」页签",
      t3.detail !== "none" && t3.rows > 0 && t3.tab === "文件",
      third,
    );

    // DC-17 宽屏第三列可切换：文件 / 当前选中文件的 diff
    const picked = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('#detail-panel-files .file-entry.file')];
      const row = rows.find((r) => r.textContent.includes('index.html')) || rows[0];
      if (!row) return false;
      row.click();
      return true;
    })()`);
    await waitUntil(async () => {
      const txt = await cdp.eval("document.querySelector('#detail-panel-files .file-browser-preview')?.innerText ?? ''");
      return String(txt).length > 0 ? true : null;
    }, 20_000, "第三列预览出现（选中文件）");
    await cdp.eval("(() => { const b=document.querySelector('#detail-tab-diff'); if(!b) return false; b.click(); return true; })()");
    const diffPane = await waitUntil(async () => {
      const v = await cdp.eval(`(() => {
        const p = document.querySelector('#detail-panel-diff');
        const files = document.querySelector('#detail-panel-files');
        if (!p || p.hidden) return null;
        const txt = (p.innerText || '').trim();
        /* 等「加载中」过去再取样：否则会把 读取中… 当成 diff 内容（假通过/假失败都来过一次） */
        if (!txt || txt.includes('读取中')) return null;
        return JSON.stringify({
          filesHidden: Boolean(files && files.hidden),
          path: document.querySelector('#detail-panel-diff .file-browser-path')?.textContent ?? '',
          text: txt.slice(0, 300),
        });
      })()`);
      return v ? String(v) : null;
    }, 20_000, "差异面板出现内容");
    summary.diffPane = diffPane;
    const dp = JSON.parse(diffPane);
    const diffKnown = /(\+\+\+|---|@@)/.test(dp.text) || dp.text.includes("不是 git 仓库") || dp.text.includes("没有未提交的改动");
    check(
      "DC-17a",
      "切到「差异」：显示当前选中文件的 diff（或明确的非 git/无改动态）",
      picked === true && dp.filesHidden === true && dp.path.length > 0 && diffKnown,
      `${dp.path} :: ${dp.text.slice(0, 120)}`,
    );
    // 清空选择（返回上一层）⇒ 差异页签回到「先选文件」空态，而不是留着上一次的 diff
    const cleared = await cdp.eval("(() => { const b=document.querySelector('#detail-panel-files .file-browser-back'); if(!b) return false; b.click(); return true; })()");
    const emptyState = await waitUntil(async () => {
      const v = await cdp.eval("document.querySelector('#detail-panel-diff')?.innerText ?? ''");
      return String(v).includes("先在「文件」里选一个文件") ? String(v) : null;
    }, 10_000, "无选中文件的差异空态");
    check(
      "DC-17b",
      "清空选择后「差异」给明确空态（不留上一次 diff）",
      cleared === true && Boolean(emptyState) && !String(emptyState).includes("不是 git 仓库"),
      String(emptyState).slice(0, 120),
    );
    await cdp.eval("(() => { const b=[...document.querySelectorAll('#detail-panel-diff button')].find((x) => x.textContent.trim() === '去选择'); if(!b) return false; b.click(); return true; })()");
    await sleep(400);
    const backToFiles = await cdp.eval("document.querySelector('#detail-tab-files')?.getAttribute('aria-selected') ?? ''");
    check("DC-17c", "空态「去选择」回到文件页签", backToFiles === "true", backToFiles);

    // DC-18 第三列「变更」页签：只读、无回滚、空态/列表都不假装
    await cdp.eval("(() => { const b=document.querySelector('#detail-tab-changes'); if(!b) return false; b.click(); return true; })()");
    await sleep(1500);
    const changes = await cdp.eval("JSON.stringify({tab:document.querySelector('#detail-tab-changes')?.getAttribute('aria-selected'),panel:document.querySelector('#detail-panel-changes')?.innerText.slice(0,200),revert:[...document.querySelectorAll('#detail-panel-changes button')].some(b=>b.textContent.includes('回滚'))})");
    const ch = JSON.parse(changes);
    check("DC-18", "「变更」页签只读：有内容/空态，且无回滚按钮", ch.tab === "true" && String(ch.panel).length > 0 && ch.revert === false, changes);

    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await sleep(400);

    // DC-10 退到后台：前台服务 + 唤醒锁让 Host 继续活着
    sh("shell", "input", "keyevent", "KEYCODE_HOME");
    await sleep(8000);
    const alive = await rpc("host.hello", { protocolVersion: 1, client: { name: "bg", version: "0", platform: "node" } });
    const services = sh("shell", "dumpsys", "activity", "services", pkg);
    check("DC-10", "按 HOME 后 Host 仍存活（前台服务常驻）", Boolean(alive?.result?.hostId) && services.includes("KeepAliveService"));

    // DC-9 无崩溃
    const crash = sh("logcat", "-d", "-b", "crash");
    check("DC-9", "全程无崩溃（crash buffer 为空）", crash.trim().length === 0, crash.trim() ? "有崩溃日志" : "empty");

    summary.ok = cases.every((c) => c.ok);
    summary.hello = Boolean(hello2);
  } finally {
    try {
      await provider.close();
    } catch {
      /* ignore */
    }
    try {
      cdp?.sock?.end();
    } catch {
      /* ignore */
    }
  }
  writeFileSync(join(here, "..", "docs", "architecture", "evidence", "device-cases-report.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

await main().catch((e) => {
  process.stderr.write(`[dc] ${e?.stack ?? e}\n`);
  process.exit(1);
});

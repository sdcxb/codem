#!/usr/bin/env node
/**
 * 真机（x86_64 模拟器）端到端验证：配对 → 会话 → 撤销 → 自动回配对门。
 *
 * 不修改产品代码；只驱动真实 Host + 真实 APK + 真实 WebView DOM。
 * 证据写 docs/architecture/evidence/device-pairing-revoke.png 与 device-pairing-report.json。
 *
 * 安全纪律：
 * - 控制令牌在进程内随机生成，只进 Host 的环境变量，不写日志/报告；
 * - 配对码只在内存里活一次，报告与 stdout 都不出现；
 * - 设备 cookie 值只在内存里用于撤销后的 401 复核，不写日志/报告。
 *
 * 前置条件：
 * - `node packages/host/scripts/build.mjs` 已产出 packages/host/dist/host.mjs；
 * - 模拟器已启动（脚本只检查 boot_completed，不负责启动/关闭）；
 * - APK 在 android-shell/build/codem-shell-x86_64.apk。
 *
 * 用法：node android-shell/verify-pairing-revoke.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const adb = join(sdk, "platform-tools", "adb.exe");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const apk = join(here, "build", "codem-shell-x86_64.apk");
const pkg = "com.codem.remote";
const CDP_PORT = Number(process.env.VERIFY_CDP_PORT ?? 9337);
const evidenceDir = join(repoRoot, "docs", "architecture", "evidence");
const reportPath = join(evidenceDir, "device-pairing-report.json");
const shotPath = join(evidenceDir, "device-pairing-revoke.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const tempRoot = join(tmpdir(), `codem-pairing-verify-${runId}`);
const dataHome = join(tempRoot, "data");
const workspace = join(tempRoot, "ws");
const controlToken = randomBytes(32).toString("hex");
/** 运行期的秘密：只在内存，绝不进报告/日志 */
const secrets = { controlToken, code: "", cookieValue: "" };

const report = {
  schema: "codem-device-pairing-revoke/1",
  startedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    adbSerial: serial,
    apk,
    apkSha256: "",
    androidApi: null,
    abi: null,
  },
  host: { url: "", port: null, hostId: "", authMode: "paired", dataHome },
  checks: {},
  steps: [],
  failure: null,
  limitations: [],
  secretsPolicy: "未写入控制令牌、配对码与设备 token；报告中的 DOM 摘要已做同值脱敏",
};

function redact(text) {
  let out = String(text ?? "");
  for (const value of [secrets.code, secrets.controlToken, secrets.cookieValue]) {
    if (value && value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out;
}

function step(name, ok, detail) {
  const entry = { step: name, ok: Boolean(ok), at: new Date().toISOString(), detail: redact(detail) };
  report.steps.push(entry);
  process.stdout.write(`[verify] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${redact(detail)}` : ""}\n`);
  return entry;
}

let currentStep = "init";
class VerifyError extends Error {
  constructor(stepName, message, extra = {}) {
    super(message);
    this.name = "VerifyError";
    this.stepName = stepName;
    this.extra = extra;
  }
}

function adbRun(...args) {
  return execFileSync(adb, ["-s", serial, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function adbBinary(...args) {
  return execFileSync(adb, ["-s", serial, ...args], {
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function waitFor(fn, timeoutMs, label, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? `（最后错误：${String(lastError.message ?? lastError)}）` : "";
  throw new VerifyError(currentStep, `等待超时：${label}${suffix}`);
}

function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { method, headers, body, signal: controller.signal })
    .then(async (res) => ({ status: res.status, headers: res.headers, text: await res.text() }))
    .finally(() => clearTimeout(timer));
}

async function rpc(baseUrl, method, params, token) {
  const res = await fetchJson(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* 非 JSON（401 页面/代理）由调用方按 status 判定 */
  }
  return { status: res.status, headers: res.headers, json };
}

class Cdp {
  constructor(url) {
    this.url = new URL(url);
    this.id = 0;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
  }
  static async connect(port, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        const target = list.find((t) => t.type === "page" && String(t.url ?? "").startsWith("http://10.0.2.2:"));
        if (target?.webSocketDebuggerUrl) {
          const c = new Cdp(target.webSocketDebuggerUrl);
          await c.open();
          return { cdp: c, target };
        }
        last = new Error(`没有匹配的 page target：${JSON.stringify(list.map((t) => t.url))}`);
      } catch (e) {
        last = e;
      }
      await sleep(500);
    }
    throw new VerifyError(currentStep, `CDP 连接超时：${last?.message ?? last}`);
  }
  open() {
    return new Promise((resolveOpen, reject) => {
      const key = randomBytes(16).toString("base64");
      const sock = net.connect(Number(this.url.port), this.url.hostname);
      this.sock = sock;
      let up = false;
      sock.on("connect", () =>
        sock.write(
          `GET ${this.url.pathname} HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        ),
      );
      sock.on("error", reject);
      sock.on("close", () => {
        for (const fn of this.pending.values()) fn({ error: { message: "websocket closed" } });
        this.pending.clear();
      });
      sock.on("data", (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!up) {
          const end = this.buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          if (!this.buf.subarray(0, end).toString().includes("101")) return reject(new Error("websocket handshake failed"));
          this.buf = this.buf.subarray(end + 4);
          up = true;
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
      const text = this.buf.subarray(off, off + len).toString();
      this.buf = this.buf.subarray(off + len);
      try {
        const message = JSON.parse(text);
        if (message.id && this.pending.has(message.id)) {
          this.pending.get(message.id)(message);
          this.pending.delete(message.id);
        }
      } catch {
        /* 忽略非 JSON 帧 */
      }
    }
  }
  send(method, params) {
    return new Promise((resolveSend) => {
      const id = ++this.id;
      this.pending.set(id, resolveSend);
      const data = Buffer.from(JSON.stringify({ id, method, params }));
      const mask = randomBytes(4);
      const masked = Buffer.from(data);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      let header;
      if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
      else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
      }
      this.sock.write(Buffer.concat([header, mask, masked]));
    });
  }
  async eval(expression) {
    const reply = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.error) throw new Error(reply.error.message ?? "CDP error");
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text ?? "eval failed");
    }
    return reply.result?.result?.value;
  }
  close() {
    try {
      this.sock?.destroy();
    } catch {
      /* ignore */
    }
  }
}

function screencap(path) {
  const png = adbBinary("exec-out", "screencap", "-p");
  if (png.length < 20_000) throw new VerifyError(currentStep, `screencap 过小：${png.length} 字节`);
  if (!(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) {
    throw new VerifyError(currentStep, "screencap 不是 PNG（前 4 字节不是 89 50 4e 47）");
  }
  writeFileSync(path, png);
  return { bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") };
}

const hostStdout = [];
const hostStderr = [];
let hostProc = null;
let hostUrl = "";
let cdp = null;
let hostExit = null;

async function startHost() {
  mkdirSync(dataHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  hostProc = spawn(
    process.execPath,
    [
      join(repoRoot, "packages", "host", "dist", "host.mjs"),
      "serve",
      "--data-home",
      dataHome,
      "--workspace",
      workspace,
      "--web",
      join(repoRoot, "packages", "host", "web"),
      "--port",
      "0",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CODEM_HOST_CONTROL_TOKEN: controlToken, CODEM_HOST_AUTH: "paired" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  hostExit = new Promise((resolveExit) => hostProc.once("exit", (code, signal) => resolveExit({ code, signal })));
  hostProc.stdout.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) hostStdout.push(line.trim());
  });
  hostProc.stderr.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) hostStderr.push(line.trim());
  });

  const ready = await waitFor(
    () => {
      const line = hostStdout.find((l) => l.startsWith("{") && l.includes('"ready":true'));
      if (!line) return null;
      const parsed = JSON.parse(line);
      return parsed.ready ? parsed : null;
    },
    90_000,
    "Host READY 行",
  );
  hostUrl = String(ready.url ?? "");
  const port = Number(ready.port);
  if (!hostUrl || !Number.isInteger(port)) throw new VerifyError("host", `Host READY 行缺少 url/port：${JSON.stringify(ready)}`);
  report.host.url = hostUrl;
  report.host.port = port;
  report.host.hostId = String(ready.hostId ?? "");
  await waitFor(async () => {
    const res = await fetchJson(`${hostUrl}/healthz`, { timeoutMs: 3000 });
    return res.status === 200 && res.text.includes('"ok":true');
  }, 30_000, "Host /healthz");
  return { port };
}

async function main() {
  currentStep = "preconditions";
  report.environment.apkSha256 = existsSync(apk) ? sha256File(apk) : "";
  if (!existsSync(apk)) throw new VerifyError("preconditions", `APK 不存在：${apk}`);
  if (!existsSync(join(repoRoot, "packages", "host", "dist", "host.mjs"))) {
    throw new VerifyError("preconditions", "packages/host/dist/host.mjs 不存在：先跑 node packages/host/scripts/build.mjs");
  }
  if (!existsSync(join(repoRoot, "packages", "host", "web", "index.html"))) {
    throw new VerifyError("preconditions", "packages/host/web/index.html 不存在");
  }
  mkdirSync(evidenceDir, { recursive: true });

  const boot = adbRun("shell", "getprop", "sys.boot_completed");
  if (boot !== "1") throw new VerifyError("preconditions", `模拟器未就绪：sys.boot_completed=${boot}`);
  report.environment.androidApi = Number(adbRun("shell", "getprop", "ro.build.version.sdk")) || null;
  report.environment.abi = adbRun("shell", "getprop", "ro.product.cpu.abi");
  step("preconditions", true, `api=${report.environment.androidApi} abi=${report.environment.abi} apk=${report.environment.apkSha256.slice(0, 12)}…`);

  currentStep = "host";
  const { port } = await startHost();
  report.checks.hostReady = true;
  step("host", true, `${hostUrl} authMode=paired port=${port}`);

  currentStep = "install";
  const installOut = adbRun("install", "-r", apk);
  report.checks.apkInstalled = /Success/i.test(installOut);
  step("install", report.checks.apkInstalled, installOut.split(/\r?\n/).slice(-2).join(" | "));
  if (!report.checks.apkInstalled) throw new VerifyError("install", `adb install 失败：${installOut.slice(-500)}`);

  currentStep = "clear";
  const clearOut = adbRun("shell", "pm", "clear", pkg);
  report.checks.appDataCleared = /Success/i.test(clearOut);
  step("pm-clear", report.checks.appDataCleared, clearOut);

  currentStep = "launch";
  adbRun("shell", "am", "force-stop", pkg);
  try {
    adbRun("forward", "--remove", `tcp:${CDP_PORT}`);
  } catch {
    /* 没有旧的 forward 时 adb 会报错，不是失败 */
  }
  const appUrl = `http://10.0.2.2:${port}/`;
  const launchOut = adbRun(
    "shell", "am", "start", "-W", "-n", `${pkg}/.MainActivity`,
    "--es", "url", appUrl,
    "--ez", "webviewDebug", "true",
  );
  const pid = await waitFor(() => {
    try {
      const out = adbRun("shell", "pidof", pkg);
      return out && /^[0-9]+$/.test(out) ? out : null;
    } catch {
      return null;
    }
  }, 30_000, "应用进程");
  report.checks.appLaunched = /Status:\s*ok/i.test(launchOut) && Boolean(pid);
  step("launch", report.checks.appLaunched, `${launchOut.split(/\r?\n/).find((l) => l.startsWith("Status:")) ?? "no status"} pid=${pid}`);
  if (!report.checks.appLaunched) throw new VerifyError("launch", `启动失败：${launchOut.slice(0, 800)}`);

  currentStep = "cdp";
  const socketName = await waitFor(() => {
    const unix = adbRun("shell", "cat", "/proc/net/unix");
    const match = unix.match(new RegExp(`@webview_devtools_remote_${pid}\\b`));
    return match ? `webview_devtools_remote_${pid}` : null;
  }, 60_000, "WebView devtools socket");
  adbRun("forward", `tcp:${CDP_PORT}`, `localabstract:${socketName}`);
  const connected = await Cdp.connect(CDP_PORT);
  cdp = connected.cdp;
  report.checks.cdpAttached = Boolean(connected.target?.id);
  step("cdp", report.checks.cdpAttached, `target=${String(connected.target?.url ?? "")}`);
  await cdp.send("Runtime.enable", {});
  await cdp.send("Page.enable", {});

  currentStep = "pairing-gate";
  const gateShown = await waitFor(
    () => cdp.eval("Boolean(document.querySelector('[data-testid=\"pairing-gate\"]'))"),
    60_000,
    "PairingGate 出现",
  );
  report.checks.pairingGateShown = gateShown === true;
  const gateText = String(await cdp.eval("document.body.innerText"));
  step("pairing-gate", report.checks.pairingGateShown, gateText.slice(0, 80).replace(/\s+/g, " "));
  if (!report.checks.pairingGateShown) throw new VerifyError("pairing-gate", "页面没有 PairingGate", { dom: gateText.slice(0, 400) });

  currentStep = "pair-start";
  const start = await rpc(hostUrl, "pair.start", {}, controlToken);
  const code = String(start.json?.result?.code ?? "");
  secrets.code = code;
  report.checks.pairCodeObtained = start.status === 200 && /^[0-9]{6}$/.test(code);
  step("pair-start", report.checks.pairCodeObtained, `status=${start.status}（配对码已获取，未记录）`);
  if (!report.checks.pairCodeObtained) throw new VerifyError("pair-start", `pair.start 未返回 6 位码（status=${start.status}）`);

  currentStep = "pair-claim";
  const filled = await cdp.eval(
    `(() => {
      const el = document.querySelector('[data-testid="pairing-code"]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(code)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value === ${JSON.stringify(code)};
    })()`,
  );
  if (!filled) throw new VerifyError("pair-claim", "无法把配对码填进 PairingGate 输入框");
  await sleep(250);
  await cdp.eval("(() => { const b = document.querySelector('[data-testid=\"pairing-submit\"]'); if (b) b.click(); return Boolean(b); })()");
  const pairStartAt = Date.now();
  const pairingSucceeded = await waitFor(async () => {
    const gone = await cdp.eval("Boolean(document.querySelector('[data-testid=\"pairing-gate\"]')) === false");
    if (!gone) return false;
    return cdp.eval("document.body.innerText.includes('新建会话')");
  }, 15_000, "配对成功（配对门消失 + 会话列表出现）");
  report.checks.pairingSucceeded = pairingSucceeded === true;
  report.checks.pairingElapsedMs = Date.now() - pairStartAt;
  const errorText = String(await cdp.eval("document.querySelector('[data-testid=\"pairing-error\"]')?.textContent ?? ''"));
  step("pair-claim", report.checks.pairingSucceeded, `elapsed=${report.checks.pairingElapsedMs}ms error=${errorText || "none"}`);
  if (!report.checks.pairingSucceeded) {
    throw new VerifyError("pair-claim", "输入配对码后没有进入应用", { dom: String(await cdp.eval("document.body.innerText")).slice(0, 400), errorText });
  }
  await waitFor(
    () => cdp.eval("document.body.getAttribute('data-connected') === '1'"),
    15_000,
    "data-connected=1（hello 成功）",
  ).then(() => {
    report.checks.helloAuthenticated = true;
  });

  const listAfterClaim = await rpc(hostUrl, "pair.list", {}, controlToken);
  const devices = Array.isArray(listAfterClaim.json?.result?.devices) ? listAfterClaim.json.result.devices : [];
  report.checks.deviceListedAfterClaim = devices.length === 1 && devices[0]?.platform === "android";
  step("device-listed", report.checks.deviceListedAfterClaim, `devices=${devices.length} platform=${devices[0]?.platform ?? "none"}`);
  if (!report.checks.deviceListedAfterClaim) throw new VerifyError("device-listed", `pair.list 期望 1 台 android 设备，实际 ${devices.length}`);

  currentStep = "session";
  const clicked = await cdp.eval(
    "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新建会话')); if (!b) return false; b.click(); return true; })()",
  );
  if (!clicked) throw new VerifyError("session", "找不到「新建会话」按钮");
  await waitFor(() => cdp.eval("Boolean(document.querySelector('textarea'))"), 20_000, "会话输入框出现");
  await sleep(1200); // 让 useSessionChat 的 SSE 订阅真正连上
  report.checks.sessionOpened = true;
  const composerText = String(await cdp.eval("document.body.innerText")).slice(0, 120).replace(/\s+/g, " ");
  step("session", true, composerText);

  currentStep = "pre-revoke-rpc";
  const preRpc = await cdp.eval(
    `(async () => {
      const r = await fetch('/rpc', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'session.list', params: {} }),
      });
      const j = await r.json().catch(() => null);
      return JSON.stringify({ status: r.status, sessions: Array.isArray(j?.result?.items) ? j.result.items.length : null });
    })()`,
  );
  const pre = JSON.parse(String(preRpc));
  report.checks.preRevokeRpcStatus = pre.status;
  report.checks.preRevokeRpcOk = pre.status === 200;
  step("pre-revoke-rpc", pre.status === 200, `session.list status=${pre.status} sessions=${pre.sessions}`);
  if (pre.status !== 200) throw new VerifyError("pre-revoke-rpc", `撤销前 session.list 期望 200，实际 ${pre.status}`);

  currentStep = "device-cookie";
  await cdp.send("Network.enable", {});
  // 必须用页面真实 origin（10.0.2.2），Host 侧地址 127.0.0.1 不是 cookie 的域。
  const cookieReply = await cdp.send("Network.getCookies", { urls: [appUrl] });
  const cookies = Array.isArray(cookieReply.result?.cookies) ? cookieReply.result.cookies : [];
  const deviceCookie = cookies.find((c) => String(c.name ?? "").startsWith("codem_device_"));
  report.checks.deviceCookieCaptured = Boolean(deviceCookie?.value);
  step("device-cookie", report.checks.deviceCookieCaptured, `HttpOnly cookie name=${deviceCookie?.name ?? "none"}（值未记录）`);
  if (deviceCookie?.value) secrets.cookieValue = deviceCookie.value;

  currentStep = "revoke";
  const revoke = await rpc(hostUrl, "pair.revoke", { deviceId: devices[0].id }, controlToken);
  report.checks.revokeAccepted = revoke.status === 200 && revoke.json?.result?.revoked === true;
  step("revoke", report.checks.revokeAccepted, `status=${revoke.status} revoked=${revoke.json?.result?.revoked}`);
  if (!report.checks.revokeAccepted) throw new VerifyError("revoke", `pair.revoke 失败：status=${revoke.status}`);
  const listAfterRevoke = await rpc(hostUrl, "pair.list", {}, controlToken);
  const devicesAfter = Array.isArray(listAfterRevoke.json?.result?.devices) ? listAfterRevoke.json.result.devices : [];
  report.checks.deviceListEmptyAfterRevoke = devicesAfter.length === 0;
  step("device-list-empty", report.checks.deviceListEmptyAfterRevoke, `devices=${devicesAfter.length}`);

  currentStep = "auto-return";
  const returnAt = Date.now();
  const returned = await waitFor(
    () => cdp.eval("Boolean(document.querySelector('[data-testid=\"pairing-gate\"]'))"),
    10_000,
    "撤销后自动回 PairingGate（≤10s）",
    200,
  );
  report.checks.autoReturnToGate = returned === true;
  report.checks.autoReturnMs = Date.now() - returnAt;
  const postBody = String(await cdp.eval("document.body.innerText"));
  step("auto-return", report.checks.autoReturnToGate, `elapsed=${report.checks.autoReturnMs}ms dom=${postBody.slice(0, 60).replace(/\s+/g, " ")}`);
  if (!report.checks.autoReturnToGate) {
    throw new VerifyError("auto-return", `撤销后 ${report.checks.autoReturnMs}ms 内没有回到 PairingGate`, { dom: postBody.slice(0, 400) });
  }

  currentStep = "post-revoke-rpc";
  const postRpc = await cdp.eval(
    `(async () => {
      const r = await fetch('/rpc', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'host.hello', params: { protocolVersion: 1, client: { name: 'verify', version: '0', platform: 'android' } } }),
      });
      const j = await r.json().catch(() => null);
      return JSON.stringify({ status: r.status, kind: j?.error?.data?.kind ?? null });
    })()`,
  );
  const post = JSON.parse(String(postRpc));
  report.checks.postRevokeRpcStatus = post.status;
  report.checks.postRevokeRpcRejected = post.status === 401;
  step("post-revoke-rpc", post.status === 401, `host.hello status=${post.status} kind=${post.kind}`);

  currentStep = "revoked-cookie";
  let cookieRejected = false;
  let cookieCleared = false;
  if (deviceCookie?.value) {
    const res = await fetchJson(`${hostUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${deviceCookie.name}=${deviceCookie.value}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 43, method: "host.hello", params: { protocolVersion: 1, client: { name: "verify-cookie", version: "0", platform: "node" } } }),
    });
    cookieRejected = res.status === 401;
    cookieCleared = /Max-Age=0/i.test(res.headers.get("set-cookie") ?? "");
  }
  report.checks.revokedCookieRejected = cookieRejected;
  report.checks.revokedCookieCleared = cookieCleared;
  step("revoked-cookie", cookieRejected, `撤销前抓到的设备 cookie 直连 /rpc status=${cookieRejected ? 401 : "非 401"} clearCookie=${cookieCleared}`);

  currentStep = "screenshot";
  await sleep(800);
  const shot = screencap(shotPath);
  report.checks.screenshotSaved = true;
  report.screenshot = { path: "docs/architecture/evidence/device-pairing-revoke.png", bytes: shot.bytes, sha256: shot.sha256 };
  step("screenshot", true, `${shot.bytes} bytes sha256=${shot.sha256.slice(0, 12)}…`);

  currentStep = "report";
  report.checks.allPassed = Boolean(
    report.checks.hostReady &&
      report.checks.apkInstalled &&
      report.checks.appDataCleared &&
      report.checks.appLaunched &&
      report.checks.cdpAttached &&
      report.checks.pairingGateShown &&
      report.checks.pairCodeObtained &&
      report.checks.pairingSucceeded &&
      report.checks.helloAuthenticated &&
      report.checks.deviceListedAfterClaim &&
      report.checks.sessionOpened &&
      report.checks.preRevokeRpcOk &&
      report.checks.revokeAccepted &&
      report.checks.deviceListEmptyAfterRevoke &&
      report.checks.autoReturnToGate &&
      report.checks.postRevokeRpcRejected &&
      report.checks.revokedCookieRejected &&
      report.checks.screenshotSaved,
  );
  step("all", report.checks.allPassed, "端到端判据");
  if (!report.checks.allPassed) throw new VerifyError("all", "有判据未通过");
}

function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.ok = Boolean(report.checks.allPassed);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`[verify] report → ${reportPath}\n`);
}

async function cleanup() {
  try {
    if (cdp) cdp.close();
  } catch {
    /* ignore */
  }
  try {
    adbRun("shell", "am", "force-stop", pkg);
  } catch {
    /* ignore */
  }
  try {
    adbRun("shell", "pm", "clear", pkg);
  } catch {
    /* ignore */
  }
  try {
    adbRun("forward", "--remove", `tcp:${CDP_PORT}`);
  } catch {
    /* ignore */
  }
  if (hostProc && hostProc.exitCode === null) {
    try {
      hostProc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await Promise.race([hostExit, sleep(5000)]);
    if (hostProc.exitCode === null) {
      try {
        execFileSync("taskkill", ["/PID", String(hostProc.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    }
  }
}

try {
  await main();
} catch (e) {
  const err = e instanceof VerifyError ? e : new VerifyError(currentStep, e?.message ?? String(e));
  report.failure = {
    step: err.stepName ?? currentStep,
    message: redact(err.message),
    domExcerpt: redact(err.extra?.dom ?? ""),
    errorText: redact(err.extra?.errorText ?? ""),
  };
  try {
    if (cdp) report.failure.finalDomExcerpt = redact(String(await cdp.eval("document.body.innerText")).slice(0, 500));
  } catch {
    /* ignore */
  }
  report.failure.hostStderrTail = hostStderr.slice(-20).map(redact);
  process.stderr.write(`[verify] FAIL at ${report.failure.step}: ${report.failure.message}\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
  try {
    writeReport();
  } catch (e) {
    report.ok = false;
    process.stderr.write(`[verify] 写报告失败：${e?.message ?? e}\n`);
  }
  if (report.ok) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响判据 */
    }
  } else {
    process.stderr.write(`[verify] 失败现场保留：${tempRoot}\n`);
  }
}

process.exit(report.ok ? 0 : 1);

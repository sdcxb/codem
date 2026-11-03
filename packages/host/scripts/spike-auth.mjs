#!/usr/bin/env node
/**
 * Host 鉴权判据（AUTH-1..9，D-7）：
 * 1. 设了 `CODEM_HOST_TOKEN` 后，`/rpc` 无 token ⇒ 401；
 * 2. 带 `Authorization: Bearer` ⇒ 正常；
 * 3. `/events` 无 token ⇒ 401（SSE 也不能绕过）；
 * 4. 静态页面不拦（页面本身不含秘密）；
 * 5. `/rpc?token=` ⇒ 401（URL 里的静态令牌不再被接受）；
 * 6. paired 模式 loopback 无凭据 ⇒ 401（隧道客户端就在本机，不能凭 remoteAddress 信任）；
 * 7. `pair.start`（控制令牌）→ `pair.claim`（匿名，**只回 Set-Cookie**，响应体无 token）
 *    → 设备 cookie 可访问 `/rpc`/`/events`；设备 token 放 query ⇒ 401；
 *    撤销后立即 401（并回 `Max-Age=0` 清理 cookie），已建立的 SSE 收到 `host.auth.revoked`；
 * 8. 控制令牌不能用于普通 RPC / events（受众隔离）；
 * 9. `pair.list` 不含 token/hash。
 * 10. 只输出布尔；不打印 cookie/令牌。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const hostEntry = join(repoRoot, "packages", "host", "dist", "host.mjs");
const dbBin = process.env.CODEM_DB_BIN ?? join(repoRoot, "src-tauri", "codem-db", "target", "release", "codem-db-cli.exe");
const TOKEN = "spike-secret-123";
const CONTROL = "spike-control-0123456789abcdef";

async function main() {
  const work = mkdtempSync(join(tmpdir(), "codem-auth-"));
  const data = join(work, "data");
  mkdirSync(data, { recursive: true });
  const child = spawn(
    process.execPath,
    [hostEntry, "serve", "--data-home", data, "--workspace", data, "--web", join(repoRoot, "packages", "host", "web"), "--port", "0"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEM_DB_BIN: dbBin,
        CODEM_HOST_TOKEN: TOKEN,
        CODEM_HOST_AUTH: "paired",
        CODEM_HOST_CONTROL_TOKEN: CONTROL,
      },
    },
  );
  const summary = { spike: "host-auth", checks: {} };
  try {
    const ready = await new Promise((res, rej) => {
      let buf = "";
      const t = setTimeout(() => rej(new Error(`Host 未 READY：${buf}`)), 15000);
      child.stdout.on("data", (c) => {
        buf += c.toString("utf8");
        const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
        if (line) {
          clearTimeout(t);
          res(JSON.parse(line));
        }
      });
    });

    const rpc = async (method, params, opts = {}) => {
      const headers = { "content-type": "application/json" };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      if (opts.cookie) headers.cookie = opts.cookie;
      const res = await fetch(`${ready.url}${opts.query ?? "/rpc"}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }),
      });
      const body = await res.json().catch(() => null);
      const setCookie =
        typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
      return { status: res.status, body, setCookie };
    };
    const hello = { protocolVersion: 1, client: { name: "a", version: "0", platform: "node" } };

    const noAuth = await rpc("host.hello", hello);
    summary.checks.AUTH1_rpc401 = noAuth.status === 401 && noAuth.body?.error?.data?.kind === "UNAUTHORIZED";

    const withAuth = await rpc("host.hello", hello, { token: TOKEN });
    summary.checks.AUTH2_bearerOk = withAuth.status === 200 && Boolean(withAuth.body?.result?.hostId);

    const sse = await fetch(`${ready.url}/events?sessionId=x`);
    summary.checks.AUTH3_sse401 = sse.status === 401;

    const page = await fetch(`${ready.url}/`);
    summary.checks.AUTH4_pagePublic = page.status === 200;

    const queryRpc = await rpc("host.hello", hello, { query: `/rpc?token=${encodeURIComponent(TOKEN)}` });
    summary.checks.AUTH5_rpcQueryRejected = queryRpc.status === 401;

    // paired + loopback + 无凭据：必须是 401（不是"本机所以放行"）
    const loopbackNoCreds = await rpc("pair.start", {});
    summary.checks.AUTH6_pairedLoopback401 = loopbackNoCreds.status === 401;

    const controlHello = await rpc("host.hello", hello, { token: CONTROL });
    summary.checks.AUTH8a_controlCannotHello =
      controlHello.body?.error?.data?.kind === "UNAUTHORIZED";
    const controlSse = await fetch(`${ready.url}/events?sessionId=x&token=${encodeURIComponent(CONTROL)}`);
    summary.checks.AUTH8b_controlCannotSse = controlSse.status === 401;

    const started = await rpc("pair.start", {}, { token: CONTROL });
    const code = String(started.body?.result?.code ?? "");
    summary.checks.AUTH7a_pairCode = /^[0-9]{6}$/.test(code);

    const claimed = await rpc("pair.claim", { code, deviceName: "spike-phone", platform: "android" });
    const deviceId = String(claimed.body?.result?.deviceId ?? "");
    const setCookie = claimed.setCookie.find((c) => c.startsWith("codem_device_")) ?? "";
    const deviceCookie = setCookie.split(";")[0];
    const deviceToken = deviceCookie.includes("=") ? deviceCookie.slice(deviceCookie.indexOf("=") + 1) : "";
    // 响应体里不能有 token；cookie 必须是 HttpOnly + Strict + Max-Age，http 下不能带 Secure
    summary.checks.AUTH7b_claimSetsHttpOnlyCookie =
      claimed.body?.result?.deviceToken === undefined &&
      !/[0-9a-f]{64}/.test(JSON.stringify(claimed.body?.result ?? {})) &&
      /HttpOnly/.test(setCookie) &&
      /SameSite=Strict/.test(setCookie) &&
      /Max-Age=[0-9]+/.test(setCookie) &&
      !/;\s*Secure/i.test(setCookie);

    const deviceHello = await rpc("host.hello", hello, { cookie: deviceCookie });
    summary.checks.AUTH7c_deviceRpc = deviceHello.status === 200 && deviceHello.body?.result?.auth?.kind === "device";
    const deviceSse = await fetch(`${ready.url}/events?sessionId=x`, { headers: { cookie: deviceCookie } });
    summary.checks.AUTH7d_deviceSse = deviceSse.status === 200;
    deviceSse.body?.cancel?.().catch?.(() => undefined);

    // 设备 token 走 query 必须 401（URL 不再是设备凭据的通道）
    const deviceQuery = await fetch(`${ready.url}/events?sessionId=x&token=${encodeURIComponent(deviceToken)}`);
    summary.checks.AUTH10_deviceQueryRejected = deviceQuery.status === 401;

    const listed = await rpc("pair.list", {}, { token: CONTROL });
    const listedText = JSON.stringify(listed.body ?? {});
    summary.checks.AUTH9_listNoSecret = !listedText.includes(deviceToken) && !listedText.includes("tokenHash");

    // 撤销：新请求 401（并清理同名 cookie）；已建立的 SSE 收到 host.auth.revoked
    const sseRead = await fetch(`${ready.url}/events?sessionId=x`, { headers: { cookie: deviceCookie } });
    const reader = sseRead.body.getReader();
    const decoder = new TextDecoder();
    let sseText = "";
    const readUntil = async (needle) => {
      const deadline = Date.now() + 5000;
      while (!sseText.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        sseText += decoder.decode(value, { stream: true });
      }
      return sseText.includes(needle);
    };
    await readUntil("retry: 2000");
    const revoked = await rpc("pair.revoke", { deviceId }, { token: CONTROL });
    summary.checks.AUTH7e_revoked = revoked.body?.result?.revoked === true;
    summary.checks.AUTH7f_sseRevokedEvent = await readUntil("auth.revoked");
    await reader.cancel().catch(() => undefined);
    const afterRevoke = await rpc("host.hello", hello, { cookie: deviceCookie });
    summary.checks.AUTH7g_afterRevoke401 = afterRevoke.status === 401;
    summary.checks.AUTH7h_revokeClearsCookie = afterRevoke.setCookie.some((c) => /Max-Age=0/.test(c));
  } finally {
    child.kill("SIGTERM");
  }
  const ok = Object.values(summary.checks).every(Boolean);
  summary.ok = ok;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

await main().catch((e) => {
  process.stderr.write(`[auth] ${e?.stack ?? e}\n`);
  process.exit(1);
});

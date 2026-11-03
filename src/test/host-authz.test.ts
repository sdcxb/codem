// @vitest-environment node
/**
 * Host 鉴权矩阵（AUTHZ-*，D-7；设备凭据 = HttpOnly cookie）。
 *
 * 这一组直接起**真实 HTTP 服务**（假 runtime 只提供 hello/subscribe），守的是线上行为：
 * - loopback 免鉴权只在 `local` 模式；`paired` 模式即使 remoteAddress=127.0.0.1 也必须带凭据；
 * - 静态令牌：Bearer 可用、`/rpc?token=` 不接受、`/events?token=` 兼容；
 * - 设备凭据：`pair.claim` **只回 Set-Cookie**（响应体无 token），`/rpc` 与 `/events`
 *   都用同一个 HttpOnly cookie；撤销后立即 401，并回 `Max-Age=0` 清理；
 * - 设备 token **不再**接受 Bearer / query（否则旧 localStorage 凭据永远有效 = 迁移没发生）；
 * - 控制令牌只够管理配对（不能调 hello / 不能连 events）；
 * - 未鉴权只允许 `pair.claim`；401 必须是 JSON-RPC 的 UNAUTHORIZED（客户端才能识别）；
 * - 响应/错误里不出现 token / hash / 提交的码。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HostConfig } from "../../packages/host/src/config";
import { pairingFile, resolveHostConfig } from "../../packages/host/src/config";
import { PairingService } from "../../packages/host/src/pairing";
import type { HostRuntime } from "../../packages/host/src/runtime";
import { startHostServer, type RunningServer } from "../../packages/host/src/server";

interface Harness {
  server: RunningServer;
  pairing: PairingService;
  dir: string;
  config: HostConfig;
}

const harnesses: Harness[] = [];
/** 额外的临时目录（AUTHZ-9 的父目录等），afterEach 一起清 */
const extraDirs: string[] = [];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "codem-authz-"));
}

function fakeRuntime(): HostRuntime {
  const hello = () => ({
    server: { name: "codem-host" as const, version: "test", protocolVersion: 1, minClientVersion: 1 },
    hostId: "host-test",
    capabilities: { supported: [], unsupported: [] },
    lease: { holder: "none" as const },
    leaseGranted: false,
  });
  return {
    hostId: "host-test",
    hello,
    listRuns: () => [],
    diagnostics: () => ({ hostId: "host-test", version: "test", protocolVersion: 1, uptimeMs: 0, dataHome: "", workspaceRoot: "", seq: 0, runs: [], persistFailures: [] }),
    subscribe: () => () => undefined,
  } as unknown as HostRuntime;
}

async function boot(overrides: Partial<HostConfig>, pairingOpts: { maxAttemptsPerWindow?: number; maxAttemptsPerCode?: number } = {}): Promise<Harness> {
  const dir = tempDir();
  const config = resolveHostConfig({
    overrides: {
      dataHome: dir,
      dbPath: join(dir, "db.bin"),
      workspaceRoot: dir,
      dbBin: process.execPath,
      port: 0,
      host: "127.0.0.1",
      ...overrides,
    },
  });
  const pairing = await PairingService.open({ filePath: pairingFile(config.dataHome), ...pairingOpts });
  const server = await startHostServer({ config, runtime: fakeRuntime(), webDir: dir, pairing });
  const harness = { server, pairing, dir, config };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.server.close();
    await h.pairing.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LOCAL = { authMode: "local" as const, token: "", controlToken: "" };
const PAIRED = { authMode: "paired" as const, token: "", controlToken: "control-token-1234567890" };
const STATIC = { authMode: "local" as const, token: "static-secret", controlToken: "" };
const CONTROL = "control-token-1234567890";

interface RpcReply {
  status: number;
  body: {
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: { kind?: string; retryable?: boolean; details?: unknown } };
  };
  /** 原始 `set-cookie` 响应头（没有就是空串） */
  setCookie: string;
}

interface AuthOpts {
  token?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

async function rpc(h: Harness, method: string, params: Record<string, unknown> = {}, auth: AuthOpts = {}): Promise<RpcReply> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(auth.headers ?? {}) };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.cookie = auth.cookie;
  const res = await fetch(`${h.server.url}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return {
    status: res.status,
    body: (await res.json()) as RpcReply["body"],
    setCookie: res.headers.get("set-cookie") ?? "",
  };
}

async function eventStatus(h: Harness, query: string, cookie?: string): Promise<number> {
  const ac = new AbortController();
  const res = await fetch(`${h.server.url}/events?sessionId=s1${query}`, {
    signal: ac.signal,
    ...(cookie ? { headers: { cookie } } : {}),
  });
  const status = res.status;
  // 先取消 body 再 abort：只 abort 时服务端可能仍把这条连接当作活动连接，
  // server.close() 会等到 keep-alive 超时（实测每个用例多 4 秒）。
  await res.body?.cancel().catch(() => undefined);
  ac.abort();
  return status;
}

/** 设备 cookie 名/值（从 Set-Cookie 里取；名字由数据根哈希决定，测试不硬编码）。 */
interface ClaimedDevice {
  code: string;
  deviceId: string;
  setCookie: string;
  cookie: string;
  token: string;
  reply: RpcReply;
}

async function claimDevice(
  h: Harness,
  extraHeaders: Record<string, string> = {},
  adminToken = CONTROL,
): Promise<ClaimedDevice> {
  const started = await rpc(h, "pair.start", {}, { token: adminToken });
  const code = String(started.body.result?.code ?? "");
  const claimed = await rpc(
    h,
    "pair.claim",
    { code, deviceName: "Pixel", platform: "android" },
    { headers: extraHeaders },
  );
  const match = /codem_device_[0-9a-f]{16}=[0-9a-f]{64}/.exec(claimed.setCookie);
  const cookie = match ? match[0] : "";
  const token = cookie ? cookie.slice(cookie.indexOf("=") + 1) : "";
  return { code, deviceId: String(claimed.body.result?.deviceId ?? ""), setCookie: claimed.setCookie, cookie, token, reply: claimed };
}

describe("AUTHZ-1 local 模式", () => {
  it("无凭据时 /rpc 与 /events 都放行（本机开发形态）", async () => {
    const h = await boot(LOCAL);
    const reply = await rpc(h, "host.hello", { protocolVersion: 1, client: { name: "t", version: "0", platform: "node" } });
    expect(reply.status).toBe(200);
    expect(reply.body.result?.hostId).toBe("host-test");
    expect(reply.body.result?.auth).toEqual({ kind: "local" });
    expect(await eventStatus(h, "")).toBe(200);
  });
});

describe("AUTHZ-2 paired 模式（P0 回归）", () => {
  it("loopback 无凭据也 401，body 是 JSON-RPC UNAUTHORIZED", async () => {
    const h = await boot(PAIRED);
    const reply = await rpc(h, "host.hello", { protocolVersion: 1 });
    expect(reply.status).toBe(401);
    expect(reply.body.error?.code).toBe(-32001);
    expect(reply.body.error?.data?.kind).toBe("UNAUTHORIZED");
    expect(reply.body.error?.message).not.toContain("undefined");
    expect(reply.setCookie).toBe(""); // 无 cookie 的 401 不该平白多一个 Set-Cookie
    expect(await eventStatus(h, "")).toBe(401);
  });

  it("未鉴权只允许 pair.claim；混入其它方法整体 401", async () => {
    const h = await boot(PAIRED);
    const { body } = await rpc(h, "pair.claim", { code: "123456" });
    // 码不对 ⇒ JSON-RPC 的 UNAUTHORIZED（不是 HTTP 401：请求已获准到达 claim 方法）
    expect(body.error?.data?.kind).toBe("UNAUTHORIZED");
    expect((body.error?.data?.details as { reason?: string })?.reason).toBe("invalid");

    const denied = await rpc(h, "session.list", {});
    expect(denied.status).toBe(401);

    const batch = await fetch(`${h.server.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "pair.claim", params: { code: "123456" } },
        { jsonrpc: "2.0", id: 2, method: "session.list", params: {} },
      ]),
    });
    expect(batch.status).toBe(401);
  });
});

describe("AUTHZ-3 静态令牌兼容", () => {
  it("Bearer 200；/rpc?token= 401；/events?token=static 200；设备 token 放 query 401", async () => {
    const h = await boot(STATIC);
    const hello = await rpc(h, "host.hello", { protocolVersion: 1 }, { token: "static-secret" });
    expect(hello.status).toBe(200);
    expect(hello.body.result?.auth).toEqual({ kind: "static" });

    const query = await fetch(`${h.server.url}/rpc?token=static-secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "host.hello", params: { protocolVersion: 1 } }),
    });
    expect(query.status).toBe(401);

    expect(await eventStatus(h, "&token=static-secret")).toBe(200);
    expect(await eventStatus(h, "&token=wrong")).toBe(401);

    // 设备 token 不再是 URL 凭据：即使它是真的，也必须在 query 上被拒
    const claimed = await claimDevice(h, {}, "static-secret");
    expect(claimed.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await eventStatus(h, `&token=${claimed.token}`)).toBe(401);
    expect(await eventStatus(h, "", claimed.cookie)).toBe(200);
  });
});

describe("AUTHZ-4 设备凭据（HttpOnly cookie）", () => {
  it("claim 响应无 token、只回 Set-Cookie；cookie 可访问 /rpc 与 /events；错 cookie 401", async () => {
    const h = await boot(PAIRED);
    expect((await rpc(h, "pair.start", {})).status).toBe(401);

    const claimed = await claimDevice(h);
    expect(claimed.reply.status).toBe(200);
    expect(claimed.deviceId).toMatch(/^dev-[0-9a-f]{8}$/);
    // 响应体里不能出现凭据（64 hex），也不能再有 deviceToken 字段
    expect(claimed.reply.body.result).not.toHaveProperty("deviceToken");
    expect(JSON.stringify(claimed.reply.body.result)).not.toMatch(/[0-9a-f]{64}/);

    // Set-Cookie 属性：HttpOnly / Path=/ / SameSite=Strict / Max-Age；http 下不能有 Secure
    expect(claimed.setCookie.match(/codem_device_[0-9a-f]{16}=/g)).toHaveLength(1);
    expect(claimed.setCookie).toContain("HttpOnly");
    expect(claimed.setCookie).toContain("Path=/");
    expect(claimed.setCookie).toContain("SameSite=Strict");
    expect(claimed.setCookie).toMatch(/Max-Age=[0-9]+/);
    expect(claimed.setCookie).not.toContain("Secure");
    expect(claimed.setCookie).not.toContain("Domain=");

    const hello = await rpc(h, "host.hello", { protocolVersion: 1 }, { cookie: claimed.cookie });
    expect(hello.status).toBe(200);
    expect(hello.body.result?.auth).toMatchObject({ kind: "device", deviceName: "Pixel" });

    // AUTHZ-4b：已配对设备**不能**发码/列设备/撤销（否则一台手机可接管所有设备）
    for (const method of ["pair.start", "pair.list", "pair.revoke"]) {
      const denied = await rpc(h, method, { deviceId: claimed.deviceId }, { cookie: claimed.cookie });
      // 已鉴权但无权限：HTTP 仍是 JSON-RPC 200，错误在 body（kind=UNAUTHORIZED）
      expect(denied.body.error?.data?.kind, method).toBe("UNAUTHORIZED");
    }
    expect(JSON.stringify(hello.body)).not.toContain(claimed.token);

    expect(await eventStatus(h, "", claimed.cookie)).toBe(200);
    const cookieName = claimed.cookie.slice(0, claimed.cookie.indexOf("="));
    expect(await eventStatus(h, "", `${cookieName}=${"0".repeat(64)}`)).toBe(401);

    // 失败的 claim 不下发 cookie
    const failed = await rpc(h, "pair.claim", { code: "000000" });
    expect(failed.setCookie).toBe("");
  });

  it("撤销后立即 401、回 Max-Age=0 清理；已建立的 SSE 收到 host.auth.revoked；列表不含 token/hash", async () => {
    const h = await boot(PAIRED);
    const claimed = await claimDevice(h);

    const ac = new AbortController();
    const sse = await fetch(`${h.server.url}/events?sessionId=s1`, {
      signal: ac.signal,
      headers: { cookie: claimed.cookie },
    });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    async function readUntil(needle: string): Promise<void> {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    }
    await readUntil("retry: 2000");

    const listed = await rpc(h, "pair.list", {}, { token: CONTROL });
    expect(listed.body.result?.devices).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(claimed.token);
    expect(JSON.stringify(listed.body)).not.toContain("tokenHash");

    const revoked = await rpc(h, "pair.revoke", { deviceId: claimed.deviceId }, { token: CONTROL });
    expect(revoked.body.result?.revoked).toBe(true);
    await readUntil("auth.revoked");
    expect(text).toContain("host.auth.revoked");
    // 服务端主动结束流
    await reader.cancel().catch(() => undefined);
    ac.abort();

    const after = await rpc(h, "host.hello", { protocolVersion: 1 }, { cookie: claimed.cookie });
    expect(after.status).toBe(401);
    expect(after.setCookie).toContain("Max-Age=0");
    const listAfter = await rpc(h, "pair.list", {}, { token: CONTROL });
    expect(listAfter.body.result?.devices).toHaveLength(0);
  });
});

describe("AUTHZ-5 控制令牌受众隔离", () => {
  it("控制令牌可用于 pair.*，但不能调 hello、不能连 /events", async () => {
    const h = await boot(PAIRED);
    const hello = await rpc(h, "host.hello", { protocolVersion: 1 }, { token: CONTROL });
    expect(hello.body.error?.data?.kind).toBe("UNAUTHORIZED");
    expect(await eventStatus(h, "&token=control-token-1234567890")).toBe(401);
    expect((await rpc(h, "pair.list", {}, { token: CONTROL })).body.result).toBeTruthy();
  });

  it("pair.start 在 local 模式可由本机匿名调用；在 paired 模式未鉴权 401", async () => {
    const local = await boot(LOCAL);
    expect((await rpc(local, "pair.start", {})).body.result?.code).toMatch(/^[0-9]{6}$/);
    const paired = await boot(PAIRED);
    expect((await rpc(paired, "pair.start", {})).status).toBe(401);
  });
});

describe("AUTHZ-6 配对失败错误码", () => {
  it("限速返回 BUSY + retryAfterMs；错误响应不含提交的码", async () => {
    const h = await boot(PAIRED, { maxAttemptsPerWindow: 2, maxAttemptsPerCode: 100 });
    const code = String((await rpc(h, "pair.start", {}, { token: CONTROL })).body.result?.code);
    const wrong = code === "000000" ? "000001" : "000000";
    await rpc(h, "pair.claim", { code: wrong });
    await rpc(h, "pair.claim", { code: wrong });
    const limited = await rpc(h, "pair.claim", { code });
    expect(limited.body.error?.data?.kind).toBe("BUSY");
    expect(limited.body.error?.data?.retryable).toBe(true);
    const details = limited.body.error?.data?.details as { reason?: string; retryAfterMs?: number };
    expect(details.reason).toBe("rate_limited");
    expect(details.retryAfterMs).toBeGreaterThan(0);
    expect(JSON.stringify(limited.body)).not.toContain(code);
    expect(JSON.stringify(limited.body)).not.toContain(wrong);
  });

  it("已用码再次兑换返回 invalid（reason 不区分码是否存在）", async () => {
    const h = await boot({ ...PAIRED }, { maxAttemptsPerWindow: 100, maxAttemptsPerCode: 100 });
    const code = String((await rpc(h, "pair.start", {}, { token: CONTROL })).body.result?.code);
    await rpc(h, "pair.claim", { code });
    const reused = await rpc(h, "pair.claim", { code });
    expect((reused.body.error?.data?.details as { reason?: string })?.reason).toBe("invalid");
  });

  it("缺 code 报 INVALID_PARAMS（不是 INTERNAL）", async () => {
    const h = await boot(LOCAL);
    const reply = await rpc(h, "pair.claim", {});
    expect(reply.body.error?.data?.kind).toBe("INVALID_PARAMS");
    expect(reply.body.error?.message).toContain("code");
  });
});

describe("AUTHZ-7 hello 不泄密", () => {
  it("设备认证下 hello.auth 只有 id/name，没有 token/hash", async () => {
    const h = await boot(PAIRED);
    const claimed = await claimDevice(h);
    const hello = await rpc(h, "host.hello", { protocolVersion: 1 }, { cookie: claimed.cookie });
    const auth = hello.body.result?.auth as Record<string, unknown>;
    expect(auth.kind).toBe("device");
    expect(Object.keys(auth).sort()).toEqual(["deviceId", "deviceName", "kind"]);
  });
});

describe("AUTHZ-8 Secure 只在有 HTTPS 证据时出现", () => {
  it("Origin https → Secure；XFP https → Secure；XFP 取第一个；纯 http → 无 Secure", async () => {
    const h = await boot(PAIRED);
    const host = new URL(h.server.url).host;

    const viaOrigin = await claimDevice(h, { origin: `https://${host}` });
    expect(viaOrigin.setCookie).toContain("; Secure");

    const viaXfp = await claimDevice(h, { "x-forwarded-proto": "https" });
    expect(viaXfp.setCookie).toContain("; Secure");

    const firstWins = await claimDevice(h, { "x-forwarded-proto": "https, http" });
    expect(firstWins.setCookie).toContain("; Secure");

    // XFP 说 http 时它说了算：LAN/本机 http 绝不能带上会被浏览器丢掉的 Secure
    const plainHttp = await claimDevice(h, { "x-forwarded-proto": "http", origin: `https://${host}` });
    expect(plainHttp.setCookie).not.toContain("Secure");

    const noSignal = await claimDevice(h);
    expect(noSignal.setCookie).not.toContain("Secure");
  });
});

describe("AUTHZ-9 cookie 名按数据根区分（不是 hostId）", () => {
  it("两个都以 /host 结尾的数据根 → 名字不同", async () => {
    const base = tempDir();
    extraDirs.push(base);
    // 旧 hostId = host-<hex(dataHome) 末 8 字符>，两个都以 "host" 结尾时会撞成同一个名字
    const a = await boot({ ...PAIRED, dataHome: join(base, "a", "host") });
    const b = await boot({ ...PAIRED, dataHome: join(base, "b", "host") });
    expect(a.config.dataHome.endsWith("host")).toBe(true);
    expect(b.config.dataHome.endsWith("host")).toBe(true);

    const claimedA = await claimDevice(a);
    const claimedB = await claimDevice(b);
    const nameOf = (s: string): string => /codem_device_[0-9a-f]{16}/.exec(s)?.[0] ?? "";
    expect(nameOf(claimedA.setCookie)).toMatch(/^codem_device_[0-9a-f]{16}$/);
    expect(nameOf(claimedA.setCookie)).not.toBe(nameOf(claimedB.setCookie));
    // 名字不同之外，各家的凭据也只认自己的 cookie
    expect(await eventStatus(b, "", claimedA.cookie)).toBe(401);
  });
});

describe("AUTHZ-10 设备凭据不再接受 Bearer / query", () => {
  it("旧 device Bearer 401；无效 Bearer + 有效 cookie 仍按设备认证", async () => {
    const h = await boot(PAIRED);
    const claimed = await claimDevice(h);

    // 迁移前客户端存的是 device token 并放 Bearer；现在必须被拒，否则旧凭据永不清理
    const oldBearer = await rpc(h, "host.hello", { protocolVersion: 1 }, { token: claimed.token });
    expect(oldBearer.status).toBe(401);
    expect(await eventStatus(h, `&token=${claimed.token}`)).toBe(401);

    // 无效 Bearer 不能遮蔽有效 cookie（否则 stale header 会让浏览器"明明显式带了凭据却 401"）
    const mixed = await rpc(h, "host.hello", { protocolVersion: 1 }, { token: "not-a-real-token", cookie: claimed.cookie });
    expect(mixed.status).toBe(200);
    expect(mixed.body.result?.auth).toMatchObject({ kind: "device" });
  });

  it("静态 Bearer 与设备 cookie 同时存在时静态优先（CLI 不受浏览器 cookie 影响）", async () => {
    const h = await boot(STATIC);
    const claimed = await claimDevice(h, {}, "static-secret");
    const hello = await rpc(h, "host.hello", { protocolVersion: 1 }, { token: "static-secret", cookie: claimed.cookie });
    expect(hello.body.result?.auth).toEqual({ kind: "static" });
  });
});

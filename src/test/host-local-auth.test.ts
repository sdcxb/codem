// @vitest-environment node
/**
 * Android 本机 Host 鉴权（`local-auth`）判据（HLA-*）。
 *
 * 这一组同时守**配置**与**线上行为**：
 * - 本机凭据必须是 64 位小写 hex，且不能与静态令牌/控制令牌/远程监听混用（混用即启动失败）；
 * - `local-auth` 下 `/rpc` 与 `/events` **都必须带凭据**（loopback 免鉴权被关闭）；
 * - 凭据只经 `Authorization: Bearer`（RPC）与 `/local-auth` 换来的 HttpOnly cookie（SSE），
 *   **绝不接受查询串**；
 * - `/local-auth`：正确 Bearer → 204 + Set-Cookie；错误/缺失 → 401 且不下发 cookie；
 *   非本模式 → 404；GET → 405；失败限速 → 429；
 * - 任何响应/错误里都不出现凭据值。
 *
 * 假 runtime 只提供 hello/listRuns/diagnostics/subscribe（与 AUTHZ-* 同一套）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HostConfig } from "../../packages/host/src/config";
import { pairingFile, resolveHostConfig } from "../../packages/host/src/config";
import { deviceCookieName, localAuthCookieName, LOCAL_AUTH_COOKIE_MAX_AGE_SEC } from "../../packages/host/src/cookie";
import { PairingService } from "../../packages/host/src/pairing";
import type { HostRuntime } from "../../packages/host/src/runtime";
import { startHostServer, type RunningServer } from "../../packages/host/src/server";

/** 固定的假凭据（**不是**任何真实值；测试里也不打印它） */
const LOCAL_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OTHER_TOKEN = "0".repeat(64);

interface Harness {
  server: RunningServer;
  pairing: PairingService;
  dir: string;
  config: HostConfig;
}

const harnesses: Harness[] = [];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "codem-local-auth-"));
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
    diagnostics: () => ({
      hostId: "host-test",
      version: "test",
      protocolVersion: 1,
      uptimeMs: 0,
      dataHome: "",
      workspaceRoot: "",
      seq: 0,
      runs: [],
      persistFailures: [],
    }),
    subscribe: () => () => undefined,
  } as unknown as HostRuntime;
}

async function boot(overrides: Partial<HostConfig>): Promise<Harness> {
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
  const pairing = await PairingService.open({ filePath: pairingFile(config.dataHome) });
  const server = await startHostServer({ config, runtime: fakeRuntime(), webDir: dir, pairing });
  const harness = { server, pairing, dir, config };
  harnesses.push(harness);
  return harness;
}

function localAuthConfig(extra: Partial<HostConfig> = {}): Partial<HostConfig> {
  return { authMode: "local-auth", localAuthToken: LOCAL_TOKEN, token: "", controlToken: "", ...extra };
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.server.close();
    await h.pairing.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

interface Reply {
  status: number;
  setCookie: string;
  body: string;
  json: {
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: { kind?: string; hint?: string } };
  } | null;
}

async function rpc(
  h: Harness,
  method: string,
  params: Record<string, unknown> = {},
  auth: { token?: string; cookie?: string; query?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.cookie = auth.cookie;
  const query = auth.query ? `?${auth.query}` : "";
  const res = await fetch(`${h.server.url}/rpc${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let json: Reply["json"] = null;
  try {
    json = JSON.parse(text) as Reply["json"];
  } catch {
    json = null;
  }
  return { status: res.status, setCookie: res.headers.get("set-cookie") ?? "", body: text, json };
}

async function localAuthCall(
  h: Harness,
  init: { method?: string; token?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${h.server.url}/local-auth`, {
    method: init.method ?? "POST",
    headers,
    ...(init.method && init.method !== "POST" ? {} : {}),
  });
  const text = await res.text();
  let json: Reply["json"] = null;
  try {
    json = JSON.parse(text) as Reply["json"];
  } catch {
    json = null;
  }
  return { status: res.status, setCookie: res.headers.get("set-cookie") ?? "", body: text, json };
}

async function eventStatus(h: Harness, query = "", cookie?: string): Promise<number> {
  const ac = new AbortController();
  const res = await fetch(`${h.server.url}/events?sessionId=s1${query}`, {
    signal: ac.signal,
    ...(cookie ? { headers: { cookie } } : {}),
  });
  const status = res.status;
  await res.body?.cancel().catch(() => undefined);
  ac.abort();
  return status;
}

/** 从 Set-Cookie 里取 cookie 名/值（名字由数据根哈希决定，测试不硬编码） */
function cookieOf(setCookie: string): { name: string; value: string } {
  const match = /(codem_local_[0-9a-f]{16})=([0-9a-f]{64})/.exec(setCookie);
  return match ? { name: match[1], value: match[2] } : { name: "", value: "" };
}

// ===== 配置 =====

describe("HLA-1 配置：形态与互斥", () => {
  function base(env: NodeJS.ProcessEnv = {}, overrides: Record<string, unknown> = {}) {
    return resolveHostConfig({
      env,
      overrides: { dataHome: join("C:", "tmp", "codem-local-auth-cfg"), dbBin: "node", workspaceRoot: "C:\\w", port: 0, ...overrides },
    });
  }

  it("只给凭据 ⇒ 自动推导 local-auth；默认仍是 local", () => {
    const derived = base({ CODEM_HOST_LOCAL_AUTH: LOCAL_TOKEN });
    expect(derived.authMode).toBe("local-auth");
    expect(derived.localAuthToken).toBe(LOCAL_TOKEN);
    expect(base().authMode).toBe("local");
    expect(base().localAuthToken).toBe("");
  });

  it("缺凭据/形态不对 ⇒ 启动失败，且错误里不含提交值", () => {
    expect(() => base({ CODEM_HOST_AUTH: "local-auth" })).toThrow(/CODEM_HOST_LOCAL_AUTH/);
    for (const bad of ["", "abc", LOCAL_TOKEN.toUpperCase(), LOCAL_TOKEN.slice(0, 63), `${LOCAL_TOKEN}0`]) {
      let message = "";
      try {
        base({ CODEM_HOST_AUTH: "local-auth", CODEM_HOST_LOCAL_AUTH: bad });
        throw new Error("应当拒绝");
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/CODEM_HOST_LOCAL_AUTH/);
      if (bad.length >= 8) expect(message).not.toContain(bad);
    }
  });

  it("与静态令牌/控制令牌/远程监听/非 loopback 绑定互斥", () => {
    expect(() =>
      base({ CODEM_HOST_AUTH: "local-auth", CODEM_HOST_LOCAL_AUTH: LOCAL_TOKEN, CODEM_HOST_TOKEN: "static-secret" }),
    ).toThrow(/CODEM_HOST_TOKEN/);
    expect(() =>
      base({
        CODEM_HOST_AUTH: "local-auth",
        CODEM_HOST_LOCAL_AUTH: LOCAL_TOKEN,
        CODEM_HOST_CONTROL_TOKEN: "control-token-1234567890",
      }),
    ).toThrow(/CODEM_HOST_CONTROL_TOKEN/);
    expect(() =>
      base({ CODEM_HOST_AUTH: "local-auth", CODEM_HOST_LOCAL_AUTH: LOCAL_TOKEN, CODEM_HOST_ALLOW_REMOTE: "1" }),
    ).toThrow(/ALLOW_REMOTE/);
    expect(() =>
      base(
        { CODEM_HOST_AUTH: "local-auth", CODEM_HOST_LOCAL_AUTH: LOCAL_TOKEN },
        { host: "0.0.0.0" },
      ),
    ).toThrow(/loopback/);
  });

  it("反向混用（给了凭据但模式不是 local-auth）也失败，避免静默退回免鉴权", () => {
    expect(() => base({ CODEM_HOST_AUTH: "local", CODEM_HOST_LOCAL_AUTH: LOCAL_TOKEN })).toThrow(/CODEM_HOST_AUTH=local-auth/);
    expect(() =>
      base({ CODEM_HOST_AUTH: "paired", CODEM_HOST_LOCAL_AUTH: LOCAL_TOKEN, CODEM_HOST_TOKEN: "static-secret" }),
    ).toThrow(/CODEM_HOST_AUTH=local-auth/);
  });
});

// ===== 线上行为 =====

describe("HLA-2 local-auth 下 /rpc 与 /events 都必须带凭据", () => {
  it("无凭据：/rpc 401（JSON-RPC UNAUTHORIZED，无 Set-Cookie）；/events 401", async () => {
    const h = await boot(localAuthConfig());
    const reply = await rpc(h, "host.hello", { protocolVersion: 1 });
    expect(reply.status).toBe(401);
    expect(reply.json?.error?.data?.kind).toBe("UNAUTHORIZED");
    expect(reply.setCookie).toBe("");
    expect(await eventStatus(h)).toBe(401);
  });

  it("/rpc 用 Bearer 可用；同一凭据换来的 cookie 也可用于 /rpc", async () => {
    const h = await boot(localAuthConfig());
    const bearer = await rpc(h, "host.hello", { protocolVersion: 1 }, { token: LOCAL_TOKEN });
    expect(bearer.status).toBe(200);
    expect(bearer.json?.result?.auth).toEqual({ kind: "local" });

    const issued = await localAuthCall(h, { token: LOCAL_TOKEN });
    expect(issued.status).toBe(204);
    const cookie = cookieOf(issued.setCookie);
    expect(cookie.name).toMatch(/^codem_local_[0-9a-f]{16}$/);
    expect(cookie.value).toBe(LOCAL_TOKEN);

    const viaCookie = await rpc(h, "host.hello", { protocolVersion: 1 }, { cookie: `${cookie.name}=${cookie.value}` });
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.json?.result?.auth).toEqual({ kind: "local" });
  });

  it("/events 用 cookie 可用（SSE 不带任何 URL 凭据）", async () => {
    const h = await boot(localAuthConfig());
    const issued = await localAuthCall(h, { token: LOCAL_TOKEN });
    const cookie = cookieOf(issued.setCookie);
    expect(await eventStatus(h, "", `${cookie.name}=${cookie.value}`)).toBe(200);
  });

  it("凭据**绝不**接受查询串（/rpc?token= 与 /events?token= 都 401）", async () => {
    const h = await boot(localAuthConfig());
    expect((await rpc(h, "host.hello", { protocolVersion: 1 }, { query: `token=${LOCAL_TOKEN}` })).status).toBe(401);
    expect(await eventStatus(h, `&token=${LOCAL_TOKEN}`)).toBe(401);
  });

  it("错误 cookie → 401 且回 Max-Age=0 清理；旧的设备 cookie 不被接受", async () => {
    const h = await boot(localAuthConfig());
    const issued = await localAuthCall(h, { token: LOCAL_TOKEN });
    const name = cookieOf(issued.setCookie).name;
    expect(name).toMatch(/^codem_local_[0-9a-f]{16}$/);

    const reply = await rpc(h, "host.hello", { protocolVersion: 1 }, { cookie: `${name}=${OTHER_TOKEN}` });
    expect(reply.status).toBe(401);
    expect(reply.setCookie).toContain("Max-Age=0");
    expect(reply.setCookie).toContain(`${name}=`);
    // 设备 cookie 名即便"看起来对"也无效：local-auth 模式不查设备凭据
    expect(
      (await rpc(h, "host.hello", { protocolVersion: 1 }, { cookie: `codem_device_0123456789abcdef=${OTHER_TOKEN}` })).status,
    ).toBe(401);
  });

  it("匿名 pair.claim 被关掉（本模式不用配对码）", async () => {
    const h = await boot(localAuthConfig());
    const claim = await rpc(h, "pair.claim", { code: "123456" });
    expect(claim.status).toBe(401);
    expect(claim.json?.error?.data?.kind).toBe("UNAUTHORIZED");
  });

  it("/healthz 仍匿名（它只暴露 hostId/pid，不是凭据）", async () => {
    const h = await boot(localAuthConfig());
    const res = await fetch(`${h.server.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; hostId?: string; pid?: number };
    expect(body.ok).toBe(true);
    expect(body.hostId).toBe("host-test");
    expect(typeof body.pid).toBe("number");
  });
});

describe("HLA-3 /local-auth 端点行为", () => {
  it("正确 Bearer → 204 + HttpOnly cookie（属性齐全，http 下无 Secure）", async () => {
    const h = await boot(localAuthConfig());
    const issued = await localAuthCall(h, { token: LOCAL_TOKEN });
    expect(issued.status).toBe(204);
    expect(issued.setCookie).toMatch(/^codem_local_[0-9a-f]{16}=[0-9a-f]{64}/);
    expect(issued.setCookie).toContain("Path=/");
    expect(issued.setCookie).toContain("HttpOnly");
    expect(issued.setCookie).toContain("SameSite=Strict");
    expect(issued.setCookie).toMatch(/Max-Age=[0-9]+/);
    expect(issued.setCookie).not.toContain("Secure");
    expect(issued.setCookie).not.toContain("Domain=");
    // 响应体里没有任何凭据（204 本来就是空体）
    expect(issued.body).toBe("");
    expect(issued.body).not.toContain(LOCAL_TOKEN);
  });

  it("缺失/错误 Bearer → 401 且不下发 cookie；GET → 405", async () => {
    const h = await boot(localAuthConfig());
    const missing = await localAuthCall(h);
    expect(missing.status).toBe(401);
    expect(missing.setCookie).toBe("");
    const wrong = await localAuthCall(h, { token: OTHER_TOKEN });
    expect(wrong.status).toBe(401);
    expect(wrong.setCookie).toBe("");
    expect(wrong.body).not.toContain(OTHER_TOKEN);
    expect((await localAuthCall(h, { method: "GET", token: LOCAL_TOKEN })).status).toBe(405);
  });

  it("非 local-auth 模式 → 404（共享 UI 靠它区分要不要本机凭据）", async () => {
    const local = await boot({ authMode: "local", token: "", controlToken: "" });
    expect((await localAuthCall(local, { token: LOCAL_TOKEN })).status).toBe(404);
    const paired = await boot({ authMode: "paired", token: "", controlToken: "control-token-1234567890" });
    expect((await localAuthCall(paired, { token: "control-token-1234567890" })).status).toBe(404);
  });

  it("失败限速：连续错误后连正确凭据也 429", async () => {
    const h = await boot(localAuthConfig());
    for (let i = 0; i < 20; i += 1) {
      expect((await localAuthCall(h, { token: OTHER_TOKEN })).status).toBe(401);
    }
    expect((await localAuthCall(h, { token: LOCAL_TOKEN })).status).toBe(429);
  });
});

describe("HLA-5 启动器与 cookie 命名纪律", () => {
  it("cli.ts 解析后立刻删除环境变量，且启动提示不打印值", () => {
    const cli = readFileSync(join(__dirname, "..", "..", "packages", "host", "src", "cli.ts"), "utf8");
    const deleteAt = cli.indexOf("delete process.env.CODEM_HOST_LOCAL_AUTH");
    expect(deleteAt).toBeGreaterThan(0);
    // 必须在 HostRuntime.create（会拉起子进程）之前删：否则工具子进程会继承它
    expect(deleteAt).toBeLessThan(cli.indexOf("HostRuntime.create"));
    const logLines = cli.split("\n").filter((line) => line.includes("process.stderr.write") || line.includes("console."));
    for (const line of logLines) {
      expect(line).not.toContain("localAuthToken");
      expect(line).not.toContain("config.localAuth");
    }
  });

  it("本机 cookie 名与设备 cookie 名不冲突（同名会互相覆盖）", () => {
    const home = join("data", "com.codem.app");
    expect(localAuthCookieName(home)).toMatch(/^codem_local_[0-9a-f]{16}$/);
    expect(localAuthCookieName(home)).not.toBe(deviceCookieName(home));
    // 有效期只需覆盖一次前台使用（值每次启动都轮换）
    expect(LOCAL_AUTH_COOKIE_MAX_AGE_SEC).toBeGreaterThan(0);
    expect(LOCAL_AUTH_COOKIE_MAX_AGE_SEC).toBeLessThanOrEqual(400 * 24 * 60 * 60);
  });
});

describe("HLA-4 凭据不泄漏", () => {
  it("hello / diagnostics / 401 / 错误信息里都不出现凭据", async () => {
    const h = await boot(localAuthConfig());
    const issued = await localAuthCall(h, { token: LOCAL_TOKEN });
    const cookie = cookieOf(issued.setCookie);
    const header = `${cookie.name}=${cookie.value}`;

    const hello = await rpc(h, "host.hello", { protocolVersion: 1 }, { token: LOCAL_TOKEN });
    const diagnostics = await rpc(h, "host.diagnostics", {}, { token: LOCAL_TOKEN });
    const denied = await rpc(h, "host.hello", { protocolVersion: 1 });

    for (const reply of [hello, diagnostics, denied]) {
      expect(reply.body).not.toContain(LOCAL_TOKEN);
      expect(reply.setCookie).not.toContain(LOCAL_TOKEN);
    }
    // 正确凭据只会出现在 Set-Cookie 里（SSE 通道），不会出现在 JSON 响应体
    expect(issued.setCookie).toContain(LOCAL_TOKEN);
    expect(hello.body).not.toContain(cookie.name);
  });
});

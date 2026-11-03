/**
 * 共享 UI 传输客户端的判据（UIC-*）。
 *
 * 这一层是阶段 2 的地基：手机壳与（未来的）React 组件都靠它说话。
 * 五个必须成立的行为：
 * 1. 请求走 JSON-RPC，成功后返回 `result`；
 * 2. 失败映射成 `HostRpcError`（带 kind/retryable），UI 只判断 retryable；
 * 3. SSE 消息解析成事件、广播给所有订阅者、记录 lastEventId；
 * 4. 解析失败的消息被忽略（不许把坏行当事件）；
 * 5. 单个订阅者抛错不影响其它订阅者；close 之后不再收事件。
 */
import { describe, expect, it } from "vitest";

import { HostRpcError, createHostClient, type EventSourceLike } from "../../packages/ui/src/host-client";

function fakeSource() {
  const state: { onmessage: EventSourceLike["onmessage"]; onerror: EventSourceLike["onerror"]; closed: boolean } = {
    onmessage: null,
    onerror: null,
    closed: false,
  };
  const factory = (_url: string): EventSourceLike => ({
    get onmessage() {
      return state.onmessage;
    },
    set onmessage(v) {
      state.onmessage = v;
    },
    get onerror() {
      return state.onerror;
    },
    set onerror(v) {
      state.onerror = v;
    },
    close() {
      state.closed = true;
    },
  });
  return { state, factory };
}

function jsonResponse(body: unknown) {
  return { json: async () => body } as unknown as Response;
}

describe("UIC-1 rpc", () => {
  it("成功返回 result；失败映射成 HostRpcError", async () => {
    const client = createHostClient({
      baseUrl: "http://127.0.0.1:1/",
      fetchImpl: (async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: 1 } })) as unknown as typeof fetch,
    });
    await expect(client.rpc("host.hello")).resolves.toEqual({ ok: 1 });

    const failing = createHostClient({
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: (async () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32004, message: "会话不存在", data: { kind: "NOT_FOUND", retryable: false } },
        })) as unknown as typeof fetch,
    });
    const err = await failing.rpc("session.get").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostRpcError);
    expect((err as HostRpcError).kind).toBe("NOT_FOUND");
    expect((err as HostRpcError).retryable).toBe(false);
  });
});

describe("UIC-2 事件流", () => {
  it("解析 SSE、广播、记录 lastEventId；坏行被忽略", () => {
    const { state, factory } = fakeSource();
    const seen: Array<{ seq: number; type: string }> = [];
    const statuses: string[] = [];
    const client = createHostClient({
      baseUrl: "http://127.0.0.1:1",
      eventSourceFactory: factory,
      onStatus: (s) => statuses.push(s),
    });
    client.connect("s1");
    const off = client.onEvent((e) => seen.push({ seq: e.seq, type: e.type }));
    state.onmessage?.({ data: JSON.stringify({ seq: 7, sessionId: "s", type: "assistant.text", payload: {} }) });
    state.onmessage?.({ data: "not json" });
    state.onmessage?.({ data: JSON.stringify({ seq: 9, sessionId: "s", type: "run.finished", payload: {} }) });
    expect(seen).toEqual([
      { seq: 7, type: "assistant.text" },
      { seq: 9, type: "run.finished" },
    ]);
    expect(client.lastEventId()).toBe(9);
    expect(client.status()).toBe("connected");
    expect(statuses).toEqual(["connected"]);
    off();
  });

  it("一个订阅者抛错不影响其它订阅者；close 后不再收", () => {
    const { state, factory } = fakeSource();
    const got: number[] = [];
    const client = createHostClient({ baseUrl: "http://127.0.0.1:1", eventSourceFactory: factory });
    client.connect("s1");
    client.onEvent(() => {
      throw new Error("boom");
    });
    client.onEvent((e) => got.push(e.seq));
    state.onmessage?.({ data: JSON.stringify({ seq: 1, sessionId: "s", type: "x", payload: {} }) });
    expect(got).toEqual([1]);
    client.close();
    expect(state.closed).toBe(true);
    expect(client.status()).toBe("disconnected");
  });
});

describe("UIC-3 事件流地址", () => {
  it("设备路径（无 staticToken）URL 不含任何凭据；静态令牌兼容 query", () => {
    const urls: string[] = [];
    const { factory } = fakeSource();
    const withRecorder = (url: string) => {
      urls.push(url);
      return factory(url);
    };
    // 设备凭据走 HttpOnly cookie：同源 EventSource 自动携带，URL 里没有任何 token
    createHostClient({ baseUrl: "http://127.0.0.1:1", eventSourceFactory: withRecorder }).connect("s1");
    expect(urls[0]).not.toContain("token=");
    // 静态令牌是 break-glass 凭据：EventSource 不能带 header，只能沿用 query（既有残余风险）
    createHostClient({
      baseUrl: "http://127.0.0.1:1",
      staticToken: "static-1",
      eventSourceFactory: withRecorder,
    }).connect("s2");
    expect(urls[1]).toContain("token=static-1");
  });
});

describe("UIC-4 撤销通知", () => {
  it("host.auth.revoked → onUnauthorized('revoked')、关闭事件流、不广播", () => {
    const { state, factory } = fakeSource();
    const unauthorized: string[] = [];
    const seen: string[] = [];
    const statuses: string[] = [];
    const client = createHostClient({
      baseUrl: "http://127.0.0.1:1",
      eventSourceFactory: factory,
      onUnauthorized: (reason) => unauthorized.push(reason),
      onStatus: (s) => statuses.push(s),
    });
    client.connect("s1");
    client.onEvent((e) => seen.push(e.type));
    state.onmessage?.({
      data: JSON.stringify({ type: "auth.revoked", method: "host.auth.revoked", reason: "revoked", timestamp: 1 }),
    });
    expect(unauthorized).toEqual(["revoked"]);
    expect(seen).toEqual([]);
    expect(state.closed).toBe(true);
    expect(client.status()).toBe("disconnected");
    expect(statuses).toContain("disconnected");
  });
});

describe("UIC-5 非 JSON-RPC 的 401 也要能识别", () => {
  it("401 + {error:'...'} → HostRpcError UNAUTHORIZED", async () => {
    const client = createHostClient({
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: (async () => ({ status: 401, json: async () => ({ error: "缺少或错误的 token" }) })) as unknown as typeof fetch,
    });
    const err = await client.rpc("host.hello").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostRpcError);
    expect((err as HostRpcError).kind).toBe("UNAUTHORIZED");
  });

  it("401 + 非 JSON body → HostRpcError UNAUTHORIZED（不是 INTERNAL/undefined）", async () => {
    const client = createHostClient({
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: (async () => ({
        status: 401,
        json: async () => {
          throw new Error("not json");
        },
      })) as unknown as typeof fetch,
    });
    const err = await client.rpc("host.hello").catch((e: unknown) => e);
    expect((err as HostRpcError).kind).toBe("UNAUTHORIZED");
    expect((err as HostRpcError).message).toBeTruthy();
  });

  it("data.details 透传（配对 rate_limited 的 retryAfterMs）", async () => {
    const client = createHostClient({
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: (async () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32007,
            message: "配对尝试过于频繁",
            data: { kind: "BUSY", retryable: true, details: { reason: "rate_limited", retryAfterMs: 1200 } },
          },
        })) as unknown as typeof fetch,
    });
    const err = await client.rpc("pair.claim", { code: "123456" }).catch((e: unknown) => e);
    expect((err as HostRpcError).kind).toBe("BUSY");
    expect((err as HostRpcError).details).toEqual({ reason: "rate_limited", retryAfterMs: 1200 });
  });
});

describe("UIC-6 RPC 的凭据契约", () => {
  it("同源 credentials；设备路径不带 Authorization；静态令牌仍是 Bearer", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const recorder = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    }) as unknown as typeof fetch;

    const devicePath = createHostClient({ baseUrl: "http://127.0.0.1:1", fetchImpl: recorder });
    await devicePath.rpc("host.hello");
    expect(seen[0].url).toBe("http://127.0.0.1:1/rpc");
    // 设备凭据由浏览器 cookie 自动携带：显式写 same-origin 是把契约写进代码
    expect(seen[0].init.credentials).toBe("same-origin");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBeUndefined();

    const staticPath = createHostClient({ baseUrl: "http://127.0.0.1:1", staticToken: "static-1", fetchImpl: recorder });
    await staticPath.rpc("host.hello");
    expect((seen[1].init.headers as Record<string, string>).authorization).toBe("Bearer static-1");
    expect(seen[1].init.credentials).toBe("same-origin");
  });
});

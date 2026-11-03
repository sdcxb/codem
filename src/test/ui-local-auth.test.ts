/**
 * 共享 UI 的**本机凭据**判据（UILA-*）。
 *
 * 任务要求（Android 本机页面）：
 * - 从 `#token=<64hex>` 读取后**立刻**从地址栏抹掉，存 sessionStorage（不是 localStorage）；
 * - 凭据只用于 RPC 的 Bearer 与一次 `/local-auth` 换 cookie（SSE），**绝不进 URL 查询串**；
 * - 没有凭据时探测 Host 是否要本机凭据，好让"凭据缺失"与"该走配对门"分开；
 * - 任何一步都不打印凭据。
 *
 * 真机行为在设备用例里；这里钉的是纯函数与请求形状。
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostClient, type EventSourceLike } from "../../packages/ui/src/host-client";
import {
  bootstrapLocalAuth,
  clearLocalAuth,
  probeLocalAuthMode,
  readStoredLocalAuth,
  saveLocalAuth,
  takeLocalAuthFromFragment,
} from "../../packages/ui/src/transport";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY = "codem.localAuth";

function response(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("UILA-1 fragment：读一次、立刻抹掉", () => {
  it("读出 64hex；地址栏不再有 fragment；保留 ?open=；不写 localStorage", () => {
    window.history.replaceState(null, "", `/?open=s1#token=${TOKEN}`);
    const token = takeLocalAuthFromFragment();
    expect(token).toBe(TOKEN);
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?open=s1");
    // 函数本身不负责存储：调用方（browser.tsx）写 sessionStorage
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("畸形值不返回，但 fragment 照样被抹掉（不留残余）", () => {
    window.history.replaceState(null, "", `/#token=${TOKEN.slice(0, 63)}`);
    expect(takeLocalAuthFromFragment()).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("其它 hash 不被破坏（不是 token 的 fragment 原样保留）", () => {
    window.history.replaceState(null, "", "/#section-2");
    expect(takeLocalAuthFromFragment()).toBe("");
    expect(window.location.hash).toBe("#section-2");
  });

  it("没有 fragment 时是空操作", () => {
    window.history.replaceState(null, "", "/?open=s1");
    expect(takeLocalAuthFromFragment()).toBe("");
    expect(window.location.search).toBe("?open=s1");
  });

  it("读取/抹除过程不打印任何日志（更不打印凭据）", () => {
    const spies = ["log", "info", "warn", "error", "debug"].map((level) =>
      vi.spyOn(console, level as "log").mockImplementation(() => undefined),
    );
    window.history.replaceState(null, "", `/#token=${TOKEN}`);
    takeLocalAuthFromFragment();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("UILA-2 sessionStorage 的保存/读取/清理", () => {
  it("只存 sessionStorage；畸形值不存", () => {
    saveLocalAuth(TOKEN);
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readStoredLocalAuth()).toBe(TOKEN);

    sessionStorage.clear();
    saveLocalAuth("not-a-token");
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(readStoredLocalAuth()).toBe("");
  });

  it("存了畸形值时读取返回空串（不把垃圾当凭据）", () => {
    sessionStorage.setItem(KEY, "x".repeat(64));
    expect(readStoredLocalAuth()).toBe("");
  });

  it("清理后读到空串", () => {
    saveLocalAuth(TOKEN);
    clearLocalAuth();
    expect(readStoredLocalAuth()).toBe("");
  });
});

describe("UILA-3 bootstrap：/local-auth 的请求形状与结果映射", () => {
  it("POST /local-auth，Bearer + same-origin + no-store，无 body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response(204);
    }) as unknown as typeof fetch;

    await expect(bootstrapLocalAuth(TOKEN, impl)).resolves.toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/local-auth");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.credentials).toBe("same-origin");
    expect(calls[0].init.cache).toBe("no-store");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].init.body).toBeUndefined();
    // 凭据不在 URL 里（这是本次改造的核心约束）
    expect(calls[0].url).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("状态映射：401/403 → rejected；404/405 → unsupported；网络错误 → unreachable", async () => {
    const status = (code: number) => (async () => response(code)) as unknown as typeof fetch;
    await expect(bootstrapLocalAuth(TOKEN, status(401))).resolves.toBe("rejected");
    await expect(bootstrapLocalAuth(TOKEN, status(403))).resolves.toBe("rejected");
    await expect(bootstrapLocalAuth(TOKEN, status(404))).resolves.toBe("unsupported");
    await expect(bootstrapLocalAuth(TOKEN, status(405))).resolves.toBe("unsupported");
    await expect(
      bootstrapLocalAuth(TOKEN, (async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch),
    ).resolves.toBe("unreachable");
  });

  it("畸形凭据直接拒绝，不发请求", async () => {
    const impl = vi.fn(async () => response(204)) as unknown as typeof fetch;
    await expect(bootstrapLocalAuth("short", impl)).resolves.toBe("rejected");
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("UILA-4 probe：这台 Host 要不要本机凭据", () => {
  it("401/403 ⇒ local-auth；404/405 ⇒ other；网络错误 ⇒ unknown", async () => {
    const status = (code: number) => (async () => response(code)) as unknown as typeof fetch;
    await expect(probeLocalAuthMode(status(401))).resolves.toBe("local-auth");
    await expect(probeLocalAuthMode(status(403))).resolves.toBe("local-auth");
    await expect(probeLocalAuthMode(status(404))).resolves.toBe("other");
    await expect(probeLocalAuthMode(status(405))).resolves.toBe("other");
    await expect(
      probeLocalAuthMode((async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch),
    ).resolves.toBe("unknown");
  });
});

describe("UILA-5 客户端：本机凭据只走 Bearer，事件流 URL 里没有凭据", () => {
  function recorder() {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return { json: async () => ({ jsonrpc: "2.0", id: 1, result: { ok: true } }) } as Response;
    }) as unknown as typeof fetch;
    const urls: string[] = [];
    const eventSourceFactory = (url: string): EventSourceLike => {
      urls.push(url);
      return { onmessage: null, onerror: null, close: () => undefined };
    };
    return { seen, urls, fetchImpl, eventSourceFactory };
  }

  it("RPC 带 Bearer；/events 不带 token；静态令牌仍走 query（既有兼容）", () => {
    const rec = recorder();
    const local = createHostClient({
      baseUrl: "http://127.0.0.1:9",
      localAuthToken: TOKEN,
      fetchImpl: rec.fetchImpl,
      eventSourceFactory: rec.eventSourceFactory,
    });
    void local.rpc("host.hello");
    local.connect("s1");
    expect((rec.seen[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(rec.urls[0]).toBe("http://127.0.0.1:9/events?sessionId=s1");
    expect(rec.urls[0]).not.toContain("token");
    expect(rec.urls[0]).not.toContain(TOKEN);

    const staticClient = createHostClient({
      baseUrl: "http://127.0.0.1:9",
      staticToken: "static-1",
      fetchImpl: rec.fetchImpl,
      eventSourceFactory: rec.eventSourceFactory,
    });
    staticClient.connect("s2");
    expect(rec.urls[1]).toContain("token=static-1");
  });
});

describe("UILA-6 入口顺序：先抹 fragment 再挂载 React", () => {
  it("browser.tsx 在 createRoot 之前读取并抹除 fragment", () => {
    const src = readFileSync("packages/ui/src/browser.tsx", "utf8");
    const read = src.indexOf("takeLocalAuthFromFragment()");
    const mount = src.indexOf("createRoot(el)");
    expect(read).toBeGreaterThan(0);
    expect(mount).toBeGreaterThan(0);
    expect(read).toBeLessThan(mount);
    // 凭据不许进 localStorage（只有静态令牌走那里）
    expect(src).not.toContain("saveHostToken");
    // 引导失败一律走本地错误页，不许退回匿名
    expect(src).toContain("probeLocalAuthMode");
  });
});

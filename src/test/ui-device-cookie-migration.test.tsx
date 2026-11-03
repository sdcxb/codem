/**
 * 设备凭据迁移到 HttpOnly cookie 的接线判据（MIG-*）。
 *
 * 这一组渲染真正的 `MobileApp`，守的是"迁移真的发生"：
 * - MIG-1：localStorage 里的**旧设备 token** 现在会被 Host 拒绝（Bearer 不再接受）⇒
 *   401 后清空 localStorage 并回到配对门（不是永远转圈）；
 * - MIG-2：配对成功**不保存任何 token**，直接靠 nonce 重建 client；重连的 hello
 *   不带 Authorization（设备凭据由浏览器 cookie 自动携带）。
 *
 * 这里不 mock `HostClient`：要证明的正是客户端与迁移后的 Host 契约一致。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileApp } from "../../packages/ui/src/mobile-app";

const LEGACY_DEVICE_TOKEN = "a".repeat(64);

interface Call {
  method: string;
  authorization: string | undefined;
  cookie: string | undefined;
  credentials: string | undefined;
}

function rpcBody(body: unknown, status = 200): Response {
  return { status, json: async () => body } as unknown as Response;
}

function errorBody(message: string, kind: string): unknown {
  return { jsonrpc: "2.0", id: 1, error: { code: -32001, message, data: { kind } } };
}

function success(result: unknown): unknown {
  return { jsonrpc: "2.0", id: 1, result };
}

/** 记录每次 RPC 的方法与凭据头；`handler` 决定返回什么。 */
function mockFetch(handler: (method: string) => Response): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method: body.method ?? "",
        authorization: headers.authorization,
        cookie: headers.cookie,
        credentials: init?.credentials,
      });
      return handler(body.method ?? "");
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("MIG-1 旧 localStorage 设备 token 被清理", () => {
  it("用旧 device token 发 hello → 401 → 清空 localStorage 并显示配对门", async () => {
    localStorage.setItem("codem.hostToken", LEGACY_DEVICE_TOKEN);
    const { calls } = mockFetch(() => rpcBody(errorBody("缺少或错误的凭据", "UNAUTHORIZED"), 401));

    render(<MobileApp />);

    await waitFor(() => expect(screen.getByTestId("pairing-gate")).toBeTruthy());
    // 旧凭据只用来触发一次 401，然后必须从本地消失（否则下次启动继续拿它试）
    expect(localStorage.getItem("codem.hostToken")).toBeNull();
    const hellos = calls.filter((c) => c.method === "host.hello");
    expect(hellos.length).toBeGreaterThanOrEqual(1);
    expect(hellos[0].authorization).toBe(`Bearer ${LEGACY_DEVICE_TOKEN}`);
  });
});

describe("MIG-3 local 模式：旧 token 不进入 SSE URL", () => {
  it("hello 返回 auth=local ⇒ 清掉旧值；重连 hello 不带 Authorization", async () => {
    localStorage.setItem("codem.hostToken", LEGACY_DEVICE_TOKEN);
    const { calls } = mockFetch((method) => {
      if (method === "host.hello") {
        return rpcBody(
          success({
            server: { name: "codem-host", version: "test", protocolVersion: 1, minClientVersion: 1 },
            hostId: "host-1",
            auth: { kind: "local" },
            capabilities: { supported: [], unsupported: [] },
            lease: { holder: "none" },
          }),
        );
      }
      if (method === "session.list") return rpcBody(success({ items: [] }));
      if (method === "workspace.list") return rpcBody(success({ path: ".", entries: [] }));
      return rpcBody(success({}));
    });

    render(<MobileApp />);

    // local 模式没有 401：必须靠 hello 的 auth 认定"这个令牌没用"，否则它会一直留着
    await waitFor(() => expect(localStorage.getItem("codem.hostToken")).toBeNull());
    const hellos = () => calls.filter((c) => c.method === "host.hello");
    await waitFor(() => expect(hellos().length).toBeGreaterThanOrEqual(2));
    expect(hellos()[0].authorization).toBe(`Bearer ${LEGACY_DEVICE_TOKEN}`);
    expect(hellos()[1].authorization).toBeUndefined();
  });
});

describe("MIG-2 配对成功不保存 token，直接重建连接", () => {
  it("claim → onPaired() → 第二次 hello 无 Authorization、同源 credentials", async () => {
    let paired = false;
    const { calls } = mockFetch((method) => {
      if (method === "pair.claim") {
        paired = true;
        return rpcBody(
          success({
            hostId: "host-1",
            deviceId: "dev-12345678",
            device: { id: "dev-12345678", name: "Pixel", platform: "android", createdAt: 1, lastSeenAt: 1 },
          }),
        );
      }
      if (method === "host.hello" && paired) {
        return rpcBody(
          success({
            server: { name: "codem-host", version: "test", protocolVersion: 1, minClientVersion: 1 },
            hostId: "host-1",
            capabilities: { supported: [], unsupported: [] },
            lease: { holder: "none" },
          }),
        );
      }
      if (method === "session.list") return rpcBody(success({ items: [] }));
      if (method === "workspace.list") return rpcBody(success({ path: ".", entries: [] }));
      return rpcBody(errorBody("缺少或错误的凭据", "UNAUTHORIZED"), 401);
    });

    render(<MobileApp />);
    await waitFor(() => expect(screen.getByTestId("pairing-gate")).toBeTruthy());

    fireEvent.change(screen.getByTestId("pairing-code"), { target: { value: "123456" } });
    fireEvent.submit(screen.getByTestId("pairing-submit").closest("form") as HTMLFormElement);

    await waitFor(() => expect(screen.queryByTestId("pairing-gate")).toBeNull());
    await waitFor(() => expect(calls.some((c) => c.method === "session.list")).toBe(true));

    // 设备凭据是 Set-Cookie 的事：客户端什么都不存
    expect(localStorage.getItem("codem.hostToken")).toBeNull();
    expect(JSON.stringify(Object.keys(localStorage))).not.toContain("hostToken");

    // 配对成功后必须重新 hello（nonce 重建 client），且这次不带 Authorization
    const claimIndex = calls.findIndex((c) => c.method === "pair.claim");
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    const afterClaim = calls.slice(claimIndex + 1);
    const reconnectHello = afterClaim.find((c) => c.method === "host.hello");
    expect(reconnectHello).toBeTruthy();
    expect(reconnectHello?.authorization).toBeUndefined();
    expect(reconnectHello?.credentials).toBe("same-origin");
  });
});

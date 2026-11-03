/**
 * 手机配对门（DPAIR-UI-*，D-7）：
 * - 6 位码只进请求体；成功后**不把任何 token 交给上层**（设备凭据在 HttpOnly cookie 里）；
 * - 失败按 reason 给可行动文案，不回显提交的码；
 * - **只有配对码一个入口**：手填访问令牌的表单已删除（静态 token 只留给桌面/CLI）；
 * - 配对码/令牌都不进 URL、不进 localStorage、不打印。
 */
import { readFileSync } from "node:fs";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PairingGate } from "../../packages/ui/src/pairing-gate";

function jsonResponse(body: unknown, status = 200) {
  return { status, json: async () => body } as unknown as Response;
}

function formOf(testId: string): HTMLFormElement {
  const el = screen.getByTestId(testId);
  const form = el.closest("form");
  if (!form) throw new Error("找不到表单");
  return form as HTMLFormElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("DPAIR-UI-1 成功配对", () => {
  it("提交 6 位码 → pair.claim → 只通知上层重建连接；不传 token、不写 localStorage", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          hostId: "host-1",
          deviceId: "dev-12345678",
          device: { id: "dev-12345678", name: "Pixel", platform: "android", createdAt: 1, lastSeenAt: 1 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const onPaired = vi.fn();

    render(<PairingGate baseUrl="http://127.0.0.1:9" onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId("pairing-code"), { target: { value: "123 456" } });
    fireEvent.submit(formOf("pairing-submit"));

    // 无参数：凭据是 Set-Cookie 的事，上层不保存任何东西
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(onPaired).toHaveBeenCalledWith();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/rpc");
    const body = JSON.parse(String(init.body)) as { method: string; params: Record<string, unknown> };
    expect(body.method).toBe("pair.claim");
    expect(body.params.code).toBe("123456");
    expect(localStorage.getItem("codem.hostToken")).toBeNull();
    expect(window.location.search).not.toContain("123456");
    expect(window.location.search).not.toContain("token=");
  });

  it("DPAIR-UI-1b 即使回包里塞了 deviceToken 也不转交（防回归）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            hostId: "host-1",
            deviceId: "dev-12345678",
            // 旧 Host 才会这样回；新客户端必须忽略它
            deviceToken: "a".repeat(64),
            device: { id: "dev-12345678", name: "Pixel", platform: "android", createdAt: 1, lastSeenAt: 1 },
          },
        }),
      ),
    );
    const onPaired = vi.fn();
    render(<PairingGate baseUrl="http://127.0.0.1:9" onPaired={onPaired} />);
    fireEvent.change(screen.getByTestId("pairing-code"), { target: { value: "123456" } });
    fireEvent.submit(formOf("pairing-submit"));

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(onPaired).toHaveBeenCalledWith();
    expect(JSON.stringify(onPaired.mock.calls)).not.toMatch(/[0-9a-f]{64}/);
    expect(localStorage.getItem("codem.hostToken")).toBeNull();
  });
});

describe("DPAIR-UI-2 失败文案", () => {
  const cases: Array<[string, string]> = [
    ["invalid", "配对码不正确"],
    ["expired", "配对码已过期"],
    ["used", "已经用过"],
    ["locked", "错误次数过多"],
    ["device_limit", "设备达到上限"],
  ];

  it.each(cases)("reason=%s 显示可行动文案且不回显码", async (reason, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32001, message: "配对码无效或已过期", data: { kind: "UNAUTHORIZED", details: { reason } } },
          },
          200,
        ),
      ),
    );
    render(<PairingGate baseUrl="http://127.0.0.1:9" onPaired={() => undefined} />);
    fireEvent.change(screen.getByTestId("pairing-code"), { target: { value: "123456" } });
    fireEvent.submit(formOf("pairing-submit"));
    const error = await screen.findByTestId("pairing-error");
    expect(error.textContent).toContain(expected);
    expect(error.textContent).not.toContain("123456");
  });

  it("限速显示剩余秒数", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32007,
            message: "配对尝试过于频繁",
            data: { kind: "BUSY", retryable: true, details: { reason: "rate_limited", retryAfterMs: 4200 } },
          },
        }),
      ),
    );
    render(<PairingGate baseUrl="http://127.0.0.1:9" onPaired={() => undefined} />);
    fireEvent.change(screen.getByTestId("pairing-code"), { target: { value: "123456" } });
    fireEvent.submit(formOf("pairing-submit"));
    expect((await screen.findByTestId("pairing-error")).textContent).toContain("5 秒");
  });

  it("格式不对不发请求", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    render(<PairingGate baseUrl="http://127.0.0.1:9" onPaired={() => undefined} />);
    fireEvent.change(screen.getByTestId("pairing-code"), { target: { value: "12ab" } });
    fireEvent.submit(formOf("pairing-submit"));
    expect((await screen.findByTestId("pairing-error")).textContent).toContain("6 位数字");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("DPAIR-UI-3 只保留配对码入口（源码不变量）", () => {
  it("配对门不再渲染手填令牌；UI 与传输层不再有保存静态令牌的入口", () => {
    const gate = readFileSync("packages/ui/src/pairing-gate.tsx", "utf8");
    expect(gate).not.toContain("pairing-manual-token");
    expect(gate).not.toContain("pairing-manual-submit");
    expect(gate).not.toContain("已有访问令牌");

    const mobile = readFileSync("packages/ui/src/mobile-app.tsx", "utf8");
    expect(mobile).not.toContain("saveHostToken");

    const transport = readFileSync("packages/ui/src/transport.ts", "utf8");
    expect(transport).not.toContain("saveHostToken");
  });
});

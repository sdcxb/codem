/**
 * 共享 UI 的客户端标识判据（CID-1..3）：
 * - 同一浏览器/设备稳定（localStorage），不同设备不同；
 * - `host.hello` 带 deviceName（Host 用它做租约身份，避免同名客户端共用租约）；
 * - `prompt.send` 带 clientId（这样 `LEASE_HELD` 才会真的生效）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { getClientId, remoteTransport } from "../../packages/ui/src/transport";

afterEach(() => localStorage.clear());

describe("CID-1 稳定标识", () => {
  it("首次生成并持久化，第二次相同", () => {
    const a = getClientId();
    expect(a).toMatch(/^client-/);
    expect(getClientId()).toBe(a);
    expect(localStorage.getItem("codem.clientId")).toBe(a);
  });
});

describe("CID-2/3 传给 Host", () => {
  it("hello 带 deviceName；send 带同一个 clientId", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = {
      rpc: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params: params ?? {} });
        if (method === "host.hello") return { hostId: "h1" };
        if (method === "prompt.send") return { runId: "r1" };
        return {};
      },
      onEvent: () => () => undefined,
    };
    const transport = remoteTransport(client as never);
    await transport.hello();
    await transport.send("s1", "hi", "req-1");

    const hello = calls.find((c) => c.method === "host.hello");
    const send = calls.find((c) => c.method === "prompt.send");
    const id = getClientId();
    expect(hello?.params.deviceName).toBe(id);
    expect(send?.params.clientId).toBe(id);
  });
});

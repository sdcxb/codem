/**
 * 桌面「远程网关」设置卡（ADR-0005 M1）：
 * - 启动/停止走 `gateway_start` / `gateway_stop`；
 * - 生成 6 位配对码走 `gateway_pair_start`，只显示在内存；
 * - 停止网关后清空内存里的码（Rust 侧同时清空配对状态）；
 * - 码不落 localStorage。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteGatewaySection } from "../components/RemoteGatewaySection";

const RUNNING = {
  running: true,
  port: 54321,
  url: "http://127.0.0.1:54321",
  pairedDevices: 0,
};
const STOPPED = { running: false, port: 0, url: null, pairedDevices: 0 };

function installTauri(handler: (cmd: string) => Promise<unknown>): void {
  (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke: handler } };
}

afterEach(() => {
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("GW-CARD-1 启停与配对码", () => {
  it("启动后显示地址与 adb reverse；生成分组码且不写 localStorage", async () => {
    const calls: string[] = [];
    let started = false;
    installTauri(async (cmd) => {
      calls.push(cmd);
      if (cmd === "gateway_status") return started ? RUNNING : STOPPED;
      if (cmd === "gateway_start") {
        started = true;
        return RUNNING;
      }
      if (cmd === "gateway_devices") return { devices: [] };
      if (cmd === "gateway_pair_start") {
        return { code: "123456", expiresAt: Date.now() + 300_000, ttlMs: 300_000 };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const view = render(<RemoteGatewaySection zh />);
    fireEvent.click(await screen.findByTestId("gateway-start"));

    expect(await screen.findByTestId("gateway-url")).toHaveTextContent("http://127.0.0.1:54321");
    expect(screen.getByText(/adb reverse tcp:54321 tcp:54321/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("gateway-pair-generate"));
    expect(await screen.findByTestId("gateway-pair-code")).toHaveTextContent("123 456");
    expect(calls).toContain("gateway_pair_start");
    expect(JSON.stringify({ ...localStorage })).not.toContain("123456");
    view.unmount();
  });

  it("停止网关立即清除界面上的码", async () => {
    installTauri(async (cmd) => {
      if (cmd === "gateway_status") return RUNNING;
      if (cmd === "gateway_devices") return { devices: [] };
      if (cmd === "gateway_pair_start") {
        return { code: "654321", expiresAt: Date.now() + 300_000, ttlMs: 300_000 };
      }
      if (cmd === "gateway_stop") return STOPPED;
      throw new Error(`unexpected ${cmd}`);
    });

    const view = render(<RemoteGatewaySection zh />);
    fireEvent.click(await screen.findByTestId("gateway-pair-generate"));
    await screen.findByTestId("gateway-pair-code");

    fireEvent.click(screen.getByTestId("gateway-stop"));
    await waitFor(() => expect(screen.queryByTestId("gateway-pair-code")).toBeNull());
    expect(screen.getByTestId("gateway-start")).toBeTruthy();
    view.unmount();
  });

  it("B2：设备列表可撤销单台；撤销后刷新列表只少它；未知 id 给出可见提示", async () => {
    let devices = [
      { id: "dev-a", name: "Pixel 9", platform: "android", createdAt: 1, lastSeenAt: 2 },
      { id: "dev-b", name: "iPad", platform: "ios", createdAt: 1, lastSeenAt: 3 },
    ];
    const revokeCalls: string[] = [];
    installTauri(async (cmd, args?: Record<string, unknown>) => {
      if (cmd === "gateway_status") return RUNNING;
      if (cmd === "gateway_devices") return { devices };
      if (cmd === "gateway_device_revoke") {
        const id = String((args as { deviceId?: string })?.deviceId ?? "");
        revokeCalls.push(id);
        // dev-b 模拟"服务端记录已不存在"：幂等返回 false，且列表里仍可能被别的标签页显示
        if (id === "dev-b") return { revoked: false };
        const before = devices.length;
        devices = devices.filter((d) => d.id !== id);
        return { revoked: devices.length !== before };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    render(<RemoteGatewaySection zh />);
    expect(await screen.findByText(/Pixel 9/)).toBeTruthy();
    expect(screen.getByText(/iPad/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("gateway-device-revoke-dev-a"));
    await waitFor(() => expect(screen.queryByText(/Pixel 9/)).toBeNull());
    expect(screen.getByText(/iPad/), "只撤销这一台").toBeTruthy();
    expect(revokeCalls).toEqual(["dev-a"]);

    // 未知 id（另一台已被别处撤销）：服务端幂等返回 revoked=false，界面给出可见提示且不崩
    // 用 dev-b 模拟"服务端那条记录已经没了"：列表回给前端时仍显示它，撤销却返回 false。
    fireEvent.click(screen.getByTestId("gateway-device-revoke-dev-b"));
    expect(await screen.findByText(/已不存在|no longer exists/)).toBeTruthy();
  });

  it("B2：自动启动开关默认开，关闭后写设置（下次启动不自动开）", async () => {
    installTauri(async (cmd) => {
      if (cmd === "gateway_status") return STOPPED;
      if (cmd === "gateway_start") return RUNNING;
      if (cmd === "gateway_devices") return { devices: [] };
      throw new Error(`unexpected ${cmd}`);
    });
    render(<RemoteGatewaySection zh />);
    const toggle = (await screen.findByTestId("gateway-autostart")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    // 设置写没写：再挂一次，开关应记住"关"
    render(<RemoteGatewaySection zh />);
    const again = screen.getAllByTestId("gateway-autostart") as HTMLInputElement[];
    expect(again.every((el) => el.checked === false)).toBe(true);
  });
});

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
});

/**
 * 设置 →「设备同步」判据（25 号文 P2 的界面这一半）。
 *
 * ## 守什么
 *
 * - **默认关**：卡片渲染出来时开关是**未勾**的，且一个网络请求都没有（"默认关闭"
 *   是产品承诺，不是文档里的一句话）；
 * - **配对**：填地址 + 6 位码 → 走 `pair.claim`；成功后显示"已配对"，设置里落的是
 *   地址与设备 id（**不是**配对码）；
 * - **开启才联网**：勾上开关后运行时才起来，fake timer 到点真的发 `sync.push`；
 * - **失败可见**：同步报错写在卡片里（`device-sync-error`），不依赖弹窗/横幅。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { setSetting, setSettingJSON } from "../core/storage/settings";
import { createProject } from "../core/storage/project";
import {
  __resetSyncRuntimeForTests,
  configureSyncLocalPorts,
  getSyncConfig,
  getSyncSummary,
  setSyncConfig,
  DEFAULT_SYNC_CONFIG,
} from "../core/storage/sync-engine";
import { DeviceSyncSettings } from "../components/DeviceSyncSettings";

function installFetch(handler: (method: string) => Promise<unknown> | unknown): { calls: string[] } {
  const calls: string[] = [];
  const fake = vi.fn(async (_input: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string };
    calls.push(String(request.method ?? ""));
    const result = await handler(String(request.method ?? ""));
    if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) {
      return { status: 200, ok: true, json: async () => ({ jsonrpc: "2.0", id: request.id ?? 1, ...(result as object) }) };
    }
    return { status: 200, ok: true, json: async () => ({ jsonrpc: "2.0", id: request.id ?? 1, result }) };
  });
  vi.stubGlobal("fetch", fake as unknown as typeof fetch);
  return { calls };
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort() as never);
  __resetSyncRuntimeForTests();
  setSetting("codem-device-id", "dev-ui");
  // 客户端端口用内存实现：这里判的是界面与运行时，不是会话存储
  configureSyncLocalPorts({
    listSessionIds: () => ["sess-ui"],
    readEvents: (sessionId, fromSeq) =>
      sessionId === "sess-ui" && fromSeq <= 1
        ? [{ seq: 1, sessionId, type: "user_message", payload: { text: "界面推的" }, timestamp: 1 }]
        : [],
    appendEvent: () => 1,
    ensureSession: () => true,
    memory: {
      read: async () => ({ ok: true as const, payload: "", deviceId: "dev-ui", entries: 0 }),
      merge: async (payload: string) => ({ ok: true, payload, entries: 0, conflicts: [], changed: false }),
      recordConflicts: async () => 0,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSyncRuntimeForTests();
  configureSyncLocalPorts(null);
  vi.useRealTimers();
});

describe("设置 → 设备同步", () => {
  it("DSU-1: 默认关闭 —— 开关未勾、零网络请求", () => {
    const { calls } = installFetch(() => ({ ok: true }));
    const view = render(<DeviceSyncSettings zh />);
    const toggle = screen.getByTestId("device-sync-enabled") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(getSyncConfig().autoSync).toBe(false);
    expect(getSyncSummary().autoSyncRunning).toBe(false);
    expect(calls).toEqual([]);
    view.unmount();
  });

  it("DSU-2: 填地址 + 6 位码即可配对；设置里不含配对码", async () => {
    const { calls } = installFetch((method) =>
      method === "pair.claim" ? { hostId: "codem-desktop", deviceId: "dev-paired" } : { ok: true },
    );
    const view = render(<DeviceSyncSettings zh />);
    fireEvent.change(screen.getByTestId("device-sync-host-url"), { target: { value: "http://host.test/" } });
    fireEvent.change(screen.getByTestId("device-sync-pair-code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("device-sync-pair"));

    await waitFor(() => expect(screen.getByTestId("device-sync-paired").getAttribute("data-paired")).toBe("1"));
    expect(calls).toEqual(["pair.claim"]);
    const config = getSyncConfig();
    expect(config.backend).toBe("gateway");
    expect(config.gatewayUrl).toBe("http://host.test");
    expect(config.gatewayDeviceId).toBe("dev-paired");
    expect(JSON.stringify(config)).not.toContain("123456");
    view.unmount();
  });

  it("DSU-3: 勾上开关才起自动同步；fake timer 到点真的推送", async () => {
    const { calls } = installFetch(() => ({ accepted: 1, duplicates: 0, rejected: [], hostSeqMax: 1, devices: 1 }));
    const view = render(<DeviceSyncSettings zh />);
    fireEvent.change(screen.getByTestId("device-sync-host-url"), { target: { value: "http://host.test" } });
    setSyncConfig({ ...DEFAULT_SYNC_CONFIG, backend: "gateway", gatewayUrl: "http://host.test" });

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId("device-sync-enabled"));
    expect(getSyncConfig().autoSync).toBe(true);
    expect(getSyncSummary().autoSyncRunning).toBe(true);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toContain("sync.push");
    view.unmount();
  });

  it("DSU-4: 同步失败写在卡片里（不静默、也不假装成功）", async () => {
    installFetch((method) =>
      method === "sync.push"
        ? { error: { code: -32001, message: "设备未配对或凭据已失效（请在设置里重新配对）", data: { kind: "UNAUTHORIZED" } } }
        : { events: [], nextSeq: 0, hasMore: false, devices: 0 },
    );
    const view = render(<DeviceSyncSettings zh />);
    fireEvent.change(screen.getByTestId("device-sync-host-url"), { target: { value: "http://host.test" } });
    setSyncConfig({ ...DEFAULT_SYNC_CONFIG, backend: "gateway", gatewayUrl: "http://host.test" });

    fireEvent.click(screen.getByTestId("device-sync-now"));
    await waitFor(() => expect(screen.getByTestId("device-sync-error")).toBeTruthy());
    expect(screen.getByTestId("device-sync-error").textContent ?? "").toContain("未配对");
    view.unmount();
  });

  it("DSU-5: 项目 allowlist —— 未配对禁用；配对后可勾选、落配置、显示当前限制", async () => {
    createProject({ id: "proj-a", name: "项目 A", path: "C:\\a", createdAt: 1, lastAccessedAt: 1 });
    createProject({ id: "proj-b", name: "项目 B", path: "C:\\b", createdAt: 1, lastAccessedAt: 1 });
    installFetch(() => ({ ok: true }));
    const view = render(<DeviceSyncSettings zh />);

    // 未配对：不可编辑（不是"改了没生效"）
    const projectA = screen.getByTestId("device-sync-project-proj-a") as HTMLInputElement;
    const projectB = screen.getByTestId("device-sync-project-proj-b") as HTMLInputElement;
    expect(projectA.disabled).toBe(true);
    expect(projectB.disabled).toBe(true);
    expect(screen.getByTestId("device-sync-acl-summary").textContent ?? "").toContain("全部项目");

    // 配对后：可编辑；勾 A ⇒ 配置里只允许 A，界面显示「仅 1 个项目」
    setSyncConfig({
      ...DEFAULT_SYNC_CONFIG,
      backend: "gateway",
      gatewayUrl: "http://host.test",
      gatewayDeviceId: "dev-ui",
      gatewayPairedAt: Date.now(),
    });
    await waitFor(() => expect((screen.getByTestId("device-sync-project-proj-a") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("device-sync-project-proj-a"));
    expect(getSyncConfig().projectIds).toEqual(["proj-a"]);
    expect(screen.getByTestId("device-sync-acl-summary").textContent ?? "").toContain("仅 1 个项目");
    view.unmount();
  });

  it("DSU-6: 快照重建与项目过滤的结果在界面上可见（不静默）", () => {
    installFetch(() => ({ ok: true }));
    setSettingJSON("codem-sync-state", {
      lastPushedSeq: 3,
      lastPulledSeq: 9,
      lastSyncAt: Date.now(),
      lastSyncStatus: "success",
      lastResetAt: Date.now(),
      lastResetOldestSeq: 21,
      lastSnapshotAt: Date.now(),
      lastSnapshotSessions: 2,
      lastSnapshotMessages: 17,
      lastFilteredSessions: 1,
      lastProjectSkipped: 1,
    });
    const view = render(<DeviceSyncSettings zh />);
    expect(screen.getByTestId("device-sync-reset").textContent ?? "").toContain("21");
    expect(screen.getByTestId("device-sync-snapshot").textContent ?? "").toContain("17");
    expect(screen.getByTestId("device-sync-acl-filtered").textContent ?? "").toContain("1");
    view.unmount();
  });
});

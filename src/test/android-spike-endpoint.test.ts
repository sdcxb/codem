/**
 * Android spike 脚本的端点判据（SPIKE-EP-*）。
 *
 * 背景：HostSupervisor 每次启动都让内核分配随机端口，并改用 `local-auth`。
 * 旧 spike 脚本里的 `tcp:8787` 会 forward 到空气；这里用源码不变量守住"不再写死 8787"，
 * 以及"APK 托管的 Host 必须走共享的端点发现/RPC helper"。
 *
 * 官方设备用例 `run-device-cases.mjs` 有自己的发现/鉴权实现，不在本判据的扫描范围。
 */
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dir = "android-shell";
const spikes = readdirSync(dir).filter((f) => f.startsWith("spike-") && f.endsWith(".mjs"));
/** 这些脚本的 Host 由 APK 启动，必须用共享 helper（端口发现 + 页面上下文 RPC）。 */
const apkHosted = [
  "spike-local-turn.mjs",
  "spike-real-model.mjs",
  "spike-restart.mjs",
  "spike-selfcontained.mjs",
  "spike-ui-shots.mjs",
];

function read(name: string): string {
  return readFileSync(`${dir}/${name}`, "utf8");
}

describe("SPIKE-EP-1 不再写死 8787", () => {
  it("所有 spike 脚本都没有 tcp:8787 / --port 8787 / 127.0.0.1:8787", () => {
    expect(spikes.length).toBeGreaterThanOrEqual(6);
    for (const name of spikes) {
      const src = read(name);
      expect(src, name).not.toMatch(/tcp:8787\b/);
      expect(src, name).not.toMatch(/--port\s+8787\b/);
      expect(src, name).not.toMatch(/127\.0\.0\.1:8787/);
    }
  });
});

describe("SPIKE-EP-2 APK 托管的 Host 走共享端点 helper", () => {
  it("五个 APK spike 都 import DeviceHostEndpoint", () => {
    for (const name of apkHosted) {
      const src = read(name);
      expect(src, name).toContain("DeviceHostEndpoint");
      expect(src, name).toContain("ensureForward");
    }
  });

  it("手动起 Host 的 spike 用 --port 0 + READY 行取端口，且不再启动 APK", () => {
    const src = read("spike-ondevice-host.mjs");
    expect(src).toContain("--port 0");
    expect(src).toContain('"ready":true');
    expect(src).toContain("ready.port");
    // APK 的 WebView 会连它自己启动的 Host；"手动 Host + APK 页面"不可能同时成立
    expect(src).not.toContain("com.codem.remote/.MainActivity");
  });
});

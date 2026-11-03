/**
 * `FileTransport` 的判据（FT-*）。
 *
 * 这一层是阶段 1 的"正解"：`file-api.ts` 原来硬编码 `window.__TAURI__.core.invoke`，
 * 让 Node Host / 测试 / 未来的 Android 壳都必须伪造 `__TAURI__`（失败信息还会变成
 * "window is not defined"）。现在有显式注入点，就必须有判据证明：
 * 1. 注册后**所有**文件命令都走注册的实现；
 * 2. 没注册且没有 Tauri 时，错误信息必须**说清楚缺什么**（不许 "window is not defined"）；
 * 3. 清除注册能恢复默认（不把测试/宿主的注入泄漏到别处）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { getAppDataDir, getDefaultCwd, hasFileInvoker, setFileInvoker } from "../core/file-api";

afterEach(() => {
  setFileInvoker(null);
});

describe("FT-1 注册后走注入的传输", () => {
  it("命令与参数原样到达，返回值原样返回", async () => {
    const seen: Array<{ command: string; args?: Record<string, unknown> }> = [];
    setFileInvoker({
      invoke: async (command, args) => {
        seen.push({ command, args });
        if (command === "get_default_cwd") return "C:/fake-workspace";
        if (command === "get_app_data_dir") return "C:/fake-data";
        throw new Error(`unexpected ${command}`);
      },
    });
    expect(hasFileInvoker()).toBe(true);
    expect(await getDefaultCwd()).toBe("C:/fake-workspace");
    expect(await getAppDataDir()).toBe("C:/fake-data");
    expect(seen.map((s) => s.command)).toEqual(["get_default_cwd", "get_app_data_dir"]);
  });
});

describe("FT-2 没有传输时的错误必须可诊断", () => {
  it("报「没有文件层传输」并点名命令，而不是 window is not defined", async () => {
    setFileInvoker(null);
    const saved = (globalThis as { __TAURI__?: unknown }).__TAURI__;
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
    try {
      await expect(getDefaultCwd()).rejects.toThrow(/没有文件层传输/);
      await expect(getDefaultCwd()).rejects.toThrow(/get_default_cwd/);
    } finally {
      if (saved !== undefined) (globalThis as { __TAURI__?: unknown }).__TAURI__ = saved;
    }
  });
});

describe("FT-3 清除注册恢复默认", () => {
  it("setFileInvoker(null) 之后 hasFileInvoker 为 false", () => {
    setFileInvoker({ invoke: async () => null });
    expect(hasFileInvoker()).toBe(true);
    setFileInvoker(null);
    expect(hasFileInvoker()).toBe(false);
  });
});

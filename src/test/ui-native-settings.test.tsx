/**
 * 「本机模型设置」共享 UI 入口的判据（UI-NATIVE-1..5）。
 *
 * 三条产品约束：
 * 1. 入口**只在 Android 出现**：桥由 WebView 注入，桌面渲染进程没有这个对象 ⇒ 不渲染按钮；
 *    `src/` 里也不许出现 `CodemNative`（源码不变量）。
 * 2. 页面**拿不到 Key**：摘要按白名单取字段，原生多返回的秘密字段也不会流进 DOM。
 * 3. 入口在 `InfoPanel` 里，**不动 Header 布局**（手机/桌面现有排版不重排）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InfoPanel } from "../../packages/ui/src/info-panel";
import {
  getNativeBridge,
  isNativeHostOrigin,
  keyStateLabel,
  parseLlmSettingsSummary,
  type CodemNativeBridge,
} from "../../packages/ui/src/native-bridge";

const ROOT = join(__dirname, "..", "..");
const SECRET = "sk-test-ui-native-0000";

function transport() {
  return {
    listPlugins: vi.fn(async () => ({ items: [] })),
    hostInfo: vi.fn(async () => ({
      hostId: "host-native",
      supported: ["session.list"],
      unsupported: [],
    })),
  } as never;
}

function bridge(overrides: Record<string, unknown> = {}): CodemNativeBridge {
  return {
    version: 1,
    openLlmSettings: vi.fn(),
    getLlmSettingsSummary: vi.fn(() =>
      JSON.stringify({
        configured: true,
        baseUrl: "https://api.example.com/v1",
        model: "deepseek-chat",
        hasKey: true,
        keyState: "keystore",
        insecureHttp: false,
        ...overrides,
      }),
    ),
  };
}

afterEach(() => {
  delete (globalThis as { CodemNative?: unknown }).CodemNative;
});

describe("UI-NATIVE-1 没有桥 ⇒ 入口不出现（桌面/远程页面的行为）", () => {
  it("InfoPanel 不渲染设置区与按钮", async () => {
    render(<InfoPanel transport={transport()} onClose={() => undefined} bridge={null} />);
    expect(await screen.findByText("host-native")).toBeTruthy();
    expect(screen.queryByTestId("native-llm-settings")).toBeNull();
    expect(screen.queryByTestId("open-native-llm-settings")).toBeNull();
    expect(screen.queryByText("本机模型设置（仅 Android）")).toBeNull();
  });

  it("默认探测：没有 CodemNative 对象 ⇒ 判定为没有桥", () => {
    expect(getNativeBridge()).toBeNull();
    (globalThis as { CodemNative?: unknown }).CodemNative = bridge();
    /*
     * 端口不再固定（Android 外壳每次启动随机端口），所以 happy-dom 的 loopback dev-server
     * origin 也会被认成"本机页面"。真正的门在**原生侧**：只有当前端点端口的页面才注入桥
     * （`android-local-auth` 判据钉住）。TS 侧只负责"本机页面 + 形状完整"。
     */
    expect(isNativeHostOrigin("https://codem.example.com")).toBe(false);
    expect(getNativeBridge("https://codem.example.com")).toBeNull();
  });
});

describe("UI-NATIVE-2 有桥 ⇒ 显示摘要，点「设置」只调用 openLlmSettings", () => {
  it("显示服务地址 / 模型 / Key 状态，且按钮触发一次原生调用", async () => {
    const b = bridge();
    render(<InfoPanel transport={transport()} onClose={() => undefined} bridge={b} />);
    expect(await screen.findByText("https://api.example.com/v1")).toBeTruthy();
    expect(screen.getByText("deepseek-chat")).toBeTruthy();
    expect(screen.getByText("已加密保存")).toBeTruthy();
    const button = screen.getByTestId("open-native-llm-settings");
    fireEvent.click(button);
    expect(b.openLlmSettings).toHaveBeenCalledTimes(1);
    // 摘要里只有"有没有/能不能解"，没有 Key 本身
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("Key 无法解密时如实提示（不装作用能用）", async () => {
    const b = bridge({ keyState: "unreadable" });
    render(<InfoPanel transport={transport()} onClose={() => undefined} bridge={b} />);
    expect(await screen.findByText("无法解密，请重新输入")).toBeTruthy();
  });

  it("http 明文端点给出安全提示", async () => {
    const b = bridge({ baseUrl: "http://10.0.2.2:11434/v1", insecureHttp: true });
    render(<InfoPanel transport={transport()} onClose={() => undefined} bridge={b} />);
    expect(await screen.findByTestId("native-llm-insecure")).toBeTruthy();
  });

  it("原生抛错 / 返回畸形时显示「读取不到」，页面不崩", async () => {
    const b: CodemNativeBridge = {
      version: 1,
      openLlmSettings: vi.fn(),
      getLlmSettingsSummary: vi.fn(() => "not json"),
    };
    const broken = render(<InfoPanel transport={transport()} onClose={() => undefined} bridge={b} />);
    expect(await screen.findByText("读取不到本机配置")).toBeTruthy();
    broken.unmount();

    const throwing: CodemNativeBridge = {
      version: 1,
      openLlmSettings: vi.fn(() => {
        throw new Error("native gone");
      }),
      getLlmSettingsSummary: vi.fn(() => {
        throw new Error("native gone");
      }),
    };
    const view = render(<InfoPanel transport={transport()} onClose={() => undefined} bridge={throwing} />);
    expect(await screen.findByText("读取不到本机配置")).toBeTruthy();
    // 点击也不许把页面带崩
    fireEvent.click(view.getByTestId("open-native-llm-settings"));
    expect(screen.getByTestId("open-native-llm-settings")).toBeTruthy();
  });
});

describe("UI-NATIVE-3 摘要白名单：多返回的秘密字段也不会进 DOM", () => {
  it("解析只取 6 个非秘密字段", () => {
    const parsed = parseLlmSettingsSummary(
      JSON.stringify({
        configured: true,
        baseUrl: "https://api.example.com/v1",
        model: "m",
        hasKey: true,
        keyState: "keystore",
        insecureHttp: false,
        apiKey: SECRET,
        keyHash: "deadbeef",
        last4: "0000",
      }),
    );
    expect(parsed).toEqual({
      configured: true,
      baseUrl: "https://api.example.com/v1",
      model: "m",
      hasKey: true,
      keyState: "keystore",
      insecureHttp: false,
    });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("畸形输入一律拒绝（未知 keyState / 非 JSON / 超长）", () => {
    expect(parseLlmSettingsSummary(`{"keyState":"nope"}`)).toBeNull();
    expect(parseLlmSettingsSummary(`{`)).toBeNull();
    expect(parseLlmSettingsSummary(`[]`)).toBeNull();
    expect(parseLlmSettingsSummary("")).toBeNull();
    expect(parseLlmSettingsSummary("x".repeat(5_000))).toBeNull();
    expect(keyStateLabel({ configured: false, baseUrl: "", model: "", hasKey: false, keyState: "none", insecureHttp: false })).toBe(
      "未保存",
    );
  });
});

describe("UI-NATIVE-4 能力探测：只认 loopback origin + 完整形状", () => {
  it("loopback origin 且两个方法都在 ⇒ 返回桥（端口不固定）", () => {
    const b = bridge();
    (globalThis as { CodemNative?: unknown }).CodemNative = b;
    expect(getNativeBridge("http://127.0.0.1:8787")).toBe(b);
    expect(getNativeBridge("http://localhost:8787")).toBe(b);
    // Android 外壳每次启动随机端口 ⇒ 任何 loopback 端口都必须认
    expect(getNativeBridge("http://127.0.0.1:54321")).toBe(b);
  });

  it("远程/其它 origin 一律不认（远程 PC 页面没有入口）", () => {
    (globalThis as { CodemNative?: unknown }).CodemNative = bridge();
    expect(getNativeBridge("https://codem.example.com")).toBeNull();
    // 非 loopback 主机：即使端口相同也没有桥（桥只属于本机页面）
    expect(getNativeBridge("http://192.168.1.5:8787")).toBeNull();
    expect(getNativeBridge("https://127.0.0.1:54321")).toBeNull();
    expect(getNativeBridge("")).toBeNull();
  });

  it("形状不完整（少了方法）不认，且不因 getter 抛错", () => {
    (globalThis as { CodemNative?: unknown }).CodemNative = { openLlmSettings: () => undefined };
    expect(getNativeBridge("http://127.0.0.1:8787")).toBeNull();
    (globalThis as { CodemNative?: unknown }).CodemNative = { getLlmSettingsSummary: () => "{}" };
    expect(getNativeBridge("http://127.0.0.1:8787")).toBeNull();
  });
});

describe("UI-NATIVE-5 桌面侧源码不变量", () => {
  it("src/ 里不出现 CodemNative（桥只存在于 Android 外壳）", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "test" || name === "node_modules") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts") || name.endsWith(".tsx")) files.push(full);
      }
    };
    walk(join(ROOT, "src"));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), `${file} 不该引用 Android 原生桥`).not.toContain("CodemNative");
    }
  });

  it("桌面入口不渲染 MobileApp / InfoPanel（入口只在手机壳里）", () => {
    const app = readFileSync(join(ROOT, "src", "App.tsx"), "utf8");
    expect(app).not.toContain("packages/ui/src/mobile-app");
    expect(app).not.toContain("packages/ui/src/info-panel");
  });

  it("Header 没有被加按钮（设置入口放在信息面板，手机窄屏排版不变）", () => {
    const components = readFileSync(join(ROOT, "packages", "ui", "src", "components.tsx"), "utf8");
    expect(components).not.toContain("openLlmSettings");
    expect(components).not.toContain("CodemNative");
    expect(components).not.toContain("本机模型设置");
  });
});

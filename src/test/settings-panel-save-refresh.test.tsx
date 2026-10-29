/**
 * 2026-10-17（用户实报）：「保存并刷新模型」在 provider 卡片里**宣称保存、其实不保存凭据**。
 *
 * 用户原话：「卡片里那个是「保存并刷新模型」（只管模型列表）这个不对，会误导用户。」
 *
 * ## 缺陷本体（取证）
 *
 * 那个按钮（`SettingsPanel.tsx` 的 provider 卡片）原来是一条**裸写**：
 *
 * ```ts
 * const newSettings = { ...settings };
 * setSettingJSON("codem-settings", newSettings);
 * window.dispatchEvent(new Event("codem-settings-changed"));
 * ```
 *
 * 它**不经过**同一面板里的规范保存流程 `handleSave()` —— 那条流程带
 * `beginSettingsWriteProbe()`（写后确认）、`buildSavePayload()`（以库值为基座）、
 * 凭据封存与失败提示。真机实测：DeepSeek 卡片里填完 API Key（35 字符）连点两次，
 * 库里**没有** `apiKeySealed`；改点底部「保存设置」才立刻出现。
 * 也就是说：**这个按钮宣称的"保存"对凭据类改动是不成立的**，真正兑现的语义只剩"刷新模型列表"。
 *
 * ## 修法与判据口径
 *
 * 选择**让它名副其实**（标签不变）：先 `handleSave()`，**确认落库之后**才
 * `refreshProviderModels()`。两半都写在标签里，所以两半都必须真的发生 ——
 * 本文件就按这两半分别断言，另外用「只有 `handleSave()` 会写 `codem-identity` / `codem-user`」
 * 把"走的是规范路径"钉住（裸写不会写这两个键）。
 *
 * ## 变异自证（本文件必须能变红）
 *
 * 把实现改回裸写 `setSettingJSON("codem-settings", { ...settings })`：
 *   · `SAVE-REFRESH-1` 的「并刷新」断言全红（裸写不刷新模型列表、不写 dynamic-models）；
 *   · 同一条里的 `codem-identity` / `codem-user` 断言也红（裸写不写这两个键）。
 * 只把 `handleSave()` 换成"不提交 providers 的保存"：payload 断言红。
 * ⚠️ 单看「库里有没有这把新 Key」**不足以**变红：裸写同样会把面板快照整块写下去
 * （面板 state 里已经有新 Key）。所以判据必须同时钉住"规范路径"与"刷新"两件事。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { getSetting, getSettingJSON, setSettingJSON } from "../core/storage/settings";
import { __resetSecretStoreForTests } from "../core/storage/secret-store";
import { __awaitCredentialResealForTests } from "../core/storage/secret-write-guard";
import { SettingsPanel } from "../components/SettingsPanel";

const SETTINGS_KEY = "codem-settings";
const NEW_KEY = "sk-saverefresh-0123456789abcdef";
const BASE_URL = "https://api.deepseek.com/v1";
const NEW_BASE_URL = "https://api.deepseek.com/beta";

/** 只用最小的设置形状：卡片要渲染的 providers + 让 `buildSavePayload` 有库值可依 */
function seedSettings(): void {
  setSettingJSON(SETTINGS_KEY, {
    mode: "api",
    model: "deepseek-chat",
    fontSize: 13,
    language: "zh",
    providers: [
      { id: "deepseek", name: "DeepSeek", apiKey: "", baseUrl: BASE_URL },
      { id: "mimo", name: "MiMo (小米)", apiKey: "", baseUrl: "https://api.mimo.ai/v1" },
    ],
  });
}

/** 模型列表接口的桩：记下请求 URL，回两个模型（刷新那半必须真的打到 provider） */
function stubFetch() {
  const calls: string[] = [];
  const fn = vi.fn(async (url: unknown) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

/** Tauri 桩：只提供封存所需的两条命令（其余返回 null，与"后端没有更多能力"同形） */
function installTauri() {
  const calls: string[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "secret_backend_available") return true;
    if (cmd === "secret_seal") {
      return { sealed: "dsh1:" + Buffer.from(String(args?.plaintext ?? "")).toString("hex") };
    }
    return null;
  };
  (window as any).__TAURI__ = { core: { invoke } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
  return calls;
}

function storedProviders(): Array<Record<string, unknown>> {
  const parsed = getSettingJSON<{ providers?: Array<Record<string, unknown>> } | null>(SETTINGS_KEY, null);
  return parsed?.providers ?? [];
}

function storedDeepSeek(): Record<string, unknown> {
  return storedProviders().find((p) => p.id === "deepseek") ?? {};
}

/** 库里（磁盘形态，未经解封水合）的那一行 */
function rawDeepSeek(): Record<string, unknown> {
  const raw = JSON.parse(getSetting(SETTINGS_KEY) ?? "{}") as {
    providers?: Array<Record<string, unknown>>;
  };
  return (raw.providers ?? []).find((p) => p.id === "deepseek") ?? {};
}

/**
 * 按**卡片**取按钮：每个 provider 卡片都有一颗同名按钮，所以必须先缩到 DeepSeek 那张卡里。
 * 用 `.provider-group`（同一张卡片的既有类名）而不是"第 N 颗按钮"：按位置取会被
 * "某天卡片里多了一个按钮"打红，且红得像功能坏了。
 */
function saveRefreshButton(): HTMLButtonElement {
  const card = screen.getByPlaceholderText("输入 DeepSeek API Key").closest(".provider-group");
  expect(card, "DeepSeek 卡片必须能被定位到").toBeTruthy();
  return within(card as HTMLElement).getByRole("button", { name: "保存并刷新模型" }) as HTMLButtonElement;
}

async function typeDeepSeekKeyAndBase(key: string, base: string): Promise<void> {
  const keyInput = screen.getByPlaceholderText("输入 DeepSeek API Key") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(keyInput, { target: { value: key } });
  });
  const baseField = screen.getByDisplayValue(BASE_URL) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(baseField, { target: { value: base } });
  });
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort());
  /**
   * 每个用例都清一次封存缓存：不然上一个用例封进去的明文会留在 `secret-cache` 里，
   * `getSettingJSON("codem-settings")` 的水合就会把**还没保存**的密钥"读"出来 ——
   * 那正是本文件要防的错结论（把缓存当库）。
   */
  __resetSecretStoreForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  setStoragePort(null);
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("provider 卡片「保存并刷新模型」= 真保存 + 真刷新（用户实报修复）", () => {
  /**
   * 放在文件第一条（不是随手排的）：它要用后端"可封存"这结论，
   * 而 `secret-store` 把 `backendAvailability()` 结论缓存在模块作用域里 ——
   * 先跑无后端的那条会把结论钉成 false，后面这条就再也封不上。
   */
  it("SAVE-REFRESH-2：同一次点击下，凭据按封存形态落库（不是明文）", async () => {
    const invokeCalls = installTauri();
    __resetSecretStoreForTests();
    stubFetch();
    seedSettings();

    render(createElement(SettingsPanel, { onClose: () => {} }));
    await act(async () => {});

    await typeDeepSeekKeyAndBase(NEW_KEY, NEW_BASE_URL);
    await act(async () => {
      fireEvent.click(saveRefreshButton());
    });

    /**
     * 这一条**只钉"封存"这一件事**：不等刷新文案（刷新那半由 SAVE-REFRESH-1 单独钉）。
     * 分开的理由：把两件事串在一条等待上，"刷新没发生"会先超时、把封存结论一起遮住 ——
     * 那就分不清到底是哪一半坏了。
     */
    await waitFor(() => expect(invokeCalls).toContain("secret_seal"));
    await act(async () => {
      await __awaitCredentialResealForTests();
    });
    await waitFor(() => expect(rawDeepSeek().apiKeySealed).toMatch(/^dsh1:/));

    const onDisk = rawDeepSeek();
    expect(onDisk.apiKeySealed, "凭据必须以密文形态落库").toMatch(/^dsh1:/);
    expect(onDisk.apiKey ?? "", "封存后磁盘上不许留明文").toBe("");
    expect(onDisk.baseUrl, "同一次点击里 Base URL 也必须落库").toBe(NEW_BASE_URL);
    expect(invokeCalls, "封存动作必须真的发出去").toContain("secret_seal");
    // 解封水合之后，界面/引擎读到的仍是那把明文（"封存"不等于"读不到"）
    expect(storedDeepSeek().apiKey).toBe(NEW_KEY);
  });

  it("SAVE-REFRESH-1：改了 API Key ⇒ 点它必须走规范保存（值落库 + 写后确认那套副作用）并真的刷新模型列表", async () => {
    const { calls } = stubFetch();
    seedSettings();

    render(createElement(SettingsPanel, { onClose: () => {} }));
    await act(async () => {});

    await typeDeepSeekKeyAndBase(NEW_KEY, NEW_BASE_URL);

    // 反向前提：还没点保存 ⇒ 库里不该出现这把新 Key（证明"落库"是点击造成的）
    expect(storedDeepSeek().apiKey ?? "").toBe("");

    await act(async () => {
      fireEvent.click(saveRefreshButton());
    });
    await waitFor(() => expect(screen.getByText(/获取到 [1-9]\d* 个模型/)).toBeTruthy());
    // 回归：服务器列表 + 内置目录都拿到了，计数不许再写成 0（用户实报“服务器 2 + 内置目录 1”却 0）
    expect(screen.queryByText(/获取到 0 个模型/)).toBeNull();

    // ① 「保存」这一半：值确实落库
    expect(storedDeepSeek().apiKey, "点了「保存」就必须把新 Key 存下去").toBe(NEW_KEY);
    expect(storedDeepSeek().baseUrl).toBe(NEW_BASE_URL);

    // ② 走的是**规范保存流程**：`codem-identity` / `codem-user` 只有 `handleSave()` 会写
    //    （裸写 `setSettingJSON("codem-settings", {...settings})` 不碰这两个键）
    expect(getSettingJSON("codem-identity", null), "必须走 handleSave（它会写 codem-identity）").toBeTruthy();
    expect(getSettingJSON("codem-user", null), "必须走 handleSave（它会写 codem-user）").toBeTruthy();

    // ③ 「并刷新模型」这一半：真的打了 provider 的 /models，且结果进了 dynamic-models
    expect(calls.length, "必须真的请求 provider 的模型列表").toBeGreaterThan(0);
    //    请求的是**刚保存下去的新 Base URL** —— 这同时证明"先保存、后刷新"的次序
    //    （先刷新后保存的话，拉列表用的还是旧地址）
    expect(calls[0]).toBe(NEW_BASE_URL + "/models");
    const dyn = getSettingJSON<Record<string, Array<{ id: string }>>>("codem-dynamic-models", {});
    expect(
      (dyn.deepseek ?? []).some((m) => m.id === "deepseek-chat"),
      "刷新结果必须落进 codem-dynamic-models",
    ).toBe(true);
  });
});

/**
 * 组件渲染测试 — SecretStorageSetting（第 62 轮）
 *
 * 为什么要有这一条：`codem-secrets-plaintext` 这个回退开关**以前只有读点、没有写入方**
 * （静态检测器 SKEY-2 报红）。修好之后，"写入方真的存在"这件事不能只靠 grep 断言 ——
 * 这里真的把组件渲染出来、真的点一下勾选框，看它是否：
 *   1. 把开关写进设置（`codem-secrets-plaintext`）；
 *   2. 调用了回退动作（`secret_unseal`）；
 *   3. 把磁盘上的 `apiKeySealed` 换成了 `apiKey`；
 *   4. 危险动作前**问一次**（拒绝时一个字都不改）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SecretStorageSetting } from "../components/SecretStorageSetting";
import { getSetting } from "../core/storage/settings";
import { __resetSecretStoreForTests, PLAINTEXT_FALLBACK_KEY, SEALED_FIELD } from "../core/storage/secret-store";
import { setSetting } from "../core/storage/settings";
import { getPersistFailures } from "../core/storage/persist-failure";

const SK = "sk-render-abcdefghijklmnopqrst";
const SETTINGS = "codem-settings";

function installTauri() {
  const calls: string[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "secret_backend_available") return true;
    if (cmd === "secret_seal") return { sealed: `dsh1:${Buffer.from(String(args?.plaintext ?? "")).toString("hex")}` };
    if (cmd === "secret_unseal") {
      const hex = String(args?.sealed ?? "").replace(/^dsh1:/, "");
      return { plaintext: Buffer.from(hex, "hex").toString("utf8") };
    }
    return null;
  };
  (window as any).__TAURI__ = { core: { invoke } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
  return { calls };
}

const writeSealedSettings = (plain: string) =>
  setSetting(SETTINGS, JSON.stringify({ mode: "api", providers: [{ id: "deepseek", apiKeySealed: `dsh1:${Buffer.from(plain).toString("hex")}` }] }));

const readRaw = () => JSON.parse(getSetting(SETTINGS) ?? "{}");

/**
 * 装一个 `window.confirm` 桩。
 * ⚠️ happy-dom 里 `window.confirm` **不存在**（`vi.spyOn` 会报 "Received undefined"），
 * 所以必须**赋值**而不是 spy。
 *
 * ⚠️ 第 72 轮更正：这段注释原来写的是"被测组件为什么要把『没有 confirm 就当已确认』
 * 写成一个显式分支" —— 那条分支**已经删掉了**：真机形态是 Tauri 的 dialog 插件把
 * `window.confirm` 换成了**异步插件调用**（返回 Promise，恒为真），
 * 于是"没有 confirm 就当同意"在生产里等价于"一点就开、用户根本没被问过"。
 * 现在组件统一走 `confirmDialog`：**只有明确的 true 才算同意**，拿不到答案 = 不开（fail-closed）。
 */
function stubConfirm(answer: boolean) {
  const fn = vi.fn(() => answer);
  (window as any).confirm = fn;
  return fn;
}

beforeEach(() => {
  __resetSecretStoreForTests();
  localStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  __resetSecretStoreForTests();
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("SecretStorageSetting — 明文回退开关（真渲染）", () => {
  it("未勾选时显示密文状态；勾选后开关落库 + 密文解回明文", async () => {
    const { calls } = installTauri();
    writeSealedSettings(SK);
    stubConfirm(true);

    render(<SecretStorageSetting lang="zh" />);

    const box = screen.getByLabelText("以明文保存 API 密钥") as HTMLInputElement;
    expect(box.checked, "默认必须是加密（不许默认明文）").toBe(false);
    // 状态行要说实话：这里磁盘上有一个密文
    await waitFor(() => expect(screen.getByText(/已用系统加密保存（1 个 provider）/)).toBeInTheDocument());

    fireEvent.click(box);

    await waitFor(() => expect(getSetting(PLAINTEXT_FALLBACK_KEY)).toBe("true"));
    await waitFor(() => expect(calls).toContain("secret_unseal"));
    await waitFor(() => {
      const raw = readRaw();
      expect(raw.providers[0].apiKey).toBe(SK);
      expect(raw.providers[0][SEALED_FIELD]).toBeUndefined();
    });
    await waitFor(() => expect(screen.getByText(/已把 1 个密钥解回明文/)).toBeInTheDocument());
  });

  it("用户在确认框里拒绝 ⇒ 一个字都不改（开关不落库、密文保留）", async () => {
    const { calls } = installTauri();
    writeSealedSettings(SK);
    stubConfirm(false);

    render(<SecretStorageSetting lang="zh" />);
    fireEvent.click(screen.getByLabelText("以明文保存 API 密钥"));

    await new Promise((r) => setTimeout(r, 30));
    expect(getSetting(PLAINTEXT_FALLBACK_KEY), "拒绝之后不许留下开关").toBeNull();
    expect(calls).not.toContain("secret_unseal");
    expect(readRaw().providers[0][SEALED_FIELD], "密文必须原样保留").toBeTruthy();
  });

  /**
   * 第 72 轮新增：**没有确认框 ≠ 用户同意**。
   *
   * 旧实现是 fail-open（`typeof window.confirm !== "function" || window.confirm(...)`），
   * 而真机上 `window.confirm` 被换成返回 Promise 的插件调用 ⇒ 这个式子**永远成立**，
   * 也就是"一点就把明文保存打开了"。现在只有明确的 `true` 才算同意。
   */
  it("环境里没有确认框 ⇒ 一个字都不改（不许把「问不到」当成「用户同意」）", async () => {
    const { calls } = installTauri();
    writeSealedSettings(SK);
    delete (window as any).confirm; // 刻意不提供确认框

    render(<SecretStorageSetting lang="zh" />);
    fireEvent.click(screen.getByLabelText("以明文保存 API 密钥"));

    await new Promise((r) => setTimeout(r, 30));
    expect(getSetting(PLAINTEXT_FALLBACK_KEY), "问不到确认 ⇒ 不许打开明文保存").toBeNull();
    expect(calls).not.toContain("secret_unseal");
    expect(readRaw().providers[0][SEALED_FIELD], "密文必须原样保留").toBeTruthy();
    expect(
      getPersistFailures().map((f) => f.area),
      "而且要在横幅上如实上报（不能点了没反应）",
    ).toContain("ui.confirmDialog");
  });
});

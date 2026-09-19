/**
 * 凭据**写回闸门**的契约（第 62 轮；缺陷是真机复量抓到的，不是推演出来的）
 *
 * ## 被守的那个缺陷
 *
 * 已安装的 1.16.102 上量到：
 *
 * ```text
 * [secrets] 已把 1 个 provider 的密钥改为系统加密保存
 * [secrets] 已回收旧明文的字节残留（WAL 折叠 + 整库重写）
 * CLI 直读库文件：has apiKey: True（sk- 前缀，长 35）   has apiKeySealed: True（长 529）
 * ```
 *
 * 也就是说**封存被自己仓库里的另一段代码撤销了**：
 * 全项目有 14 处「读整份 `codem-settings` → 改一个字段 → 整份写回」，
 * 而读出来的那份是**水合过**的（`apiKey` = 内存明文）——
 * 于是"改一下模型名"就等于"把明文密钥重新写回磁盘"。
 *
 * 用例把两侧都钉住：**读改写不许泄露明文**（WGUARD-1）、
 * **新填的密钥不许丢**且要自动补封存（WGUARD-2）、
 * **用户选明文/后端不可用时不许多事**（WGUARD-3/4）、
 * **回退成明文不许被闸门改回密文**（WGUARD-5）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getSetting, getSettingJSON, setSetting, setSettingJSON } from "../core/storage/settings";
import {
  __resetSecretStoreForTests,
  hydrateSealedProviderKeys,
  migrateProviderKeysToSealed,
  PLAINTEXT_FALLBACK_KEY,
  revertSealedKeysToPlaintext,
  SEALED_FIELD,
} from "../core/storage/secret-store";
import { __awaitCredentialResealForTests } from "../core/storage/secret-write-guard";

const SK = "sk-abcdefghijklmnopqrstuvwx";
const SK2 = "sk-brandnew-0123456789abcdef";
const SETTINGS = "codem-settings";
const sealedOf = (plain: string) => `dsh1:${Buffer.from(plain).toString("hex")}`;

function installTauri(opts: { available?: boolean } = {}) {
  const calls: string[] = [];
  const available = opts.available !== false;
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "secret_backend_available") return available;
    if (cmd === "secret_seal") return { sealed: sealedOf(String(args?.plaintext ?? "")) };
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

const writeRaw = (providers: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  setSetting(SETTINGS, JSON.stringify({ mode: "api", model: "deepseek-v4-flash", providers, ...extra }));
const readRaw = () => JSON.parse(getSetting(SETTINGS) ?? "{}");

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

describe("WGUARD：写回闸门", () => {
  it("WGUARD-1: 封存后的读改写（改模型名）**不许**把明文重新写回磁盘 —— 真机那个缺陷的正身", async () => {
    installTauri();
    writeRaw([{ id: "deepseek", apiKeySealed: sealedOf(SK), baseUrl: "https://api.deepseek.com" }]);
    await hydrateSealedProviderKeys();

    // 真机上的写法（`App.tsx:1316-1318` 逐字同形）：读整份（水合 ⇒ apiKey 是明文）再整份写回
    const hydrated = getSettingJSON<any>(SETTINGS, {});
    expect(hydrated.providers[0].apiKey, "读点必须拿得到明文（否则请求会没有 key）").toBe(SK);
    setSettingJSON(SETTINGS, { ...hydrated, model: "deepseek-v4-flash" });

    const raw = readRaw();
    expect(raw.model, "改动本身要生效").toBe("deepseek-v4-flash");
    expect(raw.providers[0].apiKey, "写回后磁盘上**不许**有明文").toBeUndefined();
    expect(raw.providers[0][SEALED_FIELD], "密文必须还在").toBe(sealedOf(SK));
    expect(JSON.stringify(raw)).not.toContain(SK);
    // 读点仍然拿得到明文（内存缓存没被写回搞坏）
    expect(getSettingJSON<any>(SETTINGS, {}).providers[0].apiKey).toBe(SK);
  });

  it("WGUARD-2: 新填的密钥先落盘（绝不丢），随后自动补封存", async () => {
    const { calls } = installTauri();
    // 先有一个已封存的 provider，闸门处于"允许回封"状态
    writeRaw([{ id: "deepseek", apiKeySealed: sealedOf(SK) }]);
    await hydrateSealedProviderKeys();

    setSettingJSON(SETTINGS, {
      ...getSettingJSON<any>(SETTINGS, {}),
      providers: [
        { id: "deepseek", apiKeySealed: sealedOf(SK) },
        { id: "openai", apiKey: SK2, baseUrl: "https://api.openai.com" }, // 用户刚填的
      ],
    });

    // 补封存是异步的：等它跑完
    await __awaitCredentialResealForTests();

    const raw = readRaw();
    const openai = raw.providers.find((p: any) => p.id === "openai");
    expect(calls).toContain("secret_seal");
    expect(openai.apiKey, "补封存之后磁盘上不该还有明文").toBeUndefined();
    expect(openai[SEALED_FIELD], "新密钥要变成密文").toBe(sealedOf(SK2));
    expect(JSON.stringify(raw)).not.toContain(SK2);
    // 新密钥仍然可用（缓存里有明文）
    const openaiViaRead = getSettingJSON<any>(SETTINGS, {}).providers.find((p: any) => p.id === "openai");
    expect(openaiViaRead.apiKey).toBe(SK2);
  });

  it("WGUARD-3: 用户显式选明文 ⇒ 闸门一步都不做（选择不许被悄悄撤销）", async () => {
    const { calls } = installTauri();
    writeRaw([{ id: "deepseek", apiKeySealed: sealedOf(SK) }]);
    await hydrateSealedProviderKeys();
    setSetting(PLAINTEXT_FALLBACK_KEY, "true");

    const hydrated = getSettingJSON<any>(SETTINGS, {});
    setSettingJSON(SETTINGS, { ...hydrated, model: "x" });

    const raw = readRaw();
    expect(raw.providers[0].apiKey, "用户要明文，就必须是明文").toBe(SK);
    expect(calls.filter((c) => c === "secret_seal").length, "不许偷偷封存").toBe(0);
  });

  it("WGUARD-4: 没有可用的系统加密 ⇒ 不碰（明文保持，由启动流程如实上报）", async () => {
    installTauri({ available: false });
    writeRaw([{ id: "deepseek", apiKey: SK }]);
    await hydrateSealedProviderKeys();

    setSettingJSON(SETTINGS, { ...getSettingJSON<any>(SETTINGS, {}), model: "y" });
    await __awaitCredentialResealForTests();

    const raw = readRaw();
    expect(raw.model).toBe("y");
    expect(raw.providers[0].apiKey, "后端不可用时不许动它（动了就是丢密钥）").toBe(SK);
    expect(raw.providers[0][SEALED_FIELD]).toBeUndefined();
  });

  it("WGUARD-5: 回退成明文之后，紧接着的读改写**不许**把它又封回去", async () => {
    installTauri();
    writeRaw([{ id: "deepseek", apiKeySealed: sealedOf(SK) }]);
    setSetting(PLAINTEXT_FALLBACK_KEY, "true");
    const reverted = await revertSealedKeysToPlaintext();
    expect(reverted).toMatchObject({ reverted: 1 });

    // 用户随后改了模型（又一次读改写）
    setSettingJSON(SETTINGS, { ...getSettingJSON<any>(SETTINGS, {}), model: "deepseek-v4-flash" });

    const raw = readRaw();
    expect(raw.providers[0].apiKey, "回退之后就该一直是明文（直到用户关掉开关）").toBe(SK);
    expect(raw.providers[0][SEALED_FIELD]).toBeUndefined();

    // 关掉开关之后的读改写才应该重新封存
    setSetting(PLAINTEXT_FALLBACK_KEY, "false");
    await migrateProviderKeysToSealed();
    expect(readRaw().providers[0].apiKey).toBeUndefined();
    expect(readRaw().providers[0][SEALED_FIELD]).toBeTruthy();
  });

  it("WGUARD-6: 损坏库恢复那条**裸写**路径也要过闸门（否则恢复 = 把明文密钥请回来）", async () => {
    const { gateSettingsRawWrite } = await import("../core/storage/secret-write-guard");
    installTauri();
    writeRaw([{ id: "deepseek", apiKeySealed: sealedOf(SK) }]);
    await hydrateSealedProviderKeys();

    // 旧库里恢复出来的原文（明文形式）
    const recovered = JSON.stringify({ mode: "api", providers: [{ id: "deepseek", apiKey: SK }] });
    const gated = gateSettingsRawWrite(SETTINGS, recovered);
    const parsed = JSON.parse(gated);
    expect(parsed.providers[0].apiKey, "恢复的明文要被换回密文").toBeUndefined();
    expect(parsed.providers[0][SEALED_FIELD]).toBe(sealedOf(SK));
    // 不是 codem-settings 的键一个字不许改
    expect(gateSettingsRawWrite("codem-other", "not json at all")).toBe("not json at all");
    // 解析不了就原样返回（不猜、不改坏）
    expect(gateSettingsRawWrite(SETTINGS, "{ 坏 JSON")).toBe("{ 坏 JSON");

    // 接线也得钉住：恢复路径必须真的调用它（不然上面那条就是这个函数自己的独角戏）
    const src = readFileSync(join(__dirname, "..", "core", "storage", "recovery-restore.ts"), "utf8");
    expect(src.includes("gateSettingsRawWrite(key, value)"), "恢复设置的裸写必须过闸门").toBe(true);
  });

  /**
   * **对照组**：把闸门摘掉（`__resetCredentialWriteGuardForTests`），同一个读改写
   * 就必须**真的泄露明文**。
   *
   * 为什么必须有这一条：只断言"写回后没有明文"是不够的 —— 那句话也可能因为
   * **别的原因**成立（例如水合根本没生效、或者写压根没落盘）。对照组证明
   * "WGUARD-1 之所以为绿，是因为闸门在做事"。
   *
   * ⚠️ 它必须放在**最后**：摘掉钩子之后本文件后续用例都会失去闸门（模块级钩子只装一次）。
   */
  it("WGUARD-0（对照组）: 摘掉闸门 ⇒ 同一个读改写会把明文写回磁盘（= 修之前的行为）", async () => {
    installTauri();
    writeRaw([{ id: "deepseek", apiKeySealed: sealedOf(SK) }]);
    await hydrateSealedProviderKeys();
    const { __resetCredentialWriteGuardForTests } = await import("../core/storage/secret-write-guard");
    __resetCredentialWriteGuardForTests();

    setSettingJSON(SETTINGS, { ...getSettingJSON<any>(SETTINGS, {}), model: "control" });

    const raw = readRaw();
    expect(raw.model).toBe("control");
    expect(raw.providers[0].apiKey, "没有闸门时明文确实会回到磁盘上（真机实测就是这样）").toBe(SK);
  });
});

/**
 * 凭据封存的**水合与迁移**契约（第 62 轮；方案 `docs/CREDENTIALS-PLAN.md` 阶段 1）
 *
 * 这一组用例守的是"改真实密钥存储"这件事的**安全边界**，所以每条都对应方案第 5 节的一条验收判据：
 *
 * | 用例 | 判据 |
 * | --- | --- |
 * | SEAL-1 | 有密文时，读设置拿到的是**内存明文**（磁盘不改） |
 * | SEAL-2 | 水合**只**对 `codem-settings` 生效，其它键一个字不动 |
 * | SEAL-3 | 迁移：封存成功后**一次原子写回**，磁盘上 `apiKey` 没了、`apiKeySealed` 在；内存仍拿得到明文 |
 * | SEAL-4 | 后端不可用 ⇒ **不改动**（继续保持明文），且原因可查 |
 * | SEAL-5 | 任一 provider 封存失败 ⇒ **整体不改动**（不允许"一半明文一半密文"） |
 * | SEAL-6 | 明文回退开关 ⇒ 不改动 |
 * | SEAL-7 | 解封失败 ⇒ **保留密文**（只是该 provider 本次不可用） |
 * | SEAL-8 | 回退：开关打开 → 密文解回明文（一次原子写回），之后不再封存 |
 * | SEAL-9 | 回退的闸门：开关没打开就**不动**；解不开就**整体不动** |
 * | SEAL-10 | `secretStorageStatus()` 是实况（明文/密文/解不开/后端/选择） |
 * | SEAL-11 | `ensureSecretsHydrated()` 单飞：并发调用只解封一次 |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSetting, getSettingJSON, setSetting } from "../core/storage/settings";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import {
  __resetSecretStoreForTests,
  backendAvailability,
  ensureSecretsHydrated,
  hydrateSealedProviderKeys,
  isSealedKeyUnreadable,
  migrateProviderKeysToSealed,
  PLAINTEXT_FALLBACK_KEY,
  reclaimSealedPlaintextResidue,
  revertSealedKeysToPlaintext,
  SEALED_FIELD,
  secretStorageStatus,
} from "../core/storage/secret-store";
const SK = "sk-abcdefghijklmnopqrstuvwx";
const SK2 = "sk-brandnew-0123456789abcdef";
const SK_OLD = "sk-previous-key-0123456789";
const SETTINGS = "codem-settings";

/** 装一个 Tauri 桩：`seal` 只是加前缀（测试里不需要真加密，语义是"可逆 + 不出现明文"） */
function installTauri(opts: { available?: boolean; failSealFor?: string[]; failUnseal?: boolean } = {}) {
  const calls: string[] = [];
  const available = opts.available !== false;
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "secret_backend_available") return available;
    if (cmd === "secret_seal") {
      const plain = String(args?.plaintext ?? "");
      if (opts.failSealFor?.some((s) => plain.includes(s))) throw new Error("UNAVAILABLE: seal failed");
      return { sealed: `dsh1:${Buffer.from(plain).toString("hex")}` };
    }
    if (cmd === "secret_unseal") {
      if (opts.failUnseal) throw new Error("UNAVAILABLE: unseal failed");
      const hex = String(args?.sealed ?? "").replace(/^dsh1:/, "");
      return { plaintext: Buffer.from(hex, "hex").toString("utf8") };
    }
    return null;
  };
  (window as any).__TAURI__ = { core: { invoke } };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
  return { calls };
}

const writeSettings = (providers: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  setSetting(SETTINGS, JSON.stringify({ mode: "api", model: "deepseek-v4-flash", providers, ...extra }));

const readRaw = () => JSON.parse(getSetting(SETTINGS) ?? "{}");

beforeEach(() => {
  __resetSecretStoreForTests();
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  __resetSecretStoreForTests();
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("SEAL：凭据水合", () => {
  it("SEAL-1: 有密文 → 读设置拿到内存明文；磁盘仍是密文", async () => {
    installTauri();
    const sealed = `dsh1:${Buffer.from(SK).toString("hex")}`;
    writeSettings([{ id: "deepseek", apiKeySealed: sealed, baseUrl: "https://api.deepseek.com" }]);

    const out = await hydrateSealedProviderKeys();
    expect(out.unsealed).toBe(1);

    const viaApi = getSettingJSON<any>(SETTINGS, {});
    expect(viaApi.providers[0].apiKey, "读点必须拿到明文（否则界面显示已配置、请求却没有 key）").toBe(SK);
    expect(readRaw().providers[0].apiKey, "磁盘上不许出现明文").toBeUndefined();
    expect(readRaw().providers[0][SEALED_FIELD]).toBe(sealed);
  });

  it("SEAL-2: 水合只对 codem-settings 生效，其它键一个字不动", () => {
    installTauri();
    setSetting("codem-other", JSON.stringify({ providers: [{ id: "deepseek", apiKey: "another-key" }] }));
    expect(getSettingJSON<any>("codem-other", {}).providers[0].apiKey).toBe("another-key");
  });
});

describe("SEAL：迁移", () => {
  it("SEAL-3: 封存成功 → 一次原子写回（明文出、密文进），内存仍拿得到明文", async () => {
    const { calls } = installTauri();
    writeSettings([
      { id: "deepseek", apiKey: SK, baseUrl: "https://api.deepseek.com" },
      { id: "openai", apiKey: "sk-openai-0123456789abcdef", baseUrl: "https://api.openai.com" },
    ]);

    const out = await migrateProviderKeysToSealed();
    expect(out).toMatchObject({ sealed: 2, failed: 0, skippedUnavailable: 0, skippedByChoice: 0 });

    const raw = readRaw();
    expect(raw.providers.every((p: any) => p.apiKey === undefined), "磁盘上不许再有明文 apiKey").toBe(true);
    expect(raw.providers.every((p: any) => typeof p[SEALED_FIELD] === "string"), "每个 provider 都要有密文").toBe(true);
    expect(JSON.stringify(raw)).not.toContain(SK);
    // 非凭据字段不许被动
    expect(raw.model).toBe("deepseek-v4-flash");
    expect(raw.providers[0].baseUrl).toBe("https://api.deepseek.com");
    // 迁移后读点仍拿得到明文（内存缓存）
    expect(getSettingJSON<any>(SETTINGS, {}).providers[0].apiKey).toBe(SK);
    // 至少封存过一次（且不是"假封存"）
    expect(calls.filter((c) => c === "secret_seal").length).toBeGreaterThanOrEqual(2);
  });

  it("SEAL-4: 后端不可用 ⇒ 不改动（继续明文），原因可查", async () => {
    installTauri({ available: false });
    writeSettings([{ id: "deepseek", apiKey: SK }]);

    const out = await migrateProviderKeysToSealed();
    expect(out).toMatchObject({ sealed: 0, skippedUnavailable: 1 });
    expect(readRaw().providers[0].apiKey, "不可用时绝不能动它（否则密钥就没了）").toBe(SK);
    expect(backendAvailability(), "还要能说出'这台机器没有可用的系统加密'").toBe(false);
  });

  it("SEAL-5: 任一 provider 封存失败 ⇒ **整体不改动**（不许出现半迁移）", async () => {
    installTauri({ failSealFor: ["sk-openai"] });
    writeSettings([
      { id: "deepseek", apiKey: SK },
      { id: "openai", apiKey: "sk-openai-0123456789abcdef" },
    ]);

    const out = await migrateProviderKeysToSealed();
    expect(out.sealed).toBe(0);
    expect(out.failed).toBe(2);
    const raw = readRaw();
    expect(raw.providers[0].apiKey, "一个失败就整体保持原样").toBe(SK);
    expect(raw.providers[1].apiKey).toBe("sk-openai-0123456789abcdef");
    expect(raw.providers.some((p: any) => p[SEALED_FIELD])).toBe(false);
  });

  it("SEAL-6: 明文回退开关 ⇒ 不改动（并如实计数）", async () => {
    installTauri();
    setSetting(PLAINTEXT_FALLBACK_KEY, "true");
    writeSettings([{ id: "deepseek", apiKey: SK }]);

    const out = await migrateProviderKeysToSealed();
    expect(out).toMatchObject({ sealed: 0, skippedByChoice: 1 });
    expect(readRaw().providers[0].apiKey).toBe(SK);
  });

  it("SEAL-7: 解封失败 ⇒ **保留密文**，只是该 provider 本次不可用", async () => {
    installTauri({ failUnseal: true });
    const sealed = `dsh1:${Buffer.from(SK).toString("hex")}`;
    writeSettings([{ id: "deepseek", apiKeySealed: sealed }]);

    const out = await hydrateSealedProviderKeys();
    expect(out).toMatchObject({ unsealed: 0, failed: 1 });
    expect(isSealedKeyUnreadable("deepseek")).toBe(true);
    expect(readRaw().providers[0][SEALED_FIELD], "解不开也必须把密文留着").toBe(sealed);
    expect(getSettingJSON<any>(SETTINGS, {}).providers[0].apiKey, "解不开时不许编一个 key 出来").toBeUndefined();
  });
});

/**
 * 第 62 轮补：回退（方案第 4 节"回退（用户/staff 可执行）"）。
 *
 * 这一组用例存在的理由：**回退能力此前是假的** —— `codem-secrets-plaintext` 只有读点、
 * 没有任何写入方，接口上一处都没有，于是"用户可以显式选择明文"只是方案里的句子。
 * 现在写入方在「设置 → 安全」的 `SecretStorageSetting`，动作在 `revertSealedKeysToPlaintext`。
 */
describe("SEAL：回退（明文路径必须真的能走）", () => {
  const sealedOf = (plain: string) => `dsh1:${Buffer.from(plain).toString("hex")}`;

  it("SEAL-8: 开关打开 → 密文解回明文（一次原子写回），且之后不再封存", async () => {
    installTauri();
    writeSettings([{ id: "deepseek", apiKeySealed: sealedOf(SK), baseUrl: "https://api.deepseek.com" }]);
    setSetting(PLAINTEXT_FALLBACK_KEY, "true");

    const out = await revertSealedKeysToPlaintext();
    expect(out).toMatchObject({ reverted: 1, failed: 0 });
    expect(out.reason).toBeUndefined();

    const raw = readRaw();
    expect(raw.providers[0].apiKey, "明文必须回到磁盘上（这是用户明确要求的）").toBe(SK);
    expect(raw.providers[0][SEALED_FIELD], "密文要清掉，否则下次启动又会被解封").toBeUndefined();
    expect(raw.providers[0].baseUrl, "非凭据字段不许被动").toBe("https://api.deepseek.com");

    // 回退之后迁移必须**不再把它封回去**（否则开关等于没用）
    const again = await migrateProviderKeysToSealed();
    expect(again).toMatchObject({ sealed: 0, skippedByChoice: 1 });
    expect(readRaw().providers[0].apiKey).toBe(SK);
  });

  it("SEAL-9: 回退闸门 —— 开关没打开不动；一个解不开就整体不动", async () => {
    // ① 开关没开（默认）：即使有密文也不许把明文写回磁盘
    installTauri();
    writeSettings([{ id: "deepseek", apiKeySealed: sealedOf(SK) }]);
    const refused = await revertSealedKeysToPlaintext();
    expect(refused).toMatchObject({ reverted: 0, reason: "disabled" });
    expect(readRaw().providers[0].apiKey, "没有用户明确要求，明文绝不能落盘").toBeUndefined();
    expect(readRaw().providers[0][SEALED_FIELD]).toBe(sealedOf(SK));

    // ② 开关打开，但其中一个解不开（例如换了 Windows 账户）⇒ 整体不动，并报"解不开"而不是"成功"
    __resetSecretStoreForTests();
    delete (window as any).__TAURI__;
    installTauri({ failUnseal: true });
    setSetting(PLAINTEXT_FALLBACK_KEY, "true");
    const failed = await revertSealedKeysToPlaintext();
    expect(failed).toMatchObject({ reverted: 0, failed: 1, reason: "unreadable" });
    const raw = readRaw();
    expect(raw.providers[0].apiKey).toBeUndefined();
    expect(raw.providers[0][SEALED_FIELD], "解不开时密文必须原样保留").toBe(sealedOf(SK));
  });

  it("SEAL-10: secretStorageStatus() 报的是实况（明文/密文/解不开/后端/用户选择）", async () => {
    installTauri();
    writeSettings([
      { id: "deepseek", apiKeySealed: sealedOf(SK) },
      { id: "openai", apiKey: "sk-openai-0123456789abcdef" },
      { id: "empty", baseUrl: "https://example.com" },
    ]);
    await hydrateSealedProviderKeys();

    const s = secretStorageStatus();
    expect(s).toMatchObject({ sealed: 1, plaintext: 1, unreadable: 0, plaintextByChoice: false, backend: true });

    // 解不开的那个要能被数出来（界面要据此提示"重新填 key"）
    __resetSecretStoreForTests();
    delete (window as any).__TAURI__;
    installTauri({ failUnseal: true });
    await hydrateSealedProviderKeys();
    expect(secretStorageStatus()).toMatchObject({ sealed: 1, unreadable: 1 });

    // 关掉后端：状态必须说出"没有可用的系统加密"，而不是沉默
    __resetSecretStoreForTests();
    delete (window as any).__TAURI__;
    installTauri({ available: false });
    await hydrateSealedProviderKeys();
    expect(secretStorageStatus().backend).toBe(false);
  });

  it("SEAL-11: ensureSecretsHydrated() 是单飞 —— 并发调用只解封一次", async () => {
    const { calls } = installTauri();
    writeSettings([{ id: "deepseek", apiKeySealed: sealedOf(SK) }]);

    const [a, b] = await Promise.all([ensureSecretsHydrated(), ensureSecretsHydrated()]);
    expect(a.unsealed).toBe(1);
    expect(b.unsealed).toBe(1); // 同一个 promise 的结果
    expect(calls.filter((c) => c === "secret_unseal").length, "解封只许跑一次").toBe(1);

    // 之后再次调用不再发 IPC（configureEngine 每次都会 await 它）
    await ensureSecretsHydrated();
    expect(calls.filter((c) => c === "secret_unseal").length).toBe(1);
  });

  it("SEAL-12: 设置面还没读出来 ⇒ **不打水合标记**，就绪后自动重来一次（密文不许被永久跳过）", async () => {
    const { calls } = installTauri();
    const sealedJson = JSON.stringify({ mode: "api", providers: [{ id: "deepseek", apiKeySealed: sealedOf(SK) }] });
    // 端口在、但设置面未预热：真端口此时 `get` 返回兜底值并留痕（"读失败" ≠ "没有密文"）
    const port = createFakeStoragePort({ seed: { settings: [{ key: SETTINGS, value: sealedJson }] }, settingsWarmed: false });
    setStoragePort(port);

    const early = await ensureSecretsHydrated();
    expect(early.settingsReady, "必须如实说'这次没读到'").toBe(false);
    expect(early.unsealed).toBe(0);
    expect(calls.filter((c) => c === "secret_unseal").length, "读不出来时不许去解封（那是猜）").toBe(0);
    expect(secretStorageStatus().settingsReady).toBe(false);

    // 预热（= 真机上的 `await config.warmup()`，端口注册前完成）之后必须**自动重来**
    await port.config.warmup();
    const late = await ensureSecretsHydrated();
    expect(late.settingsReady).toBe(true);
    expect(late.unsealed, "密文必须被解封（否则界面显示已配置、请求却没有 key）").toBe(1);
    expect(getSettingJSON<any>(SETTINGS, {}).providers[0].apiKey).toBe(SK);
    expect(secretStorageStatus()).toMatchObject({ settingsReady: true, sealed: 1 });
  });

  it("SEAL-14: 真机上已经存在的**脏行**（明文与密文并存）必须被收拾掉 —— 同密钥删明文、换过密钥重封存", async () => {
    installTauri();
    // 情形 A：明文与密文指**同一把**密钥（= 真机 1.16.102 上量到的状态）
    writeSettings([
      { id: "deepseek", apiKey: SK, apiKeySealed: sealedOf(SK) },
      { id: "openai", apiKey: "sk-untouched-0123456789ab" }, // 另一把，本次也要正常封存
    ]);
    await hydrateSealedProviderKeys();
    const outA = await migrateProviderKeysToSealed();
    expect(outA.cleanedDuplicate, "要如实报'清掉了几条重复明文'").toBe(1);
    const rawA = readRaw();
    expect(rawA.providers[0].apiKey, "同一把密钥 ⇒ 多余的明文要删掉").toBeUndefined();
    expect(rawA.providers[0][SEALED_FIELD]).toBe(sealedOf(SK));
    expect(JSON.stringify(rawA)).not.toContain(SK);

    // 情形 B：用户换过密钥（磁盘上留着**上一把**的密文 + 新明文）⇒ 必须按新明文重新封存
    __resetSecretStoreForTests();
    writeSettings([{ id: "deepseek", apiKey: SK2, apiKeySealed: sealedOf(SK_OLD) }]);
    await hydrateSealedProviderKeys();
    const outB = await migrateProviderKeysToSealed();
    expect(outB.sealed, "换过的密钥要重新封存").toBe(1);
    expect(outB.cleanedDuplicate, "这不是'重复'而是'换过'，不许混进同一个计数").toBe(0);
    const rawB = readRaw();
    expect(rawB.providers[0].apiKey).toBeUndefined();
    expect(rawB.providers[0][SEALED_FIELD], "密文必须是**新**密钥的密文，不能留旧的").toBe(sealedOf(SK2));
    expect(getSettingJSON<any>(SETTINGS, {}).providers[0].apiKey, "新密钥仍要可用").toBe(SK2);

    // 情形 C：用户显式选了明文 ⇒ 连"删重复"都不做（存储决策是用户的）
    __resetSecretStoreForTests();
    writeSettings([{ id: "deepseek", apiKey: SK, apiKeySealed: sealedOf(SK) }]);
    setSetting(PLAINTEXT_FALLBACK_KEY, "true");
    await hydrateSealedProviderKeys();
    const outC = await migrateProviderKeysToSealed();
    expect(outC.cleanedDuplicate).toBe(0);
    expect(readRaw().providers[0].apiKey, "用户要明文，明文就得留着").toBe(SK);
  });

  it("SEAL-13: 残留回收必须**真下命令**（checkpoint → 整库重写 → 再 checkpoint）且如实报成败", async () => {
    // ① 没有端口：不许假装做过
    setStoragePort(null);
    const noPort = await reclaimSealedPlaintextResidue();
    expect(noPort).toMatchObject({ attempted: false, checkpointed: false, vacuumed: false });
    expect(noPort.reason).toBeTruthy();

    // ② 端口在、引擎拒绝整库重写：必须报"没做"+原因，而不是报成功
    const calls: Array<{ cmd: string; params?: Record<string, unknown> }> = [];
    const port = createFakeStoragePort({ compactReclaims: 0 });
    const original = port.data.command!;
    (port.data as any).command = async (cmd: string, params?: Record<string, unknown>) => {
      calls.push({ cmd, params });
      return original.call(port.data, cmd, params);
    };
    setStoragePort(port);
    const noop = await reclaimSealedPlaintextResidue();
    expect(noop.attempted).toBe(true);
    expect(noop.checkpointed, "WAL 折叠本身要做").toBe(true);
    expect(noop.vacuumed, "引擎没重写 ⇒ 不许报 true").toBe(false);
    expect(noop.reason).toBeTruthy();
    expect(calls.map((c) => c.cmd)).toEqual(["checkpoint", "storage.compact"]);

    // ③ 引擎真的回收了 ⇒ 收尾还要再折一次 WAL（VACUUM 的镜像也在 WAL 里）
    const calls2: string[] = [];
    const port2 = createFakeStoragePort({ compactReclaims: 4096 });
    const original2 = port2.data.command!;
    (port2.data as any).command = async (cmd: string, params?: Record<string, unknown>) => {
      calls2.push(cmd);
      return original2.call(port2.data, cmd, params);
    };
    setStoragePort(port2);
    const done = await reclaimSealedPlaintextResidue();
    expect(done).toMatchObject({ attempted: true, checkpointed: true, vacuumed: true });
    expect(done.reason).toBeUndefined();
    expect(calls2, "真实顺序：先折 WAL、再整库重写、再折一次").toEqual(["checkpoint", "storage.compact", "checkpoint"]);
  });
});

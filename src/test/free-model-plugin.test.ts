/**
 * 第 201 波判据：**免费模型插件（dsh-our-free-model standalone）作为独立扩展**。
 *
 * ## 用户要求（逐条对判据）
 *
 * > 咱们 codem 集成这个插件，注意这个插件要独立存在，可以开启、暂停、删除，不影响 codem 的使用。
 * > 集成后，默认开启，开启后对话优先从这个插件里获取模型列表服务。
 *
 * | 要求 | 判据 |
 * | --- | --- |
 * | **默认开启** | `OFM-1`：没有这条设置 ⇒ `enabled: true`；用户显式关掉 ⇒ `false`（尊重） |
 * | **可暂停** | `OFM-2`：暂停 = 停进程 + 记 `enabled:false` + **保留数据**（不许顺手删目录） |
 * | **可删除** | `OFM-3`：删除 = 停进程 + 删扩展目录 + 关开关 |
 * | **不影响 codem** | `OFM-5`/`OFM-7`：插件拿不到清单时**原样回退**到原有模型列表（选择器不许空） |
 * | **模型列表优先来自插件** | `OFM-4`/`OFM-7`：清单映射正确、且排在其他 provider 之前 |
 * | 起不来要如实说 | `OFM-6`：没有 Node ⇒ `ok:false` + 说明；**绝不假装成功** |
 *
 * ⚠️ 这里测的是**宿主侧的行为契约**（设置语义、生命周期动作、列表映射与回退）。
 * "插件本体能不能跑"由真机冒烟验证（本波实测：内置副本能独立起来，`/v1/models` 返回 8 个免费模型）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockInvoke = vi.fn();
const mockExists = vi.fn();
const mockListDirectory = vi.fn();
const mockDeleteDirectoryPermanent = vi.fn();
const mockReadFile = vi.fn();
const mockExecuteCommand = vi.fn();
const mockGetAppDataDir = vi.fn();
const settingStore: Record<string, unknown> = {};

vi.mock("../core/file-api", () => ({
  exists: (...a: unknown[]) => mockExists(...a),
  listDirectory: (...a: unknown[]) => mockListDirectory(...a),
  deleteDirectoryPermanent: (...a: unknown[]) => mockDeleteDirectoryPermanent(...a),
  readFile: (...a: unknown[]) => mockReadFile(...a),
  executeCommand: (...a: unknown[]) => mockExecuteCommand(...a),
  getAppDataDir: (...a: unknown[]) => mockGetAppDataDir(...a),
}));

vi.mock("../core/storage/settings", () => ({
  getSettingJSON: (key: string, fallback: unknown) => (key in settingStore ? settingStore[key] : fallback),
  setSettingJSON: (key: string, value: unknown) => {
    settingStore[key] = value;
  },
  /*
   * 下面三个是**被测代码的传递依赖**要用的（`file-api` → `sandbox-acl` 会具名导入它们）：
   * `settings-mock-parity` 的 SMP-1 当场抓过这件事 —— 少给会让运行时抛
   * `No "getSetting" export is defined on the ... mock`，而那种错常被生产代码的 catch 吞掉。
   */
  getSetting: (key: string, fallback: unknown) => (key in settingStore ? settingStore[key] : fallback),
  setSetting: (key: string, value: unknown) => {
    settingStore[key] = value;
  },
  removeSetting: (key: string) => {
    delete settingStore[key];
  },
}));

import { freeModelPlugin } from "../core/free-model-plugin/service";

const EXT_DIR = "C:\\appdata\\extensions\\our-free-model";

/** 装一个假的 Tauri 宿主：`invoke` 按命令名分发 */
function installTauriHost(overrides: Partial<Record<string, () => unknown>> = {}): void {
  const table: Record<string, () => unknown> = {
    ofm_extension_dir: () => EXT_DIR,
    ofm_bundled_dir: () => "C:\\app\\resources\\ofm",
    ofm_state: () => ({ running: true, pid: 4321, port: 18937 }),
    ofm_start: () => ({ running: true, pid: 4321, port: 18937 }),
    ofm_stop: () => undefined,
    ...overrides,
  };
  mockInvoke.mockImplementation(async (command: string) => {
    const fn = table[command];
    if (!fn) throw new Error(`没有这个命令：${command}`);
    return fn();
  });
  (globalThis as unknown as { window: { __TAURI__?: unknown } }).window.__TAURI__ = { core: { invoke: mockInvoke } };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(settingStore)) delete settingStore[k];
  freeModelPlugin.resetCacheForTests();
  installTauriHost();
  mockExists.mockResolvedValue(true);
  mockExecuteCommand.mockResolvedValue({ stdout: "v22.19.0\n", stderr: "", exitCode: 0 });
  mockGetAppDataDir.mockResolvedValue("C:\\appdata");
  mockListDirectory.mockResolvedValue([]);
  mockDeleteDirectoryPermanent.mockResolvedValue(undefined);
  mockReadFile.mockRejectedValue(new Error("ENOENT"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OFM：免费模型插件的独立扩展语义", () => {
  it("OFM-1：没有设置时**默认开启**；用户显式关掉要尊重", () => {
    expect(freeModelPlugin.readSetting(), "集成后默认开启（用户要求）").toEqual({ enabled: true });

    settingStore[freeModelPlugin.settingKey] = { enabled: false, pausedAt: 123 };
    expect(freeModelPlugin.readSetting(), "用户自己关掉的必须尊重").toEqual({ enabled: false, pausedAt: 123 });

    settingStore[freeModelPlugin.settingKey] = { enabled: true };
    expect(freeModelPlugin.readSetting().enabled).toBe(true);
    /* 坏数据不许当成"用户关掉了"（那会让默认开启静默失效） */
    settingStore[freeModelPlugin.settingKey] = "坏了";
    expect(freeModelPlugin.readSetting(), "设置坏掉时按默认（开启）处理").toEqual({ enabled: true });
  });

  it("OFM-2：暂停 = 停进程 + 记下暂停 + **保留数据**（不删目录）", async () => {
    const r = await freeModelPlugin.pause();
    expect(r.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("ofm_stop", undefined);
    expect(settingStore[freeModelPlugin.settingKey], "暂停要写进设置（下次启动不再自动开）").toMatchObject({
      enabled: false,
    });
    expect(
      (settingStore[freeModelPlugin.settingKey] as { pausedAt?: number }).pausedAt,
      "记下暂停时间（界面要显示）",
    ).toBeGreaterThan(0);
    expect(mockDeleteDirectoryPermanent, "暂停**不许**删数据（账号/缓存要留着）").not.toHaveBeenCalled();
  });

  it("OFM-3：删除 = 停进程 + 删扩展目录 + 关开关", async () => {
    const r = await freeModelPlugin.remove();
    expect(r.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("ofm_stop", undefined);
    expect(mockDeleteDirectoryPermanent, "删除要把扩展目录清掉").toHaveBeenCalledWith(EXT_DIR);
    expect((settingStore[freeModelPlugin.settingKey] as { enabled: boolean }).enabled).toBe(false);
  });

  it("OFM-4：`/v1/models` 映射成 Codem 的模型形状（缺名字用 id、坏条目丢掉、出错返回空数组）", async () => {
    mockReadFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("settings.json")) {
        return JSON.stringify({ standalonePort: 18937, forwardKey: "k-123" });
      }
      throw new Error("ENOENT");
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash" },
          { id: "ling-3.0-flash-fin-free" },
          { id: "" },
          { name: "没有 id" },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await freeModelPlugin.models.list();
    expect(models).toEqual([
      { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash" },
      { id: "ling-3.0-flash-fin-free", name: "ling-3.0-flash-fin-free" },
    ]);
    expect(String(fetchMock.mock.calls[0][0]), "要打插件的 /v1/models").toContain("127.0.0.1:18937/v1/models");
    expect(
      (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.authorization,
      "要带插件自己生成的 key",
    ).toBe("Bearer k-123");

    /* 上游挂了/没起来 ⇒ 空数组（**不许抛**：模型列表这条路上抛异常会把选择器弄空） */
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    await expect(freeModelPlugin.models.list()).resolves.toEqual([]);
  });

  it("OFM-5：缓存没刷过 / 过期 / 未启用 ⇒ 同步读到的都是空（于是列表原样回退）", async () => {
    expect(freeModelPlugin.models.cached(), "没刷过 ⇒ 空").toEqual([]);

    mockReadFile.mockImplementation(async (p: string) =>
      String(p).endsWith("settings.json") ? JSON.stringify({ standalonePort: 18937, forwardKey: "k" }) : "",
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "free-1", name: "Free 1" }] }) })));
    expect(await freeModelPlugin.models.refresh(), "启用状态下刷新会拿到清单").toEqual([{ id: "free-1", name: "Free 1" }]);
    expect(freeModelPlugin.models.cached()).toEqual([{ id: "free-1", name: "Free 1" }]);

    /* 未启用 ⇒ 刷新后缓存清空（用户关了它就不该再往模型列表里塞） */
    settingStore[freeModelPlugin.settingKey] = { enabled: false };
    expect(await freeModelPlugin.models.refresh()).toEqual([]);
    expect(freeModelPlugin.models.cached()).toEqual([]);
  });

  it("OFM-6：没有 Node ⇒ 如实失败（不假装成功）", async () => {
    mockExecuteCommand.mockResolvedValue({ stdout: "v18.0.0\n", stderr: "", exitCode: 0 }); // 太旧
    mockListDirectory.mockResolvedValue([]); // 也没有便携 node
    const r = await freeModelPlugin.start();
    expect(r.ok, "起不来就必须说失败").toBe(false);
    expect(r.message, "原因要写清楚（用户能据此去装 Node）").toContain("Node");
    expect(mockInvoke, "失败路径不许去调起进程").not.toHaveBeenCalledWith("ofm_start", expect.anything());
  });

  it("OFM-9：暂停/删除后模型清单**立刻**消失（不等 60 秒 TTL），原有列表原样回来", async () => {
    /* 用户真机提问引出来的缺口：缓存 TTL 60 秒，不主动清的话暂停后列表还挂着调不通的模型 */
    settingStore["codem-settings"] = { providers: [{ id: "deepseek", name: "DeepSeek", apiKey: "sk-real" }] };
    mockReadFile.mockImplementation(async (p: string) =>
      String(p).endsWith("settings.json") ? JSON.stringify({ standalonePort: 18937, forwardKey: "k" }) : "",
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "free-1", name: "Free 1" }] }) })));

    const started = await freeModelPlugin.start();
    expect(started.ok).toBe(true);
    expect(await freeModelPlugin.models.refresh(), "前提：启用时清单非空").toEqual([{ id: "free-1", name: "Free 1" }]);
    expect(freeModelPlugin.models.cached(), "前提：同步缓存里也有").toHaveLength(1);

    await freeModelPlugin.pause();
    expect(
      freeModelPlugin.models.cached(),
      "暂停后必须**立刻**空（否则最长一分钟里列表还列着已经调不通的免费模型）",
    ).toEqual([]);

    /* 删除同理 */
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "free-2", name: "Free 2" }] }) })));
    settingStore[freeModelPlugin.settingKey] = { enabled: true };
    await freeModelPlugin.models.refresh();
    expect(freeModelPlugin.models.cached(), "前提：重新启用后缓存又有").toHaveLength(1);
    await freeModelPlugin.remove();
    expect(freeModelPlugin.models.cached(), "删除后也必须立刻空").toEqual([]);
  });

  it("OFM-8：启用成功后**登记托管供应商**（落库不带密钥、暂停时干净移除、别人的条目不动）", async () => {
    /* 用户本来就有两条供应商 —— 全程都必须原样在 */
    settingStore["codem-settings"] = {
      providers: [
        { id: "deepseek", name: "DeepSeek", apiKey: "sk-real" },
        { id: "my-custom", name: "我的自定义", apiKey: "sk-custom", custom: true },
      ],
    };
    mockReadFile.mockImplementation(async (p: string) =>
      String(p).endsWith("settings.json") ? JSON.stringify({ standalonePort: 18937, forwardKey: "plugin-key" }) : "",
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));

    const started = await freeModelPlugin.start();
    expect(started.ok, "有 Node、有代码 ⇒ 应当起来").toBe(true);

    const after = (settingStore["codem-settings"] as { providers: Array<Record<string, unknown>> }).providers;
    const managed = after.filter((p) => p.managedBy === "free-model-plugin");
    expect(managed, "必须登记一条托管供应商（否则模型列表里看得见却没路可走）").toHaveLength(1);
    expect(managed[0].id).toBe("free-model");
    expect(managed[0].baseUrl, "baseUrl 要用插件**当下**的端口").toBe("http://127.0.0.1:18937/v1");
    expect(managed[0].custom, "走自定义供应商那条注册路径").toBe(true);
    /*
     * ★ 密钥**不许**落进设置：真机实测这一段会被本仓的凭据脱敏换成占位符（写进去也读不回来），
     * 而且供应商密钥本来就不该躺在明文设置里。密钥只走运行时注册（`registerProviderInEngine`）。
     */
    expect(managed[0].apiKey, "落库那条不许带密钥（真机上会被凭据脱敏清掉，等于自欺）").toBeUndefined();
    expect(
      after.filter((p) => p.managedBy !== "free-model-plugin").map((p) => p.id),
      "别人的供应商一个字都不能动",
    ).toEqual(["deepseek", "my-custom"]);

    /* 暂停 ⇒ 条目消失（不留打不通的），别人的还在 */
    await freeModelPlugin.pause();
    const paused = (settingStore["codem-settings"] as { providers: Array<Record<string, unknown>> }).providers;
    expect(paused.some((p) => p.managedBy === "free-model-plugin"), "暂停后不该留插件条目").toBe(false);
    expect(paused.map((p) => p.id)).toEqual(["deepseek", "my-custom"]);

    /* 再启用 ⇒ 条目回来（幂等：不会攒出两条） */
    await freeModelPlugin.start();
    await freeModelPlugin.start();
    const again = (settingStore["codem-settings"] as { providers: Array<Record<string, unknown>> }).providers;
    expect(again.filter((p) => p.managedBy === "free-model-plugin"), "重复启用也只该有一条").toHaveLength(1);
  });

  it("OFM-7：模型列表**优先来自插件**（排在其他 provider 之前），取不到时原有列表不变", async () => {
    /* 造一个已配置的 provider（走设置里的 providers + 动态模型清单） */
    const settingsModule = await import("../core/storage/settings");
    const spy = vi.spyOn(settingsModule, "getSettingJSON").mockImplementation((key: string, fallback: unknown) => {
      if (key === "codem-settings") {
        return { providers: [{ id: "openai", apiKey: "sk-x" }] } as never;
      }
      if (key in settingStore) return settingStore[key] as never;
      return fallback as never;
    });
    const catalog = await import("../core/llm/model-catalog");
    vi.spyOn(catalog, "getMergedDynamicModels").mockReturnValue({ openai: [{ id: "gpt-4o", name: "GPT-4o" }] } as never);

    const { getConfiguredApiModels } = await import("../core/model-config");

    /* ① 插件没有清单 ⇒ 只剩 provider 的（原样回退） */
    const before = getConfiguredApiModels().map((m) => m.id);
    expect(before).toEqual(["gpt-4o"]);

    /* ② 插件有清单 ⇒ 排在最前 */
    mockReadFile.mockImplementation(async (p: string) =>
      String(p).endsWith("settings.json") ? JSON.stringify({ standalonePort: 18937, forwardKey: "k" }) : "",
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "free-1", name: "Free 1" }] }) })));
    await freeModelPlugin.models.refresh();

    const after = getConfiguredApiModels().map((m) => m.id);
    expect(after, "插件的模型必须排在最前（用户要求「优先从插件获取」）").toEqual(["free-1", "gpt-4o"]);

    spy.mockRestore();
  });
});

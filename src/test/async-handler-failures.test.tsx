/**
 * 异步点击处理器「没有 catch」这一类缺陷的判据（本轮）。
 *
 * ## 缺陷形态（改前，逐个文件取证）
 *
 * | 文件 | 处理器 | 改前形状 | 用户看到什么 |
 * | --- | --- | --- | --- |
 * | PetMarketDialog | `handleInstall` | `await installMarketPet(...)` 后直接 `setInstallProgress(null)`，**没有 try** | 安装进度行永久停在「准备安装...」/最后一个进度；重试按钮不出现 |
 * | PetMarketDialog | `handleUninstall` | `await uninstallPet(...)`，**没有 try** | 卸载失败**一个字都不说**，卡片仍显示「卸载」 |
 * | PetMarketDialog | `loadMarket` | `await listMarketPets(...)`，**没有 try/finally**；`useEffect` 里 `loadMarket()` 不 `void` | 列表空白 + 「正在加载宠物市场...」转圈永久 |
 * | OllamaSettingsPanel | `checkConnection` | `setChecking(true); await …; setChecking(false)`，**没有 try** | `disabled={checking}` ⇒「测试连接」永久点不动 |
 * | OllamaSettingsPanel | `fetchModels` | 同上 | 「刷新模型列表」永久点不动，且不说是哪一步失败 |
 * | McpManager | `handleConnect` | `markConnecting(true); await registry.connect(…); markConnecting(false)`，**没有 try** | 该行永久「连接中...」且按钮点不动 |
 * | McpManager | `handleDisconnect` | `await registry.disconnect(name)`，**没有 try** | 断开失败静默，状态仍显示「已连接」 |
 * | McpManager | `handleConnectAll` | `try { await connectAll() } finally { 复位 }`，**没有 catch** | 复位了，但**没有任何错误提示**（rejection 无人处理） |
 * | SkillManager | `handleMarketInstall` | `setInstallingSkillId(id); await installMarketSkill(...); setInstallingSkillId(null)` | 「安装」按钮永久转圈 + 「准备安装...」进度条永久 |
 * | PluginMarketTab | `handleInstallBundled` | `await manager.enable(...)`，**没有 try** | 点了没反应（既不成功也不报错） |
 * | PluginMarketTab | `handleOnlineSearch` | `setSearching(true); await search…; setSearching(false)` | 「检索中...」永久 + 按钮永久 disabled |
 * | DshExternalPluginsCard | `load` | `await readDshInstalledPlugins()`，**没有 try**，`useEffect` 里 `void load()` | 抛错 ⇒ `plugins` 仍为 `[]`、`error` 仍为 `null` ⇒ 整个卡片 `return null` **消失**（「读失败」与「没装」不可区分） |
 * | DshExternalPluginsCard | `check` | `try { … } finally { setChecking(false) }`，**没有 catch** | 转圈停了，但**没有任何错误提示** |
 * | DshExternalPluginsCard | `upgrade` | `try { … } finally { setBusy(null) }`，**没有 catch** | 升级按钮恢复，但**没有任何错误提示** |
 *
 * ## 这些判据怎么造（为什么断言的是产品行为）
 *
 * 每个组件都渲染**真品**，只把「它自己 import 的那个服务模块」按模块边界换成会 reject 的桩
 * （`vi.mock` + `importOriginal` 透传其余导出）。断言全部落在用户能看到的东西上：
 * 按钮是否还能点、转圈/进行中文案是否还在、错误文案是否出现在 DOM 里
 * —— 不看 state、不看实现细节。
 *
 * | # | 判据 |
 * | --- | --- |
 * | PM-1 | 安装 reject ⇒ 进度行消失 + 安装按钮恢复 + 显示「安装「…」失败：原因」 |
 * | PM-2 | 市场列表 reject ⇒ 「正在加载宠物市场...」结束 + 错误行 + 重试按钮 |
 * | PM-3 | 卸载 reject ⇒ 显示「卸载「…」失败：原因」+ 仍在列表里（不许假装卸掉了） |
 * | OL-1 | 连接检测 reject ⇒「测试连接」恢复可点 + 检测中文案消失 + 显示原因 |
 * | OL-2 | 模型列表 reject ⇒「刷新模型列表」恢复可点 + 显示「获取模型列表失败：原因」 |
 * | MCP-UI-1 | 单条连接 reject ⇒「连接中...」消失 + 按钮恢复 + 显示「连接「…」失败：原因」 |
 * | MCP-UI-2 | 断开 reject ⇒ 显示「断开「…」失败：原因」+ 仍如实显示「已连接」 |
 * | MCP-UI-3 | 全部连接 reject ⇒ 进行中态复位 + 显示「全部连接失败：原因」 |
 * | SK-1 | 市场安装 reject ⇒ `installingSkillId` 清掉（按钮恢复可点）+ 进度条消失 + 显示原因 |
 * | PL-1 | 安装并启用 reject ⇒ notify 收到「安装并启用「…」失败：原因」 |
 * | PL-2 | 在线检索 reject ⇒「检索中...」结束 + 按钮恢复 + notify 收到「检索 npm 包失败：原因」 |
 * | EX-1 | 读取失败 ⇒ 卡片**仍然渲染**（不许 `return null`）+ 显示「读取 DSH 已安装插件失败：原因」 |
 * | EX-2 | 检查更新 reject ⇒ 转圈结束 + 按钮恢复 + 显示「检查更新失败：原因」 |
 * | EX-3 | 升级 reject ⇒ 按钮文案恢复「升级并安装」+ 显示「升级「…」失败：原因」 |
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import { useState } from "react";

// ========== 模块边界桩（路径与各组件自己的 import 完全一致） ==========

/** 宠物市场客户端：只会被换成「reject 的桩」，其余导出原样 */
const petMarket = vi.hoisted(() => ({
  listMarketPets: vi.fn(),
  installMarketPet: vi.fn(),
  isMarketPetInstalled: vi.fn(() => false),
  fetchPetImageAsDataUrl: vi.fn(async () => null),
}));

const petManager = vi.hoisted(() => ({
  uninstallPet: vi.fn(),
  isPetInstalled: vi.fn(() => false),
}));

/** `usePetStore` 是 zustand 钩子；这里只提供组件真正读的字段（可逐例改写） */
const petStore = vi.hoisted(() => ({
  current: {
    enabled: true,
    installedPets: [] as Array<{ slug: string }>,
    refreshInstalledPets: async () => {},
    setActivePet: async (_slug: string | null) => {},
    setEnabled: (_enabled: boolean) => {},
  },
}));

vi.mock("../core/pet/pet-market-client", () => petMarket);
vi.mock("../core/pet/pet-manager", () => petManager);
vi.mock("../core/pet/pet-store", () => ({ usePetStore: () => petStore.current }));

/** Ollama provider：只有 checkConnection / listModels 会被换成桩（getBaseUrl 是真实类上的只读方法） */
const ollama = vi.hoisted(() => ({
  provider: {
    checkConnection: vi.fn(),
    listModels: vi.fn(),
    getBaseUrl: () => "http://localhost:11434",
  },
}));

vi.mock("../core/llm/ollama-provider", () => ({ getOllamaProvider: () => ollama.provider }));

/** MCP 注册表：模块级单例，换成每例一个可控实例（与 `mcp-connect-all-progress.test.tsx` 同手法） */
const mcp = vi.hoisted(() => ({ registry: null as any }));

vi.mock("../core/mcp/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/mcp/mcp")>();
  return { ...actual, getMCPRegistry: () => mcp.registry };
});

/** 技能市场客户端：整块替换（组件用到的 8 个导出都给上） */
const skillMarket = vi.hoisted(() => ({
  listMarketSkills: vi.fn(),
  searchMarketSkillsOnline: vi.fn(),
  installMarketSkill: vi.fn(),
  isMarketSkillInstalled: vi.fn(() => false),
  getMarketSources: vi.fn(() => [] as unknown[]),
  getSourceIcon: vi.fn(() => "📦"),
  publishSkillToMarket: vi.fn(),
  listPublishableMarkets: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../core/skill/skill-market-client", () => skillMarket);
/** 市场页签顶部的技能包区块与本节无关（它会真的去拉网络索引） */
vi.mock("../components/StackMarketSection", () => ({ StackMarketSection: () => null }));

/** dsh 市场目录：只换在线检索那个会发请求的函数，目录常量用真品 */
const dshCatalog = vi.hoisted(() => ({ searchDshNpmPackages: vi.fn() }));

vi.mock("../core/plugin-market/dsh-market-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/plugin-market/dsh-market-catalog")>();
  return { ...actual, searchDshNpmPackages: dshCatalog.searchDshNpmPackages };
});

/** 外部 dsh 插件读写：只换三个 async 动作（同步的停用状态读写用真品） */
const dshExternal = vi.hoisted(() => ({
  readDshInstalledPlugins: vi.fn(),
  checkDshPluginUpdates: vi.fn(),
  upgradeDshPlugin: vi.fn(),
}));

vi.mock("../core/plugin-market/external-dsh-plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/plugin-market/external-dsh-plugins")>();
  return { ...actual, ...dshExternal };
});

import { PetMarketDialog } from "../components/PetMarketDialog";
import { OllamaSettingsPanel } from "../components/OllamaSettingsPanel";
import { McpManager } from "../components/McpManager";
import { SkillManager } from "../components/SkillManager";
import { PluginMarketTab } from "../components/plugin-market/PluginMarketTab";
import { DshExternalPluginsCard } from "../components/plugin-market/DshExternalPluginsCard";
import { DSH_MARKET_CATALOG } from "../core/plugin-market/dsh-market-catalog";
import type { MarketPet } from "../core/pet/pet-types";

afterEach(() => {
  cleanup();
  delete (window as any).__TAURI__;
});

// ========== 1. PetMarketDialog ==========

const PET: MarketPet = {
  id: "pet-1",
  slug: "test-pet",
  name: "测试宠物",
  description: "判据用的假宠物",
  metadataUrl: "https://example.test/pet.json",
  spritesheetUrl: "https://example.test/pet.webp",
};

describe("宠物市场对话框：异步失败必须复位 + 可见", () => {
  beforeEach(() => {
    petStore.current.installedPets = [];
    petStore.current.refreshInstalledPets = async () => {};
    petStore.current.setActivePet = async () => {};
    petMarket.listMarketPets.mockReset();
    petMarket.installMarketPet.mockReset();
    petManager.uninstallPet.mockReset();
  });

  it("PM-1: 安装 reject ⇒ 进度行消失、安装按钮恢复可点，并显示「安装「测试宠物」失败：下载超时」", async () => {
    petMarket.listMarketPets.mockResolvedValue({ pets: [PET] });
    petMarket.installMarketPet.mockRejectedValue(new Error("下载超时"));

    render(<PetMarketDialog open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() =>
      expect(screen.getByText("安装「测试宠物」失败：下载超时")).toBeTruthy(),
    );
    expect(
      document.querySelector(".petm-install-block"),
      "安装失败后进度行不许永久停留（改前 setInstallProgress(null) 在 reject 后根本跑不到）",
    ).toBeNull();
    const again = screen.getByRole("button", { name: "安装" });
    expect(again, "失败后必须能再点一次安装").toBeEnabled();
  });

  it("PM-2: 市场列表 reject ⇒ loading 结束 + 错误行 + 重试按钮（不许空白转圈）", async () => {
    petMarket.listMarketPets.mockRejectedValue(new Error("manifest 拉取失败"));

    render(<PetMarketDialog open onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("加载宠物市场失败：manifest 拉取失败")).toBeTruthy(),
    );
    expect(
      screen.queryByText("正在加载宠物市场..."),
      "加载失败必须结束「正在加载」——改前 loading 永远为真",
    ).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("PM-3: 卸载 reject ⇒ 显示「卸载「测试宠物」失败：目录被占用」，且清单里仍然还在", async () => {
    petStore.current.installedPets = [{ slug: PET.slug }];
    petMarket.listMarketPets.mockResolvedValue({ pets: [PET] });
    petManager.uninstallPet.mockRejectedValue(new Error("目录被占用"));

    render(<PetMarketDialog open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "卸载" }));

    await waitFor(() =>
      expect(screen.getByText("卸载「测试宠物」失败：目录被占用")).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: "卸载" }),
      "卸载没有成功 ⇒ 卡片必须仍然如实显示「卸载」",
    ).toBeTruthy();
  });
});

// ========== 2. OllamaSettingsPanel ==========

describe("Ollama 设置面板：检测/取模型失败必须复位 + 可见", () => {
  beforeEach(() => {
    ollama.provider.checkConnection.mockReset();
    ollama.provider.listModels.mockReset();
  });

  it("OL-1: 连接检测 reject ⇒「测试连接」恢复可点、检测中文案消失，并显示原因", async () => {
    ollama.provider.checkConnection.mockRejectedValue(new Error("ECONNREFUSED"));

    render(<OllamaSettingsPanel />);

    await waitFor(() =>
      expect(screen.getByText(/测试 Ollama 连接失败：ECONNREFUSED/)).toBeTruthy(),
    );
    const btn = screen.getByRole("button", { name: /测试连接/ });
    expect(btn, "改前 disabled={checking} 会永久锁死").toBeEnabled();
    expect(
      screen.queryByText("检测中..."),
      "失败后不许停在「检测中...」",
    ).toBeNull();
  });

  it("OL-2: 取模型列表 reject ⇒「刷新模型列表」恢复可点，并显示「获取模型列表失败：…」", async () => {
    ollama.provider.checkConnection.mockResolvedValue({
      connected: true,
      url: "http://localhost:11434",
      modelCount: 1,
    });
    ollama.provider.listModels.mockRejectedValue(new Error("模型列表接口 500"));

    render(<OllamaSettingsPanel />);

    await waitFor(() =>
      expect(screen.getByText("获取模型列表失败：模型列表接口 500")).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: /刷新模型列表/ }),
      "改前 loadingModels 会永久为真 ⇒ 按钮永久 disabled",
    ).toBeEnabled();
  });
});

// ========== 3. McpManager ==========

const MCP_SERVER = { name: "alpha", transport: "http" as const, url: "http://localhost:9", timeout: 5000 };

function makeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    getConfigs: () => [MCP_SERVER],
    connect: vi.fn(async () => ({ name: "alpha", connected: true, tools: [] })),
    disconnect: vi.fn(async () => {}),
    connectAll: vi.fn(async () => [{ name: "alpha", connected: true, tools: [] }]),
    ...overrides,
  };
}

const connectBtn = () =>
  document.querySelector<HTMLButtonElement>("button.mcp-server-btn.connect");
const disconnectBtn = () =>
  document.querySelector<HTMLButtonElement>("button.mcp-server-btn.disconnect");
const connectAllBtn = () =>
  document.querySelector<HTMLButtonElement>("button.connect-all-btn")!;

describe("MCP 管理器：连接/断开/全部连接失败必须复位 + 可见", () => {
  it("MCP-UI-1: 单条连接 reject ⇒「连接中...」消失、按钮恢复，并显示「连接「alpha」失败：握手超时」", async () => {
    mcp.registry = makeRegistry({ connect: vi.fn().mockRejectedValue(new Error("握手超时")) });

    render(<McpManager onClose={() => {}} />);
    fireEvent.click(connectBtn()!);

    await waitFor(() =>
      expect(screen.getByText("连接「alpha」失败：握手超时")).toBeTruthy(),
    );
    expect(connectBtn()!.textContent, "失败后不许停在「连接中...」").toBe("连接");
    expect(connectBtn()!.disabled, "失败后必须能再点一次连接").toBe(false);
  });

  it("MCP-UI-2: 断开 reject ⇒ 显示「断开「alpha」失败：stdio 进程已退出」，且仍如实显示「已连接」", async () => {
    const registry = makeRegistry();
    mcp.registry = registry;

    render(<McpManager onClose={() => {}} />);
    fireEvent.click(connectBtn()!);
    await waitFor(() => expect(disconnectBtn()).not.toBeNull());

    registry.disconnect.mockRejectedValue(new Error("stdio 进程已退出"));
    fireEvent.click(disconnectBtn()!);

    await waitFor(() =>
      expect(screen.getByText("断开「alpha」失败：stdio 进程已退出")).toBeTruthy(),
    );
    expect(
      document.querySelector(".mcp-status-dot")!.textContent,
      "断开没有成功 ⇒ 不许把状态改成「未连接」（那是假的成功）",
    ).toBe("已连接");
  });

  it("MCP-UI-3: 全部连接 reject ⇒ 进行中态复位（按钮可点/文案回退），并显示「全部连接失败：连接调度器不可用」", async () => {
    mcp.registry = makeRegistry({
      connectAll: vi.fn().mockRejectedValue(new Error("连接调度器不可用")),
    });

    render(<McpManager onClose={() => {}} />);
    const btn = connectAllBtn();
    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByText("全部连接失败：连接调度器不可用")).toBeTruthy(),
    );
    expect(btn.disabled, "改前 try/finally 只复位、不报错；这里必须两者都有").toBe(false);
    expect(btn.textContent).toContain("全部连接");
    expect(btn.textContent).not.toContain("全部连接中");
    expect(connectBtn()!.textContent, "批量的「连接中」也要一并摘掉").toBe("连接");
  });
});

// ========== 4. SkillManager ==========

const MARKET_SKILL = {
  id: "demo-skill",
  name: "demo-skill",
  displayName: "演示技能",
  description: "判据用的假市场技能",
  sourceId: "demo",
  sourceName: "演示源",
  downloadUrl: "https://example.test/demo.zip",
  installType: "zip" as const,
  installed: false,
};

describe("技能管理：市场安装失败必须清掉 installingSkillId + 可见", () => {
  beforeEach(() => {
    skillMarket.getMarketSources.mockReturnValue([
      { id: "demo", name: "演示源", type: "github-repo", url: "https://example.test", enabled: true },
    ]);
    skillMarket.listMarketSkills.mockResolvedValue({ skills: [MARKET_SKILL], errors: [] });
    skillMarket.searchMarketSkillsOnline.mockResolvedValue({ skills: [], errors: [] });
    skillMarket.installMarketSkill.mockReset();
  });

  it("SK-1: 安装 reject ⇒ 安装按钮恢复可点、进度条消失，并显示「安装「演示技能」失败：ZIP 解包失败」", async () => {
    skillMarket.installMarketSkill.mockRejectedValue(new Error("ZIP 解包失败"));

    render(<SkillManager onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /技能市场/ }));

    const installBtn = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(".market-skill-install-btn");
      expect(el, "市场卡片必须出现安装按钮").not.toBeNull();
      return el!;
    });

    fireEvent.click(installBtn);

    await waitFor(() =>
      expect(screen.getByText("安装「演示技能」失败：ZIP 解包失败")).toBeTruthy(),
    );
    expect(
      installBtn.disabled,
      "改前 installingSkillId 永远清不掉 ⇒ 按钮永久 disabled + 永久转圈",
    ).toBe(false);
    expect(
      document.querySelector(".skill-install-progress"),
      "失败后「准备安装...」进度条不许永久停留",
    ).toBeNull();
  });
});

// ========== 5. PluginMarketTab ==========

/**
 * 父组件是「notify ⇒ toast」这条既有链路；判据把它换成一个真渲染出来的 `role="alert"`，
 * 这样断言仍然落在**用户看得见的文本**上（而不是只断言函数被调用）。
 */
function PluginMarketHarness({ manager }: { manager: any }) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <PluginMarketTab
        manager={manager}
        stateVersion={0}
        zh
        onToggle={() => {}}
        notify={(msg) => setNotice(msg)}
      />
      {notice && <div role="alert">{notice}</div>}
    </>
  );
}

function makePluginManager(overrides: Record<string, unknown> = {}) {
  const states = DSH_MARKET_CATALOG.filter((e) => e.codemAnchor).map((e) => ({
    name: e.codemAnchor as string,
    status: "disabled" as const,
    canSafelyDisable: true,
    updatedAt: 0,
  }));
  return {
    enable: vi.fn(async () => ({ success: true, enabledList: ["x"] })),
    disable: vi.fn(async () => ({ success: true, disabledList: ["x"] })),
    getPluginStates: vi.fn(() => states),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe("插件市场页签：安装/在线检索失败必须复位 + 可见", () => {
  it("PL-1: 安装并启用 reject ⇒ 用户看到「安装并启用「…」失败：装配器不可用」", async () => {
    const first = DSH_MARKET_CATALOG.find((e) => e.status === "bundled" && e.codemAnchor)!;
    const manager = makePluginManager({
      enable: vi.fn().mockRejectedValue(new Error("装配器不可用")),
    });

    render(<PluginMarketHarness manager={manager} />);
    fireEvent.click(screen.getAllByText("安装并启用")[0]);

    await waitFor(() =>
      expect(
        screen.getByText(`安装并启用「${first.dshName}」失败：装配器不可用`),
      ).toBeTruthy(),
    );
  });

  it("PL-2: 在线检索 reject ⇒「检索中...」结束、按钮恢复可点，并显示「检索 npm 包失败：npm registry 403」", async () => {
    dshCatalog.searchDshNpmPackages.mockReset();
    dshCatalog.searchDshNpmPackages.mockRejectedValue(new Error("npm registry 403"));

    render(<PluginMarketHarness manager={makePluginManager()} />);
    const btn = screen.getByRole("button", { name: /在线检索 npm/ });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByText("检索 npm 包失败：npm registry 403")).toBeTruthy(),
    );
    expect(
      btn.disabled,
      "改前 searching 永远清不掉 ⇒ 按钮永久 disabled + 永久「检索中...」",
    ).toBe(false);
    expect(btn.textContent).toContain("在线检索 npm");
    expect(btn.textContent).not.toContain("检索中");
  });
});

// ========== 6. DshExternalPluginsCard ==========

const EXT_PLUGIN = {
  name: "dsh-ops",
  installedVersion: "1.0.0",
  latestVersion: "1.1.0",
  updateAvailable: true,
  path: "/tmp/dsh-ops",
  enabled: true,
};

describe("DSH 外部插件卡片：读/检查/升级失败必须可见，且卡片不许消失", () => {
  beforeEach(() => {
    dshExternal.readDshInstalledPlugins.mockReset();
    dshExternal.checkDshPluginUpdates.mockReset();
    dshExternal.upgradeDshPlugin.mockReset();
  });

  it("EX-1: 读取 reject ⇒ 卡片仍然渲染（不许 return null），并显示「读取 DSH 已安装插件失败：…」", async () => {
    dshExternal.readDshInstalledPlugins.mockRejectedValue(new Error("profile 目录不可读"));

    render(<DshExternalPluginsCard zh />);

    await waitFor(() =>
      expect(screen.getByText("读取 DSH 已安装插件失败：profile 目录不可读")).toBeTruthy(),
    );
    expect(
      screen.queryByTestId("dsh-external-plugins"),
      "读失败必须与「一个都没装」可区分：卡片要出来",
    ).not.toBeNull();
  });

  it("EX-2: 检查更新 reject ⇒ 转圈结束、按钮恢复可点，并显示「检查更新失败：npm view 超时」", async () => {
    dshExternal.readDshInstalledPlugins.mockResolvedValue([EXT_PLUGIN]);
    dshExternal.checkDshPluginUpdates.mockRejectedValue(new Error("npm view 超时"));

    render(<DshExternalPluginsCard zh />);
    await waitFor(() => expect(screen.getByText("dsh-ops")).toBeTruthy());

    const btn = screen.getByRole("button", { name: /检查更新/ });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByText("检查更新失败：npm view 超时")).toBeTruthy(),
    );
    expect(btn.disabled, "改前 finally 只复位、不报错；这里必须两者都有").toBe(false);
  });

  it("EX-3: 升级 reject ⇒ 按钮文案恢复「升级并安装」，并显示「升级「dsh-ops」失败：npm install 退出码 1」", async () => {
    dshExternal.readDshInstalledPlugins.mockResolvedValue([EXT_PLUGIN]);
    dshExternal.upgradeDshPlugin.mockRejectedValue(new Error("npm install 退出码 1"));

    render(<DshExternalPluginsCard zh />);
    const upgradeBtn = await screen.findByRole("button", { name: /升级并安装/ });
    fireEvent.click(upgradeBtn);

    await waitFor(() =>
      expect(
        screen.getByText("升级「dsh-ops」失败：npm install 退出码 1"),
      ).toBeTruthy(),
    );
    const again = screen.getByRole("button", { name: /升级并安装/ });
    expect(again, "失败后 busy 必须清掉（按钮文案回退且可点）").toBeEnabled();
  });
});

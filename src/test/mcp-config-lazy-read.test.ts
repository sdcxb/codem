/**
 * MCP 配置读取：**启动早期的空读不许被永久缓存**（第 182 波，真机取证）。
 *
 * ## 缺陷形态（装机版 1.16.298 真机上量到）
 *
 * `MCPRegistry` 是**惰性单例**（`getMCPRegistry()`），而 `configs` 是在**构造函数里
 * 一次性**读进来的。可启动早期就有人调它（codegraph / zvec 工具在插件初始化时探测），
 * 那一刻存储端口**还没注册**（`bootstrap` 里 `await port.start()` 之后才 `setStoragePort`），
 * 于是 `getSettingJSON("codem-mcp-servers", [])` 走的是"未预热 ⇒ 返回 fallback"那条路
 * —— **读到空表，而且这一读被缓存整个会话**。
 *
 * 真机读数（同一时刻、同一个库）：
 *   · 引擎 `settings.get_all`：498 个键，**含** `codem-mcp-servers`，值是配置好的服务器；
 *   · 渲染侧 `MCPRegistry.getConfigs()`：**0 项** ⇒ 面板永远显示「暂无 MCP 服务器」。
 *
 * ## 三个必须钉住的后果（第三条是**数据丢失**）
 *
 * | # | 后果 |
 * | --- | --- |
 * | MCP-CFG-1 | 未预热时读到的空表**不许**被当成"真的没有服务器"固定住 |
 * | MCP-CFG-2 | 预热完成后同一个实例必须**自愈**（不需要重启应用） |
 * | MCP-CFG-3 | 这种状态下 `addServer()` **绝不许**把空表写回磁盘（会清掉用户原有服务器） |
 * | MCP-CFG-4 | 同上，`removeServer()` 不许把无关条目一起写丢 |
 *
 * ## 造法
 *
 * 用假端口的两个既有开关精确复现真机的两种状态：
 * `setStoragePort(null)` = 启动早期（端口未注册）；`settingsWarmed: true` = `bootstrap`
 * 完成之后（真端口的不变量是"**注册那一刻设置面已经预热完毕**"）。
 * 预置数据走假端口的 `seed: { settings: [...] }`（那才是"磁盘上已有"）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MCPRegistry } from "../core/mcp/mcp";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

const KEY = "codem-mcp-servers";
const SAVED = [
  { name: "user-server", transport: "stdio", command: "npx", args: ["-y", "user-mcp"], env: {} },
];

/** 造一个"磁盘上已经有配置"的假端口（`settingsWarmed` 默认 true = 真机注册后的状态） */
function portWith(servers: unknown, settingsWarmed = true) {
  return createFakeStoragePort({
    seed: { settings: [{ key: KEY, value: JSON.stringify(servers) }] },
    settingsWarmed,
  });
}

/** 读"磁盘"上的当前值（真端口上这句等价于重新 `settings.get_all`） */
function persisted(port: ReturnType<typeof createFakeStoragePort>): string[] {
  const raw = port.config.get<string>(KEY, "[]");
  return (JSON.parse(String(raw)) as Array<{ name: string }>).map((s) => s.name);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  setStoragePort(null);
});

describe("MCP 配置读取：空读不许被永久缓存（第 182 波）", () => {
  it("MCP-CFG-1: 端口未注册时构造 ⇒ 注册 + 预热后同一个实例必须自愈", () => {
    // ① 启动早期：端口还没注册（真机上 codegraph/zvec 在插件初始化时就会调 getMCPRegistry）
    setStoragePort(null);
    const registry = new MCPRegistry();
    expect(
      registry.getConfigs(),
      "未预热时读不到是**预期**的（不能假装有值）—— 但这一读不许被当成结论",
    ).toHaveLength(0);

    // ② bootstrap 完成：端口注册（真端口此刻设置面已预热）
    setStoragePort(portWith(SAVED));

    expect(
      registry.getConfigs().map((c: { name: string }) => c.name),
      "预热完成后必须自愈 —— 真机上这一条不成立的表现就是「面板永远显示暂无 MCP 服务器」",
    ).toEqual(["user-server"]);
  });

  it("MCP-CFG-2 反向对照：端口在、配置也在时构造，照常读到（别把好的弄坏）", () => {
    setStoragePort(portWith(SAVED));
    const registry = new MCPRegistry();
    expect(registry.getConfigs().map((c: { name: string }) => c.name)).toEqual(["user-server"]);
  });

  it("MCP-CFG-3: 早期空读之后 addServer 绝不许把空表写回磁盘（会清掉用户配置）", () => {
    setStoragePort(null);
    const early = new MCPRegistry();
    expect(early.getConfigs()).toHaveLength(0);

    const port = portWith(SAVED);
    setStoragePort(port);

    early.addServer({ name: "added-by-user", transport: "stdio", command: "npx", args: [], env: {} });

    expect(
      persisted(port).sort(),
      "写回磁盘的必须包含**原有**服务器 —— 否则用户原有配置被静默清掉（数据丢失）",
    ).toEqual(["added-by-user", "user-server"]);
  });

  it("MCP-CFG-4: 早期空读之后 removeServer 不许把无关条目一起写丢", () => {
    setStoragePort(null);
    const early = new MCPRegistry();
    early.getConfigs();

    const port = portWith([
      { name: "keep-me", transport: "stdio", command: "npx", args: [], env: {} },
      { name: "drop-me", transport: "stdio", command: "npx", args: [], env: {} },
    ]);
    setStoragePort(port);

    early.removeServer("drop-me");
    expect(persisted(port), "删一个只能少一个：先把真实列表读回来再删").toEqual(["keep-me"]);
  });

  it("MCP-CFG-5: 端口在但设置面**尚未预热**时，读到的空表同样不许被固定住", () => {
    // 这是真端口上真实存在的中间态：端口注册了，但镜像还没预热完
    const cold = portWith(SAVED, false);
    setStoragePort(cold);
    const registry = new MCPRegistry();
    expect(registry.getConfigs(), "未预热 ⇒ 读不到是预期的").toHaveLength(0);

    // 预热完成（真端口由 bootstrap 完成）
    cold.config.warmup();
    expect(
      registry.getConfigs().map((c: { name: string }) => c.name),
      "预热完成后必须自愈",
    ).toEqual(["user-server"]);
  });
});

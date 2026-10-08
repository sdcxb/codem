/**
 * MCP 服务器配置的**写入路径**：陈旧快照整表覆盖 / 未预热写空表（第 184 波 F1）。
 *
 * ## 缺陷形态（真机可复现）
 *
 * ① 打开 MCP 面板 ⇒ `getConfigs()` 加载快照 S（`configsLoaded = true`）；
 * ② 用户装 zvec-grep ⇒ `zvec-grep/service.ts` 自己读改写 `codem-mcp-servers`（**绕过 registry**）；
 * ③ 用户在面板里新增/编辑/删除任一服务器 ⇒ `saveConfigs()` 用 S **整表写回** ⇒
 *    磁盘上的 `zvec_grep` **被静默抹掉**；反向：zvec 卸载时的整表写也会抹掉面板刚加的那条。
 *
 * 附带两套真相：面板永远看不到 `zvec_grep`，而 `getRuntimeStatus().mcpRegistered`
 * （读设置键）却是 true。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | MCP-CFG-6 | 配置面**未预热**时 `addServer` 绝不许把空表写回磁盘（用户的服务器不能被清空） |
 * | MCP-CFG-7 | 面板写回（add / remove）**不许丢别人的条目**：写前重读 + 以磁盘为基准 |
 * | MCP-CFG-8 | zvec 的注册/注销走**唯一写入方**（幂等 + 面板可见，不再是两套真相） |
 * | MCP-CFG-7-S | 结构护栏：zvec 不再自己写 `codem-mcp-servers` |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCPRegistry } from "../core/mcp/mcp";
import { setStoragePort } from "../core/storage/port";
import { setSettingJSON } from "../core/storage/settings";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { createFakeStoragePort } from "./fake-storage-port";

const KEY = "codem-mcp-servers";

const cfg = (name: string) => ({
  name,
  transport: "stdio" as const,
  command: "npx",
  args: ["-y", name],
  env: {},
});

/** 造一个"磁盘上已经有配置"的假端口（`settingsWarmed` 默认 true = 真机注册后的状态） */
function portWith(servers: unknown, settingsWarmed = true) {
  return createFakeStoragePort({
    seed: { settings: [{ key: KEY, value: JSON.stringify(servers) }] },
    settingsWarmed,
  });
}

/**
 * 读**磁盘**上的真实条目（不看端口的配置面内存镜像）。
 *
 * 为什么不用 `config.get`：配置面未预热时它返回兜底值 —— 那正是本文件要区分的两种状态之一。
 */
function diskNames(port: ReturnType<typeof createFakeStoragePort>): string[] {
  const row = port.__table("settings").find((r) => r.key === KEY);
  if (!row) return [];
  return (JSON.parse(String(row.value)) as Array<{ name: string }>).map((s) => s.name);
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetPersistFailures();
});

afterEach(() => {
  setStoragePort(null);
  resetPersistFailures();
});

describe("MCP 配置写入：唯一写入方 + 写前重读（第 184 波 F1）", () => {
  it("MCP-CFG-6: 配置面未预热 ⇒ addServer 绝不许把空表写回磁盘", () => {
    // 端口在、但设置面还没预热：`getSettingJSON` 会静默返回空表
    const cold = portWith([cfg("user-server")], false);
    setStoragePort(cold);

    const registry = new MCPRegistry();
    expect(registry.getConfigs(), "未预热读不到是预期的（不许假装有值）").toHaveLength(0);

    registry.addServer(cfg("from-panel"));

    expect(
      diskNames(cold),
      "读到的空表不是结论：拿它写回就等于把用户已有的服务器全清掉（数据丢失）",
    ).toEqual(["user-server"]);
  });

  it("MCP-CFG-7: 第三方写入 + 面板 addServer ⇒ 别人的条目不许丢（写前重读）", () => {
    const port = portWith([cfg("user-server"), cfg("zvec_grep")]);
    setStoragePort(port);

    const registry = new MCPRegistry();
    expect(
      registry.getConfigs().map((c) => c.name),
      "夹具前提：面板已经加载过一份快照",
    ).toEqual(["user-server", "zvec_grep"]);

    // ③' 另一个写入方（别的窗口 / 别的能力）在快照之后又写了一条
    setSettingJSON(KEY, [...diskNames(port).map(cfg), cfg("late-added")]);

    // ① 用户在面板里加一条 ⇒ 走 addServer
    registry.addServer(cfg("from-panel"));

    expect(
      diskNames(port).sort(),
      "写前必须重读、以磁盘为基准：快照里没有的 late-added 不许被覆盖掉",
    ).toEqual(["from-panel", "late-added", "user-server", "zvec_grep"]);
  });

  it("MCP-CFG-7b: 第三方写入 + 面板 removeServer ⇒ 与删除无关的条目一个都不许丢", () => {
    const port = portWith([cfg("user-server"), cfg("keep-me"), cfg("drop-me")]);
    setStoragePort(port);

    const registry = new MCPRegistry();
    registry.getConfigs();

    setSettingJSON(KEY, [...diskNames(port).map(cfg), cfg("late-added")]);

    registry.removeServer("drop-me");

    expect(
      diskNames(port).sort(),
      "删一个只能少一个：先把真实列表读回来再删",
    ).toEqual(["keep-me", "late-added", "user-server"]);
  });

  it("MCP-CFG-7c: 第三方写入 + 面板 updateServer ⇒ 也是以磁盘为基准（不整表覆盖）", () => {
    const port = portWith([cfg("a"), cfg("b")]);
    setStoragePort(port);

    const registry = new MCPRegistry();
    registry.getConfigs();

    setSettingJSON(KEY, [...diskNames(port).map(cfg), cfg("late-added")]);

    registry.updateServer("a", cfg("a-renamed"));

    expect(diskNames(port).sort()).toEqual(["a-renamed", "b", "late-added"]);
  });

  it("MCP-CFG-8: zvec 的注册/注销走唯一写入方（幂等 + 面板可见）", () => {
    const port = portWith([cfg("user-server")]);
    setStoragePort(port);

    const registry = new MCPRegistry();
    registry.getConfigs();

    // zvec 的注册入口（改前它自己读改写设置键）
    registry.upsertServer(cfg("zvec_grep"));
    registry.upsertServer(cfg("zvec_grep")); // 幂等：重复注册不许变成两条

    expect(diskNames(port).sort(), "幂等注册：同名替换").toEqual(["user-server", "zvec_grep"]);
    expect(
      registry.getConfigs().map((c) => c.name).sort(),
      "面板必须能看到 zvec_grep —— 改前它是「面板看不到、设置键说已注册」的两套真相",
    ).toEqual(["user-server", "zvec_grep"]);

    // zvec 的注销入口（改前它整表读改写）
    registry.removeServer("zvec_grep");
    expect(diskNames(port), "注销只该少一条").toEqual(["user-server"]);
  });

  it("MCP-CFG-7-S 结构护栏：zvec-grep 不再自己写 codem-mcp-servers（唯一写入方）", () => {
    const src = readFileSync(join(__dirname, "../core/zvec-grep/service.ts"), "utf8");
    expect(
      /setSettingJSON\s*\(\s*["']codem-mcp-servers["']/.test(src),
      "zvec 必须走 MCPRegistry（upsertServer/removeServer）—— 第二个写入方就是静默丢失的成因",
    ).toBe(false);
    expect(src, "注册走 registry.upsertServer").toContain("upsertServer");
    expect(src, "注销走 registry.removeServer").toContain("removeServer");
  });

  /**
   * ★ 第 185 波（复审 R1-5）：`addServer` **同名不许追加第二条**。
   *
   * 形态：面板「添加服务器」用同一个名字连点两次 ⇒ `configs` 两条同名，而
   * `MCPClient.connections` 以 **name** 为键（第二次 connect 覆盖第一条）
   * ⇒ 列表显示两条、实际只有一条连接，`removeServer(name)` 一次删两条。
   */
  it("MCP-CFG-9: 同名 addServer 两次 ⇒ 配置里只有一条（配置与连接不许分叉）", () => {
    const port = portWith([cfg("user-server")]);
    setStoragePort(port);

    const registry = new MCPRegistry();
    registry.getConfigs();

    registry.addServer(cfg("dup"));
    registry.addServer(cfg("dup"));

    expect(
      registry.getConfigs().map((c) => c.name).sort(),
      "同名添加必须替换（追加会得到「配置两条、连接只有一条」——列表与实际不符）",
    ).toEqual(["dup", "user-server"]);
    expect(diskNames(port).sort(), "磁盘上同样不许出现两条同名").toEqual(["dup", "user-server"]);
  });

  it("MCP-CFG-10: 同名 addServer 是**替换**（反向对照：第二次的内容必须生效）", () => {
    const port = portWith([]);
    setStoragePort(port);

    const registry = new MCPRegistry();
    registry.addServer(cfg("dup"));
    registry.addServer({ ...cfg("dup"), args: ["-y", "new-version"] });

    const stored = registry.getConfigs().find((c) => c.name === "dup");
    expect(stored?.args, "第二次添加的参数必须替换掉第一次的（不是被静默忽略）").toEqual(["-y", "new-version"]);
    expect(diskNames(port)).toEqual(["dup"]);
  });
});
